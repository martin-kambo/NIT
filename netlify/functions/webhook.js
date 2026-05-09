// netlify/functions/webhook.js
// Automatically resets voting period every 5 minutes
const { getStore } = require('@netlify/blobs');
const store = (name) => getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });

const CANDIDATES = [
  { id: 0, name: 'Hon. James Mwangi' },
  { id: 1, name: 'Grace Wanjiku' },
  { id: 2, name: 'Peter Kimani' },
  { id: 3, name: 'Sarah Nduati' },
  { id: 4, name: 'John Otieno' },
  { id: 5, name: 'Mary Wambui' },
  { id: 6, name: 'David Kiprotich' }
];

async function sendSMSToAllVoters(message) {
  if (!process.env.AFRICASTALKING_API_KEY || !process.env.AFRICASTALKING_USERNAME) return;
  try {
    const africastalking = require('africastalking')({
      apiKey: process.env.AFRICASTALKING_API_KEY,
      username: process.env.AFRICASTALKING_USERNAME
    });
    const usersStore = store('users');
    const userList = await usersStore.list();
    const phones = [];
    for (const { key } of userList.blobs) {
      const data = await usersStore.get(key);
      if (data) {
        const user = JSON.parse(data);
        if (user.phone) phones.push(user.phone);
      }
    }
    if (phones.length === 0) return;
    // Africa's Talking supports max 1000 recipients per call
    const chunks = [];
    for (let i = 0; i < phones.length; i += 1000) chunks.push(phones.slice(i, i + 1000));
    for (const chunk of chunks) {
      await africastalking.SMS.send({
        to: chunk,
        message,
        from: process.env.AFRICASTALKING_SENDER_ID || undefined
      });
    }
  } catch (err) {
    console.error('SMS send error:', err);
  }
}

exports.handler = async (event) => {
  const secret = event.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const periodsStore = store('periods');
    const metaStore = store('meta');

    let currentPeriod = await periodsStore.get('current');
    currentPeriod = currentPeriod ? JSON.parse(currentPeriod) : null;

    if (!currentPeriod) {
      const newPeriod = {
        periodId: 1,
        periodStart: new Date().toISOString(),
        periodEnd: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        isActive: true, totalVotes: 0,
        votesByCandidate: {}, votesByUser: [], votesBySublocation: {}
      };
      await periodsStore.set('current', JSON.stringify(newPeriod));
      return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Initial period created' }) };
    }

    if (new Date(currentPeriod.periodEnd) <= new Date()) {
      // Archive completed period
      const archiveKey = `archive_${currentPeriod.periodId}_${Date.now()}`;
      await periodsStore.set(archiveKey, JSON.stringify(currentPeriod));

      // Trim archives to last 30
      const archives = await periodsStore.list();
      const archiveKeys = archives.blobs
        .filter(b => b.key.startsWith('archive_'))
        .sort((a, b) => b.key.localeCompare(a.key));
      for (let i = 30; i < archiveKeys.length; i++) {
        await periodsStore.delete(archiveKeys[i].key);
      }

      // Increment period counter
      let meta = await metaStore.get('counters');
      meta = meta ? JSON.parse(meta) : {};
      const newPeriodId = (meta.lastPeriodId || 0) + 1;

      // Create new period anchored to NOW
      const newPeriod = {
        periodId: newPeriodId,
        periodStart: new Date().toISOString(),
        periodEnd: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        isActive: true, totalVotes: 0,
        votesByCandidate: {}, votesByUser: [], votesBySublocation: {}
      };
      await periodsStore.set('current', JSON.stringify(newPeriod));
      await metaStore.set('counters', JSON.stringify({ ...meta, lastPeriodId: newPeriodId }));

      // Find winner
      let winnerId = null;
      let maxVotes = 0;
      for (const [candidateId, votes] of Object.entries(currentPeriod.votesByCandidate || {})) {
        if (votes > maxVotes) { maxVotes = votes; winnerId = candidateId; }
      }

      // Send SMS to all voters if there was a winner
      if (winnerId !== null && maxVotes > 0) {
        const winnerName = CANDIDATES.find(c => String(c.id) === String(winnerId))?.name || `Candidate ${winnerId}`;
        const msg = `Ngoliba InfoTrack: Cycle ${currentPeriod.periodId} ended. Winner: ${winnerName} with ${maxVotes} vote(s). New cycle started! Vote now at ngolibainfotrack.netlify.app`;
        sendSMSToAllVoters(msg); // fire and forget
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true, message: 'Period reset completed',
          completedPeriod: currentPeriod.periodId, newPeriod: newPeriodId,
          winner: winnerId, totalVotes: currentPeriod.totalVotes
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Period still active', endsAt: currentPeriod.periodEnd })
    };

  } catch (error) {
    console.error('webhook error:', error);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Failed to reset period' }) };
  }
};