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

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

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