// netlify/functions/polling-results.js
const { getStore } = require('@netlify/blobs');
const store = (name) => getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const periodsStore = store('periods');
    const metaStore = store('meta');

    const [currentPeriodData, metaData] = await Promise.all([
      periodsStore.get('current'),
      metaStore.get('counters')
    ]);

    const meta = metaData ? JSON.parse(metaData) : {};
    const registeredVoters = meta.registeredVoters || 0;
    const votersBySublocation = meta.votersBySublocation || {};

    if (!currentPeriodData) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=5' },
        body: JSON.stringify({ periodId: null, totalVotes: 0, votesByCandidate: {}, isActive: false, registeredVoters, votersBySublocation })
      };
    }

    const currentPeriod = JSON.parse(currentPeriodData);
    const { votesByUser, ...publicData } = currentPeriod;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=5' },
      body: JSON.stringify({ ...publicData, registeredVoters, votersBySublocation })
    };
  } catch (error) {
    console.error('polling-results error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch results' }) };
  }
};