// netlify/functions/admin.js
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');
const store = (name) => getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });

function verifyAdminToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  try {
    const [payloadB64, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest('base64');
    if (sig !== expected) return false;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    if (payload.role !== 'admin') return false;
    if (payload.exp < Date.now()) return false;
    return true;
  } catch { return false; }
}

function createAdminToken() {
  const payload = { role: 'admin', exp: Date.now() + 4 * 60 * 60 * 1000 }; // 4hr session
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest('base64');
  return `${payloadB64}.${sig}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action } = body;

  // ── ADMIN LOGIN (no auth required) ──
  if (action === 'admin_login') {
    const { password } = body;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;
    const inputHash = crypto.createHash('sha256').update(password || '').digest('hex');
    if (!adminHash || inputHash !== adminHash) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid admin password' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, token: createAdminToken() }) };
  }

  // ── ALL OTHER ACTIONS REQUIRE ADMIN TOKEN ──
  if (!verifyAdminToken(event.headers.authorization)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const periodsStore = store('periods');
    const metaStore = store('meta');
    const usersStore = store('users');

    // ── GET DASHBOARD STATS ──
    if (action === 'get_stats') {
      const [currentPeriodData, metaData, userList, archives] = await Promise.all([
        periodsStore.get('current'),
        metaStore.get('counters'),
        usersStore.list(),
        periodsStore.list()
      ]);

      const currentPeriod = currentPeriodData ? JSON.parse(currentPeriodData) : null;
      const meta = metaData ? JSON.parse(metaData) : {};

      const archiveKeys = archives.blobs
        .filter(b => b.key.startsWith('archive_'))
        .sort((a, b) => b.key.localeCompare(a.key))
        .slice(0, 10);

      const recentPeriods = await Promise.all(
        archiveKeys.map(async ({ key }) => {
          const data = await periodsStore.get(key);
          return data ? JSON.parse(data) : null;
        })
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          registeredVoters: meta.registeredVoters || 0,
          votersBySublocation: meta.votersBySublocation || {},
          totalUsers: userList.blobs.length,
          currentPeriod: currentPeriod ? {
            periodId: currentPeriod.periodId,
            totalVotes: currentPeriod.totalVotes,
            votesByCandidate: currentPeriod.votesByCandidate,
            periodStart: currentPeriod.periodStart,
            periodEnd: currentPeriod.periodEnd
          } : null,
          recentPeriods: recentPeriods.filter(Boolean).map(p => ({
            periodId: p.periodId,
            totalVotes: p.totalVotes,
            votesByCandidate: p.votesByCandidate,
            periodStart: p.periodStart,
            periodEnd: p.periodEnd
          }))
        })
      };
    }

    // ── LIST USERS ──
    if (action === 'list_users') {
      const userList = await usersStore.list();
      const users = await Promise.all(
        userList.blobs.slice(0, 100).map(async ({ key }) => {
          const data = await usersStore.get(key);
          if (!data) return null;
          const { passwordHash, salt, ...safe } = JSON.parse(data);
          return safe;
        })
      );
      return { statusCode: 200, body: JSON.stringify({ success: true, users: users.filter(Boolean) }) };
    }

    // ── DELETE USER ──
    if (action === 'delete_user') {
      const { phone } = body;
      if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'Phone required' }) };
      const userData = await usersStore.get(phone);
      if (!userData) return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
      const user = JSON.parse(userData);
      await usersStore.delete(phone);
      // Decrement counters
      let meta = await metaStore.get('counters');
      meta = meta ? JSON.parse(meta) : {};
      meta.registeredVoters = Math.max(0, (meta.registeredVoters || 1) - 1);
      if (user.sublocation && meta.votersBySublocation?.[user.sublocation]) {
        meta.votersBySublocation[user.sublocation] = Math.max(0, meta.votersBySublocation[user.sublocation] - 1);
      }
      await metaStore.set('counters', JSON.stringify(meta));
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // ── RESET PERIOD NOW ──
    if (action === 'reset_period') {
      const current = await periodsStore.get('current');
      if (current) {
        const p = JSON.parse(current);
        await periodsStore.set(`archive_${p.periodId}_${Date.now()}`, current);
      }
      let meta = await metaStore.get('counters');
      meta = meta ? JSON.parse(meta) : {};
      const newPeriodId = (meta.lastPeriodId || 0) + 1;
      const newPeriod = {
        periodId: newPeriodId,
        periodStart: new Date().toISOString(),
        periodEnd: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        isActive: true, totalVotes: 0,
        votesByCandidate: {}, votesByUser: [], votesBySublocation: {}
      };
      await periodsStore.set('current', JSON.stringify(newPeriod));
      await metaStore.set('counters', JSON.stringify({ ...meta, lastPeriodId: newPeriodId }));
      return { statusCode: 200, body: JSON.stringify({ success: true, newPeriodId }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };

  } catch (error) {
    console.error('admin error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};