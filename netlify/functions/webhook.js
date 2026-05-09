// netlify/functions/webhook.js
// Automatically resets voting period every 5 minutes
// Trigger via Netlify Cron Jobs or external scheduler like cron-job.org

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  // Verify secret key for security
  const secret = event.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const periodsStore = getStore('periods');
    const metaStore = getStore('meta');
    
    // Get current period
    let currentPeriod = await periodsStore.get('current');
    currentPeriod = currentPeriod ? JSON.parse(currentPeriod) : null;
    
    if (!currentPeriod) {
      // Create first period
      const newPeriod = {
        periodId: 1,
        periodStart: new Date().toISOString(),
        periodEnd: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        isActive: true,
        totalVotes: 0,
        votesByCandidate: {},
        votesByUser: [],
        votesBySublocation: {}
      };
      await periodsStore.set('current', JSON.stringify(newPeriod));
      
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Initial period created' })
      };
    }

    // Check if period has ended
    if (new Date(currentPeriod.periodEnd) <= new Date()) {
      // Archive the completed period
      const archiveKey = `archive_${currentPeriod.periodId}_${Date.now()}`;
      await periodsStore.set(archiveKey, JSON.stringify(currentPeriod));
      
      // Keep last 30 periods in archive
      const archives = await periodsStore.list();
      const archiveKeys = archives.blobs
        .filter(b => b.key.startsWith('archive_'))
        .sort((a, b) => b.key.localeCompare(a.key));
      
      // Delete old archives beyond 30
      for (let i = 30; i < archiveKeys.length; i++) {
        await periodsStore.delete(archiveKeys[i].key);
      }

      // Update period counter
      let meta = await metaStore.get('counters');
      meta = meta ? JSON.parse(meta) : { lastPeriodId: 0 };
      const newPeriodId = (meta.lastPeriodId || 0) + 1;
      
      // Create new period
      const newPeriod = {
        periodId: newPeriodId,
        periodStart: new Date().toISOString(),
        periodEnd: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        isActive: true,
        totalVotes: 0,
        votesByCandidate: {},
        votesByUser: [],
        votesBySublocation: {}
      };
      
      await periodsStore.set('current', JSON.stringify(newPeriod));
      await metaStore.set('counters', JSON.stringify({ lastPeriodId: newPeriodId }));
      
      // Calculate winner for notification
      let winnerId = null;
      let maxVotes = 0;
      for (const [candidateId, votes] of Object.entries(currentPeriod.votesByCandidate)) {
        if (votes > maxVotes) {
          maxVotes = votes;
          winnerId = candidateId;
        }
      }
      
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: 'Period reset completed',
          completedPeriod: currentPeriod.periodId,
          newPeriod: newPeriodId,
          winner: winnerId,
          totalVotes: currentPeriod.totalVotes
        })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Period still active', endsAt: currentPeriod.periodEnd })
    };

  } catch (error) {
    console.error('webhook error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'Failed to reset period' })
    };
  }
};