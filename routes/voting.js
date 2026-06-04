// ============================================
// PHASE 2: VOTING SYSTEM - BACKEND
// Production-ready Voting API endpoints
// ============================================

const express = require('express');
const crypto  = require('crypto');

const router = express.Router();

// ─────────────────────────────────────────
// SSE CLIENTS REGISTRY FOR VOTE UPDATES
// ─────────────────────────────────────────

let voteClients = [];

function broadcastVoteUpdate(eventType, data) {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    // Iterate in reverse so splices don't skip entries
    for (let i = voteClients.length - 1; i >= 0; i--) {
        try {
            voteClients[i].write(message);
        } catch (_) {
            voteClients.splice(i, 1);
        }
    }
}

// ─────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────

/**
 * Get or create current (active) voting period
 */
async function getCurrentPeriod(pool) {
    let result = await pool.query(`
        SELECT id, period_start, period_end, total_votes
        FROM   voting_periods
        WHERE  is_active = true
        LIMIT  1
    `);

    if (result.rows.length > 0) return result.rows[0];

    // No active period — create one
    const periodStart = new Date();
    const periodEnd   = new Date(periodStart.getTime() + 5 * 60 * 1000); // 5 minutes

    result = await pool.query(`
        INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
        VALUES (
            COALESCE((SELECT MAX(id) FROM voting_periods), 0) + 1,
            $1, $2, true, 0
        )
        RETURNING id, period_start, period_end, total_votes
    `, [periodStart, periodEnd]);

    return result.rows[0];
}

/**
 * CUMULATIVE vote counts across ALL cycles for every candidate.
 * This is the source of truth for candidate card totals.
 */
async function getCumulativeVoteCounts(pool) {
    const result = await pool.query(`
        SELECT   candidate_id,
                 COUNT(*) AS vote_count
        FROM     votes
        GROUP BY candidate_id
        ORDER BY vote_count DESC
    `);
    return result.rows;   // [{ candidate_id, vote_count }]
}

/**
 * Per-cycle vote counts (used only for period-specific admin views).
 */
async function getVoteCountsForPeriod(pool, periodId) {
    const result = await pool.query(`
        SELECT   candidate_id,
                 COUNT(*) AS vote_count
        FROM     votes
        WHERE    period_id = $1
        GROUP BY candidate_id
        ORDER BY vote_count DESC
    `, [periodId]);
    return result.rows;
}

/**
 * Check whether a user has already voted in a specific cycle.
 * Returns true  → already voted
 * Returns false → has not voted yet
 */
async function hasUserVotedInCycle(pool, userId, periodId) {
    const result = await pool.query(`
        SELECT 1 FROM votes
        WHERE  user_id    = $1
          AND  period_id  = $2
        LIMIT  1
    `, [userId, periodId]);
    return result.rows.length > 0;
}

/**
 * Get votes by sublocation for a given period.
 */
async function getVotesBySublocations(pool, periodId) {
    const result = await pool.query(`
        SELECT   sublocation,
                 candidate_id,
                 COUNT(*) AS vote_count
        FROM     votes
        WHERE    period_id   = $1
          AND    sublocation IS NOT NULL
        GROUP BY sublocation, candidate_id
        ORDER BY sublocation, vote_count DESC
    `, [periodId]);

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
 * Candidate list (single source of truth — mirrors server.js CANDIDATES).
 */
function getCandidates() {
    return [
        { id: 0, name: 'Hon. James Mwangi', party: 'Jubilee',     incumbent: true,  bio: 'Incumbent MCA, serving second term.',  img: 'https://ui-avatars.com/api/?name=James+Mwangi&background=0d2818&color=40c27a&size=120' },
        { id: 1, name: 'Grace Wanjiku',     party: 'ODM',         incumbent: false, bio: 'Community health advocate.',            img: 'https://ui-avatars.com/api/?name=Grace+Wanjiku&background=1a3f28&color=e9c46a&size=120' },
        { id: 2, name: 'Peter Kimani',      party: 'UDA',         incumbent: false, bio: 'Former ward administrator.',            img: 'https://ui-avatars.com/api/?name=Peter+Kimani&background=2d6a4f&color=fff&size=120' },
        { id: 3, name: 'Sarah Nduati',      party: 'Wiper',       incumbent: false, bio: 'Women rights campaigner.',              img: 'https://ui-avatars.com/api/?name=Sarah+Nduati&background=4361ee&color=fff&size=120' },
        { id: 4, name: 'John Otieno',       party: 'ANC',         incumbent: false, bio: 'Youth empowerment champion.',           img: 'https://ui-avatars.com/api/?name=John+Otieno&background=e63946&color=fff&size=120' },
        { id: 5, name: 'Mary Wambui',       party: 'Ford-K',      incumbent: false, bio: 'Education sector advocate.',            img: 'https://ui-avatars.com/api/?name=Mary+Wambui&background=c9a027&color=fff&size=120' },
        { id: 6, name: 'David Kiprotich',   party: 'Independent', incumbent: false, bio: 'Farmer and entrepreneur.',              img: 'https://ui-avatars.com/api/?name=David+Kiprotich&background=6b7280&color=fff&size=120' }
    ];
}

function isValidCandidateId(candidateId) {
    return Number.isInteger(candidateId) && candidateId >= 0 && candidateId <= 6;
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

/**
 * GET /api/voting-period
 * Current voting period info + whether the authenticated user has voted this cycle.
 */
router.get('/api/voting-period', async (req, res) => {
    try {
        const period = await getCurrentPeriod(req.pool);

        const now              = new Date();
        const endsAt           = new Date(period.period_end);
        const secondsRemaining = Math.max(0, Math.floor((endsAt - now) / 1000));
        const endsInMs         = Math.max(0, endsAt - now);

        // Check if the authenticated user has voted in this cycle
        let userHasVoted = false;
        if (req.session && req.session.userId) {
            userHasVoted = await hasUserVotedInCycle(req.pool, req.session.userId, period.id);
        }

        res.json({
            success: true,
            data: {
                periodId:         period.id,
                startedAt:        period.period_start,
                endsAt:           period.period_end,
                endsIn:           endsInMs,
                secondsRemaining,
                totalVotes:       period.total_votes,
                isActive:         true,
                userHasVoted                        // NEW: frontend can read this
            }
        });

    } catch (error) {
        console.error('Error fetching voting period:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch voting period' });
    }
});


/**
 * GET /api/voting-results
 * Returns CUMULATIVE vote totals across all cycles.
 */
router.get('/api/voting-results', async (req, res) => {
    try {
        const candidates       = getCandidates();
        const cumulativeCounts = await getCumulativeVoteCounts(req.pool);
        const results          = formatCumulativeResults(cumulativeCounts, candidates);
        const totalVotes       = results.reduce((s, r) => s + r.votes, 0);

        // Still expose current period info so the frontend can show cycle context
        const period = await getCurrentPeriod(req.pool);

        res.json({
            success: true,
            data: {
                periodId:    period.id,
                results,
                totalVotes,
                updatedAt:   new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error fetching voting results:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch voting results' });
    }
});


/**
 * GET /api/voting-results/face-off
 * Returns the top two candidates by cumulative votes for the Face-Off section.
 */
router.get('/api/voting-results/face-off', async (req, res) => {
    try {
        const candidates       = getCandidates();
        const cumulativeCounts = await getCumulativeVoteCounts(req.pool);
        const results          = formatCumulativeResults(cumulativeCounts, candidates);
        const totalVotes       = results.reduce((s, r) => s + r.votes, 0);

        const top2 = results.slice(0, 2).map(r => ({
            ...r,
            percentage: totalVotes > 0 ? ((r.votes / totalVotes) * 100).toFixed(1) : '0.0'
        }));

        res.json({ success: true, data: { top2, totalVotes } });

    } catch (error) {
        console.error('Error fetching face-off:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch face-off data' });
    }
});


/**
 * GET /api/my-vote-history
 * Authenticated user's full vote history across all cycles.
 */
router.get('/api/my-vote-history', async (req, res) => {
    // Resolve userId from session cookie
    const cookieHeader = req.headers.cookie || '';
    const match        = cookieHeader.match(/session=([^;]+)/);
    if (!match) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // server.js exposes verifySession globally via req.verifySession or we re-derive:
    // We rely on req.userId being set by a middleware in server.js (see migration notes).
    // Fall back: parse the session here the same way server.js does.
    let userId;
    try {
        const [payloadB64, sig] = match[1].split('.');
        const expected = require('crypto')
            .createHmac('sha256', process.env.SESSION_SECRET)
            .update(payloadB64)
            .digest('base64');
        if (sig !== expected) throw new Error('bad sig');
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
        if (payload.exp < Date.now()) throw new Error('expired');
        userId = payload.userId;
    } catch (_) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session' });
    }

    try {
        const candidates = getCandidates();

        const result = await req.pool.query(`
            SELECT   v.id,
                     v.period_id   AS "cycleId",
                     v.candidate_id,
                     v.timestamp   AS "voteTimestamp",
                     vp.period_start,
                     vp.period_end
            FROM     votes v
            JOIN     voting_periods vp ON vp.id = v.period_id
            WHERE    v.user_id = $1
            ORDER BY v.timestamp DESC
        `, [userId]);

        const history = result.rows.map(row => {
            const candidate = candidates.find(c => c.id === parseInt(row.candidate_id)) || {};
            return {
                voteId:        row.id,
                cycleId:       row.cycleId,
                candidateId:   parseInt(row.candidate_id),
                candidateName: candidate.name  || 'Unknown',
                candidateParty:candidate.party || '',
                voteTimestamp: row.voteTimestamp
                    ? new Date(parseInt(row.voteTimestamp)).toISOString()
                    : null,
                periodStart:   row.period_start,
                periodEnd:     row.period_end
            };
        });

        res.json({
            success: true,
            data: {
                userId,
                totalVotesCast:    history.length,
                cyclesParticipated:[...new Set(history.map(h => h.cycleId))].length,
                history
            }
        });

    } catch (error) {
        console.error('Error fetching vote history:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch vote history' });
    }
});


/**
 * POST /api/vote
 * Submit a vote.
 * Enforces: authenticated, valid candidateId, one vote per user per cycle.
 * Returns cumulative totals so the frontend can update immediately.
 */
router.post('/api/vote', async (req, res) => {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const cookieHeader = req.headers.cookie || '';
    const match        = cookieHeader.match(/session=([^;]+)/);
    if (!match) return res.status(401).json({ success: false, error: 'Please log in to vote.' });

    let userId, userPhone;
    try {
        const [payloadB64, sig] = match[1].split('.');
        const expected = crypto
            .createHmac('sha256', process.env.SESSION_SECRET)
            .update(payloadB64)
            .digest('base64');
        if (sig !== expected) throw new Error('bad sig');
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
        if (payload.exp < Date.now()) throw new Error('expired');
        userId    = payload.userId;
        userPhone = payload.phone;
    } catch (_) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
    }

    const { candidateId, sublocation } = req.body;
    const candId = parseInt(candidateId);

    if (!isValidCandidateId(candId)) {
        return res.status(400).json({ success: false, error: 'Invalid candidate ID.' });
    }

    try {
        // ── Get active period ─────────────────────────────────────────────────
        const period = await getCurrentPeriod(req.pool);

        // ── Cycle-based deduplication (backend guard) ─────────────────────────
        const alreadyVoted = await hasUserVotedInCycle(req.pool, userId, period.id);
        if (alreadyVoted) {
            return res.status(409).json({
                success: false,
                error:   'You have already voted in this cycle. Please wait for the next voting period.'
            });
        }

        // ── Store vote ────────────────────────────────────────────────────────
        const ipHash    = crypto.createHash('md5').update(req.ip || '').digest('hex').slice(0, 16);
        const timestamp = Date.now();

        await req.pool.query(`
            INSERT INTO votes (user_id, candidate_id, period_id, sublocation, ip_hash, timestamp)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [userId, candId, period.id, sublocation || null, ipHash, timestamp]);

        // Update period vote counter
        await req.pool.query(`
            UPDATE voting_periods SET total_votes = total_votes + 1 WHERE id = $1
        `, [period.id]);

        // ── Fetch updated CUMULATIVE totals for immediate card update ─────────
        const candidates       = getCandidates();
        const cumulativeCounts = await getCumulativeVoteCounts(req.pool);
        const totalVotes       = cumulativeCounts.reduce((s, r) => s + parseInt(r.vote_count), 0);

        const votesByCandidate = {};
        cumulativeCounts.forEach(r => {
            votesByCandidate[parseInt(r.candidate_id)] = parseInt(r.vote_count);
        });

        // ── Broadcast to SSE clients ──────────────────────────────────────────
        broadcastVoteUpdate('vote-received', {
            candidateId: candId,
            votes:       votesByCandidate[candId] || 0,
            totalVotes,
            votesByCandidate,
            periodId:    period.id
        });

        return res.json({
            success:          true,
            message:          'Vote recorded successfully.',
            candidateId:      candId,
            totalVotes,
            votesByCandidate,  // full cumulative map so frontend can sync all cards
            periodId:         period.id
        });

    } catch (error) {
        console.error('Error submitting vote:', error);
        return res.status(500).json({ success: false, error: 'Failed to submit vote.' });
    }
});


/**
 * GET /api/votes/stream
 * Server-Sent Events for real-time vote updates.
 */
router.get('/api/votes/stream', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    voteClients.push(res);
    console.log(`Vote SSE client connected. Total: ${voteClients.length}`);

    res.write(`event: connected\ndata: {"message":"Connected to voting updates"}\n\n`);

    const heartbeat = setInterval(() => {
        try { res.write(`: heartbeat\n\n`); } catch (_) {}
    }, 30000);

    req.on('close', () => {
        clearInterval(heartbeat);
        const idx = voteClients.indexOf(res);
        if (idx !== -1) voteClients.splice(idx, 1);
        console.log(`Vote SSE client disconnected. Total: ${voteClients.length}`);
    });
});


/**
 * GET /api/leaderboard
 * Returns CUMULATIVE standings + period archive history.
 */
router.get('/api/leaderboard', async (req, res) => {
    try {
        const candidates       = getCandidates();
        const cumulativeCounts = await getCumulativeVoteCounts(req.pool);
        const results          = formatCumulativeResults(cumulativeCounts, candidates);
        const period           = await getCurrentPeriod(req.pool);

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
        const breakdown = await getVotesBySublocations(req.pool, period.id);

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
 * Admin: POST /api/period/next
 * Close the current period and open a new one.
 */
router.post('/api/period/next', async (req, res) => {
    const adminPassword = req.headers['x-admin-password'];
    if (!adminPassword) {
        return res.status(401).json({ success: false, error: 'Admin password required' });
    }
    const hash = crypto.createHash('sha256').update(adminPassword).digest('hex');
    if (hash.toUpperCase() !== (process.env.ADMIN_PASSWORD_HASH || '').toUpperCase()) {
        return res.status(401).json({ success: false, error: 'Invalid admin password' });
    }

    const { durationMinutes = 5 } = req.body;

    try {
        const currentResult = await req.pool.query(
            `SELECT * FROM voting_periods WHERE is_active = true LIMIT 1`
        );

        let completedPeriodId = null;
        let winner            = null;

        if (currentResult.rows.length > 0) {
            const currentPeriod   = currentResult.rows[0];
            completedPeriodId = currentPeriod.id;

            // Winner for this cycle only (not cumulative — archive records per-cycle winners)
            const cycleCounts = await getVoteCountsForPeriod(req.pool, currentPeriod.id);
            if (cycleCounts.length > 0) {
                winner = {
                    id:    parseInt(cycleCounts[0].candidate_id),
                    votes: parseInt(cycleCounts[0].vote_count)
                };
            }

            await req.pool.query(`
                UPDATE voting_periods
                SET    is_active = false, winner_id = $1, winner_votes = $2
                WHERE  id = $3
            `, [winner?.id ?? null, winner?.votes ?? 0, currentPeriod.id]);

            const breakdown = await getVotesBySublocations(req.pool, currentPeriod.id);
            await req.pool.query(`
                INSERT INTO period_archives (id, period_data)
                VALUES ($1, $2)
                ON CONFLICT (id) DO NOTHING
            `, [
                currentPeriod.id,
                JSON.stringify({
                    ...currentPeriod,
                    winner_id:      winner?.id    ?? null,
                    winner_votes:   winner?.votes ?? 0,
                    total_votes:    currentPeriod.total_votes,
                    vote_breakdown: breakdown
                })
            ]);

            broadcastVoteUpdate('period-ended', {
                period:      completedPeriodId,
                winner:      winner?.id,
                winnerVotes: winner?.votes
            });
        }

        const periodStart = new Date();
        const periodEnd   = new Date(periodStart.getTime() + durationMinutes * 60 * 1000);

        const newResult = await req.pool.query(`
            INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
            VALUES (
                COALESCE((SELECT MAX(id) FROM voting_periods), 0) + 1,
                $1, $2, true, 0
            )
            RETURNING id, period_start, period_end
        `, [periodStart, periodEnd]);

        const newPeriod = newResult.rows[0];

        broadcastVoteUpdate('new-period', {
            period:          newPeriod.id,
            startsAt:        newPeriod.period_start,
            endsAt:          newPeriod.period_end,
            durationMinutes
        });

        console.log(`Period advanced: ${completedPeriodId} → ${newPeriod.id}`);

        res.json({
            success: true,
            message: 'New period started',
            data: {
                newPeriod:       newPeriod.id,
                completedPeriod: completedPeriodId,
                winner,
                endsAt:          newPeriod.period_end
            }
        });

    } catch (error) {
        console.error('Error starting new period:', error);
        res.status(500).json({ success: false, error: 'Failed to start new period' });
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