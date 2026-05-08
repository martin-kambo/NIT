// netlify/functions/auth.js
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function createSession(phone, userId) {
  const payload = { phone, userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(payloadBase64)
    .digest('base64');
  return `${payloadBase64}.${signature}`;
}

function sanitizeUser(user) {
  const { passwordHash, salt, ...safe } = user;
  return safe;
}

async function getNextVoterNumber(metaStore) {
  let meta = await metaStore.get('counters');
  meta = meta ? JSON.parse(meta) : { lastVoterNumber: 0 };
  const next = (meta.lastVoterNumber || 0) + 1;
  await metaStore.set('counters', JSON.stringify({ ...meta, lastVoterNumber: next }));
  return next;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, phone, password } = body;
  const usersStore = getStore('users');

  // LOGIN
  if (action === 'login') {
    if (!phone || !password)
      return { statusCode: 400, body: JSON.stringify({ error: 'Phone and password are required' }) };

    const userData = await usersStore.get(phone);
    if (!userData)
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid credentials' }) };

    const user = JSON.parse(userData);
    if (hashPassword(password, user.salt) !== user.passwordHash)
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid credentials' }) };

    const sessionToken = createSession(phone, user.id);
    return {
      statusCode: 200,
      headers: {
        'Set-Cookie': `session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ success: true, user: sanitizeUser(user) })
    };
  }

  // REGISTER
  if (action === 'register') {
    const { firstName, surname, dob, sublocation, email, nationalId, language } = body;

    if (!phone || !password || !firstName || !surname)
      return { statusCode: 400, body: JSON.stringify({ error: 'Phone, password, first name, and surname are required' }) };
    if (password.length < 6)
      return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 6 characters' }) };

    const existing = await usersStore.get(phone);
    if (existing)
      return { statusCode: 409, body: JSON.stringify({ error: 'Phone number already registered' }) };

    const metaStore = getStore('meta');
    const voterNumber = await getNextVoterNumber(metaStore);
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');

    const user = {
      id, phone, firstName, surname,
      dob: dob || null, sublocation: sublocation || null,
      email: email || null, nationalId: nationalId || null,
      language: language || 'en', voterNumber,
      passwordHash: hashPassword(password, salt), salt,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };

    await usersStore.set(phone, JSON.stringify(user));
    const sessionToken = createSession(phone, id);
    return {
      statusCode: 200,
      headers: {
        'Set-Cookie': `session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ success: true, user: sanitizeUser(user) })
    };
  }

  // LOGOUT
  if (action === 'logout') {
    return {
      statusCode: 200,
      headers: {
        'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ success: true })
    };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };
};