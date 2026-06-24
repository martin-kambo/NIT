// ============================================
// PHASE 2: VOTING SYSTEM - BACKEND
// Production-ready Voting API endpoints
// ============================================

const express = require('express');
const crypto  = require('crypto');
const { getCandidatesByCategory } = require('../lib/candidates');
const { transitionPeriod } = require('../lib/period-engine');

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
 */
router.delete('/api/vote/:id', async (req, res) => {
    const adminPassword = req.headers['x-admin-password'];
    if (!adminPassword) return res.status(401).json({ success: false, error: 'Admin password required' });

    const hash = crypto.createHash('sha256').update(adminPassword).digest('hex');
    if (hash.toUpperCase() !== (process.env.ADMIN_PASSWORD_HASH || '').toUpperCase()) {
        return res.status(401).json({ success: false, error: 'Invalid admin password' });
    }

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
 */
router.get('/api/admin/votes', async (req, res) => {
    const adminPassword = req.headers['x-admin-password'];
    if (!adminPassword) return res.status(401).json({ success: false, error: 'Admin password required' });

    const hash = crypto.createHash('sha256').update(adminPassword).digest('hex');
    if (hash.toUpperCase() !== (process.env.ADMIN_PASSWORD_HASH || '').toUpperCase()) {
        return res.status(401).json({ success: false, error: 'Invalid admin password' });
    }

    try {
        const period = await getCurrentPeriod(req.pool);
        const result = await req.pool.query(`
            SELECT id, user_id, candidate_id, sublocation, timestamp
            FROM   votes
            WHERE  period_id = $1
            ORDER  BY timestamp DESC
            LIMIT  100
        `, [period.id]);

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

// ─────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────
module.exports               = router;
module.exports.router        = router;
module.exports.broadcastVoteUpdate = broadcastVoteUpdate;