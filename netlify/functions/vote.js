const { getStore } = require('@netlify/blobs');
const { verifyJWT } = require('./utils/jwt');

exports.handler = async (event) => {
  // Verify authentication
  const token = event.headers.authorization?.split(' ')[1];
  const user = verifyJWT(token);
  if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  
  const { candidateId, periodId } = JSON.parse(event.body);
  
  // Check if user already voted this period
  const store = getStore('votes');
  const existing = await store.get(`${user.id}_${periodId}`);
  if (existing) return { statusCode: 400, body: JSON.stringify({ error: 'Already voted' }) };
  
  // Record vote
  const vote = {
    userId: user.id,
    candidateId,
    periodId,
    sublocation: user.sublocation,
    timestamp: Date.now(),
    ipHash: hashIP(event.headers['x-forwarded-for'])
  };
  
  await store.set(`${user.id}_${periodId}`, JSON.stringify(vote));
  
  // Update candidate running total
  await incrementCandidateVotes(candidateId, periodId);
  
  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};