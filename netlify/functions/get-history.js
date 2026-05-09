// netlify/functions/get-history.js
// Returns last N archived voting periods for historical chart
const { getStore } = require('@netlify/blobs');
const store = (name) => getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const periodsStore = store('periods');
    const limit = Math.min(parseInt(event.queryStringParameters?.limit || '10'), 30);

    const archives = await periodsStore.list();
    const archiveKeys = archives.blobs
      .filter(b => b.key.startsWith('archive_'))
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, limit);

    const periods = await Promise.all(
      archiveKeys.map(async ({ key }) => {
        const data = await periodsStore.get(key);
        if (!data) return null;
        const period = JSON.parse(data);
        const { votesByUser, ...publicPeriod } = period;
        return publicPeriod;
      })
    );

    const validPeriods = periods.filter(Boolean).reverse(); // oldest first for chart

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
      body: JSON.stringify({ success: true, periods: validPeriods })
    };
  } catch (error) {
    console.error('get-history error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch history' }) };
  }
};