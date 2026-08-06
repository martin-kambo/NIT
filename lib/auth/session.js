// lib/auth/session.js
// Phase 4B.2A: createSession() and verifySession() extracted verbatim from
// server.js — confirmed to depend only on the built-in `crypto` module and
// process.env.SESSION_SECRET (globally available, no import needed), no
// other state from server.js. Cookie name/format, HMAC signing, session
// payload shape ({phone, userId, exp}), and expiry logic are all
// byte-for-byte unchanged — this file is a straight relocation.

const crypto = require('crypto');

function createSession(phone, userId, ttlDays = 7) {
  const payload = { phone, userId, exp: Date.now() + ttlDays * 24 * 60 * 60 * 1000 };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(payloadBase64)
    .digest('base64');
  return `${payloadBase64}.${signature}`;
}

function verifySession(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;
  try {
    const [payloadBase64, signature] = match[1].split('.');
    const expectedSig = crypto
      .createHmac('sha256', process.env.SESSION_SECRET)
      .update(payloadBase64)
      .digest('base64');
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

module.exports = { createSession, verifySession };
