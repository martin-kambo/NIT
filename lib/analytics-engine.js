// ============================================
// PHASE 3: ANALYTICS ENGINE
// Statistical Calculations & Predictions
// ============================================

/**
 * Read a single candidate's total votes out of one archived period.
 *
 * IMPORTANT — archive.period_data shape (written by lib/period-engine.js):
 *   { ...period, winner_id, winner_votes, total_votes,
 *     vote_breakdown: { [sublocation]: [{ candidateId, votes }] } }
 * There is no flat `votes` array and no `candidate_id` (snake_case) field —
 * every function below used to look for both and silently got nothing.
 *
 * Also: archive.period_data comes from a JSONB column. node-postgres (pg)
 * already parses JSON/JSONB columns into a JS object before this code ever
 * sees them, so calling JSON.parse() on it again throws (it coerces the
 * object to the string "[object Object]" first). Every function below used
 * to do that too, which is why the try/catch always landed on the
 * zero-value fallback for any period that had ever actually been archived.
 */
function getCandidateVotesFromArchive(periodData, candidateId) {
    if (!periodData || !periodData.vote_breakdown) return 0;
    let total = 0;
    Object.values(periodData.vote_breakdown).forEach(entries => {
        const match = entries.find(e => e.candidateId === candidateId);
        if (match) total += match.votes;
    });
    return total;
}

/**
 * Read per-candidate vote totals for ALL candidates out of one archived
 * period (sums vote_breakdown across sublocations, grouped by candidateId).
 */
function getAllCandidateTotalsFromArchive(periodData) {
    const totals = {};
    if (!periodData || !periodData.vote_breakdown) return totals;
    Object.values(periodData.vote_breakdown).forEach(entries => {
        entries.forEach(e => {
            totals[e.candidateId] = (totals[e.candidateId] || 0) + e.votes;
        });
    });
    return totals;
}

/**
 * Calculate candidate statistics from historical data
 */
function calculateCandidateStats(candidateId, archives, currentVotes) {
    try {
        // Collect all votes for this candidate
        const voteHistory = [];

        // From archives
        archives.forEach(archive => {
            // archive.period_data is already a parsed object (JSONB) — see
            // getCandidateVotesFromArchive's doc comment above.
            voteHistory.push(getCandidateVotesFromArchive(archive.period_data, candidateId));
        });

        // Add current if exists
        const currentVote = currentVotes.find(v => v.candidate_id === candidateId);
        if (currentVote) {
            voteHistory.push(currentVote.votes);
        }

        // If no data
        if (voteHistory.length === 0) {
            return {
                totalVotes: 0,
                avgVotes: 0,
                maxVotes: 0,
                minVotes: 0,
                wins: 0,
                consistency: 0,
                trend: 'stable',
                growthRate: 0,
                winProbability: 0
            };
        }

        // Calculate basic stats
        const totalVotes = voteHistory.reduce((a, b) => a + b, 0);
        const avgVotes = totalVotes / voteHistory.length;
        const maxVotes = Math.max(...voteHistory);
        const minVotes = Math.min(...voteHistory);

        // Count wins (periods where candidate had highest votes)
        let wins = 0;
        archives.forEach(archive => {
            if (archive.winner_id === candidateId) {
                wins++;
            }
        });

        // Calculate consistency score
        const consistency = calculateConsistencyScore(voteHistory);

        // Calculate growth rate
        const growthRate = calculateGrowthRate(voteHistory);

        // Determine trend
        const trend = determineTrend(growthRate);

        // Calculate win probability for next period
        const winProbability = calculateWinProbability(voteHistory);

        return {
            totalVotes,
            avgVotes: parseFloat(avgVotes.toFixed(2)),
            maxVotes,
            minVotes,
            wins,
            consistency: parseFloat(consistency.toFixed(1)),
            trend,
            growthRate: parseFloat(growthRate.toFixed(1)),
            winProbability: parseFloat(winProbability.toFixed(2))
        };

    } catch (error) {
        console.error('Error calculating stats:', error);
        return {
            totalVotes: 0,
            avgVotes: 0,
            maxVotes: 0,
            minVotes: 0,
            wins: 0,
            consistency: 0,
            trend: 'stable',
            growthRate: 0,
            winProbability: 0
        };
    }
}

/**
 * Calculate consistency score (0-100)
 * Higher = more consistent
 */
function calculateConsistencyScore(votes) {
    if (votes.length <= 1) return 100;

    // Calculate mean
    const mean = votes.reduce((a, b) => a + b, 0) / votes.length;

    // Calculate standard deviation
    const variance = votes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / votes.length;
    const stdDev = Math.sqrt(variance);

    // Consistency = 100 - (coefficient of variation * 100)
    const cv = stdDev / mean;
    const consistency = 100 - (cv * 100);

    return Math.max(0, Math.min(100, consistency));
}

/**
 * Calculate growth rate (percent)
 */
function calculateGrowthRate(votes) {
    if (votes.length < 2) return 0;

    const previous = votes[votes.length - 2];
    const current = votes[votes.length - 1];

    if (previous === 0) return 0;

    return ((current - previous) / previous) * 100;
}

/**
 * Determine trend direction
 */
function determineTrend(growthRate) {
    if (growthRate > 5) return 'up';
    if (growthRate < -5) return 'down';
    return 'stable';
}

/**
 * Calculate win probability (0-1)
 * Uses linear regression prediction
 */
function calculateWinProbability(votes) {
    if (votes.length === 0) return 0;

    // Linear regression to predict next value
    const n = votes.length;
    const x = Array.from({ length: n }, (_, i) => i + 1);
    const y = votes;

    // Calculate sums
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);

    // Calculate slope
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // Predict next value
    const nextX = n + 1;
    const intercept = (sumY - slope * sumX) / n;
    const predictedVotes = intercept + slope * nextX;

    // Calculate average
    const avgVotes = sumY / n;

    // Win probability based on prediction vs average
    // If predicted is significantly above average, higher probability
    const ratio = predictedVotes / avgVotes;

    return Math.max(0, Math.min(1, ratio / 2)); // Normalize to 0-1
}

/**
 * Predict next period results
 */
function predictNextPeriod(candidateId, archives) {
    try {
        // Collect vote history
        const voteHistory = [];

        archives.forEach(archive => {
            voteHistory.push(getCandidateVotesFromArchive(archive.period_data, candidateId));
        });

        if (voteHistory.length === 0) {
            return {
                votes: 0,
                confidence: 0,
                trend: 'stable',
                winProbability: 0
            };
        }

        // Use linear regression
        const n = voteHistory.length;
        const x = Array.from({ length: n }, (_, i) => i + 1);
        const y = voteHistory;

        // Calculate regression
        const sumX = x.reduce((a, b) => a + b, 0);
        const sumY = y.reduce((a, b) => a + b, 0);
        const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
        const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;

        // Predict next period
        const nextX = n + 1;
        const predictedVotes = Math.round(intercept + slope * nextX);

        // Calculate R-squared for confidence
        const yMean = sumY / n;
        const ssRes = y.reduce((sum, yi) => {
            const predicted = intercept + slope * (y.indexOf(yi) + 1);
            return sum + Math.pow(yi - predicted, 2);
        }, 0);
        const ssTot = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
        const rSquared = ssTot === 0 ? 0 : 1 - (ssRes / ssTot);
        const confidence = Math.round(rSquared * 100);

        // Trend
        const trend = slope > 0.5 ? 'up' : slope < -0.5 ? 'down' : 'stable';

        // Win probability
        const avgVotes = sumY / n;
        const ratio = Math.max(0, predictedVotes / avgVotes);
        const winProbability = Math.min(1, ratio / 2);

        return {
            votes: Math.max(0, predictedVotes),
            confidence: Math.max(0, Math.min(100, confidence)),
            trend,
            winProbability: parseFloat(winProbability.toFixed(2))
        };

    } catch (error) {
        console.error('Error predicting:', error);
        return {
            votes: 0,
            confidence: 0,
            trend: 'stable',
            winProbability: 0
        };
    }
}

/**
 * Detect anomalies in voting pattern
 */
function detectAnomalies(candidateId, archives) {
    try {
        const voteHistory = [];

        archives.forEach(archive => {
            voteHistory.push(getCandidateVotesFromArchive(archive.period_data, candidateId));
        });

        if (voteHistory.length < 3) return [];

        // Calculate mean and std dev
        const mean = voteHistory.reduce((a, b) => a + b, 0) / voteHistory.length;
        const variance = voteHistory.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / voteHistory.length;
        const stdDev = Math.sqrt(variance);

        // Find anomalies (values beyond 2 standard deviations)
        const anomalies = [];
        voteHistory.forEach((vote, index) => {
            const zScore = Math.abs((vote - mean) / stdDev);
            if (zScore > 2) {
                anomalies.push({
                    period: index,
                    votes: vote,
                    zScore: parseFloat(zScore.toFixed(2))
                });
            }
        });

        return anomalies;

    } catch (error) {
        console.error('Error detecting anomalies:', error);
        return [];
    }
}

/**
 * Calculate period statistics
 */
function calculatePeriodStats(archive) {
    try {
        // archive.period_data is already a parsed object (JSONB) — see
        // getCandidateVotesFromArchive's doc comment above. Aggregate
        // vote_breakdown into one total per candidate for this period.
        const candidateTotals = getAllCandidateTotalsFromArchive(archive.period_data);
        const voteValues = Object.values(candidateTotals);

        if (voteValues.length === 0) {
            return {
                totalVotes: 0,
                avgVotes: 0,
                maxVotes: 0,
                minVotes: 0,
                stdDev: 0
            };
        }

        const totalVotes = voteValues.reduce((a, b) => a + b, 0);
        const avgVotes = totalVotes / voteValues.length;
        const maxVotes = Math.max(...voteValues);
        const minVotes = Math.min(...voteValues);

        // Calculate standard deviation
        const variance = voteValues.reduce((sum, v) => sum + Math.pow(v - avgVotes, 2), 0) / voteValues.length;
        const stdDev = Math.sqrt(variance);

        return {
            totalVotes,
            avgVotes: parseFloat(avgVotes.toFixed(2)),
            maxVotes,
            minVotes,
            stdDev: parseFloat(stdDev.toFixed(2))
        };

    } catch (error) {
        console.error('Error calculating period stats:', error);
        return {
            totalVotes: 0,
            avgVotes: 0,
            maxVotes: 0,
            minVotes: 0,
            stdDev: 0
        };
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    getCandidateVotesFromArchive,
    getAllCandidateTotalsFromArchive,
    calculateCandidateStats,
    calculateConsistencyScore,
    calculateGrowthRate,
    determineTrend,
    calculateWinProbability,
    predictNextPeriod,
    detectAnomalies,
    calculatePeriodStats
};
