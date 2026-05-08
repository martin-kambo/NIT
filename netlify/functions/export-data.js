// netlify/functions/export-data.js
// Exports user's personal data (GDPR compliance)

const { getStore } = require('@netlify/blobs');
const store = (name) => getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
const crypto = require('crypto');

function verifySession(cookieHeader) {
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;
  
  const [payloadBase64, signature] = match[1].split('.');
  const expectedSig = crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(payloadBase64)
    .digest('base64');
  
  if (signature !== expectedSig) return null;
  
  const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
  if (payload.exp < Date.now()) return null;
  
  return payload;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Verify session
  const session = verifySession(event.headers.cookie || '');
  if (!session) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const usersStore = store('users');
    const votesStore = store('votes');
    const periodsStore = store('periods');

    // Get user data
    const userData = await usersStore.get(session.phone);
    if (!userData) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
    }

    const user = JSON.parse(userData);
    
    // Remove sensitive data
    const { passwordHash, salt, ...safeUser } = user;

    // Get user's vote history
    const votesList = await votesStore.list();
    const userVotes = [];
    
    for (const { key } of votesList) {
      if (key.includes(session.userId)) {
        const voteData = await votesStore.get(key);
        if (voteData) {
          const vote = JSON.parse(voteData);
          userVotes.push(vote);
        }
      }
    }

    // Get current period info
    let currentPeriod = await periodsStore.get('current');
    currentPeriod = currentPeriod ? JSON.parse(currentPeriod) : null;

    // Build export data
    const exportData = {
      exportedAt: new Date().toISOString(),
      user: safeUser,
      votingHistory: userVotes,
      currentCycle: currentPeriod ? {
        periodId: currentPeriod.periodId,
        periodEnd: currentPeriod.periodEnd,
        hasVoted: currentPeriod.votesByUser?.includes(session.userId) || false
      } : null,
      dataRights: {
        rightToAccess: true,
        rightToRectification: true,
        rightToErasure: true,
        rightToDataPortability: true,
        contactEmail: "dpo@ngolibainfotrack.co.ke"
      }
    };

    // Generate filename
    const filename = `ngoliba_voter_data_${user.voterNumber}_${new Date().toISOString().slice(0,10)}.json`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`
      },
      body: JSON.stringify(exportData, null, 2)
    };

  } catch (error) {
    console.error('export-data error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'Failed to export data' })
    };
  }
};