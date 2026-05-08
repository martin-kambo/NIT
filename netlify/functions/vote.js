// netlify/functions/vote.js
const { getStore } = require('@netlify/blobs');
const store = (name) => getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
const crypto = require('crypto');

function verifySession(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;

  const [payloadBase64, signature] = match[1].split('.');
  const expectedSig = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(payloadBase64)
    .digest('base64');
  if (signature !== expectedSig) return null;

  const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
  if (payload.exp < Date.now()) return null;
  return payload;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Verify session
  const session = verifySession(event.headers.cookie || '');
  if (!session) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { candidateId, periodId } = body;
  if (!candidateId || !periodId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'candidateId and periodId are required' }) };
  }

  const votesStore = store('votes');
  const periodsStore = store('periods');

  // Check current period is still active
  const currentPeriodData = await periodsStore.get('current');
  if (!currentPeriodData) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No active voting period' }) };
  }
  const currentPeriod = JSON.parse(currentPeriodData);
  if (String(currentPeriod.periodId) !== String(periodId)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Voting period has ended' }) };
  }
  if (new Date(currentPeriod.periodEnd) <= new Date()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Voting period has ended' }) };
  }

  // Check if user already voted this period
  const voteKey = `${session.userId}_${periodId}`;
  const existing = await votesStore.get(voteKey);
  if (existing) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Already voted this period' }) };
  }

  // Get user's sublocation
  const usersStore = store('users');
  const userData = await usersStore.get(session.phone);
  const user = userData ? JSON.parse(userData) : null;

  // Hash IP for privacy
  const rawIp = (event.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);

  // Record vote
  const vote = {
    userId: session.userId,
    candidateId,
    periodId,
    sublocation: user?.sublocation || null,
    timestamp: Date.now(),
    ipHash
  };
  await votesStore.set(voteKey, JSON.stringify(vote));

  // Update period aggregates atomically
  currentPeriod.totalVotes = (currentPeriod.totalVotes || 0) + 1;
  currentPeriod.votesByCandidate = currentPeriod.votesByCandidate || {};
  currentPeriod.votesByCandidate[candidateId] = (currentPeriod.votesByCandidate[candidateId] || 0) + 1;
  currentPeriod.votesByUser = currentPeriod.votesByUser || [];
  currentPeriod.votesByUser.push(session.userId);

  if (user?.sublocation) {
    currentPeriod.votesBySublocation = currentPeriod.votesBySublocation || {};
    currentPeriod.votesBySublocation[user.sublocation] =
      (currentPeriod.votesBySublocation[user.sublocation] || 0) + 1;
  }

  // Track first/second/third voters
  if (!currentPeriod.firstVoter) currentPeriod.firstVoter = session.userId;
  else if (!currentPeriod.secondVoter) currentPeriod.secondVoter = session.userId;
  else if (!currentPeriod.thirdVoter) currentPeriod.thirdVoter = session.userId;

  await periodsStore.set('current', JSON.stringify(currentPeriod));

  // Determine badge
  let badge = null;
  if (currentPeriod.firstVoter === session.userId) badge = '1st';
  else if (currentPeriod.secondVoter === session.userId) badge = '2nd';
  else if (currentPeriod.thirdVoter === session.userId) badge = '3rd';

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, badge, totalVotes: currentPeriod.totalVotes })
  };
};