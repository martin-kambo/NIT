// ============================================
// PHASE 2: VOTING SYSTEM - BACKEND
// Production-ready Voting API endpoints
// ============================================

const express = require('express');
const crypto = require('crypto');

const router = express.Router();

// ─────────────────────────────────────────
// SSE CLIENTS REGISTRY FOR VOTE UPDATES
// ─────────────────────────────────────────

let voteClients = [];

function broadcastVoteUpdate(eventType, data) {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    
    voteClients.forEach((res, index) => {
        res.write(message);
        
        res.on('error', () => {
            voteClients.splice(index, 1);
        });
    });
}

// ─────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────

/**
 * Get or create current voting period
 */
async function getCurrentPeriod(pool) {
    try {
        // Check if active period exists
        let result = await pool.query(`
            SELECT id, period_start, period_end, total_votes 
            FROM voting_periods 
            WHERE is_active = true 
            LIMIT 1
        `);

        if (result.rows.length > 0) {
            return result.rows[0];
        }

        // No active period, create one
        const periodStart = new Date();
        const periodEnd = new Date(periodStart.getTime() + 5 * 60 * 1000); // 5 minutes

        result = await pool.query(`
            INSERT INTO voting_periods (period_start, period_end, is_active, total_votes)
            VALUES ($1, $2, true, 0)
            RETURNING id, period_start, period_end, total_votes
        `, [periodStart, periodEnd]);

        return result.rows[0];

    } catch (error) {
        console.error('Error getting current period:', error);
        throw error;
    }
}

/**
 * Calculate vote counts for all candidates in period
 */
async function getVoteCounts(pool, periodId) {
    try {
        const result = await pool.query(`
            SELECT 
                candidate_id,
                COUNT(*) as vote_count
            FROM votes
            WHERE period_id = $1
            GROUP BY candidate_id
            ORDER BY vote_count DESC
        `, [periodId]);

        return result.rows;

    } catch (error) {
        console.error('Error calculating votes:', error);
        throw error;
    }
}

/**
 * Get vote counts by sublocation
 */
async function getVotesBySublocations(pool, periodId) {
    try {
        const result = await pool.query(`
            SELECT 
                sublocation,
                candidate_id,
                COUNT(*) as vote_count
            FROM votes
            WHERE period_id = $1 AND sublocation IS NOT NULL
            GROUP BY sublocation, candidate_id
            ORDER BY sublocation, vote_count DESC
        `, [periodId]);

        // Transform to nested object
        const breakdown = {};
        result.rows.forEach(row => {
            if (!breakdown[row.sublocation]) {
                breakdown[row.sublocation] = [];
            }
            breakdown[row.sublocation].push({
                candidateId: row.candidate_id,
                votes: parseInt(row.vote_count)
            });
        });

        return breakdown;

    } catch (error) {
        console.error('Error getting votes by sublocation:', error);
        throw error;
    }
}

/**
 * Format vote results with candidate information
 */
function formatVoteResults(voteCounts, candidates) {
    return voteCounts.map(row => {
        const candidate = candidates.find(c => c.id === row.candidate_id) || {};
        return {
            candidateId: row.candidate_id,
            name: candidate.name || 'Unknown',
            party: candidate.party,
            votes: parseInt(row.vote_count),
            percentage: 0 // Will be calculated by frontend
        };
    });
}

/**
 * Get candidate list
 */
function getCandidates() {
    return [
        { id: 0, name: 'Hon. James Mwangi', party: 'UDA', incumbent: true },
        { id: 1, name: 'Grace Wanjiku', party: 'Independent' },
        { id: 2, name: 'Peter Kimani', party: 'Jubilee' },
        { id: 3, name: 'Sarah Nduati', party: 'Wiper' },
        { id: 4, name: 'John Otieno', party: 'Independent' },
        { id: 5, name: 'Mary Wambui', party: 'Maendeleo' },
        { id: 6, name: 'David Kiprotich', party: 'Roots' }
    ];
}

/**
 * Validate candidate ID
 */
function isValidCandidateId(candidateId) {
    return Number.isInteger(candidateId) && candidateId >= 0 && candidateId <= 6;
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

/**
 * GET /api/voting-period
 * Get current voting period information
 */
router.get('/api/voting-period', async (req, res) => {
    try {
        const period = await getCurrentPeriod(req.pool);
        
        const now = new Date();
        const endsAt = new Date(period.period_end);
        const secondsRemaining = Math.max(0, Math.floor((endsAt - now) / 1000));
        const endsInMs = Math.max(0, endsAt - now);

        res.json({
            success: true,
            data: {
                periodId: period.id,
                startedAt: period.period_start,
                endsAt: period.period_end,
                endsIn: endsInMs,
                secondsRemaining,
                totalVotes: period.total_votes,
                isActive: true
            }
        });

    } catch (error) {
        console.error('Error fetching voting period:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch voting period'
        });
    }
});

/**
 * POST /api/vote
 * Submit a vote for a candidate
 */
router.post('/api/vote', async (req, res) => {
    try {
        const { candidateId, sublocation } = req.body;
        const userId = req.user?.id || req.headers['x-user-id'];

        // Validation
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID required (login first)'
            });
        }

        if (!isValidCandidateId(candidateId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid candidate ID'
            });
        }

        // Get current period
        const period = await getCurrentPeriod(req.pool);
        
        // Check if period is still active
        const now = new Date();
        if (new Date(period.period_end) <= now) {
            return res.status(400).json({
                success: false,
                error: 'Voting period has ended'
            });
        }

        // Check if user already voted in this period
        const checkVote = await req.pool.query(`
            SELECT id FROM votes 
            WHERE user_id = $1 AND period_id = $2
        `, [userId, period.id]);

        if (checkVote.rows.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'You have already voted in this period'
            });
        }

        // Record vote
        const ipHash = crypto
            .createHash('sha256')
            .update(req.ip + process.env.SESSION_SECRET)
            .digest('hex')
            .substring(0, 16);

        const result = await req.pool.query(`
            INSERT INTO votes (user_id, candidate_id, period_id, sublocation, ip_hash, timestamp)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, created_at
        `, [userId, candidateId, period.id, sublocation || null, ipHash, Date.now()]);

        // Update period vote count
        await req.pool.query(`
            UPDATE voting_periods 
            SET total_votes = total_votes + 1 
            WHERE id = $1
        `, [period.id]);

        // Get updated vote counts
        const voteCounts = await getVoteCounts(req.pool, period.id);
        const totalVotes = voteCounts.reduce((sum, row) => sum + parseInt(row.vote_count), 0);

        // Broadcast to all connected clients
        broadcastVoteUpdate('vote-received', {
            candidateId,
            votes: voteCounts.find(v => v.candidate_id === candidateId)?.vote_count || 0,
            totalVotes: totalVotes
        });

        console.log(`Vote recorded: user=${userId}, candidate=${candidateId}, period=${period.id}`);

        res.status(201).json({
            success: true,
            message: 'Vote recorded successfully',
            data: {
                voteId: result.rows[0].id,
                candidateId,
                periodId: period.id,
                createdAt: result.rows[0].created_at
            }
        });

    } catch (error) {
        console.error('Error recording vote:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to record vote'
        });
    }
});

/**
 * GET /api/voting-results
 * Get current vote counts for all candidates
 */
router.get('/api/voting-results', async (req, res) => {
    try {
        const period = await getCurrentPeriod(req.pool);
        const voteCounts = await getVoteCounts(req.pool, period.id);
        const candidates = getCandidates();

        const totalVotes = voteCounts.reduce((sum, row) => sum + parseInt(row.vote_count), 0);

        const results = voteCounts.map(row => {
            const candidate = candidates.find(c => c.id === row.candidate_id) || {};
            return {
                candidateId: row.candidate_id,
                name: candidate.name || 'Unknown',
                party: candidate.party,
                votes: parseInt(row.vote_count),
                percentage: totalVotes > 0 ? ((parseInt(row.vote_count) / totalVotes) * 100).toFixed(1) : 0
            };
        });

        res.json({
            success: true,
            data: {
                periodId: period.id,
                results,
                totalVotes,
                updatedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error fetching voting results:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch voting results'
        });
    }
});

/**
 * GET /api/votes/stream
 * Server-Sent Events stream for real-time vote updates
 */
router.get('/api/votes/stream', (req, res) => {
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Add client to active clients
    voteClients.push(res);
    const clientIndex = voteClients.length - 1;

    console.log(`Vote SSE client connected. Total: ${voteClients.length}`);

    // Send initial connection message
    res.write(`event: connected\ndata: {"message": "Connected to voting updates"}\n\n`);

    // Handle disconnect
    req.on('close', () => {
        voteClients.splice(clientIndex, 1);
        console.log(`Vote SSE client disconnected. Total: ${voteClients.length}`);
    });

    // Keep-alive heartbeat
    const heartbeat = setInterval(() => {
        res.write(`: heartbeat\n\n`);
    }, 30000);

    res.on('close', () => {
        clearInterval(heartbeat);
    });
});

/**
 * GET /api/leaderboard
 * Get vote standings (current and historical)
 */
router.get('/api/leaderboard', async (req, res) => {
    try {
        const candidates = getCandidates();

        // Get current period results
        const period = await getCurrentPeriod(req.pool);
        const voteCounts = await getVoteCounts(req.pool, period.id);
        
        const totalVotes = voteCounts.reduce((sum, row) => sum + parseInt(row.vote_count), 0);
        
        const current = voteCounts.map(row => {
            const candidate = candidates.find(c => c.id === row.candidate_id) || {};
            return {
                candidateId: row.candidate_id,
                name: candidate.name,
                votes: parseInt(row.vote_count),
                percentage: totalVotes > 0 ? ((parseInt(row.vote_count) / totalVotes) * 100).toFixed(1) : 0
            };
        });

        // Get previous period winners
        const archiveResult = await req.pool.query(`
            SELECT id, period_data->>'winner_id' as winner_id, 
                   period_data->>'winner_votes' as winner_votes
            FROM period_archives
            ORDER BY id DESC
            LIMIT 5
        `);

        const previous = archiveResult.rows.map(row => {
            const winnerData = row.period_data ? JSON.parse(row.period_data) : {};
            const winner = candidates.find(c => c.id === parseInt(row.winner_id));
            return {
                period: row.id,
                winner: winner?.name || 'Unknown',
                winnerId: row.winner_id,
                votes: parseInt(row.winner_votes || 0)
            };
        });

        res.json({
            success: true,
            data: {
                current: {
                    period: period.id,
                    results: current
                },
                previous
            }
        });

    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch leaderboard'
        });
    }
});

/**
 * GET /api/voting-results/by-sublocation
 * Get vote breakdown by sublocation
 */
router.get('/api/voting-results/by-sublocation', async (req, res) => {
    try {
        const period = await getCurrentPeriod(req.pool);
        const breakdown = await getVotesBySublocations(req.pool, period.id);

        res.json({
            success: true,
            data: {
                periodId: period.id,
                bySublocations: breakdown
            }
        });

    } catch (error) {
        console.error('Error fetching sublocation breakdown:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch sublocation breakdown'
        });
    }
});

/**
 * GET /api/candidates
 * Get list of candidates
 */
router.get('/api/candidates', (req, res) => {
    res.json({
        success: true,
        data: {
            candidates: getCandidates()
        }
    });
});

/**
 * Admin: POST /api/period/next
 * Manually start next voting period
 */
router.post('/api/period/next', async (req, res) => {
    try {
        // Check admin auth
        const adminPassword = req.headers['x-admin-password'];
        if (!adminPassword) {
            return res.status(401).json({
                success: false,
                error: 'Admin password required'
            });
        }

        const hash = crypto.createHash('sha256').update(adminPassword).digest('hex');
        if (hash.toUpperCase() !== (process.env.ADMIN_PASSWORD_HASH || '').toUpperCase()) {
            return res.status(401).json({
                success: false,
                error: 'Invalid admin password'
            });
        }

        const { durationMinutes = 5 } = req.body;

        // Get current period
        const currentResult = await req.pool.query(`
            SELECT * FROM voting_periods WHERE is_active = true LIMIT 1
        `);

        let completedPeriodId = null;
        let winner = null;

        if (currentResult.rows.length > 0) {
            const currentPeriod = currentResult.rows[0];
            completedPeriodId = currentPeriod.id;

            // Calculate winner
            const voteCounts = await getVoteCounts(req.pool, currentPeriod.id);
            if (voteCounts.length > 0) {
                winner = {
                    id: voteCounts[0].candidate_id,
                    votes: parseInt(voteCounts[0].vote_count)
                };
            }

            // Mark current period as inactive
            await req.pool.query(`
                UPDATE voting_periods 
                SET is_active = false, winner_id = $1, winner_votes = $2
                WHERE id = $3
            `, [winner?.id || null, winner?.votes || 0, currentPeriod.id]);

            // Archive period
            const breakdown = await getVotesBySublocations(req.pool, currentPeriod.id);
            await req.pool.query(`
                INSERT INTO period_archives (id, period_data, winner_id, winner_votes, total_votes, vote_breakdown)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO NOTHING
            `, [
                currentPeriod.id,
                JSON.stringify(currentPeriod),
                winner?.id,
                winner?.votes,
                currentPeriod.total_votes,
                JSON.stringify(breakdown)
            ]);

            // Broadcast period ended
            broadcastVoteUpdate('period-ended', {
                period: completedPeriodId,
                winner: winner?.id,
                winnerVotes: winner?.votes
            });
        }

        // Create new period
        const periodStart = new Date();
        const periodEnd = new Date(periodStart.getTime() + durationMinutes * 60 * 1000);

        const newResult = await req.pool.query(`
            INSERT INTO voting_periods (period_start, period_end, is_active, total_votes)
            VALUES ($1, $2, true, 0)
            RETURNING id, period_start, period_end
        `, [periodStart, periodEnd]);

        const newPeriod = newResult.rows[0];

        // Broadcast new period
        broadcastVoteUpdate('new-period', {
            period: newPeriod.id,
            startsAt: newPeriod.period_start,
            endsAt: newPeriod.period_end,
            durationMinutes
        });

        console.log(`Period advanced: ${completedPeriodId} → ${newPeriod.id}, winner: ${winner?.id}`);

        res.json({
            success: true,
            message: 'New period started',
            data: {
                newPeriod: newPeriod.id,
                completedPeriod: completedPeriodId,
                winner,
                endsAt: newPeriod.period_end
            }
        });

    } catch (error) {
        console.error('Error starting new period:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start new period'
        });
    }
});

/**
 * Admin: DELETE /api/vote/:id
 * Remove a vote (invalidate it)
 */
router.delete('/api/vote/:id', async (req, res) => {
    try {
        // Check admin auth
        const adminPassword = req.headers['x-admin-password'];
        if (!adminPassword) {
            return res.status(401).json({
                success: false,
                error: 'Admin password required'
            });
        }

        const hash = crypto.createHash('sha256').update(adminPassword).digest('hex');
        if (hash.toUpperCase() !== (process.env.ADMIN_PASSWORD_HASH || '').toUpperCase()) {
            return res.status(401).json({
                success: false,
                error: 'Invalid admin password'
            });
        }

        const { id } = req.params;

        // Get vote details
        const voteResult = await req.pool.query(`
            SELECT period_id, candidate_id FROM votes WHERE id = $1
        `, [id]);

        if (voteResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Vote not found'
            });
        }

        const { period_id, candidate_id } = voteResult.rows[0];

        // Delete vote
        await req.pool.query('DELETE FROM votes WHERE id = $1', [id]);

        // Update period count
        await req.pool.query(`
            UPDATE voting_periods 
            SET total_votes = total_votes - 1 
            WHERE id = $1
        `, [period_id]);

        console.log(`Vote deleted: ${id} (candidate ${candidate_id})`);

        res.json({
            success: true,
            message: 'Vote removed successfully'
        });

    } catch (error) {
        console.error('Error deleting vote:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete vote'
        });
    }
});

/**
 * Admin: GET /api/admin/votes
 * Get all votes for current period (admin view)
 */
router.get('/api/admin/votes', async (req, res) => {
    try {
        // Check admin auth
        const adminPassword = req.headers['x-admin-password'];
        if (!adminPassword) {
            return res.status(401).json({
                success: false,
                error: 'Admin password required'
            });
        }

        const hash = crypto.createHash('sha256').update(adminPassword).digest('hex');
        if (hash.toUpperCase() !== (process.env.ADMIN_PASSWORD_HASH || '').toUpperCase()) {
            return res.status(401).json({
                success: false,
                error: 'Invalid admin password'
            });
        }

        const period = await getCurrentPeriod(req.pool);

        const result = await req.pool.query(`
            SELECT 
                id,
                user_id,
                candidate_id,
                sublocation,
                created_at
            FROM votes
            WHERE period_id = $1
            ORDER BY created_at DESC
            LIMIT 100
        `, [period.id]);

        res.json({
            success: true,
            data: {
                periodId: period.id,
                votes: result.rows,
                total: result.rows.length
            }
        });

    } catch (error) {
        console.error('Error fetching admin votes:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch votes'
        });
    }
});

module.exports = router;

// ============================================
// HOW TO INTEGRATE INTO SERVER.JS
// ============================================

/*

In your server.js, add:

// 1. Import the router
const votingRouter = require('./routes/voting');

// 2. Mount the router (after database setup)
app.use(votingRouter);

// Now these endpoints will be available:
// GET    /api/voting-period
// POST   /api/vote
// GET    /api/voting-results
// GET    /api/votes/stream
// GET    /api/leaderboard
// GET    /api/voting-results/by-sublocation
// GET    /api/candidates
// POST   /api/period/next (admin)
// DELETE /api/vote/:id (admin)

*/

// ============================================
// TESTING WITH CURL
// ============================================

/*

# Get current period
curl http://localhost:3000/api/voting-period

# Submit a vote
curl -X POST http://localhost:3000/api/vote \
  -H "Content-Type: application/json" \
  -H "x-user-id: user-uuid-here" \
  -d '{"candidateId": 0, "sublocation": "Ngoliba"}'

# Get voting results
curl http://localhost:3000/api/voting-results

# Get leaderboard
curl http://localhost:3000/api/leaderboard

# Get by sublocation
curl http://localhost:3000/api/voting-results/by-sublocation

# Get candidates
curl http://localhost:3000/api/candidates

# Stream real-time updates
curl http://localhost:3000/api/votes/stream

# Admin: Start next period
curl -X POST http://localhost:3000/api/period/next \
  -H "x-admin-password: your_password" \
  -d '{"durationMinutes": 5}'

# Admin: Delete vote
curl -X DELETE http://localhost:3000/api/vote/vote-uuid-here \
  -H "x-admin-password: your_password"

*/
