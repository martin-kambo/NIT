// netlify/functions/polling-results.js
exports.handler = async (event) => {
  const store = getStore('current_period');
  const data = await store.get('aggregated');
  
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=5', // 5 second cache
      'CDN-Cache-Control': 'public, max-age=5'
    },
    body: JSON.stringify(data)
  };
};