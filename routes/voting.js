// ============================================
// PHASE 2: VOTING SYSTEM - BACKEND
// Production-ready Voting API endpoints
// ============================================

const express = require('express');
const crypto  = require('crypto');
const { getCandidatesByCategory, FALLBACK_CANDIDATES } = require('../lib/candidates');
const { transitionPeriod } = require('../lib/period-engine');
const RBAC = require('../lib/rbac'); // Phase 4A.3C: migrating this file's last two legacy-secret-gated routes to RBAC
// Phase 4B.7: the seven routes moved in this phase reference a bare `pool`
// (as they did verbatim in server.js), verifySession() (POST /api/vote,
// GET /api/polling-results, GET /api/my-votes), and getFoundingWardId()
// (POST /api/vote's ward-fallback). Everything else in this file already
// used req.pool / req.wardId (set by server.js's middleware, upstream of
// every router mount) instead -- these three imports exist purely so the
// moved code resolves those identifiers exactly as it did before, with no
// change to any query, condition, or response.
const { pool } = require('../bootstrap/database');
const { verifySession } = require('../lib/auth/session');
const { getFoundingWardId } = require('../lib/ward-cache');

const router = express.Router();

// ─────────────────────────────────────────
// SSE CLIENTS REGISTRY FOR VOTE UPDATES
// Phase 2.6E: each entry is now { res, wardId } instead of a bare res
// object, so a broadcast can be targeted at one ward's clients only.
// wardId is captured once at registration time (see /api/votes/stream
// below) from req.wardId — the same per-request ward value every other
// route in this codebase already reads. No second geography model, no
// county/constituency routing — this reuses exactly the ward identifier
// that's already there.
// ─────────────────────────────────────────

let voteClients = [];

/**
 * Broadcast an SSE event.
 *
 * wardId is OPTIONAL and defaults to null, meaning "broadcast to every
 * connected client regardless of ward" — i.e. the exact behavior this
 * function always had. This is intentional and required: transitionPeriod()
 * (lib/period-engine.js, out of scope this phase) calls this function via
 * its injected broadcastFn parameter with only 2 arguments
 * (broadcastFn('period-rollover', {...}) / broadcastFn('period-ended', {...})),
 * for period-rollover and period-ended events — which are genuinely global,
 * since voting_periods/period_archives have no ward_id column and every
 * ward shares the same period clock. Those calls, and /api/period/next's
 * own 'period-ended' re-broadcast in server.js, keep working identically
 * with zero changes to either of those files.
 *
 * Only the one genuinely ward-specific event — 'vote-received', broadcast
 * from server.js's POST /api/vote — passes a wardId, so only that event
 * type is actually partitioned today.
 */
function broadcastVoteUpdate(eventType, data, wardId = null) {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    // Iterate in reverse so splices don't skip entries
    for (let i = voteClients.length - 1; i >= 0; i--) {
        const client = voteClients[i];
        // null wardId = global broadcast (every existing 2-arg caller).
        // Otherwise: only clients registered under the matching ward.
        if (wardId != null && client.wardId !== wardId) continue;
        try {
            client.res.write(message);
        } catch (_) {
            voteClients.splice(i, 1);
        }
    }
}

// ─────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────

/**
 * Get or create current (active) voting period.
 * Phase 2.6C: the "no active period" branch used to INSERT directly —
 * a hidden mutation path outside the period engine. It now delegates the
 * actual creation to transitionPeriod(mode:'bootstrap'), the same single
 * control function server.js uses, so there is still exactly one place
 * in the whole system that can write a voting_periods row.
 */
async function getCurrentPeriod(pool) {
    let result = await pool.query(`
        SELECT id, period_start, period_end, total_votes
        FROM   voting_periods
        WHERE  is_active = true
        LIMIT  1
    `);

    if (result.rows.length > 0) return result.rows[0];

    // No active period — bootstrap one via the single control function.
    const boot = await transitionPeriod(pool, broadcastVoteUpdate, {
        triggerSource: 'leaderboard-read',
        mode: 'bootstrap'
    });

    result = await pool.query(`
        SELECT id, period_start, period_end, total_votes
        FROM   voting_periods
        WHERE  is_active = true
        LIMIT  1
    `); // re-read regardless of boot.transitioned — covers both "we created it"
        // and "already-active" (a concurrent caller won the bootstrap race)

    return result.rows[0];
}

/**
 * CUMULATIVE vote counts across ALL cycles for every candidate.
 * This is the source of truth for candidate card totals.
 *
 * Phase 2.6D Group 3: wardId is optional, defaults to null (no filter) —
 * same backward-compatible pattern as lib/candidates.js. Filtering here is
 * defense-in-depth on top of the candidate-list join (candidate ids never
 * collide across wards, so the join alone already isolates correctly) —
 * this makes the query itself ward-aware rather than relying solely on
 * that join to do the isolating.
 */
async function getCumulativeVoteCounts(pool, wardId = null) {
    const params = [];
    let whereClause = '';
    if (wardId != null) {
        params.push(wardId);
        whereClause = 'WHERE ward_id = $1';
    }
    const result = await pool.query(`
        SELECT   candidate_id,
                 COUNT(*) AS vote_count
        FROM     votes
        ${whereClause}
        GROUP BY candidate_id
        ORDER BY vote_count DESC
    `, params);
    return result.rows;   // [{ candidate_id, vote_count }]
}

/**
 * Get votes by sublocation for a given period.
 * Phase 2.6D Group 3: wardId optional, same backward-compatible pattern.
 */
async function getVotesBySublocations(pool, periodId, wardId = null) {
    const params = [periodId];
    let wardClause = '';
    if (wardId != null) {
        params.push(wardId);
        wardClause = `AND ward_id = $${params.length}`;
    }
    const result = await pool.query(`
        SELECT   sublocation,
                 candidate_id,
                 COUNT(*) AS vote_count
        FROM     votes
        WHERE    period_id   = $1
          AND    sublocation IS NOT NULL
          ${wardClause}
        GROUP BY sublocation, candidate_id
        ORDER BY sublocation, vote_count DESC
    `, params);

    const breakdown = {};
    result.rows.forEach(row => {
        if (!breakdown[row.sublocation]) breakdown[row.sublocation] = [];
        breakdown[row.sublocation].push({
            candidateId: row.candidate_id,
            votes: parseInt(row.vote_count)
        });
    });
    return breakdown;
}

/**
 * Build the formatted results array from cumulative counts.
 */
function formatCumulativeResults(cumulativeCounts, candidates) {
    const totalVotes = cumulativeCounts.reduce((s, r) => s + parseInt(r.vote_count), 0);

    // Build a map so every candidate appears even with 0 votes
    const countMap = {};
    cumulativeCounts.forEach(r => {
        countMap[parseInt(r.candidate_id)] = parseInt(r.vote_count);
    });

    return candidates
        .map(candidate => {
            const votes = countMap[candidate.id] || 0;
            return {
                candidateId: candidate.id,
                name:        candidate.name,
                party:       candidate.party,
                img:         candidate.img,
                votes,
                percentage:  totalVotes > 0 ? ((votes / totalVotes) * 100).toFixed(1) : '0.0'
            };
        })
        .sort((a, b) => b.votes - a.votes);
}

/**
 * Candidate list — delegates to lib/candidates.js, the single canonical
 * candidate source (Phase 2.6C). This file no longer carries its own
 * hardcoded fallback array; getCandidatesByCategory() already falls back
 * to the shared FALLBACK_CANDIDATES constant if the DB is unreachable.
 *
 * Phase 2.6D fix: this used to be permanently hardcoded to 'MCA' with no
 * way to call it for any other category, which is why /api/leaderboard
 * and /api/voting-results/face-off could only ever return MCA data no
 * matter what a caller wanted. category now defaults to 'MCA' so every
 * existing caller that doesn't pass one keeps the exact same behavior.
 *
 * Phase 2.6D Group 3: wardId added, same optional/backward-compatible
 * pattern as lib/candidates.js.
 *
 * Trims to the columns these two routes actually read (id, name, party,
 * img) — same shape callers here always expected.
 */
async function getCandidates(pool, category = 'MCA', wardId = null) {
    const candidates = await getCandidatesByCategory(pool, category, wardId);
    return candidates.map(c => ({ id: c.id, name: c.name, party: c.party, img: c.img }));
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

/**
 * GET /api/votes/stream
 * Server-Sent Events for real-time vote updates.
 * Phase 2.6E: client's ward is captured once here, from req.wardId (set by
 * server.js's existing middleware — the same per-request ward value every
 * other route already uses, no new ward-resolution mechanism introduced).
 */
router.get('/api/votes/stream', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const client = { res, wardId: req.wardId };
    voteClients.push(client);
    console.log(`Vote SSE client connected (ward=${req.wardId}). Total: ${voteClients.length}`);

    res.write(`event: connected\ndata: {"message":"Connected to voting updates"}\n\n`);

    const heartbeat = setInterval(() => {
        try { res.write(`: heartbeat\n\n`); } catch (_) {}
    }, 30000);

    req.on('close', () => {
        clearInterval(heartbeat);
        const idx = voteClients.indexOf(client);
        if (idx !== -1) voteClients.splice(idx, 1);
        console.log(`Vote SSE client disconnected. Total: ${voteClients.length}`);
    });
});

/**
 * GET /api/leaderboard
 * Returns CUMULATIVE standings + period archive history.
 * Supports ?category=MCA|WomenRep|MP|Senator|Governor|President (defaults
 * to MCA — this route used to be hardcoded to MCA with no way to ask for
 * anything else; the default preserves every existing caller's behavior).
 */
router.get('/api/leaderboard', async (req, res) => {
    try {
        const category          = req.query.category || 'MCA';
        const candidates        = await getCandidates(req.pool, category, req.wardId);
        const cumulativeCounts  = await getCumulativeVoteCounts(req.pool, req.wardId);
        const results           = formatCumulativeResults(cumulativeCounts, candidates);
        const period            = await getCurrentPeriod(req.pool);

        // Previous period archive (winner per cycle — historical record)
        const archiveResult = await req.pool.query(`
            SELECT   id,
                     (period_data->>'winner_id')::int    AS winner_id,
                     (period_data->>'winner_votes')::int AS winner_votes
            FROM     period_archives
            ORDER BY id DESC
            LIMIT    10
        `);

        const previous = archiveResult.rows.map(row => {
            const winner = candidates.find(c => c.id === row.winner_id);
            return {
                period:   row.id,
                winner:   winner?.name || 'Unknown',
                winnerId: row.winner_id,
                votes:    row.winner_votes || 0
            };
        });

        res.json({
            success: true,
            data: {
                category,
                current: { period: period.id, results },
                previous
            }
        });

    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
    }
});

/**
 * GET /api/voting-results/by-sublocation
 * Vote breakdown by sublocation for the current period.
 */
router.get('/api/voting-results/by-sublocation', async (req, res) => {
    try {
        const period    = await getCurrentPeriod(req.pool);
        const breakdown = await getVotesBySublocations(req.pool, period.id, req.wardId);

        res.json({
            success: true,
            data: { periodId: period.id, bySublocations: breakdown }
        });

    } catch (error) {
        console.error('Error fetching sublocation breakdown:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch sublocation breakdown' });
    }
});

/**
 * GET /api/voting-results/face-off
 * Returns the top two candidates by cumulative votes for the Face-Off section.
 * Restored 2026-06-16: confirmed live consumer in leaderboard.html (loadFaceOff,
 * line 587) — was removed in error during the original voting-results/
 * my-vote-history cleanup, before leaderboard.html had been audited.
 * Phase 2.6D: supports ?category= (defaults to MCA, same reasoning as
 * /api/leaderboard above).
 */
router.get('/api/voting-results/face-off', async (req, res) => {
    try {
        const category          = req.query.category || 'MCA';
        const candidates        = await getCandidates(req.pool, category, req.wardId);
        const cumulativeCounts  = await getCumulativeVoteCounts(req.pool, req.wardId);
        const results           = formatCumulativeResults(cumulativeCounts, candidates);
        const totalVotes        = results.reduce((s, r) => s + r.votes, 0);

        const top2 = results.slice(0, 2).map(r => ({
            ...r,
            percentage: totalVotes > 0 ? ((r.votes / totalVotes) * 100).toFixed(1) : '0.0'
        }));

        res.json({ success: true, data: { category, top2, totalVotes } });

    } catch (error) {
        console.error('Error fetching face-off:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch face-off data' });
    }
});

/**
 * Admin: DELETE /api/vote/:id
 * Remove a single vote record.
 * Phase 4A.3C: SUPER_ADMIN-only — destructive, and not ward-scoped (this
 * mutates voting_periods.total_votes globally), matching the same
 * minimum-role reasoning already applied to add_period/end_period/
 * delete_user in server.js.
 */
router.delete('/api/vote/:id', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
    try {
        const voteResult = await req.pool.query(
            `SELECT period_id, candidate_id FROM votes WHERE id = $1`, [req.params.id]
        );
        if (voteResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Vote not found' });
        }

        const { period_id } = voteResult.rows[0];

        await req.pool.query('DELETE FROM votes WHERE id = $1', [req.params.id]);
        await req.pool.query(
            `UPDATE voting_periods SET total_votes = GREATEST(total_votes - 1, 0) WHERE id = $1`,
            [period_id]
        );

        res.json({ success: true, message: 'Vote removed successfully' });

    } catch (error) {
        console.error('Error deleting vote:', error);
        res.status(500).json({ success: false, error: 'Failed to delete vote' });
    }
});

/**
 * Admin: GET /api/admin/votes
 * Recent votes for the current period with candidate names.
 * Phase 4A.3C: WARD_ADMIN+, read-only — same minimum-role reasoning as
 * get_stats/get_periods in server.js's /api/admin dispatcher.
 * Phase 4A.4: read-side scope added. votes.ward_id (added by
 * ensurePhase2Migrations' GEO_TABLES migration) is used directly for
 * WARD_ADMIN; CONSTITUENCY_ADMIN/COUNTY_ADMIN join through wards/
 * constituencies. Response shape (id, user_id, candidate_id, sublocation,
 * timestamp) is unchanged — ward_id is used in the WHERE clause only, not
 * added to the SELECT list.
 */
router.get('/api/admin/votes', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
    try {
        const period = await getCurrentPeriod(req.pool);
        const scope = RBAC.resolveReadScope(req.user);
        const { clause: scopeClause, params } = RBAC.buildScopeFilter(
            scope,
            { ward: 'v.ward_id', constituency: 'w.constituency_id', county: 'con.county_id' },
            [period.id]
        );
        const whereSql = scopeClause ? `WHERE v.period_id = $1 AND ${scopeClause}` : 'WHERE v.period_id = $1';
        const result = await req.pool.query(`
            SELECT v.id, v.user_id, v.candidate_id, v.sublocation, v.timestamp
            FROM   votes v
            LEFT JOIN wards w ON w.id = v.ward_id
            LEFT JOIN constituencies con ON con.id = w.constituency_id
            ${whereSql}
            ORDER  BY v.timestamp DESC
            LIMIT  100
        `, params);

        res.json({
            success: true,
            data: {
                periodId: period.id,
                votes:    result.rows,
                total:    result.rows.length
            }
        });

    } catch (error) {
        console.error('Error fetching admin votes:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch votes' });
    }
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 4B.7: the remaining Voting-domain routes below, moved verbatim
// from server.js -- POST /api/vote, GET /api/polling-results, GET
// /api/history, GET /api/voting-results, GET /api/period-history, GET
// /api/my-votes, GET /api/faceoff. Per the repository audit already
// completed: /api/voting-results is an intentionally SEPARATE
// implementation from /api/leaderboard above (different consumer --
// admin-voting.html vs leaderboard.html -- different response shape),
// and /api/polling-results is an intentionally separate implementation
// from /api/voting-results/by-sublocation above (different NULL-
// sublocation handling, different response shape). Neither pair was
// merged, consolidated, or rewritten to share logic -- each keeps its
// original SQL and JSON contract exactly. /api/history had no frontend
// consumer identified during the repository audit; it is preserved
// unchanged for backward compatibility, not removed.
// ────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════
// ROUTE: /api/vote
// ════════════════════════════════════════════════
router.post('/api/vote', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { candidateId, periodId } = req.body;
  if (!candidateId && candidateId !== 0 || !periodId)
    return res.status(400).json({ error: 'candidateId and periodId are required' });

  try {
    const periodResult = await pool.query(
      'SELECT * FROM voting_periods WHERE id = $1 AND is_active = true',
      [periodId]
    );
    if (periodResult.rows.length === 0)
      return res.status(400).json({ error: 'Voting period not found or inactive' });

    const period = periodResult.rows[0];
    if (new Date(period.period_end) <= new Date())
      return res.status(400).json({ error: 'Voting period has ended' });

    // Resolve the candidate's category from the DB (fall back to 'MCA' for legacy in-memory candidates)
    const CANDS_FALLBACK_CAT = { 0:'MCA',1:'MCA',2:'MCA',3:'MCA',4:'MCA',5:'MCA',6:'MCA' };
    let voteCategory = 'MCA';
    try {
      const candRes = await pool.query('SELECT category FROM candidates WHERE id = $1', [candidateId]);
      if (candRes.rows.length > 0) voteCategory = candRes.rows[0].category || 'MCA';
      else voteCategory = CANDS_FALLBACK_CAT[candidateId] || 'MCA';
    } catch(_) { voteCategory = CANDS_FALLBACK_CAT[candidateId] || 'MCA'; }

    // Eligibility check: one vote per user per period PER CATEGORY
    const voteCheck = await pool.query(
      'SELECT id FROM votes WHERE user_id = $1 AND period_id = $2 AND category = $3',
      [session.userId, periodId, voteCategory]
    );
    if (voteCheck.rows.length > 0)
      return res.status(409).json({ error: `Already voted for ${voteCategory} this period`, alreadyVoted: true, category: voteCategory });

    // ── DEPRECATED: votes.sublocation ──────────────────────────────────────
    // Phase 2.5: votes.sublocation is deprecated as a geographic field.
    // It is a freetext copy of users.sublocation at vote cast-time and has
    // no FK constraint or hierarchy link. It can diverge from the user's
    // actual geographic record if their profile is updated after voting.
    //
    // Geographic source of truth is now: votes.ward_id → wards → constituencies → counties
    //
    // DO NOT add new queries that filter or group by votes.sublocation.
    // Phase 3 migration will replace sublocation-based analytics with ward_id joins.
    // This read and the write below are retained for backward compatibility only.
    // ────────────────────────────────────────────────────────────────────────
    //
    // Stage 3B.1 — ward_id data-integrity correction:
    // Extending the existing user lookup (which was already SELECT sublocation)
    // to also fetch ward_id. The trust chain is:
    //   session.userId (HMAC-verified, cannot be spoofed by client)
    //   → server-side DB lookup using only that verified userId
    //   → user.ward_id used in INSERT
    // No client request parameter is accepted for ward — identical pattern
    // to forum posts (Phase 3A: authorWardId = u.ward_id || getFoundingWardId()).
    const userResult = await pool.query(
      'SELECT sublocation, ward_id FROM users WHERE id = $1',
      [session.userId]
    );
    const user = userResult.rows[0];
    // Null-safety fallback: only fires for users who pre-date the ward
    // backfill (ward_id IS NULL). For all users created after Phase 2.6,
    // user.ward_id is always set.
    const voteWardId = user?.ward_id || getFoundingWardId();

    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);

    const insertResult = await pool.query(
      // DEPRECATED: sublocation ($5) — kept for backward compat; ward_id ($8) is the authoritative geographic field.
      // Phase 3: remove sublocation from this INSERT and from vote-based analytics queries.
      `INSERT INTO votes (user_id, candidate_id, period_id, category, sublocation, ip_hash, timestamp, ward_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, period_id, category) DO NOTHING
       RETURNING id`,
      [session.userId, candidateId, periodId, voteCategory, user?.sublocation || null, ipHash, Date.now(), voteWardId]
    );

    // If no row was inserted, a concurrent request already recorded a vote (race condition)
    if (insertResult.rowCount === 0) {
      return res.status(409).json({ error: `Already voted for ${voteCategory} this period`, alreadyVoted: true, category: voteCategory });
    }

    // total_votes counter removed — totalVotes is now counted live from the votes table

    // ── Count totals and per-candidate ────────────────────────────────────
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    // Phase 2.6E: the SSE broadcast below is ward-partitioned too — each
    // connected client's wardId is captured at connection time and
    // broadcastVoteUpdate() only delivers to clients whose wardId matches
    // (see routes/voting.js), so this stays correct as more wards are added.
    const totalParams = [periodId];
    let totalWardClause = '';
    if (req.wardId != null) {
      totalParams.push(req.wardId);
      totalWardClause = 'AND ward_id = $2';
    }
    const totalRes = await pool.query(
      `SELECT COUNT(*) as count FROM votes WHERE period_id = $1 ${totalWardClause}`,
      totalParams
    );
    const voterCount = parseInt(totalRes.rows[0].count);

    let badge = null;
    if (voterCount === 1) badge = '1st';
    else if (voterCount === 2) badge = '2nd';
    else if (voterCount === 3) badge = '3rd';

    // Per-candidate counts for faceoff / live display
    const perCandParams = [periodId];
    let perCandWardClause = '';
    if (req.wardId != null) {
      perCandParams.push(req.wardId);
      perCandWardClause = 'AND ward_id = $2';
    }
    const perCandRes = await pool.query(
      `SELECT candidate_id, COUNT(*) as vote_count FROM votes WHERE period_id = $1 ${perCandWardClause} GROUP BY candidate_id`,
      perCandParams
    );
    const votesByCandidate = {};
    perCandRes.rows.forEach(r => {
      votesByCandidate[r.candidate_id] = parseInt(r.vote_count);
    });

    // ── Broadcast to SSE subscribers in THIS ward only (Phase 2.6E) ──────
    // Was a global broadcast to every connected client regardless of ward;
    // now targeted via the third (optional) wardId argument added to
    // broadcastVoteUpdate in routes/voting.js.
    broadcastVoteUpdate('vote-received', {
      candidateId,
      periodId,
      totalVotes: voterCount,
      votes: votesByCandidate[candidateId] || 1,
      votesByCandidate
    }, req.wardId);

    return res.json({
      success: true,
      badge,
      totalVotes: voterCount,
      votesByCandidate,
      candidateId,
      periodId,
      category: voteCategory
    });
  } catch (e) {
    console.error('/api/vote error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/polling-results
// ════════════════════════════════════════════════
router.get('/api/polling-results', async (req, res) => {
  try {
    const periodResult = await pool.query(
      'SELECT * FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );

    if (periodResult.rows.length === 0) {
      return res
        .set('Cache-Control', 'public, max-age=5')
        .json({ 
          periodId: null, 
          totalVotes: 0, 
          votesByCandidate: {}, 
          isActive: false 
        });
    }

    const period = periodResult.rows[0];
    // Phase 2.6D Group 3: this is the ward_id join the old comment below
    // said "Phase 3" would add — votes.sublocation stays as a freetext
    // display value, ward_id is now the actual filter.
    const votesParams = [period.id];
    let votesWardClause = '';
    if (req.wardId != null) {
      votesParams.push(req.wardId);
      votesWardClause = 'AND ward_id = $2';
    }
    const votesResult = await pool.query(
      `SELECT candidate_id, sublocation, COUNT(*) as count FROM votes WHERE period_id = $1 ${votesWardClause} GROUP BY candidate_id, sublocation`,
      votesParams
    );

    // Check which categories the authenticated user has voted in this period
    let hasVoted = false;
    let votedCategories = {};
    const session = verifySession(req.headers.cookie || '');
    if (session && session.userId) {
      const voteCheck = await pool.query(
        'SELECT category FROM votes WHERE user_id = $1 AND period_id = $2',
        [session.userId, period.id]
      );
      if (voteCheck.rows.length > 0) {
        hasVoted = true; // backward-compat: true if voted in ANY category
        voteCheck.rows.forEach(r => { votedCategories[r.category] = true; });
      }
    }

    // Build structure with sublocations and total
    const votesByCandidate = {};
    votesResult.rows.forEach(row => {
      if (!votesByCandidate[row.candidate_id]) {
        votesByCandidate[row.candidate_id] = { 
          total: 0, 
          sublocations: {} 
        };
      }
      const count = parseInt(row.count);
      votesByCandidate[row.candidate_id].total += count;
      const sublocKey = row.sublocation || 'Unknown';
      votesByCandidate[row.candidate_id].sublocations[sublocKey] = count;
    });

    // Live count — always accurate regardless of deletes or restores
    const liveTotalParams = [period.id];
    let liveTotalWardClause = '';
    if (req.wardId != null) {
      liveTotalParams.push(req.wardId);
      liveTotalWardClause = 'AND ward_id = $2';
    }
    const liveTotalRes = await pool.query(
      `SELECT COUNT(*) AS count FROM votes WHERE period_id = $1 ${liveTotalWardClause}`, liveTotalParams
    );
    const liveTotalVotes = parseInt(liveTotalRes.rows[0].count || 0);

    return res
      .set('Cache-Control', 'private, no-cache')
      .json({
        periodId: period.id,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        isActive: period.is_active,
        totalVotes: liveTotalVotes,
        hasVoted,
        votedCategories,
        votesByCandidate: votesByCandidate,
        votesByUser: []
      });
  } catch (e) {
    console.error('/api/polling-results error:', e);
    return res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/history
// ════════════════════════════════════════════════
router.get('/api/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const periodsResult = await pool.query(`
      SELECT id, period_start, period_end, total_votes 
      FROM voting_periods 
      ORDER BY id DESC 
      LIMIT $1
    `, [limit]);
    
    const periods = [];
    for (const period of periodsResult.rows) {
      // Phase 2.6D Group 3: ward_id join, same as /api/polling-results above.
      const votesParams = [period.id];
      let votesWardClause = '';
      if (req.wardId != null) {
        votesParams.push(req.wardId);
        votesWardClause = 'AND ward_id = $2';
      }
      const votesResult = await pool.query(
        `SELECT candidate_id, sublocation, COUNT(*) as count FROM votes WHERE period_id = $1 ${votesWardClause} GROUP BY candidate_id, sublocation`,
        votesParams
      );

      const votesByCandidate = {};
      let periodTotalVotes = 0;
      votesResult.rows.forEach(row => {
        if (!votesByCandidate[row.candidate_id]) {
          votesByCandidate[row.candidate_id] = { total: 0, sublocations: {} };
        }
        const count = parseInt(row.count);
        votesByCandidate[row.candidate_id].total += count;
        votesByCandidate[row.candidate_id].sublocations[row.sublocation || 'Unknown'] = count;
        periodTotalVotes += count;
      });

      periods.push({
        periodId: period.id,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        // Phase 2.6D Group 3: was period.total_votes (the global per-period
        // counter incremented by EVERY ward combined — voting_periods has
        // no ward_id column, see lib/period-engine.js). Now the sum of the
        // ward-filtered rows above, so it's actually filterable. Identical
        // number today (one ward); correct once a second ward exists.
        totalVotes: req.wardId != null ? periodTotalVotes : period.total_votes,
        votesByCandidate: votesByCandidate
      });
    }
    
    return res.json({ success: true, periods });
  } catch (e) {
    console.error('/api/history error:', e);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: GET /api/voting-results
// Returns CUMULATIVE vote totals across ALL periods, joined to the
// candidates table (DB-backed). Mirrors the contract previously served
// by routes/voting.js so frontend consumers need no changes.
//
// Response shape:
//   { success, data: { periodId, results[ candidateId, name, party, img, votes, percentage ], totalVotes, updatedAt } }
//
// Vote semantics: lifetime cumulative (no period filter) — identical to
// the voting.js implementation which used SELECT … FROM votes GROUP BY candidate_id.
// ════════════════════════════════════════════════
router.get('/api/voting-results', async (req, res) => {
  try {
    const category = req.query.category || 'MCA';

    // 1. Cumulative vote counts across ALL periods (no period filter)
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set —
    // defense-in-depth on top of the candidate-list join below (candidate
    // ids never collide across wards, so the join alone already isolates).
    const voteParams = [];
    let voteWardClause = '';
    if (req.wardId != null) {
      voteParams.push(req.wardId);
      voteWardClause = `WHERE ward_id = $${voteParams.length}`;
    }
    const voteRes = await pool.query(`
      SELECT   candidate_id,
               COUNT(*) AS vote_count
      FROM     votes
      ${voteWardClause}
      GROUP BY candidate_id
    `, voteParams);

    // Build a lookup map: candidate_id (int) → vote_count (int)
    const countMap = {};
    let totalVotes = 0;
    voteRes.rows.forEach(row => {
      const id    = parseInt(row.candidate_id);
      const count = parseInt(row.vote_count);
      countMap[id] = count;
      totalVotes  += count;
    });

    // 2. Fetch candidates for the requested category from the DB (authoritative source)
    // Phase 2.6D: this used to be hardcoded to category = 'MCA' with no
    // parameter at all — ?category= now defaults to MCA so existing
    // callers keep the exact same behavior.
    // Phase 2.6D Group 3: also filtered by ward_id when req.wardId is set.
    const candParams = [category];
    let candWardClause = '';
    if (req.wardId != null) {
      candParams.push(req.wardId);
      candWardClause = 'AND ward_id = $2';
    }
    const candRes = await pool.query(`
      SELECT id, name, party, img
      FROM   candidates
      WHERE  category = $1
      ${candWardClause}
      ORDER BY id
    `, candParams);

    // 3. Build results array — every candidate appears even with 0 votes
    const results = candRes.rows.map(c => {
      const votes = countMap[parseInt(c.id)] || 0;
      return {
        candidateId: parseInt(c.id),
        name:        c.name,
        party:       c.party  || '',
        img:         c.img    || '',
        votes,
        percentage:  totalVotes > 0 ? ((votes / totalVotes) * 100).toFixed(1) : '0.0'
      };
    }).sort((a, b) => b.votes - a.votes);

    // 4. Current active period id for cycle context (mirrors voting.js behaviour)
    const periodRes = await pool.query(
      `SELECT id FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1`
    );
    const periodId = periodRes.rows.length > 0 ? periodRes.rows[0].id : null;

    return res.json({
      success: true,
      data: {
        category,
        periodId,
        results,
        totalVotes,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (e) {
    console.error('[/api/voting-results] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch voting results' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: GET /api/period-history
// Returns completed voting periods with per-candidate vote totals.
// Source of truth: voting_periods (is_active=false) + votes + candidates tables.
// Does NOT depend on localStorage or period_archives.
// ════════════════════════════════════════════════
router.get('/api/period-history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    // Fetch completed periods only (is_active = false), most recent first
    const periodsResult = await pool.query(`
      SELECT id, period_start, period_end, total_votes
        FROM voting_periods
       WHERE is_active = false
       ORDER BY id DESC
       LIMIT $1
    `, [limit]);

    if (periodsResult.rows.length === 0) {
      return res.json({ success: true, periods: [] });
    }

    // Fetch all candidates once (id, name, category) to avoid N+1 lookups
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    const candParams = [];
    let candWardClause = '';
    if (req.wardId != null) {
      candParams.push(req.wardId);
      candWardClause = 'WHERE ward_id = $1';
    }
    const candResult = await pool.query(
      `SELECT id, name, category FROM candidates ${candWardClause} ORDER BY id`,
      candParams
    );
    const candidateMap = {};
    candResult.rows.forEach(c => { candidateMap[c.id] = c; });

    const periods = [];
    for (const period of periodsResult.rows) {
      // Aggregate votes per candidate for this period
      // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set —
      // defense-in-depth on top of the candidateMap join above.
      const voteParams = [period.id];
      let voteWardClause = '';
      if (req.wardId != null) {
        voteParams.push(req.wardId);
        voteWardClause = 'AND ward_id = $2';
      }
      const votesResult = await pool.query(
        `SELECT candidate_id, COUNT(*) AS vote_count
           FROM votes
          WHERE period_id = $1
          ${voteWardClause}
          GROUP BY candidate_id`,
        voteParams
      );

      const candidates = votesResult.rows.map(row => {
        const cand = candidateMap[row.candidate_id] || {};
        return {
          candidateId:   String(row.candidate_id),
          candidateName: cand.name     || `Candidate ${row.candidate_id}`,
          category:      cand.category || 'MCA',
          votes:         parseInt(row.vote_count),
        };
      });

      periods.push({
        periodId:   String(period.id),
        periodName: `Cycle ${period.id}`,
        startDate:  period.period_start,
        endDate:    period.period_end,
        candidates,
      });
    }

    return res.json({ success: true, periods });
  } catch (e) {
    console.error('/api/period-history error:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch period history' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/my-votes  — voter's personal vote history
// ════════════════════════════════════════════════
router.get('/api/my-votes', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Unauthorized' });

  try {
    const result = await pool.query(
      `SELECT
         v.id,
         v.candidate_id,
         v.period_id,
         v.sublocation,
         v.timestamp,
         vp.period_start,
         vp.period_end,
         vp.is_active,
         vp.total_votes  AS period_total_votes,
         vp.winner_id    AS period_winner_id
       FROM votes v
       JOIN voting_periods vp ON vp.id = v.period_id
       WHERE v.user_id = $1
       ORDER BY v.timestamp DESC`,
      [session.userId]
    );

    // Enrich with candidate name + category from DB (fall back to in-memory for MCA 0-6)
    const candIdsNeeded = [...new Set(result.rows.map(r => parseInt(r.candidate_id)))];
    let candMap = {};
    if (candIdsNeeded.length > 0) {
      try {
        const cr = await pool.query(
          `SELECT id, name, party, category FROM candidates WHERE id = ANY($1)`,
          [candIdsNeeded]
        );
        cr.rows.forEach(c => { candMap[c.id] = c; });
      } catch (_) {}
    }
    // In-memory fallback for original MCA candidates — single canonical
    // source (lib/candidates.js). This used to be a fourth local copy with
    // party affiliations that had drifted out of sync with every other
    // candidate list in the codebase (Phase 2.6C finding).
    const candsFallback = FALLBACK_CANDIDATES;

    const votes = result.rows.map(row => {
      const cid = parseInt(row.candidate_id);
      const cand = candMap[cid] || candsFallback.find(c => c.id === cid) || {};
      return {
        id:               row.id,
        candidateId:      parseInt(row.candidate_id),
        candidateName:    cand.name  || 'Unknown',
        candidateParty:   cand.party || '—',
        periodId:         row.period_id,
        periodStart:      row.period_start,
        periodEnd:        row.period_end,
        isActivePeriod:   row.is_active,
        periodTotalVotes: parseInt(row.period_total_votes) || 0,
        periodWinnerId:   row.period_winner_id != null ? parseInt(row.period_winner_id) : null,
        sublocation:      row.sublocation,
        votedAt:          new Date(parseInt(row.timestamp)).toISOString()
      };
    });

    return res.json({ success: true, votes });
  } catch (e) {
    console.error('/api/my-votes error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/faceoff - Top 2 candidates by CUMULATIVE votes across all cycles
// Supports ?category=MCA|MP|Governor|WomenRep (defaults to MCA for backward compat)
router.get('/api/faceoff', async (req, res) => {
  try {
    const category = req.query.category || 'MCA';

    // Single canonical candidate source (lib/candidates.js) — same helper
    // /api/candidates, routes/voting.js, and routes/analytics.js now use.
    const candidates = await getCandidatesByCategory(pool, category, req.wardId);

    if (candidates.length === 0) {
      return res.json({ success: true, candidates: [], allCandidates: [], periodId: null, totalVotes: 0 });
    }

    // Cumulative vote counts for this category's candidates
    // Phase 2.6D Group 3: ward_id filter added as defense-in-depth on top
    // of the candidate_id = ANY($1) filter, which already disambiguates
    // since candidate ids never collide across wards.
    const candidateIds = candidates.map(c => c.id);
    const voteParams = [candidateIds];
    let voteWardClause = '';
    if (req.wardId != null) {
      voteParams.push(req.wardId);
      voteWardClause = 'AND ward_id = $2';
    }
    const allVotes = await pool.query(
      `SELECT candidate_id, COUNT(*) AS vote_count
         FROM votes
        WHERE candidate_id = ANY($1)
        ${voteWardClause}
        GROUP BY candidate_id`,
      voteParams
    );

    const voteMap = {};
    allVotes.rows.forEach(r => {
      voteMap[parseInt(r.candidate_id)] = parseInt(r.vote_count);
    });

    const totalVotes = Object.values(voteMap).reduce((s, n) => s + n, 0);

    const ranked = candidates.map(c => ({
      ...c,
      vote_count: voteMap[c.id] || 0,
      percentage: totalVotes > 0 ? (((voteMap[c.id] || 0) / totalVotes) * 100).toFixed(1) : '0.0'
    })).sort((a, b) => b.vote_count - a.vote_count);

    const top2 = ranked.slice(0, 2);

    const periodRes = await pool.query(
      'SELECT id FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );
    const periodId = periodRes.rows[0]?.id ?? null;

    res.json({
      success: true,
      candidates:    top2,
      allCandidates: ranked,
      periodId,
      totalVotes
    });
  } catch (error) {
    console.error('/api/faceoff error:', error.message, error.stack);
    res.status(500).json({ success: false, error: 'Failed to get faceoff data' });
  }
});

// ─────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────
module.exports               = router;
module.exports.router        = router;
module.exports.broadcastVoteUpdate = broadcastVoteUpdate;