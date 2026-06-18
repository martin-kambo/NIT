// ============================================
// PHASE 3: ADVANCED LEADERBOARD - BACKEND
// Analytics API Endpoints
// ============================================

const express = require('express');
const crypto = require('crypto');
const analyticsEngine = require('../lib/analytics-engine');
const { getCandidatesByCategory } = require('../lib/candidates');

const router = express.Router();

// ─────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────

/**
 * Get candidate information.
 * Phase 2.6C: this used to be a hardcoded array that NEVER touched the
 * database — a second, permanent source of truth that could silently
 * disagree with whatever the `candidates` table actually said. It now
 * delegates to lib/candidates.js, the single canonical candidate source;
 * the hardcoded data only survives as that module's last-resort fallback.
 */
async function getCandidates(pool) {
    return getCandidatesByCategory(pool, 'MCA');
}

/**
 * Get all period archives
 */
async function getAllPeriodArchives(pool) {
    try {
        const result = await pool.query(`
            SELECT id, period_data, winner_id, winner_votes, total_votes, archived_at
            FROM period_archives
            ORDER BY id DESC
        `);
        return result.rows;
    } catch (error) {
        console.error('Error fetching archives:', error);
        return [];
    }
}

/**
 * Get current period votes by candidate
 */
async function getCurrentPeriodVotes(pool) {
    try {
        const result = await pool.query(`
            SELECT 
                candidate_id,
                COUNT(*) as votes
            FROM votes
            WHERE period_id = (
                SELECT id FROM voting_periods WHERE is_active = true LIMIT 1
            )
            GROUP BY candidate_id
            ORDER BY votes DESC
        `);
        return result.rows;
    } catch (error) {
        console.error('Error fetching current votes:', error);
        return [];
    }
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

/**
 * GET /api/analytics/leaders
 * Advanced leaderboard with all metrics
 */
router.get('/api/analytics/leaders', async (req, res) => {
    try {
        const candidates = await getCandidates(req.pool);
        const currentVotes = await getCurrentPeriodVotes(req.pool);
        const archives = await getAllPeriodArchives(req.pool);

        // Calculate current rankings with metrics
        const totalVotes = currentVotes.reduce((sum, v) => sum + v.votes, 0);
        
        const current = candidates.map(candidate => {
            const vote = currentVotes.find(v => v.candidate_id === candidate.id) || { votes: 0 };
            const stats = analyticsEngine.calculateCandidateStats(candidate.id, archives, currentVotes);

            return {
                rank: 0, // Will be set below
                candidateId: candidate.id,
                name: candidate.name,
                party: candidate.party,
                votes: vote.votes,
                percentage: totalVotes > 0 ? ((vote.votes / totalVotes) * 100).toFixed(1) : 0,
                consistency: stats.consistency,
                growth: stats.growthRate,
                trend: stats.trend,
                winProbability: stats.winProbability,
                totalVotes: stats.totalVotes,
                avgVotes: stats.avgVotes
            };
        }).sort((a, b) => b.votes - a.votes);

        // Add rankings
        current.forEach((c, i) => c.rank = i + 1);

        // Calculate all-time rankings
        const allTime = candidates.map(candidate => {
            const stats = analyticsEngine.calculateCandidateStats(candidate.id, archives, []);
            return {
                candidateId: candidate.id,
                name: candidate.name,
                totalVotes: stats.totalVotes,
                avgVotes: stats.avgVotes,
                wins: stats.wins,
                consistency: stats.consistency
            };
        }).sort((a, b) => b.totalVotes - a.totalVotes);

        allTime.forEach((c, i) => c.rank = i + 1);

        res.json({
            success: true,
            data: {
                current,
                allTime,
                totalVotes,
                periods: archives.length
            }
        });

    } catch (error) {
        console.error('Error fetching leaders:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch leaderboard'
        });
    }
});

/**
 * GET /api/analytics/trends
 * Get trend data for charting
 */
router.get('/api/analytics/trends', async (req, res) => {
    try {
        const candidates = await getCandidates(req.pool);
        const archives = await getAllPeriodArchives(req.pool);

        if (archives.length === 0) {
            return res.json({
                success: true,
                data: { labels: [], datasets: [] }
            });
        }

        const labels = archives.map(a => `Period ${a.id}`);
        
        const datasets = candidates.map((candidate, index) => {
            const colors = [
                '#2563eb', '#dc2626', '#16a34a', '#ea580c',
                '#7c3aed', '#06b6d4', '#f59e0b'
            ];

            const data = archives.map(archive => {
                const periodData = JSON.parse(archive.period_data);
                const voteData = periodData.votes?.find(v => v.candidate_id === candidate.id);
                return voteData?.votes || 0;
            });

            return {
                label: candidate.name,
                data,
                borderColor: colors[index],
                backgroundColor: colors[index] + '20',
                fill: false,
                tension: 0.4
            };
        });

        res.json({
            success: true,
            data: {
                labels,
                datasets
            }
        });

    } catch (error) {
        console.error('Error fetching trends:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch trends'
        });
    }
});

/**
 * GET /api/analytics/candidate/:id
 * Get individual candidate analytics
 */
router.get('/api/analytics/candidate/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const candidateId = parseInt(id);

        if (candidateId < 0 || candidateId > 6) {
            return res.status(400).json({
                success: false,
                error: 'Invalid candidate ID'
            });
        }

        const candidates = await getCandidates(req.pool);
        const candidate = candidates.find(c => c.id === candidateId);
        const archives = await getAllPeriodArchives(req.pool);
        const currentVotes = await getCurrentPeriodVotes(req.pool);

        const stats = analyticsEngine.calculateCandidateStats(candidateId, archives, currentVotes);

        // Build history
        const history = archives.map(archive => {
            const periodData = JSON.parse(archive.period_data);
            const voteData = periodData.votes?.find(v => v.candidate_id === candidateId);
            return {
                period: archive.id,
                votes: voteData?.votes || 0,
                rank: 0 // Will calculate
            };
        });

        // Add current period
        const currentVote = currentVotes.find(v => v.candidate_id === candidateId);
        history.push({
            period: 'current',
            votes: currentVote?.votes || 0,
            rank: 0
        });

        res.json({
            success: true,
            data: {
                candidate,
                stats,
                history
            }
        });

    } catch (error) {
        console.error('Error fetching candidate:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch candidate'
        });
    }
});

/**
 * GET /api/analytics/stats
 * Get overall statistics
 */
router.get('/api/analytics/stats', async (req, res) => {
    try {
        const archives = await getAllPeriodArchives(req.pool);
        const currentVotes = await getCurrentPeriodVotes(req.pool);
        const candidates = await getCandidates(req.pool);

        const totalVotes = currentVotes.reduce((sum, v) => sum + v.votes, 0);

        // Calculate aggregate stats
        let allTimeVotes = 0;
        let allTimePeriods = 0;
        let maxPeriodVotes = 0;
        let minPeriodVotes = Infinity;

        archives.forEach(archive => {
            const periodData = JSON.parse(archive.period_data);
            allTimeVotes += archive.total_votes;
            allTimePeriods++;
            maxPeriodVotes = Math.max(maxPeriodVotes, archive.total_votes);
            minPeriodVotes = Math.min(minPeriodVotes, archive.total_votes);
        });

        // Add current period
        allTimeVotes += totalVotes;

        // Calculate top performers
        const topByVotes = candidates.map(c => {
            const stats = analyticsEngine.calculateCandidateStats(c.id, archives, currentVotes);
            return { ...c, votes: stats.totalVotes };
        }).sort((a, b) => b.votes - a.votes).slice(0, 3);

        const topByConsistency = candidates.map(c => {
            const stats = analyticsEngine.calculateCandidateStats(c.id, archives, currentVotes);
            return { ...c, consistency: stats.consistency };
        }).sort((a, b) => b.consistency - a.consistency).slice(0, 3);

        res.json({
            success: true,
            data: {
                periods: {
                    total: allTimePeriods + 1,
                    completed: allTimePeriods
                },
                votes: {
                    total: allTimeVotes,
                    avgPerPeriod: allTimePeriods > 0 ? Math.round(allTimeVotes / allTimePeriods) : 0,
                    maxPeriod: maxPeriodVotes,
                    minPeriod: minPeriodVotes,
                    current: totalVotes
                },
                topPerformers: topByVotes,
                mostConsistent: topByConsistency
            }
        });

    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch statistics'
        });
    }
});

/**
 * GET /api/analytics/predict
 * Predict next period results
 */
router.get('/api/analytics/predict', async (req, res) => {
    try {
        const candidates = await getCandidates(req.pool);
        const archives = await getAllPeriodArchives(req.pool);

        const predictions = candidates.map(candidate => {
            const forecast = analyticsEngine.predictNextPeriod(candidate.id, archives);
            return {
                candidateId: candidate.id,
                name: candidate.name,
                predictedVotes: forecast.votes,
                confidence: forecast.confidence,
                trend: forecast.trend,
                winProbability: forecast.winProbability
            };
        }).sort((a, b) => b.predictedVotes - a.predictedVotes);

        res.json({
            success: true,
            data: {
                predictions,
                methodology: 'linear_regression_with_trend',
                basedOnPeriods: archives.length
            }
        });

    } catch (error) {
        console.error('Error generating predictions:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate predictions'
        });
    }
});

/**
 * GET /api/analytics/compare?c1=0&c2=1
 * Compare two candidates
 */
router.get('/api/analytics/compare', async (req, res) => {
    try {
        const { c1, c2 } = req.query;

        if (!c1 || !c2) {
            return res.status(400).json({
                success: false,
                error: 'Candidate IDs required (c1 and c2)'
            });
        }

        const id1 = parseInt(c1);
        const id2 = parseInt(c2);

        if (id1 < 0 || id1 > 6 || id2 < 0 || id2 > 6) {
            return res.status(400).json({
                success: false,
                error: 'Invalid candidate IDs'
            });
        }

        const candidates = await getCandidates(req.pool);
        const archives = await getAllPeriodArchives(req.pool);
        const currentVotes = await getCurrentPeriodVotes(req.pool);

        const stats1 = analyticsEngine.calculateCandidateStats(id1, archives, currentVotes);
        const stats2 = analyticsEngine.calculateCandidateStats(id2, archives, currentVotes);

        const candidate1 = candidates.find(c => c.id === id1);
        const candidate2 = candidates.find(c => c.id === id2);

        res.json({
            success: true,
            data: {
                candidate1: { ...candidate1, stats: stats1 },
                candidate2: { ...candidate2, stats: stats2 },
                comparison: {
                    totalVotes: {
                        c1: stats1.totalVotes,
                        c2: stats2.totalVotes,
                        diff: stats1.totalVotes - stats2.totalVotes
                    },
                    avgVotes: {
                        c1: stats1.avgVotes,
                        c2: stats2.avgVotes,
                        diff: (stats1.avgVotes - stats2.avgVotes).toFixed(2)
                    },
                    consistency: {
                        c1: stats1.consistency,
                        c2: stats2.consistency,
                        diff: (stats1.consistency - stats2.consistency).toFixed(1)
                    },
                    wins: {
                        c1: stats1.wins,
                        c2: stats2.wins,
                        diff: stats1.wins - stats2.wins
                    }
                }
            }
        });

    } catch (error) {
        console.error('Error comparing candidates:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to compare candidates'
        });
    }
});

/**
 * POST /api/analytics/export (Admin)
 * Export analytics as CSV or PDF
 */
router.post('/api/analytics/export', async (req, res) => {
    try {
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

        const { format = 'csv' } = req.body;

        if (format === 'csv') {
            const candidates = await getCandidates(req.pool);
            const archives = await getAllPeriodArchives(req.pool);
            const currentVotes = await getCurrentPeriodVotes(req.pool);

            let csv = 'Candidate,Total Votes,Average Votes,Consistency,Trend\n';
            
            candidates.forEach(candidate => {
                const stats = analyticsEngine.calculateCandidateStats(candidate.id, archives, currentVotes);
                csv += `${candidate.name},${stats.totalVotes},${stats.avgVotes.toFixed(2)},${stats.consistency.toFixed(1)},${stats.trend}\n`;
            });

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="analytics-export.csv"');
            res.send(csv);

        } else if (format === 'json') {
            const candidates = await getCandidates(req.pool);
            const archives = await getAllPeriodArchives(req.pool);
            const currentVotes = await getCurrentPeriodVotes(req.pool);

            const data = candidates.map(candidate => {
                const stats = analyticsEngine.calculateCandidateStats(candidate.id, archives, currentVotes);
                return { ...candidate, stats };
            });

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="analytics-export.json"');
            res.json(data);

        } else {
            return res.status(400).json({
                success: false,
                error: 'Unsupported format'
            });
        }

    } catch (error) {
        console.error('Error exporting analytics:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to export analytics'
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
const analyticsRouter = require('./routes/analytics');

// 2. Mount the router (after database setup)
app.use(analyticsRouter);

// 3. Add frontend routes
app.get('/advanced-leaderboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'advanced-leaderboard.html'));
});

app.get('/candidate/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'candidate-profile.html'));
});

app.get('/admin-analytics', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'analytics-dashboard.html'));
});

app.get('/comparison', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'comparison-tool.html'));
});

Now these endpoints will be available:
GET    /api/analytics/leaders
GET    /api/analytics/trends
GET    /api/analytics/candidate/:id
GET    /api/analytics/stats
GET    /api/analytics/predict
GET    /api/analytics/compare
POST   /api/analytics/export (admin)

*/