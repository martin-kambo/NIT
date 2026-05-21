// server.js — Ngoliba InfoTrack
// PostgreSQL version (no Netlify dependency)
// Production-ready for Render
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ── PostgreSQL Connection Pool ──
// ── PostgreSQL Connection Pool ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  ssl: {
    rejectUnauthorized: false
  }
});
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});
// ── Initialize Database Tables ──
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      first_name VARCHAR(50),
      surname VARCHAR(50),
      dob DATE,
      sublocation VARCHAR(100),
      email VARCHAR(255),
      national_id VARCHAR(20),
      language VARCHAR(10) DEFAULT 'en',
      voter_number BIGINT,
      password_hash VARCHAR(64),
      salt VARCHAR(32),
      profile_photo BYTEA,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key VARCHAR(50) PRIMARY KEY,
      value JSONB NOT NULL
    );
    INSERT INTO metadata (key, value) VALUES ('counters', '{"last_voter_number": 0, "registered_voters": 0, "last_period_id": 0}')
      ON CONFLICT (key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS voters_by_sublocation (
      sublocation VARCHAR(100) PRIMARY KEY,
      voter_count INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS voting_periods (
      id INT PRIMARY KEY,
      period_start TIMESTAMP,
      period_end TIMESTAMP,
      is_active BOOLEAN DEFAULT true,
      total_votes INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      user_id UUID,
      candidate_id INT,
      period_id INT,
      sublocation VARCHAR(100),
      ip_hash VARCHAR(16),
      timestamp BIGINT
    );

    CREATE TABLE IF NOT EXISTS period_archives (
      id INT PRIMARY KEY,
      period_data JSONB,
      archived_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS otps (
      phone VARCHAR(20) PRIMARY KEY,
      code VARCHAR(6),
      expires_at TIMESTAMP,
      attempts INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS forum_posts (
      id UUID PRIMARY KEY,
      title VARCHAR(200),
      content TEXT,
      author_id UUID,
      author_name VARCHAR(100),
      author_phone VARCHAR(20),
      like_count INT DEFAULT 0,
      reply_count INT DEFAULT 0,
      last_activity_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS forum_replies (
      id UUID PRIMARY KEY,
      post_id UUID,
      content TEXT,
      author_id UUID,
      author_name VARCHAR(100),
      author_phone VARCHAR(20),
      like_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS post_likes (
      post_id UUID,
      user_id UUID,
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS reply_likes (
      reply_id UUID,
      user_id UUID,
      PRIMARY KEY (reply_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS notices (
      id UUID PRIMARY KEY,
      title VARCHAR(200),
      content TEXT,
      category VARCHAR(50) DEFAULT 'general',
      priority VARCHAR(20) DEFAULT 'normal',
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ad_requests (
      id UUID PRIMARY KEY,
      business_name VARCHAR(100),
      ad_content TEXT,
      contact_phone VARCHAR(20),
      contact_email VARCHAR(255),
      budget VARCHAR(50),
      duration VARCHAR(50) DEFAULT '7 days',
      status VARCHAR(20) DEFAULT 'pending',
      submitted_at TIMESTAMP DEFAULT NOW(),
      reviewed_at TIMESTAMP,
      reviewed_by VARCHAR(50),
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS mpesa_transactions (
      id VARCHAR(100) PRIMARY KEY,
      phone VARCHAR(20),
      amount INT,
      account_reference VARCHAR(50),
      description TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      respond_code VARCHAR(10),
      respond_description TEXT,
      mpesa_receipt_number VARCHAR(50),
      callback_data JSONB,
      callback_received_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mpesa_callback_logs (
      id SERIAL PRIMARY KEY,
      transaction_id VARCHAR(100),
      result_code INT,
      result_desc TEXT,
      raw_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ All tables initialized');
}

initDB().catch(err => {
  console.error('❌ DB init failed:', err);
  process.exit(1);
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  } else {
    console.log('✅ PostgreSQL connected');
  }
});

// ── Middleware ──
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Shared Utilities ──
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

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

function sanitizeUser(user) {
  const { password_hash, salt, ...safe } = user;
  return safe;
}

function createAdminToken() {
  const payload = { role: 'admin', exp: Date.now() + 4 * 60 * 60 * 1000 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest('base64');
  return `${payloadB64}.${sig}`;
}

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

async function getNextVoterNumber() {
  const res = await pool.query(
    `SELECT (value->>'last_voter_number')::bigint as last FROM metadata WHERE key = 'counters'`
  );
  const last = res.rows[0]?.last || 0;
  const next = last + 1;
  await pool.query(
    `UPDATE metadata SET value = jsonb_set(value, '{last_voter_number}', to_jsonb($1::int)) WHERE key = 'counters'`,
    [next]
  );
  return next;
}

const CANDIDATES = [
  { id: 0, name: 'Hon. James Mwangi' },
  { id: 1, name: 'Grace Wanjiku' },
  { id: 2, name: 'Peter Kimani' },
  { id: 3, name: 'Sarah Nduati' },
  { id: 4, name: 'John Otieno' },
  { id: 5, name: 'Mary Wambui' },
  { id: 6, name: 'David Kiprotich' }
];

// ════════════════════════════════════════════════
// ROUTE: /api/me
// ════════════════════════════════════════════════
app.get('/api/me', async (req, res) => {
  try {
    // ✅ EXTRACT SESSION TOKEN FROM COOKIE
    const cookieHeader = req.headers.cookie || '';
    const sessionMatch = cookieHeader.match(/session=([^;]*)/);
    const sessionToken = sessionMatch ? sessionMatch[1] : null;
    
    if (!sessionToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // ✅ VERIFY THE TOKEN
    const session = verifySession(sessionToken);
    if (!session) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    
    // ✅ GET USER FROM DATABASE
    const result = await pool.query(
      'SELECT id, phone, first_name, surname, dob, sublocation, email, national_id, language, voter_number, profile_photo, created_at, updated_at FROM users WHERE phone = $1',
      [session.phone]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];
    res.json({ success: true, user: sanitizeUser(user) });
    
  } catch (e) {
    console.error('/api/me error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/api/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const result = await pool.query(
      'SELECT * FROM period_archives ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    
    return res.json({
      success: true,
      periods: result.rows.map(row => ({
        periodId: row.id,
        periodStart: row.period_data.period_start,
        periodEnd: row.period_data.period_end,
        totalVotes: row.period_data.total_votes,
        votesByCandidate: row.period_data.votes_by_candidate || {}
      }))
    });
  } catch (e) {
    console.error('/api/history error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/auth
// ════════════════════════════════════════════════
app.post('/api/auth', async (req, res) => {
  const { action, phone, password } = req.body;

  // LOGIN
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
      
      // ✅ FIX: Conditional Secure flag + use it
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
  // REGISTER
  if (action === 'register') {
    const { firstName, surname, dob, sublocation, email, nationalId, language } = req.body;

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
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = hashPassword(password, salt);

      await pool.query(
        `INSERT INTO users (id, phone, first_name, surname, dob, sublocation, email, national_id, language, voter_number, password_hash, salt, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
        [id, phone, firstName, surname, dob || null, sublocation || null, email || null, nationalId || null, language || 'en', voterNumber, passwordHash, salt]
      );

      // Update counters
      await pool.query(
        `UPDATE metadata SET value = jsonb_set(value, '{registered_voters}', 
         to_jsonb(COALESCE((value->'registered_voters')::int, 0) + 1)) 
         WHERE key = 'counters'`
      );

      if (sublocation) {
        await pool.query(
          `INSERT INTO voters_by_sublocation (sublocation, voter_count) VALUES ($1, 1)
           ON CONFLICT (sublocation) DO UPDATE SET voter_count = voters_by_sublocation.voter_count + 1`,
          [sublocation]
        );
      }

      const sessionToken = createSession(phone, id, 7);
      
      // ✅ FIX: Conditional Secure flag + use it
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
  if (action === 'logout') {
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    return res.json({ success: true });
  }

  return res.status(400).json({ error: 'Invalid action' });
});

// ════════════════════════════════════════════════
// ROUTE: /api/vote
// ════════════════════════════════════════════════
app.post('/api/vote', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { candidateId, periodId } = req.body;
  if (!candidateId && candidateId !== 0 || !periodId)
    return res.status(400).json({ error: 'candidateId and periodId are required' });

  try {
    // Get current period
    const periodResult = await pool.query(
      'SELECT * FROM voting_periods WHERE id = $1 AND is_active = true',
      [periodId]
    );
    if (periodResult.rows.length === 0)
      return res.status(400).json({ error: 'Voting period not found or inactive' });

    const period = periodResult.rows[0];
    if (new Date(period.period_end) <= new Date())
      return res.status(400).json({ error: 'Voting period has ended' });

    // Check if already voted
    const voteCheck = await pool.query(
      'SELECT id FROM votes WHERE user_id = $1 AND period_id = $2',
      [session.userId, periodId]
    );
    if (voteCheck.rows.length > 0)
      return res.status(400).json({ error: 'Already voted this period' });

    // Get user info
    const userResult = await pool.query(
      'SELECT sublocation FROM users WHERE id = $1',
      [session.userId]
    );
    const user = userResult.rows[0];

    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);

    // Insert vote
    await pool.query(
      `INSERT INTO votes (user_id, candidate_id, period_id, sublocation, ip_hash, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [session.userId, candidateId, periodId, user?.sublocation || null, ipHash, Date.now()]
    );

    // Update period stats
    await pool.query(
      `UPDATE voting_periods SET total_votes = total_votes + 1 WHERE id = $1`,
      [periodId]
    );

    // Check if first/second/third voter
    let badge = null;
    const voterCountResult = await pool.query(
      'SELECT COUNT(*) as count FROM votes WHERE period_id = $1',
      [periodId]
    );
    const voterCount = parseInt(voterCountResult.rows[0].count);
    if (voterCount === 1) badge = '1st';
    else if (voterCount === 2) badge = '2nd';
    else if (voterCount === 3) badge = '3rd';

    return res.json({ success: true, badge, totalVotes: voterCount });
  } catch (e) {
    console.error('/api/vote error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/polling-results
// ════════════════════════════════════════════════
app.get('/api/polling-results', async (req, res) => {
  try {
    const periodResult = await pool.query(
      'SELECT * FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );

    if (periodResult.rows.length === 0) {
      return res
        .set('Cache-Control', 'public, max-age=5')
        .json({ periodId: null, totalVotes: 0, votesByCandidate: {}, isActive: false });
    }

    const period = periodResult.rows[0];
    const votesResult = await pool.query(
      'SELECT candidate_id, COUNT(*) as count FROM votes WHERE period_id = $1 GROUP BY candidate_id',
      [period.id]
    );

    const votesByCandidate = {};
    votesResult.rows.forEach(row => {
      votesByCandidate[row.candidate_id] = parseInt(row.count);
    });

    const sublocationResult = await pool.query(
      'SELECT sublocation, COUNT(*) as count FROM voters_by_sublocation GROUP BY sublocation'
    );

    const votersBySublocation = {};
    sublocationResult.rows.forEach(row => {
      votersBySublocation[row.sublocation] = parseInt(row.count);
    });

    return res
      .set('Cache-Control', 'public, max-age=5')
      .json({
        periodId: period.id,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        isActive: period.is_active,
        totalVotes: parseInt(period.total_votes),
        votesByCandidate,
        votersBySublocation
      });
  } catch (e) {
    console.error('/api/polling-results error:', e);
    return res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/get-history
// ════════════════════════════════════════════════
app.get('/api/get-history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10'), 30);

    const archivesResult = await pool.query(
      'SELECT id, period_data FROM period_archives ORDER BY archived_at DESC LIMIT $1',
      [limit]
    );

    const periods = archivesResult.rows.map(row => row.period_data);

    return res
      .set('Cache-Control', 'public, max-age=30')
      .json({ success: true, periods });
  } catch (e) {
    console.error('/api/get-history error:', e);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/profile
// ════════════════════════════════════════════════
app.post('/api/profile', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const isValidEmail = (e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const isValidNationalId = (id) => !id || /^[0-9]{7,8}$/.test(id);

  try {
    const { action } = req.body;
    const userResult = await pool.query('SELECT * FROM users WHERE phone = $1', [session.phone]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];

    if (action === 'get_profile') {
      return res.json({ success: true, user: sanitizeUser(user) });
    }

    if (action === 'update_profile') {
      const { firstName, surname, sublocation, email, nationalId, language } = req.body;
      if (firstName && (firstName.length < 2 || firstName.length > 50))
        return res.status(400).json({ error: 'First name must be 2-50 characters' });
      if (surname && (surname.length < 2 || surname.length > 50))
        return res.status(400).json({ error: 'Surname must be 2-50 characters' });
      if (email && !isValidEmail(email))
        return res.status(400).json({ error: 'Invalid email address' });
      if (nationalId && !isValidNationalId(nationalId))
        return res.status(400).json({ error: 'National ID must be 7-8 digits' });

      await pool.query(
        `UPDATE users SET 
         first_name = COALESCE($2, first_name),
         surname = COALESCE($3, surname),
         sublocation = COALESCE($4, sublocation),
         email = COALESCE($5, email),
         national_id = COALESCE($6, national_id),
         language = COALESCE($7, language),
         updated_at = NOW()
         WHERE phone = $1`,
        [session.phone, firstName || null, surname || null, sublocation || null, email || null, nationalId || null, language || null]
      );

      const updatedResult = await pool.query('SELECT * FROM users WHERE phone = $1', [session.phone]);
      return res.json({ success: true, user: sanitizeUser(updatedResult.rows[0]) });
    }

    if (action === 'change_password') {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword)
        return res.status(400).json({ error: 'Current password and new password are required' });
      if (newPassword.length < 6)
        return res.status(400).json({ error: 'New password must be at least 6 characters' });

      const currentHash = crypto.createHash('sha256').update(currentPassword + user.salt).digest('hex');
      if (currentHash !== user.password_hash)
        return res.status(401).json({ error: 'Current password is incorrect' });

      const newSalt = crypto.randomBytes(16).toString('hex');
      const newHash = crypto.createHash('sha256').update(newPassword + newSalt).digest('hex');

      await pool.query(
        'UPDATE users SET password_hash = $2, salt = $3, updated_at = NOW() WHERE phone = $1',
        [session.phone, newHash, newSalt]
      );

      return res.json({ success: true, message: 'Password changed successfully' });
    }

    if (action === 'update_photo') {
      const { photoBase64 } = req.body;
      if (!photoBase64) return res.status(400).json({ error: 'Photo data is required' });
      if (photoBase64.length * 0.75 > 2 * 1024 * 1024)
        return res.status(400).json({ error: 'Image must be less than 2MB' });

      await pool.query(
        'UPDATE users SET profile_photo = $2, updated_at = NOW() WHERE phone = $1',
        [session.phone, Buffer.from(photoBase64, 'base64')]
      );

      const updatedResult = await pool.query('SELECT * FROM users WHERE phone = $1', [session.phone]);
      return res.json({ success: true, user: sanitizeUser(updatedResult.rows[0]) });
    }

    if (action === 'remove_photo') {
      await pool.query(
        'UPDATE users SET profile_photo = NULL, updated_at = NOW() WHERE phone = $1',
        [session.phone]
      );

      const updatedResult = await pool.query('SELECT * FROM users WHERE phone = $1', [session.phone]);
      return res.json({ success: true, user: sanitizeUser(updatedResult.rows[0]) });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('/api/profile error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/send-otp
// ════════════════════════════════════════════════
app.post('/api/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone is required' });

  try {
    const userResult = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (userResult.rows.length === 0) return res.json({ success: true });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      'INSERT INTO otps (phone, code, expires_at, attempts) VALUES ($1, $2, $3, 0) ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3, attempts = 0',
      [phone, otp, expiresAt]
    );

    // Send via Africa's Talking
    if (process.env.AFRICASTALKING_API_KEY && process.env.AFRICASTALKING_USERNAME) {
      try {
        const africastalking = require('africastalking')({
          apiKey: process.env.AFRICASTALKING_API_KEY,
          username: process.env.AFRICASTALKING_USERNAME
        });

        await africastalking.SMS.send({
          to: [phone],
          message: `Your Ngoliba InfoTrack verification code is: ${otp}. Valid for 10 minutes.`,
          from: process.env.AFRICASTALKING_SENDER_ID || undefined
        });
      } catch (e) {
        console.error('SMS send error:', e);
      }
    }

    return res.json({ success: true });
  } catch (e) {
    console.error('/api/send-otp error:', e);
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/verify-otp
// ════════════════════════════════════════════════
app.post('/api/verify-otp', async (req, res) => {
  const { phone, otpCode, newPassword } = req.body;
  if (!phone || !otpCode)
    return res.status(400).json({ success: false, error: 'Phone and OTP code are required' });

  try {
    const otpResult = await pool.query('SELECT * FROM otps WHERE phone = $1', [phone]);
    if (otpResult.rows.length === 0)
      return res.status(400).json({ success: false, error: 'No OTP request found for this phone' });

    const otpData = otpResult.rows[0];

    if (new Date() > otpData.expires_at) {
      await pool.query('DELETE FROM otps WHERE phone = $1', [phone]);
      return res.status(400).json({ success: false, error: 'OTP has expired. Please request a new one.' });
    }

    if (otpData.attempts >= 5) {
      await pool.query('DELETE FROM otps WHERE phone = $1', [phone]);
      return res.status(400).json({ success: false, error: 'Too many failed attempts. Please request a new OTP.' });
    }

    if (otpData.code !== otpCode) {
      await pool.query(
        'UPDATE otps SET attempts = attempts + 1 WHERE phone = $1',
        [phone]
      );
      return res.status(400).json({ success: false, error: `Invalid OTP. ${5 - otpData.attempts - 1} attempts remaining.` });
    }

    if (newPassword) {
      if (newPassword.length < 6)
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });

      const userResult = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
      if (userResult.rows.length === 0)
        return res.status(404).json({ success: false, error: 'User not found' });

      const newSalt = crypto.randomBytes(16).toString('hex');
      const newHash = crypto.createHash('sha256').update(newPassword + newSalt).digest('hex');

      await pool.query(
        'UPDATE users SET password_hash = $2, salt = $3, updated_at = NOW() WHERE phone = $1',
        [phone, newHash, newSalt]
      );
    }

    await pool.query('DELETE FROM otps WHERE phone = $1', [phone]);
    return res.json({ success: true, message: newPassword ? 'Password reset successfully' : 'OTP verified successfully' });
  } catch (e) {
    console.error('/api/verify-otp error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/export-data
// ════════════════════════════════════════════════
app.get('/api/export-data', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE phone = $1', [session.phone]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = sanitizeUser(userResult.rows[0]);

    const votesResult = await pool.query(
      'SELECT * FROM votes WHERE user_id = $1 ORDER BY created_at DESC',
      [session.userId]
    );

    const periodResult = await pool.query(
      'SELECT * FROM voting_periods WHERE is_active = true LIMIT 1'
    );
    const currentPeriod = periodResult.rows[0];

    const exportData = {
      exportedAt: new Date().toISOString(),
      user,
      votingHistory: votesResult.rows,
      currentCycle: currentPeriod ? {
        periodId: currentPeriod.id,
        periodEnd: currentPeriod.period_end,
        hasVoted: !!(await pool.query(
          'SELECT id FROM votes WHERE user_id = $1 AND period_id = $2',
          [session.userId, currentPeriod.id]
        )).rows[0]
      } : null,
      dataRights: {
        rightToAccess: true, rightToRectification: true,
        rightToErasure: true, rightToDataPortability: true,
        contactEmail: 'dpo@ngolibainfotrack.co.ke'
      }
    };

    const filename = `ngoliba_voter_data_${user.voter_number}_${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.json(exportData);
  } catch (e) {
    console.error('/api/export-data error:', e);
    return res.status(500).json({ error: 'Failed to export data' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/admin
// ════════════════════════════════════════════════
app.post('/api/admin', async (req, res) => {
  const { action } = req.body;

  if (action === 'admin_login') {
    const { password } = req.body;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;
    const inputHash = crypto.createHash('sha256').update(password || '').digest('hex');
    if (!adminHash || inputHash !== adminHash)
      return res.status(401).json({ error: 'Invalid admin password' });
    return res.json({ success: true, token: createAdminToken() });
  }

  if (!verifyAdminToken(req.headers.authorization))
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (action === 'get_stats') {
      const [userCountResult, votersResult, sublocationsResult, currentPeriodResult] = await Promise.all([
        pool.query('SELECT COUNT(*) as count FROM users'),
        pool.query('SELECT (value->>\'registered_voters\')::int as count FROM metadata WHERE key = \'counters\''),
        pool.query('SELECT * FROM voters_by_sublocation'),
        pool.query('SELECT * FROM voting_periods WHERE is_active = true LIMIT 1')
      ]);

      const votersBySubLocation = {};
      sublocationsResult.rows.forEach(row => {
        votersBySubLocation[row.sublocation] = row.voter_count;
      });

      const currentPeriod = currentPeriodResult.rows[0];
      const currentVotes = currentPeriod ? 
        await pool.query(
          'SELECT candidate_id, COUNT(*) as count FROM votes WHERE period_id = $1 GROUP BY candidate_id',
          [currentPeriod.id]
        ) : null;

      const votesByCandidate = {};
      if (currentVotes) {
        currentVotes.rows.forEach(row => {
          votesByCandidate[row.candidate_id] = parseInt(row.count);
        });
      }

      return res.json({
        success: true,
        registeredVoters: parseInt(votersResult.rows[0]?.count || 0),
        votersBySublocation: votersBySubLocation,
        totalUsers: parseInt(userCountResult.rows[0].count),
        currentPeriod: currentPeriod ? {
          periodId: currentPeriod.id,
          totalVotes: parseInt(currentPeriod.total_votes),
          periodEnd: currentPeriod.period_end,
          votesByCandidate
        } : null
      });
    }

    if (action === 'list_users') {
      const result = await pool.query(
        'SELECT id, phone, first_name as "firstName", surname, email, sublocation, voter_number as "voterNumber", created_at as "createdAt" FROM users LIMIT 100'
      );
      return res.json({ success: true, users: result.rows });
    }

    if (action === 'delete_user') {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: 'Phone required' });

      const userResult = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
      if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

      const user = userResult.rows[0];
      await pool.query('DELETE FROM users WHERE phone = $1', [phone]);

      await pool.query(
        'UPDATE metadata SET value = jsonb_set(value, \'{registered_voters}\', GREATEST(0, (COALESCE((value->>\'registered_voters\')::int, 1) - 1))::text::jsonb) WHERE key = \'counters\''
      );

      if (user.sublocation) {
        await pool.query(
          'UPDATE voters_by_sublocation SET voter_count = GREATEST(0, voter_count - 1) WHERE sublocation = $1',
          [user.sublocation]
        );
      }

      return res.json({ success: true });
    }

    if (action === 'reset_period') {
      const currentResult = await pool.query('SELECT * FROM voting_periods WHERE is_active = true LIMIT 1');
      if (currentResult.rows.length > 0) {
        const current = currentResult.rows[0];
        await pool.query(
          'INSERT INTO period_archives (id, period_data) VALUES ($1, $2)',
          [current.id, JSON.stringify(current)]
        );
        await pool.query('UPDATE voting_periods SET is_active = false WHERE id = $1', [current.id]);
      }

      const metaResult = await pool.query('SELECT value FROM metadata WHERE key = \'counters\'');
      const meta = metaResult.rows[0]?.value || { last_period_id: 0 };
      const newPeriodId = (parseInt(meta.last_period_id) || 0) + 1;

      await pool.query(
        `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
         VALUES ($1, NOW(), NOW() + INTERVAL '5 minutes', true, 0)`,
        [newPeriodId]
      );

      await pool.query(
        'UPDATE metadata SET value = jsonb_set(value, \'{last_period_id}\', $1::text::jsonb) WHERE key = \'counters\'',
        [newPeriodId]
      );

      return res.json({ success: true, newPeriodId });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('/api/admin error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
// ════════════════════════════════════════════════════════════════════════════
// ROUTE: /api/stats (Required by index.html)
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/stats', async (req, res) => {
  try {
    // Get registered voters
    const votersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const registeredVoters = parseInt(votersResult.rows[0].count || 0);
    
    // Get voters by sublocation
    const sublocResult = await pool.query(
      'SELECT sublocation, COUNT(*) as count FROM users WHERE sublocation IS NOT NULL GROUP BY sublocation'
    );
    const votersBySubLocation = {};
    sublocResult.rows.forEach(row => {
      votersBySubLocation[row.sublocation] = parseInt(row.count);
    });
    
    // Get current active period and vote counts
    const periodResult = await pool.query(
      'SELECT id, total_votes, period_end FROM voting_periods WHERE is_active = true LIMIT 1'
    );
    
    let currentPeriod = null;
    if (periodResult.rows.length > 0) {
      const period = periodResult.rows[0];
      
      // Get votes by candidate
      const votesResult = await pool.query(
        'SELECT candidate_id, COUNT(*) as count FROM votes WHERE period_id = $1 GROUP BY candidate_id',
        [period.id]
      );
      
      const votesByCandidate = {};
      votesResult.rows.forEach(row => {
        votesByCandidate[row.candidate_id] = parseInt(row.count);
      });
      
      currentPeriod = {
        periodId: period.id,
        totalVotes: parseInt(period.total_votes || 0),
        periodEnd: period.period_end,
        votesByCandidate
      };
    }
    
    return res.json({
      success: true,
      registeredVoters,
      votersBySubLocation,
      currentPeriod
    });
  } catch (error) {
    console.error('/api/stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});
// ════════════════════════════════════════════════
// ROUTE: /api/webhook — period reset trigger
// ════════════════════════════════════════════════
async function sendSMSToAllVoters(message) {
  if (!process.env.AFRICASTALKING_API_KEY || !process.env.AFRICASTALKING_USERNAME) return;
  try {
    const africastalking = require('africastalking')({
      apiKey: process.env.AFRICASTALKING_API_KEY,
      username: process.env.AFRICASTALKING_USERNAME
    });
    const result = await pool.query('SELECT phone FROM users');
    const phones = result.rows.map(r => r.phone);
    if (!phones.length) return;

    const chunks = [];
    for (let i = 0; i < phones.length; i += 1000) chunks.push(phones.slice(i, i + 1000));
    for (const chunk of chunks) {
      await africastalking.SMS.send({ to: chunk, message, from: process.env.AFRICASTALKING_SENDER_ID || undefined });
    }
  } catch (err) { console.error('SMS send error:', err); }
}

app.all('/api/webhook', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const currentResult = await pool.query('SELECT * FROM voting_periods WHERE is_active = true LIMIT 1');
    let currentPeriod = currentResult.rows[0];

    if (!currentPeriod) {
      const metaResult = await pool.query('SELECT value FROM metadata WHERE key = \'counters\'');
      const meta = metaResult.rows[0]?.value || { last_period_id: 0 };
      const newPeriodId = (parseInt(meta.last_period_id) || 0) + 1;

      await pool.query(
        `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
         VALUES ($1, NOW(), NOW() + INTERVAL '5 minutes', true, 0)`,
        [newPeriodId]
      );

      return res.json({ success: true, message: 'Initial period created' });
    }

    if (new Date(currentPeriod.period_end) <= new Date()) {
      await pool.query(
        'INSERT INTO period_archives (id, period_data) VALUES ($1, $2)',
        [currentPeriod.id, JSON.stringify(currentPeriod)]
      );

      // Get winner
      const votesResult = await pool.query(
        'SELECT candidate_id, COUNT(*) as count FROM votes WHERE period_id = $1 GROUP BY candidate_id ORDER BY count DESC LIMIT 1',
        [currentPeriod.id]
      );

      let winnerId = null;
      if (votesResult.rows.length > 0) {
        winnerId = votesResult.rows[0].candidate_id;
        const winnerName = CANDIDATES.find(c => c.id === winnerId)?.name || `Candidate ${winnerId}`;
        const msg = `Ngoliba InfoTrack: Cycle ${currentPeriod.id} ended. Winner: ${winnerName} with ${votesResult.rows[0].count} vote(s). New cycle started! Vote now at ngolibainfotrack.onrender.com`;
        sendSMSToAllVoters(msg);
      }

      await pool.query('UPDATE voting_periods SET is_active = false WHERE id = $1', [currentPeriod.id]);

      const metaResult = await pool.query('SELECT value FROM metadata WHERE key = \'counters\'');
      const meta = metaResult.rows[0]?.value || { last_period_id: currentPeriod.id };
      const newPeriodId = parseInt(meta.last_period_id) + 1;

      await pool.query(
        `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
         VALUES ($1, NOW(), NOW() + INTERVAL '5 minutes', true, 0)`,
        [newPeriodId]
      );

      await pool.query(
        'UPDATE metadata SET value = jsonb_set(value, \'{last_period_id}\', $1::text::jsonb) WHERE key = \'counters\'',
        [newPeriodId]
      );

      return res.json({
        success: true, message: 'Period reset completed',
        completedPeriod: currentPeriod.id, newPeriod: newPeriodId, winner: winnerId
      });
    }

    return res.json({ success: true, message: 'Period still active', endsAt: currentPeriod.period_end });
  } catch (e) {
    console.error('/api/webhook error:', e);
    return res.status(500).json({ success: false, error: 'Failed to reset period' });
  }
});

// ════════════════════════════════════════════════
// FORUM API
// ════════════════════════════════════════════════

app.post('/api/forum', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { action } = req.body;

  try {
    const userResult = await pool.query('SELECT first_name, surname, profile_photo FROM users WHERE id = $1', [session.userId]);
    const user = userResult.rows[0];
    const userName = user ? `${user.first_name} ${user.surname}` : 'Anonymous';

    if (action === 'create_post') {
      const { title, content } = req.body;
      if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });
      if (title.length < 5 || title.length > 200) return res.status(400).json({ error: 'Title must be 5-200 characters' });
      if (content.length < 10 || content.length > 5000) return res.status(400).json({ error: 'Content must be 10-5000 characters' });

      const postId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO forum_posts (id, title, content, author_id, author_name, author_phone)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [postId, title.trim(), content.trim(), session.userId, userName, session.phone]
      );

      const post = {
        id: postId, title, content, author_id: session.userId, author_name: userName,
        author_phone: session.phone, like_count: 0, reply_count: 0, created_at: new Date().toISOString()
      };

      return res.json({ success: true, post });
    }

    if (action === 'list_posts') {
      const limit = Math.min(parseInt(req.body.limit || '20'), 100);
      const offset = parseInt(req.body.offset || '0');

      const result = await pool.query(
        'SELECT * FROM forum_posts ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );

      const totalResult = await pool.query('SELECT COUNT(*) as count FROM forum_posts');
      const total = parseInt(totalResult.rows[0].count);

      return res.json({
        success: true,
        posts: result.rows,
        total,
        hasMore: offset + limit < total
      });
    }

    if (action === 'get_post') {
      const { postId } = req.body;
      if (!postId) return res.status(400).json({ error: 'postId required' });

      const postResult = await pool.query('SELECT * FROM forum_posts WHERE id = $1', [postId]);
      if (postResult.rows.length === 0) return res.status(404).json({ error: 'Post not found' });

      const repliesResult = await pool.query('SELECT * FROM forum_replies WHERE post_id = $1 ORDER BY created_at ASC', [postId]);

      const post = postResult.rows[0];
      post.replies = repliesResult.rows;

      return res.json({ success: true, post });
    }

    if (action === 'create_reply') {
      const { postId, content } = req.body;
      if (!postId || !content) return res.status(400).json({ error: 'postId and content are required' });
      if (content.length < 2 || content.length > 2000) return res.status(400).json({ error: 'Reply must be 2-2000 characters' });

      const postCheck = await pool.query('SELECT id FROM forum_posts WHERE id = $1', [postId]);
      if (postCheck.rows.length === 0) return res.status(404).json({ error: 'Post not found' });

      const replyId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO forum_replies (id, post_id, content, author_id, author_name, author_phone)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [replyId, postId, content.trim(), session.userId, userName, session.phone]
      );

      await pool.query('UPDATE forum_posts SET reply_count = reply_count + 1, last_activity_at = NOW() WHERE id = $1', [postId]);

      const reply = {
        id: replyId, content, author_id: session.userId, author_name: userName,
        author_phone: session.phone, like_count: 0, created_at: new Date().toISOString()
      };

      return res.json({ success: true, reply, replyCount: null });
    }

    if (action === 'delete_reply') {
      const { postId, replyId } = req.body;
      if (!postId || !replyId) return res.status(400).json({ error: 'postId and replyId required' });

      const replyResult = await pool.query('SELECT author_id FROM forum_replies WHERE id = $1', [replyId]);
      if (replyResult.rows.length === 0) return res.status(404).json({ error: 'Reply not found' });

      const reply = replyResult.rows[0];
      if (reply.author_id !== session.userId) return res.status(403).json({ error: 'Can only delete your own replies' });

      await pool.query('DELETE FROM forum_replies WHERE id = $1', [replyId]);
      await pool.query('UPDATE forum_posts SET reply_count = reply_count - 1 WHERE id = $1', [postId]);

      return res.json({ success: true });
    }

    if (action === 'like_post') {
      const { postId } = req.body;
      if (!postId) return res.status(400).json({ error: 'postId required' });

      const checkLike = await pool.query('SELECT id FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, session.userId]);

      if (checkLike.rows.length === 0) {
        await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)', [postId, session.userId]);
        await pool.query('UPDATE forum_posts SET like_count = like_count + 1 WHERE id = $1', [postId]);

        const likeCountResult = await pool.query('SELECT like_count FROM forum_posts WHERE id = $1', [postId]);
        return res.json({ success: true, liked: true, likeCount: likeCountResult.rows[0].like_count });
      }

      return res.json({ success: true, liked: false, likeCount: null, message: 'Already liked' });
    }

    if (action === 'unlike_post') {
      const { postId } = req.body;
      if (!postId) return res.status(400).json({ error: 'postId required' });

      const likeResult = await pool.query('SELECT id FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, session.userId]);

      if (likeResult.rows.length > 0) {
        await pool.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, session.userId]);
        await pool.query('UPDATE forum_posts SET like_count = like_count - 1 WHERE id = $1', [postId]);

        const likeCountResult = await pool.query('SELECT like_count FROM forum_posts WHERE id = $1', [postId]);
        return res.json({ success: true, liked: false, likeCount: likeCountResult.rows[0].like_count });
      }

      return res.json({ success: true, liked: true, likeCount: null, message: 'Not liked yet' });
    }

    if (action === 'like_reply') {
      const { postId, replyId } = req.body;
      if (!postId || !replyId) return res.status(400).json({ error: 'postId and replyId required' });

      const checkLike = await pool.query('SELECT id FROM reply_likes WHERE reply_id = $1 AND user_id = $2', [replyId, session.userId]);

      if (checkLike.rows.length === 0) {
        await pool.query('INSERT INTO reply_likes (reply_id, user_id) VALUES ($1, $2)', [replyId, session.userId]);
        await pool.query('UPDATE forum_replies SET like_count = like_count + 1 WHERE id = $1', [replyId]);

        const likeCountResult = await pool.query('SELECT like_count FROM forum_replies WHERE id = $1', [replyId]);
        return res.json({ success: true, liked: true, likeCount: likeCountResult.rows[0].like_count });
      }

      return res.json({ success: true, liked: false, likeCount: null, message: 'Already liked' });
    }

    if (action === 'unlike_reply') {
      const { postId, replyId } = req.body;
      if (!postId || !replyId) return res.status(400).json({ error: 'postId and replyId required' });

      const likeResult = await pool.query('SELECT id FROM reply_likes WHERE reply_id = $1 AND user_id = $2', [replyId, session.userId]);

      if (likeResult.rows.length > 0) {
        await pool.query('DELETE FROM reply_likes WHERE reply_id = $1 AND user_id = $2', [replyId, session.userId]);
        await pool.query('UPDATE forum_replies SET like_count = like_count - 1 WHERE id = $1', [replyId]);

        const likeCountResult = await pool.query('SELECT like_count FROM forum_replies WHERE id = $1', [replyId]);
        return res.json({ success: true, liked: false, likeCount: likeCountResult.rows[0].like_count });
      }

      return res.json({ success: true, liked: true, likeCount: null, message: 'Not liked yet' });
    }

    if (action === 'delete_post') {
      const { postId } = req.body;
      if (!postId) return res.status(400).json({ error: 'postId required' });

      const postResult = await pool.query('SELECT author_id FROM forum_posts WHERE id = $1', [postId]);
      if (postResult.rows.length === 0) return res.status(404).json({ error: 'Post not found' });

      const post = postResult.rows[0];
      if (post.author_id !== session.userId && !verifyAdminToken(req.headers.authorization))
        return res.status(403).json({ error: 'Can only delete your own posts' });

      await pool.query('DELETE FROM forum_posts WHERE id = $1', [postId]);

      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('/api/forum error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════
// NOTICES API
// ════════════════════════════════════════════════

app.post('/api/notices', async (req, res) => {
  const { action } = req.body;

  try {
    if (action === 'list_notices') {
      const result = await pool.query(
        `SELECT * FROM notices WHERE expires_at IS NULL OR expires_at > NOW()
         ORDER BY created_at DESC`
      );
      return res.set('Cache-Control', 'public, max-age=60').json({ success: true, notices: result.rows });
    }

    if (action === 'get_notice') {
      const { noticeId } = req.body;
      if (!noticeId) return res.status(400).json({ error: 'noticeId required' });

      const result = await pool.query('SELECT * FROM notices WHERE id = $1', [noticeId]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Notice not found' });

      return res.json({ success: true, notice: result.rows[0] });
    }

    if (action === 'submit_ad_request') {
      const { businessName, adContent, contactPhone, contactEmail, budget, duration } = req.body;

      if (!businessName || !adContent || !contactPhone)
        return res.status(400).json({ error: 'Business name, ad content, and phone required' });
      if (businessName.length > 100 || adContent.length > 1000)
        return res.status(400).json({ error: 'Business name (100) or content (1000) too long' });
      if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))
        return res.status(400).json({ error: 'Invalid email address' });

      const requestId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO ad_requests (id, business_name, ad_content, contact_phone, contact_email, budget, duration)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [requestId, businessName.trim(), adContent.trim(), contactPhone.trim(), contactEmail?.trim() || null, budget || null, duration || '7 days']
      );

      return res.json({
        success: true,
        requestId,
        message: 'Ad request submitted. You will be contacted within 24 hours.'
      });
    }

    // Admin endpoints
    if (!verifyAdminToken(req.headers.authorization))
      return res.status(401).json({ error: 'Admin access required' });

    if (action === 'create_notice') {
      const { title, content, category, priority, expiresAt } = req.body;
      if (!title || !content) return res.status(400).json({ error: 'Title and content required' });

      const noticeId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO notices (id, title, content, category, priority, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [noticeId, title.trim(), content.trim(), category || 'general', priority || 'normal', expiresAt || null]
      );

      const notice = {
        id: noticeId, title, content, category: category || 'general', priority: priority || 'normal',
        created_at: new Date().toISOString(), expires_at: expiresAt || null
      };

      return res.json({ success: true, notice });
    }

    if (action === 'list_ad_requests') {
      const status = req.body.status || 'pending';
      const result = await pool.query(
        status === 'all'
          ? 'SELECT * FROM ad_requests ORDER BY submitted_at DESC'
          : 'SELECT * FROM ad_requests WHERE status = $1 ORDER BY submitted_at DESC',
        status === 'all' ? [] : [status]
      );

      return res.json({ success: true, requests: result.rows });
    }

    if (action === 'approve_ad_request') {
      const { requestId } = req.body;
      if (!requestId) return res.status(400).json({ error: 'requestId required' });

      const adResult = await pool.query('SELECT * FROM ad_requests WHERE id = $1', [requestId]);
      if (adResult.rows.length === 0) return res.status(404).json({ error: 'Ad request not found' });

      const ad = adResult.rows[0];

      await pool.query(
        'UPDATE ad_requests SET status = $2, reviewed_at = NOW(), reviewed_by = $3 WHERE id = $1',
        [requestId, 'approved', 'admin']
      );

      const noticeId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + getDurationMs(ad.duration));

      await pool.query(
        `INSERT INTO notices (id, title, content, category, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [noticeId, `[AD] ${ad.business_name}`, ad.ad_content, 'advertisement', expiresAt]
      );

      return res.json({ success: true, message: 'Ad approved and published' });
    }

    if (action === 'reject_ad_request') {
      const { requestId, reason } = req.body;
      if (!requestId) return res.status(400).json({ error: 'requestId required' });

      await pool.query(
        'UPDATE ad_requests SET status = $2, reviewed_at = NOW(), reviewed_by = $3, notes = $4 WHERE id = $1',
        [requestId, 'rejected', 'admin', reason || null]
      );

      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('/api/notices error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function getDurationMs(duration) {
  const days = parseInt(duration) || 7;
  return days * 24 * 60 * 60 * 1000;
}

// ════════════════════════════════════════════════
// M-PESA API
// ════════════════════════════════════════════════

const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  businessShortcode: process.env.MPESA_SHORTCODE,
  passkey: process.env.MPESA_PASSKEY,
  callbackUrl: process.env.MPESA_CALLBACK_URL || 'https://ngolibainfotrack.onrender.com/api/mpesa/callback'
};

let mpesaAccessToken = null;
let mpesaTokenExpiry = null;

const MPESA_AUTH_URL = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
const MPESA_STK_PUSH_URL = 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
const MPESA_STATUS_URL = 'https://sandbox.safaricom.co.ke/mpesa/transactionstatus/v1/query';

async function getMpesaAccessToken() {
  if (mpesaAccessToken && mpesaTokenExpiry && Date.now() < mpesaTokenExpiry) {
    return mpesaAccessToken;
  }

  try {
    const auth = Buffer.from(
      `${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`
    ).toString('base64');

    const response = await axios.get(MPESA_AUTH_URL, {
      headers: { Authorization: `Basic ${auth}` }
    });

    mpesaAccessToken = response.data.access_token;
    mpesaTokenExpiry = Date.now() + (response.data.expires_in * 1000) - 30000;
    return mpesaAccessToken;
  } catch (error) {
    console.error('M-Pesa token error:', error.response?.data || error.message);
    throw new Error('Failed to get M-Pesa access token');
  }
}

function formatPhoneNumber(phone) {
  return phone.replace(/^\+/, '').replace(/[^0-9]/g, '');
}

function getMpesaTimestamp() {
  const now = new Date();
  return now.toISOString()
    .replace(/[-:T.]/g, '')
    .slice(0, 14);
}

function generatePassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

app.post('/api/mpesa', async (req, res) => {
  const { action } = req.body;

  try {
    if (action === 'check_config') {
      const configured = !!(
        MPESA_CONFIG.consumerKey &&
        MPESA_CONFIG.consumerSecret &&
        MPESA_CONFIG.businessShortcode &&
        MPESA_CONFIG.passkey
      );
      return res.json({ success: true, configured });
    }

    if (action === 'initiate_stk_push') {
      if (!MPESA_CONFIG.consumerKey)
        return res.status(400).json({ error: 'M-Pesa not configured' });

      const { phone, amount, accountReference, description } = req.body;

      if (!phone || !amount)
        return res.status(400).json({ error: 'Phone and amount required' });

      const phoneFormatted = formatPhoneNumber(phone);
      if (!/^254\d{9}$/.test(phoneFormatted))
        return res.status(400).json({ error: 'Invalid phone number' });

      const parsedAmount = parseInt(amount);
      if (isNaN(parsedAmount) || parsedAmount < 1)
        return res.status(400).json({ error: 'Amount must be a positive number' });

      try {
        const token = await getMpesaAccessToken();
        const timestamp = getMpesaTimestamp();
        const password = generatePassword(MPESA_CONFIG.businessShortcode, MPESA_CONFIG.passkey, timestamp);

        const response = await axios.post(MPESA_STK_PUSH_URL, {
          BusinessShortCode: MPESA_CONFIG.businessShortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: parsedAmount,
          PartyA: phoneFormatted,
          PartyB: MPESA_CONFIG.businessShortcode,
          PhoneNumber: phoneFormatted,
          CallBackURL: MPESA_CONFIG.callbackUrl,
          AccountReference: accountReference || 'NGOLIBA',
          TransactionDesc: description || 'Ngoliba InfoTrack'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });

        const transactionId = response.data.CheckoutRequestID;

        await pool.query(
          `INSERT INTO mpesa_transactions (id, phone, amount, account_reference, description, respond_code, respond_description)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [transactionId, phoneFormatted, parsedAmount, accountReference || 'NGOLIBA', description || 'Ngoliba InfoTrack', response.data.ResponseCode, response.data.ResponseDescription]
        );

        return res.json({
          success: true,
          transactionId,
          respondCode: response.data.ResponseCode,
          message: response.data.ResponseDescription
        });
      } catch (mpesaError) {
        console.error('STK Push error:', mpesaError.response?.data || mpesaError.message);
        return res.status(500).json({
          error: 'Failed to initiate payment',
          details: mpesaError.response?.data?.errorMessage || mpesaError.message
        });
      }
    }

    if (action === 'check_status') {
      if (!MPESA_CONFIG.consumerKey)
        return res.status(400).json({ error: 'M-Pesa not configured' });

      const { transactionId } = req.body;
      if (!transactionId) return res.status(400).json({ error: 'transactionId required' });

      const txnResult = await pool.query('SELECT * FROM mpesa_transactions WHERE id = $1', [transactionId]);
      const transaction = txnResult.rows[0];

      if (transaction?.status !== 'pending') {
        return res.json({ success: true, transaction });
      }

      try {
        const token = await getMpesaAccessToken();
        const timestamp = getMpesaTimestamp();
        const password = generatePassword(MPESA_CONFIG.businessShortcode, MPESA_CONFIG.passkey, timestamp);

        const response = await axios.post(MPESA_STATUS_URL, {
          BusinessShortCode: MPESA_CONFIG.businessShortcode,
          CheckoutRequestID: transactionId,
          Password: password,
          Timestamp: timestamp
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (transaction) {
          await pool.query(
            'UPDATE mpesa_transactions SET respond_code = $2, respond_description = $3 WHERE id = $1',
            [transactionId, response.data.ResponseCode, response.data.ResponseDescription]
          );
        }

        return res.json({ success: true, transaction, mpesaStatus: response.data });
      } catch (mpesaError) {
        console.error('Status check error:', mpesaError.response?.data || mpesaError.message);
        return res.status(500).json({
          error: 'Failed to check status',
          details: mpesaError.response?.data?.errorMessage || mpesaError.message
        });
      }
    }

    if (action === 'get_history') {
      const phone = req.body.phone || '';
      const limit = Math.min(parseInt(req.body.limit || '20'), 100);

      const result = await pool.query(
        phone ? 'SELECT * FROM mpesa_transactions WHERE phone LIKE $1 ORDER BY created_at DESC LIMIT $2' : 'SELECT * FROM mpesa_transactions ORDER BY created_at DESC LIMIT $1',
        phone ? [`%${formatPhoneNumber(phone)}%`, limit] : [limit]
      );

      return res.json({ success: true, transactions: result.rows });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('/api/mpesa error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  res.status(200).json({ success: true });

  try {
    const { Body } = req.body;
    if (!Body || !Body.stkCallback) return;

    const callback = Body.stkCallback;
    const transactionId = callback.CheckoutRequestID;
    const resultCode = callback.ResultCode;
    const resultDesc = callback.ResultDesc;

    let status = 'failed';
    let mpesaReceiptNumber = null;

    if (resultCode === 0 && callback.CallbackMetadata) {
      status = 'completed';
      const metadata = callback.CallbackMetadata.Item.reduce((acc, item) => {
        acc[item.Name] = item.Value;
        return acc;
      }, {});
      mpesaReceiptNumber = metadata.MpesaReceiptNumber;
    }

    await pool.query(
      `UPDATE mpesa_transactions 
       SET status = $2, callback_data = $3::jsonb, callback_received_at = NOW(), mpesa_receipt_number = $4
       WHERE id = $1`,
      [transactionId, status, JSON.stringify(callback), mpesaReceiptNumber]
    );

    await pool.query(
      'INSERT INTO mpesa_callback_logs (transaction_id, result_code, result_desc, raw_data) VALUES ($1, $2, $3, $4::jsonb)',
      [transactionId, resultCode, resultDesc, JSON.stringify(callback)]
    );

    console.log('M-Pesa callback processed:', { transactionId, status, resultCode });
  } catch (e) {
    console.error('Callback processing error:', e);
  }
});

app.post('/api/mpesa/confirmation', async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ════════════════════════════════════════════════
// CATCH-ALL & ERROR HANDLING
// ════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`✅ Ngoliba InfoTrack server running on port ${PORT}`);
  console.log(`📚 Database: PostgreSQL connected`);
  console.log(`🔐 Session Secret: ${process.env.SESSION_SECRET ? '✓ Configured' : '✗ Missing'}`);
  console.log(`📱 M-Pesa: ${MPESA_CONFIG.consumerKey ? '✓ Configured' : '✗ Not configured'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    pool.end();
    process.exit(0);
  });
});