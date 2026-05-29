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
// notices routes are defined inline — no separate router file needed

const app = express();
const PORT = process.env.PORT || 10000;

// ── PostgreSQL Connection Pool ──
// Increased timeout for Render's free tier (which hibernates)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 60000, // ✅ INCREASED FROM 15s to 60s
  statement_timeout: 30000,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('error', (err) => {
  console.error('Database error:', err);
});


// ── Initialize Database Tables ──
// ✅ NOW WITH BETTER ERROR HANDLING & SKIP IF TABLES EXIST
async function initDB() {
  try {
    // First, check if tables already exist
    const checkResult = await pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'users'
      )`
    );
    
    if (checkResult.rows[0].exists) {
      console.log('✅ Database tables already exist - skipping initialization');
      return;
    }
    
    console.log('📝 Creating database tables...');
    
    // Create UUID extension
    await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    
    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        phone VARCHAR(20) UNIQUE NOT NULL,
        first_name VARCHAR(50),
        surname VARCHAR(50),
        dob DATE,
        sublocation VARCHAR(100),
        email VARCHAR(255),
        national_id VARCHAR(20),
        language VARCHAR(10) DEFAULT 'en',
        voter_number BIGINT UNIQUE,
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
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  category VARCHAR(20) DEFAULT 'general',
  priority VARCHAR(10) DEFAULT 'normal',
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  is_archived BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_notices_archived ON notices(is_archived);
CREATE INDEX IF NOT EXISTS idx_notices_expires ON notices(expires_at);
      CREATE TABLE IF NOT EXISTS ad_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
    
    // ✅ FIX 2: Create indexes for better query performance
    console.log('📊 Creating database indexes...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_notices_category ON notices(category);
      CREATE INDEX IF NOT EXISTS idx_notices_priority ON notices(priority);
      CREATE INDEX IF NOT EXISTS idx_notices_expires ON notices(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_notices_created ON notices(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notices_archived ON notices(is_archived);
    `);
    
    // ✅ FIX 3: Insert sample notices data for testing
    console.log('📋 Seeding sample notices...');
    const noticeCount = await pool.query('SELECT COUNT(*) FROM notices');
    if (parseInt(noticeCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO notices (title, content, category, priority, expires_at, created_by) VALUES
        (
          'Ngoliba Farmers Market - Every Saturday',
          'Fresh produce, dairy, and crafts from local farmers. Open 7AM-1PM at the Ngoliba Market grounds. Bulk orders welcome. Contact: 0712 111 222',
          'business',
          'normal',
          NOW() + INTERVAL '90 days',
          'system'
        ),
        (
          'Water Rationing Notice - Kilimambogo',
          'Kenya Water Authority advises that Kilimambogo sublocation will experience reduced water supply Mon-Wed for 30 days due to pipeline maintenance. Residents should store water accordingly. Helpline: 0800 723 232',
          'public',
          'high',
          NOW() + INTERVAL '30 days',
          'system'
        ),
        (
          'Boda Boda Riders Wanted - Ngoliba Express',
          'Ngoliba Express Logistics is recruiting 10 boda boda riders for parcel delivery. Must have valid licence. Earn KES 800-1,500 daily. Apply in person at Ngoliba Town Centre. Contact: 0798 456 789',
          'jobs',
          'normal',
          NOW() + INTERVAL '60 days',
          'system'
        ),
        (
          'Community Health Camp - Mwea Ward',
          'Free health screening and vaccination services. Dates: First Saturday of every month. Location: Mwea Ward Market. Services: Blood pressure check, BMI assessment, Immunizations. Bring ID. Contact: 0789 654 321',
          'health',
          'normal',
          NOW() + INTERVAL '120 days',
          'system'
        ),
        (
          'Road Maintenance - Ngoliba-Ruiru Highway',
          'Notice: The Ngoliba-Ruiru main highway will be under maintenance from June 15-22, 2024. Expect delays. Alternative routes recommended. Updates: www.krb.go.ke',
          'public',
          'high',
          NOW() + INTERVAL '45 days',
          'system'
        );
      `);
      console.log('✅ Sample notices inserted');
    }
    
    // Initialize metadata
    await pool.query(
      `INSERT INTO metadata (key, value) VALUES ('counters', '{"last_voter_number": 0, "registered_voters": 0, "last_period_id": 0}')
       ON CONFLICT (key) DO NOTHING`
    );
    
    console.log('✅ All tables initialized');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    // Don't exit - database might already exist
    // Just log the error and continue
  }
}

// ── Ensure notices table exists (runs every startup, independent of initDB early-exit) ──
async function ensureNoticesTable() {
  try {
    // Detect whether 'id' column is UUID or SERIAL so we handle both schema versions
    const idTypeResult = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'notices' AND column_name = 'id'
    `);
    const idIsUuid = idTypeResult.rows.length > 0 && idTypeResult.rows[0].data_type === 'uuid';

    // Create table only if it does not exist (idempotent)
    if (idIsUuid) {
      // Existing DB has UUID id — keep as-is, do not recreate
      console.log('✅ notices table exists (UUID id schema)');
    } else {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notices (
          id SERIAL PRIMARY KEY,
          title VARCHAR(200) NOT NULL,
          content TEXT NOT NULL,
          category VARCHAR(20) DEFAULT 'general',
          priority VARCHAR(10) DEFAULT 'normal',
          created_by VARCHAR(100),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          expires_at TIMESTAMP,
          is_archived BOOLEAN DEFAULT false
        )
      `);
    }

    // ── Column migrations: add any columns missing from older schema versions ──
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMP DEFAULT NOW()`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS created_by  VARCHAR(100)`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS priority    VARCHAR(10) DEFAULT 'normal'`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS category    VARCHAR(20) DEFAULT 'general'`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMP`);
    console.log('✅ notices columns verified/migrated');

    // Indexes (all IF NOT EXISTS — safe to re-run)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_archived ON notices(is_archived)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_expires  ON notices(expires_at) WHERE expires_at IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_category ON notices(category)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_priority ON notices(priority)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_created  ON notices(created_at DESC)`);

    // Seed only if table is empty — isolated so a seed failure never blocks startup
    try {
      const { rows } = await pool.query('SELECT COUNT(*) AS count FROM notices');
      if (parseInt(rows[0].count) === 0) {
        if (idIsUuid) {
          // UUID id schema: supply explicit gen_random_uuid() for each row
          await pool.query(`
            INSERT INTO notices (id, title, content, category, priority, expires_at, created_by) VALUES
            (gen_random_uuid(), 'Ngoliba Farmers Market - Every Saturday',
             'Fresh produce, dairy, and crafts from local farmers. Open 7AM-1PM at Ngoliba Market grounds.',
             'business', 'normal', NOW() + INTERVAL '90 days', 'system'),
            (gen_random_uuid(), 'Water Rationing Notice - Kilimambogo',
             'Kenya Water Authority advises reduced supply Mon-Wed for 30 days. Store water. Helpline: 0800 723 232',
             'public', 'high', NOW() + INTERVAL '30 days', 'system'),
            (gen_random_uuid(), 'Boda Boda Riders Wanted - Ngoliba Express',
             'Ngoliba Express recruiting 10 boda boda riders. Valid licence required. Earn KES 800-1,500/day. Apply: Ngoliba Town Centre.',
             'jobs', 'normal', NOW() + INTERVAL '60 days', 'system'),
            (gen_random_uuid(), 'Community Health Camp - Mwea Ward',
             'Free health screening and vaccination. First Saturday every month, Mwea Ward Market. Bring ID.',
             'health', 'normal', NOW() + INTERVAL '120 days', 'system'),
            (gen_random_uuid(), 'Road Maintenance - Ngoliba-Ruiru Highway',
             'Ngoliba-Ruiru highway under maintenance June 15-22. Expect delays. Use alternative routes.',
             'public', 'high', NOW() + INTERVAL '45 days', 'system')
          `);
        } else {
          // SERIAL id schema: omit id, let the sequence handle it
          await pool.query(`
            INSERT INTO notices (title, content, category, priority, expires_at, created_by) VALUES
            ('Ngoliba Farmers Market - Every Saturday',
             'Fresh produce, dairy, and crafts from local farmers. Open 7AM-1PM at Ngoliba Market grounds.',
             'business', 'normal', NOW() + INTERVAL '90 days', 'system'),
            ('Water Rationing Notice - Kilimambogo',
             'Kenya Water Authority advises reduced supply Mon-Wed for 30 days. Store water. Helpline: 0800 723 232',
             'public', 'high', NOW() + INTERVAL '30 days', 'system'),
            ('Boda Boda Riders Wanted - Ngoliba Express',
             'Ngoliba Express recruiting 10 boda boda riders. Valid licence required. Earn KES 800-1,500/day. Apply: Ngoliba Town Centre.',
             'jobs', 'normal', NOW() + INTERVAL '60 days', 'system'),
            ('Community Health Camp - Mwea Ward',
             'Free health screening and vaccination. First Saturday every month, Mwea Ward Market. Bring ID.',
             'health', 'normal', NOW() + INTERVAL '120 days', 'system'),
            ('Road Maintenance - Ngoliba-Ruiru Highway',
             'Ngoliba-Ruiru highway under maintenance June 15-22. Expect delays. Use alternative routes.',
             'public', 'high', NOW() + INTERVAL '45 days', 'system')
          `);
        }
        console.log('✅ notices table seeded with sample data');
      }
    } catch (seedErr) {
      console.error('❌ notices seed error (non-fatal):', seedErr.message);
    }
    console.log('✅ notices table ready');
  } catch (err) {
    console.error('❌ ensureNoticesTable error:', err.message);
  }
}

// Test database connection
async function testDBConnection() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected at:', res.rows[0].now);
    return true;
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('   Make sure DATABASE_URL in .env is correct');
    console.error('   And that Render PostgreSQL instance is running');
    return false;
  }
}

app.use((req, res, next) => {
  req.pool = pool;
  next();
});


// Initialize on startup
(async () => {
  const connected = await testDBConnection();
  if (connected) {
    await initDB();
    await ensureNoticesTable();
    await ensureActivePeriod();
  } else {
    console.warn('⚠️  Continuing without database. Some features may not work.');
  }
})();

// ── Ensure Active Voting Period ──
async function ensureActivePeriod() {
  try {
    const existing = await pool.query(
      'SELECT * FROM voting_periods WHERE is_active = true LIMIT 1'
    );
    
    if (existing.rows.length === 0) {
      console.log('📝 Creating initial voting period...');
      const now = new Date();
      const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours from now
      
      await pool.query(`
        INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
        VALUES (
          COALESCE((SELECT MAX(id) FROM voting_periods), 0) + 1,
          $1, $2, true, 0
        )
      `, [now, endTime]);
      
      console.log('✅ Active voting period created');
    } else {
      console.log('✅ Active voting period already exists');
    }
  } catch (e) {
    console.error('Failed to ensure active period:', e);
  }
}

// ── Middleware ──
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
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
  { id: 0, name: 'Hon. James Mwangi', party: 'Jubilee', bio: 'Incumbent MCA, serving second term.', img: 'https://ui-avatars.com/api/?name=James+Mwangi&background=0d2818&color=40c27a&size=120' },
  { id: 1, name: 'Grace Wanjiku',     party: 'ODM',     bio: 'Community health advocate.', img: 'https://ui-avatars.com/api/?name=Grace+Wanjiku&background=1a3f28&color=e9c46a&size=120' },
  { id: 2, name: 'Peter Kimani',      party: 'UDA',     bio: 'Former ward administrator.', img: 'https://ui-avatars.com/api/?name=Peter+Kimani&background=2d6a4f&color=fff&size=120' },
  { id: 3, name: 'Sarah Nduati',      party: 'Wiper',   bio: 'Women rights campaigner.', img: 'https://ui-avatars.com/api/?name=Sarah+Nduati&background=4361ee&color=fff&size=120' },
  { id: 4, name: 'John Otieno',       party: 'ANC',     bio: 'Youth empowerment champion.', img: 'https://ui-avatars.com/api/?name=John+Otieno&background=e63946&color=fff&size=120' },
  { id: 5, name: 'Mary Wambui',       party: 'Ford-K',  bio: 'Education sector advocate.', img: 'https://ui-avatars.com/api/?name=Mary+Wambui&background=c9a027&color=fff&size=120' },
  { id: 6, name: 'David Kiprotich',   party: 'Independent', bio: 'Farmer and entrepreneur.', img: 'https://ui-avatars.com/api/?name=David+Kiprotich&background=6b7280&color=fff&size=120' }
];

// ════════════════════════════════════════════════
// ROUTE: /api/candidates (PUBLIC - NO AUTH REQUIRED)
// ════════════════════════════════════════════════
app.get('/api/candidates', (req, res) => {
  try {
    return res.json({ 
      success: true, 
      candidates: CANDIDATES 
    });
  } catch (e) {
    console.error('/api/candidates error:', e);
    return res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/me
// ════════════════════════════════════════════════
app.get('/api/me', async (req, res) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const sessionMatch = cookieHeader.match(/session=([^;]*)/);
    const sessionToken = sessionMatch ? sessionMatch[1] : null;
    
    if (!sessionToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const session = verifySession(sessionToken);
    if (!session) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    
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

// ════════════════════════════════════════════════
// ROUTE: /api/auth
// ════════════════════════════════════════════════
app.post('/api/auth', async (req, res) => {
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
    const periodResult = await pool.query(
      'SELECT * FROM voting_periods WHERE id = $1 AND is_active = true',
      [periodId]
    );
    if (periodResult.rows.length === 0)
      return res.status(400).json({ error: 'Voting period not found or inactive' });

    const period = periodResult.rows[0];
    if (new Date(period.period_end) <= new Date())
      return res.status(400).json({ error: 'Voting period has ended' });

    const voteCheck = await pool.query(
      'SELECT id FROM votes WHERE user_id = $1 AND period_id = $2',
      [session.userId, periodId]
    );
    if (voteCheck.rows.length > 0)
      return res.status(400).json({ error: 'Already voted this period' });

    const userResult = await pool.query(
      'SELECT sublocation FROM users WHERE id = $1',
      [session.userId]
    );
    const user = userResult.rows[0];

    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);

    await pool.query(
      `INSERT INTO votes (user_id, candidate_id, period_id, sublocation, ip_hash, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [session.userId, candidateId, periodId, user?.sublocation || null, ipHash, Date.now()]
    );

    await pool.query(
      `UPDATE voting_periods SET total_votes = total_votes + 1 WHERE id = $1`,
      [periodId]
    );

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
        .json({ 
          periodId: null, 
          totalVotes: 0, 
          votesByCandidate: {}, 
          isActive: false 
        });
    }

    const period = periodResult.rows[0];
    const votesResult = await pool.query(
      'SELECT candidate_id, sublocation, COUNT(*) as count FROM votes WHERE period_id = $1 GROUP BY candidate_id, sublocation',
      [period.id]
    );

    // Build structure with sublocations and total
    const votesByCandidate = {};
    votesResult.rows.forEach(row => {
      if (!votesByCandidate[row.candidate_id]) {
        votesByCandidate[row.candidate_id] = { 
          total: 0, 
          sublocations: {} 
        };
      }
      const count = parseInt(row.count);
      votesByCandidate[row.candidate_id].total += count;
      const sublocKey = row.sublocation || 'Unknown';
      votesByCandidate[row.candidate_id].sublocations[sublocKey] = count;
    });

    return res
      .set('Cache-Control', 'public, max-age=5')
      .json({
        periodId: period.id,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        isActive: period.is_active,
        totalVotes: parseInt(period.total_votes),
        votesByCandidate: votesByCandidate,
        votesByUser: []
      });
  } catch (e) {
    console.error('/api/polling-results error:', e);
    return res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/history
// ════════════════════════════════════════════════
app.get('/api/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const periodsResult = await pool.query(`
      SELECT id, period_start, period_end, total_votes 
      FROM voting_periods 
      ORDER BY id DESC 
      LIMIT $1
    `, [limit]);
    
    const periods = [];
    for (const period of periodsResult.rows) {
      const votesResult = await pool.query(
        'SELECT candidate_id, sublocation, COUNT(*) as count FROM votes WHERE period_id = $1 GROUP BY candidate_id, sublocation',
        [period.id]
      );
      
      const votesByCandidate = {};
      votesResult.rows.forEach(row => {
        if (!votesByCandidate[row.candidate_id]) {
          votesByCandidate[row.candidate_id] = { total: 0, sublocations: {} };
        }
        const count = parseInt(row.count);
        votesByCandidate[row.candidate_id].total += count;
        votesByCandidate[row.candidate_id].sublocations[row.sublocation || 'Unknown'] = count;
      });
      
      periods.push({
        periodId: period.id,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        totalVotes: period.total_votes,
        votesByCandidate: votesByCandidate
      });
    }
    
    return res.json({ success: true, periods });
  } catch (e) {
    console.error('/api/history error:', e);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ════════════════════════════════════════════════
// CATCH-ALL & ERROR HANDLING
// ════════════════════════════════════════════════

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ════════════════════════════════════════════════════════════════════════════
// MISSING ENDPOINTS - Add these
// ════════════════════════════════════════════════════════════════════════════

// GET /api/stats - Return voting statistics
// GET /api/stats - Return voting statistics
app.get('/api/stats', async (req, res) => {
  try {
    // Get registered voters count
    const votersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const registeredVoters = parseInt(votersResult.rows[0].count || 0);
    
    // Get votes by candidate
    const votesResult = await pool.query(`
      SELECT candidate_id, COUNT(*) as vote_count 
      FROM votes 
      GROUP BY candidate_id
    `);
    
    const votesByCandidate = {};
    votesResult.rows.forEach(row => {
      votesByCandidate[row.candidate_id] = parseInt(row.vote_count);
    });
    
    // Return stats
    res.json({
      success: true,
      registeredVoters: registeredVoters,
      currentPeriod: {
        totalVotes: Object.values(votesByCandidate).reduce((a, b) => a + b, 0),
        votesByCandidate: votesByCandidate
      },
      votersBySubLocation: {
        'Ngoliba': 0,
        'Gatiiguru': 0,
        'Kilimambogo': 0,
        'Magogoni': 0
      }
    });
  } catch (error) {
    console.error('/api/stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forum - List forum posts
app.get('/api/forum', async (req, res) => {
  try {
    const posts = await pool.query('SELECT * FROM forum_posts ORDER BY created_at DESC LIMIT 50');
    res.json({
      success: true,
      posts: posts.rows.map(p => ({
        id: p.id,
        author: p.author_name || 'Anonymous',
        text: p.content,
        tag: p.tag || 'general',
        likes: p.likes || 0,
        created_at: p.created_at
      }))
    });
  } catch (error) {
    console.error('/api/forum error:', error);
    res.status(500).json({ success: false, error: 'Failed to get forum posts' });
  }
});

// POST /api/forum - Create forum post
app.post('/api/forum', async (req, res) => {
  const { action, text, tag, postId } = req.body;
  
  if (action === 'create_post') {
    try {
      const session = verifySession(req.headers.cookie || '');
      if (!session) return res.status(401).json({ error: 'Unauthorized' });
      
      const user = await pool.query('SELECT first_name, surname FROM users WHERE phone = $1', [session.phone]);
      const author = user.rows[0] ? `${user.rows[0].first_name} ${user.rows[0].surname}` : 'Anonymous';
      
      const post = await pool.query(
        'INSERT INTO forum_posts (author_name, content, tag) VALUES ($1, $2, $3) RETURNING *',
        [author, text, tag || 'general']
      );
      
      res.json({
        success: true,
        post: post.rows[0]
      });
    } catch (error) {
      console.error('/api/forum create error:', error);
      res.status(500).json({ success: false, error: 'Failed to create post' });
    }
  }
  
  if (action === 'list_posts') {
    try {
      const posts = await pool.query('SELECT * FROM forum_posts ORDER BY created_at DESC LIMIT 50');
      res.json({
        success: true,
        posts: posts.rows.map(p => ({
          id: p.id,
          author: p.author_name || 'Anonymous',
          text: p.content,
          tag: p.tag || 'general',
          likes: p.likes || 0,
          created_at: p.created_at
        }))
      });
    } catch (error) {
      console.error('/api/forum list error:', error);
      res.status(500).json({ success: false, error: 'Failed to get forum posts' });
    }
  }
  
  if (action === 'like_post') {
    try {
      await pool.query('UPDATE forum_posts SET likes = likes + 1 WHERE id = $1', [postId]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to like post' });
    }
  }
});

// GET /api/faceoff - Get top 2 candidates
app.get('/api/faceoff', async (req, res) => {
  try {
    const candidates = await pool.query('SELECT * FROM candidates ORDER BY id LIMIT 2');
    res.json({
      success: true,
      candidates: candidates.rows
    });
  } catch (error) {
    console.error('/api/faceoff error:', error);
    res.status(500).json({ success: false, error: 'Failed to get faceoff data' });
  }
});


// ══════════════════════════════════════════════
// GET /api/notices — fetch all active notices
// ══════════════════════════════════════════════
app.get('/api/notices', async (req, res) => {
  try {
    const { cat } = req.query;
    let result;
    if (cat && cat !== 'all') {
      result = await pool.query(
        `SELECT * FROM notices
         WHERE (expires_at IS NULL OR expires_at > NOW())
           AND category = $1
         ORDER BY
           CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           created_at DESC`,
        [cat]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM notices
         WHERE (expires_at IS NULL OR expires_at > NOW())
         ORDER BY
           CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           created_at DESC`
      );
    }
    res.json({ success: true, notices: result.rows });
  } catch (error) {
    console.error('/api/notices GET error:', error);
    res.status(500).json({ success: false, notices: [], error: error.message });
  }
});

// ══════════════════════════════════════════════
// POST /api/notices — admin: add a new notice
// ══════════════════════════════════════════════
app.post('/api/notices', async (req, res) => {
  try {
    const { title, content, category, priority, days, adminSecret } = req.body;
    const secret = process.env.ADMIN_SECRET || 'ngoliba2025admin';
    if (adminSecret !== secret) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    if (!title || !content) {
      return res.status(400).json({ success: false, error: 'title and content are required' });
    }
    const result = await pool.query(
      `INSERT INTO notices (title, content, category, priority, expires_at, created_by)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::INTERVAL, 'admin')
       RETURNING *`,
      [title, content, category || 'general', priority || 'normal', String(days || 30)]
    );
    res.json({ success: true, notice: result.rows[0] });
  } catch (error) {
    console.error('/api/notices POST error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/notices/:id — admin: remove a notice
app.delete('/api/notices/:id', async (req, res) => {
  try {
    const { adminSecret } = req.body;
    const secret = process.env.ADMIN_SECRET || 'ngoliba2025admin';
    if (adminSecret !== secret) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    await pool.query('DELETE FROM notices WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
app.post('/api/admin', async (req, res) => {
  const { action, password, token } = req.body;

  // ✅ admin_login action
  if (action === 'admin_login') {
    const adminHash = process.env.ADMIN_PASSWORD_HASH;
    const inputHash = crypto.createHash('sha256').update(password).digest('hex').toUpperCase();

    console.log('[DEBUG] admin_login attempt');
    console.log('  - Password received (length):', password?.length || 'undefined');
    console.log('  - Input hash:', inputHash);
    console.log('  - Stored hash:', adminHash);
    console.log('  - Stored hash (uppercase):', adminHash?.toUpperCase());
    console.log('  - Hashes match:', inputHash === adminHash?.toUpperCase());

    if (!adminHash || inputHash !== adminHash.toUpperCase()) {
      console.log('[DEBUG] Login FAILED - hash mismatch or missing env var');
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }
    console.log('[DEBUG] Login SUCCESS - generating token');

    const payload = { role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest('base64');
    return res.json({ success: true, token: `${payloadB64}.${sig}` });
  }

  // ✅ For other actions, accept token from body or Authorization header
  const authToken = token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!authToken) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  // ✅ GET STATS - Fixed column names (period_start, period_end instead of created_at, ends_at)
if (action === 'get_stats') {
  try {
    const voters = await pool.query('SELECT COUNT(*) as count FROM users');
    const period = await pool.query('SELECT * FROM voting_periods WHERE is_active = true ORDER BY period_start DESC LIMIT 1');
    const votes = period.rows.length ? 
      await pool.query('SELECT COUNT(*) as count FROM votes WHERE period_id = $1', [period.rows[0].id]) : 
      { rows: [{ count: 0 }] };

    return res.json({
      success: true,
      registeredVoters: parseInt(voters.rows[0].count),
      currentPeriod: period.rows.length ? {
        periodId: period.rows[0].id,
        totalVotes: parseInt(votes.rows[0].count),
        startTime: period.rows[0].period_start,
        endTime: period.rows[0].period_end
      } : null
    });
  } catch (error) {
    console.error('Error in get_stats:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

 // ✅ GET PERIODS - Fixed column references
if (action === 'get_periods') {
  try {
    const result = await pool.query('SELECT id, period_start, period_end, is_active FROM voting_periods ORDER BY period_start DESC LIMIT 50');
    return res.json({ success: true, periods: result.rows });
  } catch (error) {
    console.error('Error in get_periods:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
  // ✅ GET USERS - Removed non-existent civic_score column
if (action === 'get_users') {
  try {
    const result = await pool.query('SELECT id, phone, first_name, surname, sublocation, created_at FROM users ORDER BY created_at DESC LIMIT 100');
    return res.json({ success: true, users: result.rows, total: result.rowCount });
  } catch (error) {
    console.error('Error in get_users:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

  // ✅ ADD PERIOD - Fixed INSERT and RETURNING clauses
if (action === 'add_period') {
  const { durationDays } = req.body;
  if (!durationDays) return res.status(400).json({ success: false, error: 'Duration required' });
  try {
    const result = await pool.query(
      `INSERT INTO voting_periods (period_start, period_end, is_active) 
       VALUES (NOW(), NOW() + ($1 || ' days')::INTERVAL, true) 
       RETURNING id, period_start, period_end, is_active`,
      [durationDays]
    );
    return res.json({ success: true, period: result.rows[0] });
  } catch (error) {
    console.error('Error in add_period:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
// ✅ END PERIOD
if (action === 'end_period') {
  const { periodId } = req.body;
  if (!periodId) return res.status(400).json({ success: false, error: 'Period ID required' });
  try {
    await pool.query('UPDATE voting_periods SET is_active = false WHERE id = $1', [periodId]);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error in end_period:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
  // ✅ DELETE USER
if (action === 'delete_user') {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });
  try {
    await pool.query('DELETE FROM users WHERE phone = $1', [phone]);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error in delete_user:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// Default: Unknown action
return res.status(400).json({ success: false, error: 'Unknown action' });
});

// Add this right before the app.listen() line (around line 980):
app.get('/api/debug/check-env', (req, res) => {
  res.json({
    ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH ? 'SET (length: ' + process.env.ADMIN_PASSWORD_HASH.length + ')' : 'NOT SET',
    SESSION_SECRET: process.env.SESSION_SECRET ? 'SET' : 'NOT SET',
    DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT SET',
    NODE_ENV: process.env.NODE_ENV
  });
});

// ── Catch-all: serve index.html for any unmatched GET ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`✅ Ngoliba InfoTrack server running on port ${PORT}`);
  console.log(`📚 Database: PostgreSQL (check connection above)`);
  console.log(`🔐 Session Secret: ${process.env.SESSION_SECRET ? '✓ Configured' : '✗ Missing'}`);
  console.log(`📱 M-Pesa: ${process.env.MPESA_CONSUMER_KEY ? '✓ Configured' : '✗ Not configured'}`);
  console.log(`\n🌐 Access the app at: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    pool.end();
    process.exit(0);
  });
});