// netlify/functions/polling-results.js
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const periodsStore = getStore('periods');
    const currentPeriodData = await periodsStore.get('current');

    if (!currentPeriodData) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=5',
          'CDN-Cache-Control': 'public, max-age=5'
        },
        body: JSON.stringify({ periodId: null, totalVotes: 0, votesByCandidate: {}, isActive: false })
      };
    }

    const currentPeriod = JSON.parse(currentPeriodData);

    // Return only aggregate/public data — no voter IDs
    const { votesByUser, ...publicData } = currentPeriod;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=5',
        'CDN-Cache-Control': 'public, max-age=5'
      },
      body: JSON.stringify(publicData)
    };
  } catch (error) {
    console.error('polling-results error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch results' }) };
  }
};