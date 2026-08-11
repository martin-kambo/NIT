// ──────────────────────────────────────────────
// routes/auth.js — Phase 4B.6: extracted verbatim from server.js.
// GET /api/me, POST /api/auth, POST /api/profile, POST /api/reset-password,
// POST /api/change-password, plus the two helpers used only by these five
// routes (sanitizeUser(), getNextVoterNumber()) and the auth-specific rate
// limiter. Confirmed (Phase 4B.3/4B.4 audits) to have zero dependency on
// requirePermission(), the static-data cache, or the founding-ward
// singleton at the time those audits ran -- the one read of
// getFoundingWardId() below (inside the register branch) was already safe
// to move because Phase 4B.5 gave it a lib/ module home. Every query,
// parameter, cookie flag, and status code below is byte-for-byte identical
// to the original inline version.

const express = require('express');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { pool } = require('../bootstrap/database');
const { hashPassword, generateSalt } = require('../lib/auth/password');
const { createSession, verifySession } = require('../lib/auth/session');
const { getFoundingWardId } = require('../lib/ward-cache');

const router = express.Router();

// ── Authentication Rate Limiter ──
// Limits repeated login/register attempts to 5 per 15 minutes per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  statusCode: 429,
  message: { success: false, message: 'Too many authentication attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// sanitizeUser() and getNextVoterNumber() moved verbatim -- both were
// used exclusively by the five routes below (confirmed by repo-wide grep
// during the Phase 4B.3/4B.4 audits: zero callers outside this route
// group).
function sanitizeUser(user) {
  const { password_hash, salt, ...safe } = user;

  // ── AVATAR FIX: profile_photo is stored as BYTEA in Postgres.
  // The pg driver returns it as a Node.js Buffer; we must turn it back into
  // the original base64 data-URL string before sending it to the browser.
  // If the column was already migrated to TEXT it arrives as a plain string
  // — both cases are handled here so this function is safe in either state.
  if (safe.profile_photo != null) {
    if (Buffer.isBuffer(safe.profile_photo)) {
      const decoded = safe.profile_photo.toString('utf8');
      // Only accept recognised image data-URLs; discard corrupted bytes.
      safe.profile_photo =
        decoded.startsWith('data:image/') ? decoded : null;
    } else if (typeof safe.profile_photo === 'string') {
      // Reject anything that isn't a data-URL or an http URL
      if (
        !safe.profile_photo.startsWith('data:image/') &&
        !safe.profile_photo.startsWith('http')
      ) {
        safe.profile_photo = null;
      }
    } else {
      safe.profile_photo = null;
    }
  }

  return safe;
}


async function getNextVoterNumber() {
  // Guarantee the counters row exists even when initDB() early-exited because
  // the users table was already present (i.e. the metadata seed was never run).
  await pool.query(
    `INSERT INTO metadata (key, value)
     VALUES ('counters', '{"last_voter_number": 0, "registered_voters": 0, "last_period_id": 0}')
     ON CONFLICT (key) DO NOTHING`
  );

  // Atomic increment (Task 1, Pre-Phase 3B hardening): the read AND the
  // write now happen inside one SQL statement, so Postgres's row-level
  // lock on the 'counters' row serializes concurrent calls — each UPDATE
  // computes its increment from whatever value is currently committed at
  // the moment it actually runs, not from a value read into JS memory
  // earlier. This eliminates the prior read-then-write race (SELECT last
  // -> compute next in JS -> UPDATE), where two concurrent registrations
  // could read the same `last` and both compute the same `next`,
  // producing a duplicate voter_number and a raw 500 error for whichever
  // registration's INSERT lost the unique-constraint race.
  //
  // parseInt() is explicit and deliberate here: Postgres's bigint/int8
  // type (OID 20) is returned by node-postgres as a STRING by default
  // (no custom type parser is registered anywhere in this file) — the
  // previous implementation's `last + 1` on that string was JS string
  // concatenation, not arithmetic (confirmed by direct testing against
  // pg-types' actual default OID-20 parser), which silently produced a
  // digit-appending sequence (1, 11, 111, 1111, ...) instead of a real
  // increment. parseInt() here ensures this exact bug class cannot recur.
  const res = await pool.query(
    `UPDATE metadata
        SET value = jsonb_set(value, '{last_voter_number}', to_jsonb(((value->>'last_voter_number')::bigint + 1)))
      WHERE key = 'counters'
      RETURNING (value->>'last_voter_number')::bigint AS next`
  );
  return parseInt(res.rows[0].next, 10);
}


// ════════════════════════════════════════════════
// ROUTE: /api/me
// ════════════════════════════════════════════════
router.get('/api/me', async (req, res) => {
  try {
    const cookieHeader = req.headers.cookie || '';

    const session = verifySession(cookieHeader);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const result = await pool.query(
      `SELECT u.id, u.phone, u.first_name, u.surname, u.dob, u.sublocation,
              u.email, u.national_id, u.language, u.voter_number,
              u.profile_photo, u.created_at, u.updated_at, u.ward_id,
              w.name   AS ward_name,
              con.name AS constituency_name,
              cty.name AS county_name
         FROM users u
         LEFT JOIN wards         w   ON w.id   = u.ward_id
         LEFT JOIN constituencies con ON con.id = w.constituency_id
         LEFT JOIN counties      cty ON cty.id  = con.county_id
        WHERE u.phone = $1`,
      [session.phone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const sanitized = sanitizeUser(user);
    // Include geography fields alongside the sanitized user record
    res.json({
      success: true,
      user: {
        ...sanitized,
        wardId:           user.ward_id,
        wardName:         user.ward_name         || null,
        constituencyName: user.constituency_name || null,
        countyName:       user.county_name       || null
      }
    });
    
  } catch (e) {
    console.error('/api/me error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/auth
// ════════════════════════════════════════════════
router.post('/api/auth', authLimiter, async (req, res) => {
  const { action, password, phone, token } = req.body;

  // LOGIN
  if (action === 'login') {
    if (!phone || !password)
      return res.status(400).json({ error: 'Phone and password are required' });

    try {
      const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
      if (result.rows.length === 0)
        return res.status(401).json({ error: 'Invalid credentials' });

      const user = result.rows[0];
      if (hashPassword(password, user.salt) !== user.password_hash)
        return res.status(401).json({ error: 'Invalid credentials' });

      const ttlDays = req.body.remember ? 30 : 7;
      const sessionToken = createSession(phone, user.id, ttlDays);
      
      const isHttps = req.protocol === 'https' || process.env.NODE_ENV === 'production';
      const secureFlagStr = isHttps ? 'Secure; ' : '';
      
      res.setHeader('Set-Cookie', `session=${sessionToken}; HttpOnly; ${secureFlagStr}SameSite=Lax; Path=/; Max-Age=${ttlDays * 24 * 3600}`);
      
      return res.json({ success: true, user: sanitizeUser(user) });
    } catch (e) {
      console.error('Login error:', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // REGISTER
  if (action === 'register') {
    const { firstName, surname, dob, sublocation, email, nationalId, language, wardId } = req.body;

    if (!phone || !password || !firstName || !surname)
      return res.status(400).json({ error: 'Phone, password, first name, and surname are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    try {
      const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (existing.rows.length > 0)
        return res.status(409).json({ error: 'Phone number already registered' });

      const voterNumber = await getNextVoterNumber();
      const id = crypto.randomUUID();
      const salt = generateSalt();
      const passwordHash = hashPassword(password, salt);

      // Phase 3A Task 4: was hardcoded getFoundingWardId(). wardId is now read
      // from the request body (sent by index.html's new County→Constituency→
      // Ward selector), falling back to getFoundingWardId() so old clients that
      // don't send it yet keep registering exactly as before.
      const resolvedWardId = parseInt(wardId, 10) || getFoundingWardId();

      await pool.query(
        `INSERT INTO users (id, phone, first_name, surname, dob, sublocation, email, national_id, language, voter_number, password_hash, salt, ward_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())`,
        [id, phone, firstName, surname, dob || null, sublocation || null, email || null, nationalId || null, language || 'en', voterNumber, passwordHash, salt, resolvedWardId]
      );

      const sessionToken = createSession(phone, id, 7);
      
      const isHttps = req.protocol === 'https' || process.env.NODE_ENV === 'production';
      const secureFlagStr = isHttps ? 'Secure; ' : '';
      
      res.setHeader('Set-Cookie', `session=${sessionToken}; HttpOnly; ${secureFlagStr}SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`);

      const user = {
        id, phone, first_name: firstName, surname, dob: dob || null, sublocation: sublocation || null,
        email: email || null, national_id: nationalId || null, language: language || 'en', voter_number: voterNumber,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      };

      return res.json({ success: true, user: sanitizeUser(user) });
    } catch (e) {
      console.error('Register error:', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // LOGOUT
  // CHECK-PHONE: used by forgot-password flow to confirm phone is registered
  if (action === 'check-phone') {
    if (!phone) return res.status(400).json({ exists: false });
    try {
      const result = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
      return res.json({ exists: result.rows.length > 0 });
    } catch (e) {
      return res.status(500).json({ exists: false });
    }
  }

    if (action === 'logout') {
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    return res.json({ success: true });
  }

  return res.status(400).json({ error: 'Invalid action' });
});

// ════════════════════════════════════════════════
// ROUTE: /api/profile  — update profile details & photo
// ════════════════════════════════════════════════
router.post('/api/profile', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const { firstName, surname, sublocation, email, nationalId, language } = req.body;
  if (!firstName || !surname)
    return res.status(400).json({ success: false, error: 'Name fields required' });

  // ── AVATAR FIX: distinguish three photo states ──
  //   • key absent  → don't touch the stored photo
  //   • key = null  → user wants to REMOVE the photo (set DB column to NULL)
  //   • key = str   → user uploaded a new photo; store it
  const photoKeyPresent = Object.prototype.hasOwnProperty.call(req.body, 'profilePhoto');
  const photoValue      = photoKeyPresent ? (req.body.profilePhoto || null) : undefined;

  try {
    let result;
    if (photoKeyPresent) {
      // Update profile_photo explicitly (covers both set and clear)
      result = await pool.query(
        `UPDATE users
           SET first_name=$1, surname=$2, sublocation=$3, email=$4,
               national_id=$5, language=$6,
               profile_photo=$7, updated_at=NOW()
         WHERE id=$8
         RETURNING id, phone, first_name, surname, dob, sublocation, email,
                   national_id, language, voter_number, profile_photo,
                   created_at, updated_at`,
        [
          firstName, surname, sublocation || null, email || null,
          nationalId || null, language || 'en',
          photoValue,               // null → clear; string → store
          session.userId
        ]
      );
    } else {
      // Leave profile_photo unchanged (no photo key in request)
      result = await pool.query(
        `UPDATE users
           SET first_name=$1, surname=$2, sublocation=$3, email=$4,
               national_id=$5, language=$6, updated_at=NOW()
         WHERE id=$7
         RETURNING id, phone, first_name, surname, dob, sublocation, email,
                   national_id, language, voter_number, profile_photo,
                   created_at, updated_at`,
        [
          firstName, surname, sublocation || null, email || null,
          nationalId || null, language || 'en',
          session.userId
        ]
      );
    }

    if (!result.rows.length)
      return res.status(404).json({ success: false, error: 'User not found' });

    return res.json({ success: true, user: sanitizeUser(result.rows[0]) });
  } catch (e) {
    console.error('/api/profile error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/reset-password
// ════════════════════════════════════════════════
// action='request' — generate a 6-digit OTP, store it server-side in the otps
//   table, and return it in the response (DEV/DEMO mode — replace the return
//   value with an Africa's Talking SMS call when ready for production).
// action='confirm' — verify the OTP from the DB before allowing the password
//   change. Rate-limited to 5 attempts per OTP to prevent brute-force.
router.post('/api/reset-password', async (req, res) => {
  const { action, phone } = req.body;

  if (!phone || typeof phone !== 'string' || !phone.trim())
    return res.status(400).json({ success: false, error: 'Phone number required' });

  // ── REQUEST: generate & store OTP ──────────────────────────────────────
  if (action === 'request') {
    try {
      const userResult = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (!userResult.rows.length)
        return res.status(404).json({ success: false, error: 'Phone not registered' });

      const code    = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Upsert into the otps table (reset attempts on each new request)
      await pool.query(
        `INSERT INTO otps (phone, code, expires_at, attempts)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (phone) DO UPDATE
           SET code = $2, expires_at = $3, attempts = 0`,
        [phone, code, expires]
      );

      // ── DEV/DEMO: return OTP in response ──────────────────────────────
      // TODO: replace with Africa's Talking SMS call and remove 'otp' from
      // the response before going to production.
      console.log(`[reset-password] OTP for ${phone}: ${code} (demo mode)`);
      return res.json({ success: true, otp: code, note: 'DEMO MODE — OTP returned in response. Wire SMS before production.' });

    } catch (e) {
      console.error('[reset-password] request error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  // ── CONFIRM: verify OTP then reset password ─────────────────────────────
  if (action === 'confirm') {
    const { code, password } = req.body;
    if (!code || !password || password.length < 6)
      return res.status(400).json({ success: false, error: 'Code and password (min 6 chars) required' });

    try {
      const otpResult = await pool.query(
        'SELECT code, expires_at, attempts FROM otps WHERE phone = $1', [phone]
      );

      if (!otpResult.rows.length)
        return res.status(400).json({ success: false, error: 'No OTP requested for this number' });

      const row = otpResult.rows[0];

      // Hard-limit attempts to prevent brute-force
      if (row.attempts >= 5) {
        await pool.query('DELETE FROM otps WHERE phone = $1', [phone]);
        return res.status(429).json({ success: false, error: 'Too many attempts. Request a new OTP.' });
      }

      // Increment attempt counter before checking (prevents enumeration on timing)
      await pool.query('UPDATE otps SET attempts = attempts + 1 WHERE phone = $1', [phone]);

      if (new Date() > new Date(row.expires_at))
        return res.status(400).json({ success: false, error: 'OTP has expired. Request a new one.' });

      if (row.code !== code.trim())
        return res.status(400).json({ success: false, error: 'Incorrect OTP' });

      // OTP valid — reset password
      const salt         = generateSalt();
      const passwordHash = hashPassword(password, salt);
      await pool.query(
        'UPDATE users SET password_hash=$1, salt=$2, updated_at=NOW() WHERE phone=$3',
        [passwordHash, salt, phone]
      );

      // Consume the OTP so it cannot be reused
      await pool.query('DELETE FROM otps WHERE phone = $1', [phone]);

      return res.json({ success: true });
    } catch (e) {
      console.error('[reset-password] confirm error:', e.message);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  return res.status(400).json({ success: false, error: 'Invalid action' });
});

// ════════════════════════════════════════════════
// ROUTE: /api/change-password  — authenticated password change
// ════════════════════════════════════════════════
router.post('/api/change-password', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 6)
    return res.status(400).json({ success: false, error: 'Both passwords required; new password min 6 chars' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [session.userId]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    const user = result.rows[0];
    if (hashPassword(currentPassword, user.salt) !== user.password_hash)
      return res.status(401).json({ success: false, error: 'Current password incorrect' });
    const salt = generateSalt();
    const passwordHash = hashPassword(newPassword, salt);
    await pool.query('UPDATE users SET password_hash=$1, salt=$2, updated_at=NOW() WHERE id=$3',
      [passwordHash, salt, session.userId]);
    return res.json({ success: true });
  } catch (e) {
    console.error('/api/change-password error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
