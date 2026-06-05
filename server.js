// server.js — Ngoliba InfoTrack
// PostgreSQL version (no Netlify dependency)
// Production-ready for Render
require('dotenv').config();
const analyticsRouter = require('./routes/analytics');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');
// notices routes are defined inline — no separate router file needed

// ── PHASE 2: Voting Router ──
const votingRouterModule = require('./routes/voting');
const votingRouter          = votingRouterModule.router || votingRouterModule;
const broadcastVoteUpdate   = votingRouterModule.broadcastVoteUpdate || function(){};

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
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    // ── Column migrations: idempotent, run every startup ──
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMP DEFAULT NOW()`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS created_by  VARCHAR(100)`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS priority    VARCHAR(10) DEFAULT 'normal'`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS category    VARCHAR(20) DEFAULT 'general'`);
    await pool.query(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMP`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_archived  ON notices(is_archived)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_expires   ON notices(expires_at) WHERE expires_at IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_category  ON notices(category)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_priority  ON notices(priority)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notices_created   ON notices(created_at DESC)`);

    // ✅ Ensure ad_requests table exists with the correct UUID default (no uuid-ossp dependency)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ad_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_name VARCHAR(100),
        ad_content TEXT,
        contact_phone VARCHAR(20),
        contact_email VARCHAR(255),
        budget VARCHAR(50),
        duration VARCHAR(50) DEFAULT '7 days',
        status VARCHAR(20) DEFAULT 'pending',
        fee INTEGER DEFAULT 0,
        submitted_by_phone VARCHAR(20),
        submitted_at TIMESTAMP DEFAULT NOW(),
        reviewed_at TIMESTAMP,
        reviewed_by VARCHAR(50),
        notes TEXT
      )
    `);
    // Fix the default on existing deployments where uuid_generate_v4() was used
    await pool.query(`
      ALTER TABLE ad_requests
        ALTER COLUMN id SET DEFAULT gen_random_uuid()
    `);
    // Migrations for existing deployments
    await pool.query(`ALTER TABLE ad_requests ADD COLUMN IF NOT EXISTS fee INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE ad_requests ADD COLUMN IF NOT EXISTS submitted_by_phone VARCHAR(20)`);
    await pool.query(`ALTER TABLE ad_requests ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE ad_requests ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT 'general'`);

    // Seed sample notices only if table is empty
    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM notices');
    if (parseInt(rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO notices (title, content, category, priority, expires_at, created_by) VALUES
        ('Ngoliba Farmers Market - Every Saturday',
         'Fresh produce, dairy, and crafts from local farmers. Open 7AM-1PM at the Ngoliba Market grounds.',
         'business', 'normal', NOW() + INTERVAL '90 days', 'system'),
        ('Water Rationing Notice - Kilimambogo',
         'Kenya Water Authority advises reduced supply Mon-Wed for 30 days due to pipeline maintenance. Store water accordingly. Helpline: 0800 723 232',
         'public', 'high', NOW() + INTERVAL '30 days', 'system'),
        ('Boda Boda Riders Wanted - Ngoliba Express',
         'Ngoliba Express Logistics recruiting 10 boda boda riders for parcel delivery. Must have valid licence. Earn KES 800-1,500 daily. Apply: Ngoliba Town Centre.',
         'jobs', 'normal', NOW() + INTERVAL '60 days', 'system'),
        ('Community Health Camp - Mwea Ward',
         'Free health screening and vaccination. First Saturday of every month, Mwea Ward Market. Bring ID.',
         'health', 'normal', NOW() + INTERVAL '120 days', 'system'),
        ('Road Maintenance - Ngoliba-Ruiru Highway',
         'The Ngoliba-Ruiru highway will be under maintenance June 15-22. Expect delays. Use alternative routes.',
         'public', 'high', NOW() + INTERVAL '45 days', 'system')
      `);
      console.log('✅ notices table seeded with sample data');
    }
    console.log('✅ notices table ready');

    // ── AVATAR COLUMN MIGRATION ──
    // profile_photo may be BYTEA (original schema) or TEXT (already migrated).
    // Query the actual column type first — never call convert_from on TEXT.
    try {
      const colType = await pool.query(`
        SELECT data_type
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'users'
           AND column_name  = 'profile_photo'
      `);
      const currentType = colType.rows[0]?.data_type || '';
      if (currentType === 'bytea') {
        await pool.query(`
          ALTER TABLE users
            ALTER COLUMN profile_photo TYPE TEXT
            USING convert_from(profile_photo, 'UTF8')
        `);
        console.log('\u2705 profile_photo column migrated BYTEA \u2192 TEXT');
      } else {
        console.log(`\u2705 profile_photo column already ${currentType || 'unknown'} \u2014 no migration needed`);
      }
    } catch (migErr) {
      console.warn('\u26a0\ufe0f  profile_photo migration skipped:', migErr.message);
    }
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
    await ensureVotingPeriodsTable();  // ← must run BEFORE ensureActivePeriod so schema is ready
    await ensureActivePeriod();        // now a no-op alias for backward compat
  } else {
    console.warn('⚠️  Continuing without database. Some features may not work.');
  }
})();

// ── Ensure voting_periods table exists with correct schema ──
async function ensureVotingPeriodsTable() {
  try {
    // 1. Create with full schema if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS voting_periods (
        id           INT PRIMARY KEY,
        period_start TIMESTAMP,
        period_end   TIMESTAMP,
        is_active    BOOLEAN DEFAULT true,
        total_votes  INT DEFAULT 0,
        winner_id    INT,
        winner_votes INT DEFAULT 0
      )
    `);

    // 2. Idempotent column migrations — add anything that might be missing
    const cols = [
      `ALTER TABLE voting_periods ADD COLUMN IF NOT EXISTS winner_id    INT`,
      `ALTER TABLE voting_periods ADD COLUMN IF NOT EXISTS winner_votes INT DEFAULT 0`,
      `ALTER TABLE voting_periods ADD COLUMN IF NOT EXISTS total_votes  INT DEFAULT 0`,
      `ALTER TABLE voting_periods ADD COLUMN IF NOT EXISTS is_active    BOOLEAN DEFAULT true`,
      `ALTER TABLE voting_periods ADD COLUMN IF NOT EXISTS period_start TIMESTAMP`,
      `ALTER TABLE voting_periods ADD COLUMN IF NOT EXISTS period_end   TIMESTAMP`,
    ];
    for (const sql of cols) {
      try { await pool.query(sql); } catch (_) { /* already exists */ }
    }

    // 3. Also ensure votes table exists (may be absent on fresh DB after early-exit initDB)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS votes (
        id           SERIAL PRIMARY KEY,
        user_id      UUID,
        candidate_id INT,
        period_id    INT,
        sublocation  VARCHAR(100),
        ip_hash      VARCHAR(32),
        timestamp    BIGINT
      )
    `);
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_votes_candidate ON votes (candidate_id)`); } catch(_){}
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_votes_user_period ON votes (user_id, period_id)`); } catch(_){}
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_votes_period ON votes (period_id)`); } catch(_){}

    // 4. Also ensure period_archives table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS period_archives (
        id          INT PRIMARY KEY,
        period_data JSONB,
        archived_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 5. Index for fast active-period look-ups
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_voting_periods_active
          ON voting_periods (is_active)
          WHERE is_active = true
      `);
    } catch (_) {}

    console.log('\u2705 voting_periods table ready');

    // 6. Ensure there is always exactly one active period
    const existing = await pool.query(
      'SELECT id, period_end FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );

    if (existing.rows.length === 0) {
      console.log('\ud83d\udcdd No active voting period — creating one...');
      const now     = new Date();
      const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

      const maxIdRes = await pool.query('SELECT COALESCE(MAX(id), 0) AS maxid FROM voting_periods');
      const nextId   = parseInt(maxIdRes.rows[0].maxid) + 1;

      await pool.query(
        `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
         VALUES ($1, $2, $3, true, 0)`,
        [nextId, now, endTime]
      );
      console.log(`\u2705 Active voting period created (id=${nextId}, ends ${endTime.toISOString()})`);
    } else {
      const period = existing.rows[0];
      const isExpired = new Date(period.period_end) < new Date();
      if (isExpired) {
        // Close the expired period and open a fresh one
        console.log(`\u26a0\ufe0f  Period ${period.id} has expired — closing and creating new one`);
        await pool.query(`UPDATE voting_periods SET is_active = false WHERE id = $1`, [period.id]);

        const now     = new Date();
        const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const maxIdRes = await pool.query('SELECT COALESCE(MAX(id), 0) AS maxid FROM voting_periods');
        const nextId   = parseInt(maxIdRes.rows[0].maxid) + 1;

        await pool.query(
          `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
           VALUES ($1, $2, $3, true, 0)`,
          [nextId, now, endTime]
        );
        console.log(`\u2705 Fresh voting period created (id=${nextId})`);
      } else {
        console.log(`\u2705 Active voting period OK (id=${period.id}, ends ${new Date(period.period_end).toISOString()})`);
      }
    }

  } catch (e) {
    // Log the full stack so the real cause is visible in Render logs
    console.error('\u274c ensureVotingPeriodsTable FAILED:', e.message);
    console.error(e.stack);
  }
}

// ── Ensure Active Voting Period (legacy alias) ──
// Superseded by ensureVotingPeriodsTable() — kept so the startup call still works.
async function ensureActivePeriod() {
  await ensureVotingPeriodsTable();
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
  // Guarantee the counters row exists even when initDB() early-exited because
  // the users table was already present (i.e. the metadata seed was never run).
  await pool.query(
    `INSERT INTO metadata (key, value)
     VALUES ('counters', '{"last_voter_number": 0, "registered_voters": 0, "last_period_id": 0}')
     ON CONFLICT (key) DO NOTHING`
  );

  const res = await pool.query(
    `SELECT (value->>'last_voter_number')::bigint as last FROM metadata WHERE key = 'counters'`
  );
  const last = res.rows[0]?.last || 0;
  const next = last + 1;
  await pool.query(
    `UPDATE metadata SET value = jsonb_set(value, '{last_voter_number}', to_jsonb($1::bigint)) WHERE key = 'counters'`,
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

    const session = verifySession(cookieHeader);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
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
// ROUTE: /api/profile  — update profile details & photo
// ════════════════════════════════════════════════
app.post('/api/profile', async (req, res) => {
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
// ROUTE: /api/reset-password  — OTP-less reset (server validates phone exists)
// ════════════════════════════════════════════════
app.post('/api/reset-password', async (req, res) => {
  const { action, phone } = req.body;
  // action='request': validate phone exists → in production send SMS; here just confirm
  if (action === 'request') {
    try {
      const result = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'Phone not registered' });
      // In production: generate OTP, save to DB, send via Africa's Talking SMS
      // For now: return success so frontend can show code entry
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }
  // action='confirm': apply new password
  if (action === 'confirm') {
    const { password } = req.body;
    if (!phone || !password || password.length < 6)
      return res.status(400).json({ success: false, error: 'Phone and password (min 6 chars) required' });
    try {
      const result = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'Phone not registered' });
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = hashPassword(password, salt);
      await pool.query('UPDATE users SET password_hash=$1, salt=$2, updated_at=NOW() WHERE phone=$3',
        [passwordHash, salt, phone]);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }
  return res.status(400).json({ success: false, error: 'Invalid action' });
});

// ════════════════════════════════════════════════
// ROUTE: /api/change-password  — authenticated password change
// ════════════════════════════════════════════════
app.post('/api/change-password', async (req, res) => {
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
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(newPassword, salt);
    await pool.query('UPDATE users SET password_hash=$1, salt=$2, updated_at=NOW() WHERE id=$3',
      [passwordHash, salt, session.userId]);
    return res.json({ success: true });
  } catch (e) {
    console.error('/api/change-password error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
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

    // ── Count totals and per-candidate ────────────────────────────────────
    const totalRes = await pool.query(
      'SELECT COUNT(*) as count FROM votes WHERE period_id = $1',
      [periodId]
    );
    const voterCount = parseInt(totalRes.rows[0].count);

    let badge = null;
    if (voterCount === 1) badge = '1st';
    else if (voterCount === 2) badge = '2nd';
    else if (voterCount === 3) badge = '3rd';

    // Per-candidate counts for faceoff / live display
    const perCandRes = await pool.query(
      'SELECT candidate_id, COUNT(*) as vote_count FROM votes WHERE period_id = $1 GROUP BY candidate_id',
      [periodId]
    );
    const votesByCandidate = {};
    perCandRes.rows.forEach(r => {
      votesByCandidate[r.candidate_id] = parseInt(r.vote_count);
    });

    // ── Broadcast to every SSE subscriber (faceoff, voting-page live tab) ──
    broadcastVoteUpdate('vote-received', {
      candidateId,
      periodId,
      totalVotes: voterCount,
      votes: votesByCandidate[candidateId] || 1,
      votesByCandidate
    });

    return res.json({
      success: true,
      badge,
      totalVotes: voterCount,
      votesByCandidate,
      candidateId,
      periodId
    });
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
// ROUTE: /api/transaction  (record STK push initiation)
// ════════════════════════════════════════════════
app.post('/api/transaction', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { checkout_request_id, phone, amount, candidate_id } = req.body;
  if (!checkout_request_id) return res.status(400).json({ error: 'checkout_request_id required' });

  try {
    await pool.query(
      `INSERT INTO mpesa_transactions
         (id, phone, amount, account_reference, description, status, created_at)
       VALUES ($1, $2, $3, 'NIT-VOTE', $4, 'pending', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        checkout_request_id,
        phone || session.phone || null,
        amount || 10,
        `Vote for candidate ${candidate_id ?? 'unknown'}`
      ]
    );
    return res.json({ success: true });
  } catch (e) {
    console.error('/api/transaction error:', e);
    return res.status(500).json({ error: 'Failed to record transaction' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/transaction/confirm  (mark STK push as paid)
// ════════════════════════════════════════════════
app.post('/api/transaction/confirm', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { checkout_request_id, receipt } = req.body;
  if (!checkout_request_id || !receipt)
    return res.status(400).json({ error: 'checkout_request_id and receipt required' });

  try {
    await pool.query(
      `UPDATE mpesa_transactions
          SET status = 'confirmed',
              mpesa_receipt_number = $2,
              callback_received_at = NOW()
        WHERE id = $1`,
      [checkout_request_id, receipt]
    );
    return res.json({ success: true });
  } catch (e) {
    console.error('/api/transaction/confirm error:', e);
    return res.status(500).json({ error: 'Failed to confirm transaction' });
  }
});


// ════════════════════════════════════════════════
// ROUTE: /api/my-votes  — voter's personal vote history
// ════════════════════════════════════════════════
app.get('/api/my-votes', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Unauthorized' });

  try {
    const result = await pool.query(
      `SELECT
         v.id,
         v.candidate_id,
         v.period_id,
         v.sublocation,
         v.timestamp,
         vp.period_start,
         vp.period_end,
         vp.is_active,
         vp.total_votes  AS period_total_votes,
         vp.winner_id    AS period_winner_id
       FROM votes v
       JOIN voting_periods vp ON vp.id = v.period_id
       WHERE v.user_id = $1
       ORDER BY v.timestamp DESC`,
      [session.userId]
    );

    // Enrich with candidate name from the in-memory list
    const CANDS = [
      { id: 0, name: 'Hon. James Mwangi', party: 'Jubilee' },
      { id: 1, name: 'Grace Wanjiku',     party: 'ODM'     },
      { id: 2, name: 'Peter Kimani',      party: 'UDA'     },
      { id: 3, name: 'Sarah Nduati',      party: 'Wiper'   },
      { id: 4, name: 'John Otieno',       party: 'ANC'     },
      { id: 5, name: 'Mary Wambui',       party: 'Ford-K'  },
      { id: 6, name: 'David Kiprotich',   party: 'Independent' }
    ];

    const votes = result.rows.map(row => {
      const cand = CANDS.find(c => c.id === parseInt(row.candidate_id)) || {};
      return {
        id:               row.id,
        candidateId:      parseInt(row.candidate_id),
        candidateName:    cand.name  || 'Unknown',
        candidateParty:   cand.party || '—',
        periodId:         row.period_id,
        periodStart:      row.period_start,
        periodEnd:        row.period_end,
        isActivePeriod:   row.is_active,
        periodTotalVotes: parseInt(row.period_total_votes) || 0,
        periodWinnerId:   row.period_winner_id != null ? parseInt(row.period_winner_id) : null,
        sublocation:      row.sublocation,
        votedAt:          new Date(parseInt(row.timestamp)).toISOString()
      };
    });

    return res.json({ success: true, votes });
  } catch (e) {
    console.error('/api/my-votes error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});
// ════════════════════════════════════════════════
// ROUTE: /api/debug/db  (admin-only, logs DB state)
// GET /api/debug/db?secret=YOUR_SESSION_SECRET
// ════════════════════════════════════════════════
app.get('/api/debug/db', async (req, res) => {
  // Only accessible with the SESSION_SECRET as query param (not for production — remove when done)
  if (req.query.secret !== process.env.SESSION_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
    );
    const periods = await pool.query(
      `SELECT id, period_start, period_end, is_active, total_votes FROM voting_periods ORDER BY id DESC LIMIT 5`
    );
    const voteCount = await pool.query(`SELECT COUNT(*) AS c FROM votes`);
    const userCount = await pool.query(`SELECT COUNT(*) AS c FROM users`);
    res.json({
      tables:    tables.rows.map(r => r.table_name),
      periods:   periods.rows,
      voteCount: parseInt(voteCount.rows[0].c),
      userCount: parseInt(userCount.rows[0].c),
      now:       new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ════════════════════════════════════════════════
// CATCH-ALL & ERROR HANDLING
// ════════════════════════════════════════════════

app.use((err, req, res, next) => {
  console.error('[GlobalErrorHandler]', req.method, req.path, err.message);
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ════════════════════════════════════════════════════════════════════════════
// MISSING ENDPOINTS - Add these
// ════════════════════════════════════════════════════════════════════════════

// GET /api/stats - Return voting statistics
app.get('/api/stats', async (req, res) => {
  try {
    const votersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const registeredVoters = parseInt(votersResult.rows[0].count || 0);

    const periodResult = await pool.query(
      'SELECT id, total_votes, period_start, period_end FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );
    const period = periodResult.rows[0] || null;

    const votesByCandidate = {};
    if (period) {
      const votesResult = await pool.query(
        'SELECT candidate_id, COUNT(*) as vote_count FROM votes WHERE period_id = $1 GROUP BY candidate_id',
        [period.id]
      );
      votesResult.rows.forEach(row => {
        votesByCandidate[row.candidate_id] = parseInt(row.vote_count);
      });
    }

    // Real sublocation breakdown from users table
    const sublocResult = await pool.query(
      `SELECT COALESCE(sublocation, 'Unknown') as sublocation, COUNT(*) as count
       FROM users GROUP BY sublocation`
    );
    const votersBySubLocation = {};
    sublocResult.rows.forEach(r => { votersBySubLocation[r.sublocation] = parseInt(r.count); });

    res.json({
      success: true,
      registeredVoters,
      currentPeriod: period ? {
        periodId: period.id,
        totalVotes: parseInt(period.total_votes || 0),
        periodStart: period.period_start,
        periodEnd: period.period_end,
        votesByCandidate
      } : null,
      votersBySubLocation
    });
  } catch (error) {
    console.error('/api/stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/forum - List forum posts
app.get('/api/forum', async (req, res) => {
  try {
    const posts = await pool.query('SELECT * FROM forum_posts ORDER BY last_activity_at DESC LIMIT 50');
    res.json({
      success: true,
      posts: posts.rows.map(p => ({
        id: p.id,
        author: p.author_name || 'Anonymous',
        text: p.content,
        title: p.title,
        likes: p.like_count || 0,
        reply_count: p.reply_count || 0,
        created_at: p.created_at
      }))
    });
  } catch (error) {
    console.error('/api/forum error:', error);
    res.status(500).json({ success: false, error: 'Failed to get forum posts' });
  }
});

// POST /api/forum - Create forum post / list / like
app.post('/api/forum', async (req, res) => {
  const { action, text, title, postId } = req.body;

  if (action === 'create_post') {
    try {
      const session = verifySession(req.headers.cookie || '');
      if (!session) return res.status(401).json({ error: 'Unauthorized' });

      const user = await pool.query('SELECT id, first_name, surname FROM users WHERE phone = $1', [session.phone]);
      if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
      const author = `${user.rows[0].first_name} ${user.rows[0].surname}`;

      const post = await pool.query(
        `INSERT INTO forum_posts (title, content, author_id, author_name, author_phone, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
        [title || text?.slice(0, 80) || 'Post', text, user.rows[0].id, author, session.phone]
      );

      res.json({ success: true, post: post.rows[0] });
    } catch (error) {
      console.error('/api/forum create error:', error);
      res.status(500).json({ success: false, error: 'Failed to create post' });
    }
  }

  else if (action === 'list_posts') {
    try {
      const posts = await pool.query('SELECT * FROM forum_posts ORDER BY last_activity_at DESC LIMIT 50');
      res.json({
        success: true,
        posts: posts.rows.map(p => ({
          id: p.id,
          author: p.author_name || 'Anonymous',
          text: p.content,
          title: p.title,
          likes: p.like_count || 0,
          reply_count: p.reply_count || 0,
          created_at: p.created_at
        }))
      });
    } catch (error) {
      console.error('/api/forum list error:', error);
      res.status(500).json({ success: false, error: 'Failed to get forum posts' });
    }
  }

  else if (action === 'like_post') {
    try {
      const session = verifySession(req.headers.cookie || '');
      if (!session) return res.status(401).json({ error: 'Unauthorized' });

      const userRes = await pool.query('SELECT id FROM users WHERE phone = $1', [session.phone]);
      if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
      const userId = userRes.rows[0].id;

      // Insert like — ignore if already liked (PRIMARY KEY constraint)
      await pool.query(
        'INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [postId, userId]
      );
      // Sync like_count from actual rows
      await pool.query(
        'UPDATE forum_posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1) WHERE id = $1',
        [postId]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to like post' });
    }
  }

  else {
    res.status(400).json({ success: false, error: 'Unknown action' });
  }
});

// GET /api/faceoff - Top 2 candidates by CUMULATIVE votes across all cycles
app.get('/api/faceoff', async (req, res) => {
  try {
    // Cumulative vote counts across ALL periods
    const allVotes = await pool.query(
      `SELECT candidate_id, COUNT(*) AS vote_count
         FROM votes
        GROUP BY candidate_id`
    );

    // Build vote map
    const voteMap = {};
    allVotes.rows.forEach(r => {
      voteMap[parseInt(r.candidate_id)] = parseInt(r.vote_count);
    });

    const totalVotes = Object.values(voteMap).reduce((s, n) => s + n, 0);

    // Attach counts to every candidate and sort descending
    const ranked = CANDIDATES.map(c => ({
      ...c,
      vote_count: voteMap[c.id] || 0,
      percentage: totalVotes > 0 ? ((( voteMap[c.id] || 0) / totalVotes) * 100).toFixed(1) : '0.0'
    })).sort((a, b) => b.vote_count - a.vote_count);

    const top2 = ranked.slice(0, 2);

    // Also get current period for context
    const periodRes = await pool.query(
      'SELECT id FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );
    const periodId = periodRes.rows[0]?.id ?? null;

    res.json({
      success: true,
      candidates:    top2,
      allCandidates: ranked,
      periodId,
      totalVotes
    });
  } catch (error) {
    console.error('/api/faceoff error:', error.message, error.stack);
    res.status(500).json({ success: false, error: 'Failed to get faceoff data' });
  }
});


// ══════════════════════════════════════════════
// GET /api/notices — fetch all active notices
// ══════════════════════════════════════════════
app.get('/api/notices', async (req, res) => {
  try {
    const { cat } = req.query;
    const filterCat = cat && cat !== 'all' ? cat : null;

    // Query 1: admin notices
    const noticesQ = filterCat
      ? pool.query(
          `SELECT id, title, content, category, priority, created_at, expires_at,
                  NULL AS contact_phone, NULL AS business_name, false AS is_ad
           FROM notices
           WHERE (expires_at IS NULL OR expires_at > NOW())
             AND COALESCE(is_archived, false) = false
             AND category = $1
           ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC`,
          [filterCat]
        )
      : pool.query(
          `SELECT id, title, content, category, priority, created_at, expires_at,
                  NULL AS contact_phone, NULL AS business_name, false AS is_ad
           FROM notices
           WHERE (expires_at IS NULL OR expires_at > NOW())
             AND COALESCE(is_archived, false) = false
           ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC`
        );

    // Query 2: approved paid ad requests shaped to match notice cards
    const adsQ = filterCat
      ? pool.query(
          `SELECT id,
                  business_name                AS title,
                  ad_content                   AS content,
                  COALESCE(category,'general') AS category,
                  'normal'                     AS priority,
                  submitted_at                 AS created_at,
                  NULL                         AS expires_at,
                  contact_phone,
                  business_name,
                  true                         AS is_ad
           FROM ad_requests
           WHERE status = 'approved'
             AND COALESCE(is_hidden, false) = false
             AND COALESCE(category, 'general') = $1
           ORDER BY submitted_at DESC`,
          [filterCat]
        )
      : pool.query(
          `SELECT id,
                  business_name                AS title,
                  ad_content                   AS content,
                  COALESCE(category,'general') AS category,
                  'normal'                     AS priority,
                  submitted_at                 AS created_at,
                  NULL                         AS expires_at,
                  contact_phone,
                  business_name,
                  true                         AS is_ad
           FROM ad_requests
           WHERE status = 'approved'
             AND COALESCE(is_hidden, false) = false
           ORDER BY submitted_at DESC`
        );

    // Run both queries — ads query is isolated so a missing column never kills notices
    const [noticesResult, adsResultRaw] = await Promise.all([
      noticesQ,
      adsQ.catch(err => {
        console.error('/api/notices ads query error (non-fatal):', err.message);
        return { rows: [] };
      })
    ]);

    // Merge: high-priority first, then newest
    const all = [...noticesResult.rows, ...adsResultRaw.rows].sort((a, b) => {
      const pa = a.priority === 'high' ? 0 : 1;
      const pb = b.priority === 'high' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    res.json({ success: true, notices: all });
  } catch (error) {
    console.error('/api/notices GET error:', error.message, '|', error.detail || '');
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
// ══════════════════════════════════════════════════════
// /api/admin/notices — notice management endpoints
// ══════════════════════════════════════════════════════
function checkNoticeAdminAuth(req, res) {
  const secret = process.env.ADMIN_SECRET || 'ngoliba2025admin';
  const provided = req.headers['x-admin-password'];
  if (!provided || provided !== secret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.post('/api/admin/notices/verify', (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'ngoliba2025admin';
  const provided = req.headers['x-admin-password'];
  if (provided && provided === secret) return res.json({ success: true });
  return res.status(401).json({ success: false, error: 'Invalid password' });
});

app.get('/api/admin/notices', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  try {
    const result = await pool.query('SELECT * FROM notices ORDER BY created_at DESC');
    res.json({ success: true, data: { notices: result.rows } });
  } catch (err) {
    console.error('GET /api/admin/notices error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/notices', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  const { title, content, category, priority, expiresAt } = req.body;
  if (!title || !content) return res.status(400).json({ success: false, error: 'title and content are required' });
  try {
    const result = await pool.query(
      'INSERT INTO notices (title,content,category,priority,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [title, content, category||'general', priority||'normal', expiresAt||null, 'admin']
    );
    res.json({ success: true, notice: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/notices error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/notices/:id', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  const { title, content, category, priority, expiresAt } = req.body;
  if (!title || !content) return res.status(400).json({ success: false, error: 'title and content are required' });
  try {
    const result = await pool.query(
      'UPDATE notices SET title=$1,content=$2,category=$3,priority=$4,expires_at=$5,updated_at=NOW() WHERE id=$6 RETURNING *',
      [title, content, category||'general', priority||'normal', expiresAt||null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Notice not found' });
    res.json({ success: true, notice: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/admin/notices error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/notices/:id', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  try {
    await pool.query('DELETE FROM notices WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/notices error:', err.message);
    res.status(500).json({ success: false, error: err.message });
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

  // ✅ ADD PERIOD - id has no DEFAULT, must be computed; also deactivate old periods
if (action === 'add_period') {
  const { durationDays } = req.body;
  if (!durationDays) return res.status(400).json({ success: false, error: 'Duration required' });
  try {
    // Deactivate any currently active periods first
    await pool.query('UPDATE voting_periods SET is_active = false WHERE is_active = true');
    const result = await pool.query(
      `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
       VALUES (
         COALESCE((SELECT MAX(id) FROM voting_periods), 0) + 1,
         NOW(), NOW() + ($1 || ' days')::INTERVAL, true, 0
       )
       RETURNING id, period_start, period_end, is_active, total_votes`,
      [String(durationDays)]
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
  // ✅ DELETE USER - with token auth (already verified above) + cascade votes
if (action === 'delete_user') {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (!userRes.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    const userId = userRes.rows[0].id;
    await pool.query('DELETE FROM votes WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM post_likes WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM reply_likes WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
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

// ══════════════════════════════════════════════════════
// AD REQUESTS — public submission + admin management
// ══════════════════════════════════════════════════════

// POST /api/ad-requests — logged-in user submits an ad request
app.post('/api/ad-requests', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Please log in to submit an ad request.' });

  const { businessName, adContent, category, contactPhone, contactEmail, budget, duration } = req.body;
  if (!businessName || !adContent || !contactPhone) {
    return res.status(400).json({ success: false, error: 'businessName, adContent and contactPhone are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO ad_requests (id, business_name, ad_content, contact_phone, contact_email, budget, duration, status, submitted_by_phone, submitted_at, category)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'pending', $7, NOW(), $8) RETURNING id, submitted_at`,
      [businessName, adContent, contactPhone, contactEmail || null, budget || null, duration || '7 days', session.phone, category || 'general']
    );
    res.json({ success: true, id: result.rows[0].id, submittedAt: result.rows[0].submitted_at });
  } catch (err) {
    console.error('POST /api/ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/my-ad-requests — returns all requests submitted by the logged-in user
app.get('/api/my-ad-requests', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Not authenticated' });
  try {
    const result = await pool.query(
      `SELECT id, business_name, ad_content, duration, status, fee, notes, submitted_at, reviewed_at
       FROM ad_requests
       WHERE submitted_by_phone = $1
       ORDER BY submitted_at DESC`,
      [session.phone]
    );
    res.json({ success: true, adRequests: result.rows });
  } catch (err) {
    console.error('GET /api/my-ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/ad-requests — admin: list all ad requests (hidden excluded by default)
app.get('/api/admin/ad-requests', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  try {
    const showHidden = req.query.showHidden === 'true';
    const result = await pool.query(
      showHidden
        ? `SELECT * FROM ad_requests ORDER BY submitted_at DESC`
        : `SELECT * FROM ad_requests WHERE COALESCE(is_hidden, false) = false ORDER BY submitted_at DESC`
    );
    res.json({ success: true, adRequests: result.rows });
  } catch (err) {
    console.error('GET /api/admin/ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/ad-requests/:id/hide — toggle is_hidden
app.patch('/api/admin/ad-requests/:id/hide', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  const { hidden } = req.body; // true = hide, false = unhide
  try {
    const result = await pool.query(
      `UPDATE ad_requests SET is_hidden = $1 WHERE id = $2 RETURNING id, is_hidden`,
      [hidden === true, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Ad request not found' });
    res.json({ success: true, hidden: result.rows[0].is_hidden });
  } catch (err) {
    console.error('PATCH /api/admin/ad-requests/:id/hide error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/ad-requests/:id — permanently delete an ad request
app.delete('/api/admin/ad-requests/:id', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  try {
    const result = await pool.query(
      `DELETE FROM ad_requests WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Ad request not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/ad-requests/:id — admin: update status + notes + optional fee
app.patch('/api/admin/ad-requests/:id', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  const { status, notes, fee } = req.body;
  const allowed = ['pending', 'payment_pending', 'approved', 'rejected', 'completed'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ success: false, error: `status must be one of: ${allowed.join(', ')}` });
  }
  if (status === 'payment_pending' && (!fee || isNaN(parseInt(fee)) || parseInt(fee) <= 0)) {
    return res.status(400).json({ success: false, error: 'A valid fee (KES) is required when requesting payment.' });
  }
  try {
    const result = await pool.query(
      `UPDATE ad_requests
         SET status=$1, notes=$2, fee=COALESCE($3, fee), reviewed_at=NOW(), reviewed_by='admin'
       WHERE id=$4 RETURNING *`,
      [status, notes || null, fee ? parseInt(fee) : null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Ad request not found' });
    res.json({ success: true, adRequest: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/admin/ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/ad-requests/:id — public: requester checks their own request status
app.get('/api/ad-requests/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, business_name, status, fee, duration, notes, submitted_at, reviewed_at FROM ad_requests WHERE id=$1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, adRequest: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/ad-requests/:id/pay — requester confirms payment (M-Pesa receipt)
app.post('/api/ad-requests/:id/pay', async (req, res) => {
  const { mpesaReceiptNumber, phone } = req.body;
  if (!mpesaReceiptNumber) return res.status(400).json({ success: false, error: 'mpesaReceiptNumber is required' });
  try {
    // Verify the request is in payment_pending state
    const check = await pool.query(`SELECT status, fee FROM ad_requests WHERE id=$1`, [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ success: false, error: 'Ad request not found' });
    if (check.rows[0].status !== 'payment_pending') {
      return res.status(400).json({ success: false, error: `Cannot confirm payment — request is currently "${check.rows[0].status}"` });
    }
    const result = await pool.query(
      `UPDATE ad_requests
         SET status='approved', notes=COALESCE(notes||' | ', '')||'Paid via M-Pesa: '||$1
       WHERE id=$2 RETURNING *`,
      [mpesaReceiptNumber, req.params.id]
    );
    res.json({ success: true, adRequest: result.rows[0] });
  } catch (err) {
    console.error('POST /api/ad-requests/:id/pay error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/period/next  — start a new voting cycle (admin only)
// ════════════════════════════════════════════════
app.post('/api/period/next', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;

  const { durationMinutes } = req.body;
  const mins = parseInt(durationMinutes) || 5;

  try {
    // Deactivate all currently active periods
    await pool.query('UPDATE voting_periods SET is_active = false WHERE is_active = true');

    // Create the new period
    const result = await pool.query(
      `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
       VALUES (
         COALESCE((SELECT MAX(id) FROM voting_periods), 0) + 1,
         NOW(),
         NOW() + ($1 || ' minutes')::INTERVAL,
         true,
         0
       )
       RETURNING id, period_start, period_end`,
      [String(mins)]
    );

    const newPeriod = result.rows[0];
    return res.json({ success: true, data: { newPeriod: newPeriod.id, endsAt: newPeriod.period_end } });
  } catch (e) {
    console.error('[/api/period/next] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to start new period' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/voting-period  ← defined in server.js (authoritative)
// Supersedes any version in routes/voting.js to guarantee req.pool
// is always the live pool instance and errors are fully logged.
// ════════════════════════════════════════════════
app.get('/api/voting-period', async (req, res) => {
  try {
    // 1. Get active period
    let periodRes = await pool.query(
      `SELECT id, period_start, period_end, total_votes
         FROM voting_periods
        WHERE is_active = true
        ORDER BY id DESC
        LIMIT 1`
    );

    // 2. If none exists, auto-create one (safety net)
    if (periodRes.rows.length === 0) {
      console.warn('[voting-period] No active period found — creating one');
      const now     = new Date();
      const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const maxRes  = await pool.query('SELECT COALESCE(MAX(id), 0) AS maxid FROM voting_periods');
      const nextId  = parseInt(maxRes.rows[0].maxid) + 1;
      await pool.query(
        `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
           VALUES ($1, $2, $3, true, 0)`,
        [nextId, now, endTime]
      );
      periodRes = await pool.query(
        `SELECT id, period_start, period_end, total_votes
           FROM voting_periods WHERE id = $1`, [nextId]
      );
    }

    const period = periodRes.rows[0];
    const now    = new Date();
    const endsAt = new Date(period.period_end);
    const secondsRemaining = Math.max(0, Math.floor((endsAt - now) / 1000));
    const endsInMs         = Math.max(0, endsAt - now);

    // 3. Check if authenticated user has voted this cycle
    let userHasVoted = false;
    const session = verifySession(req.headers.cookie || '');
    if (session && session.userId) {
      const voteCheck = await pool.query(
        `SELECT 1 FROM votes WHERE user_id = $1 AND period_id = $2 LIMIT 1`,
        [session.userId, period.id]
      );
      userHasVoted = voteCheck.rows.length > 0;
    }

    return res.json({
      success: true,
      data: {
        periodId:         period.id,
        startedAt:        period.period_start,
        endsAt:           period.period_end,
        endsIn:           endsInMs,
        secondsRemaining,
        totalVotes:       parseInt(period.total_votes) || 0,
        isActive:         true,
        userHasVoted
      }
    });

  } catch (e) {
    console.error('[/api/voting-period] ERROR:', e.message);
    console.error(e.stack);
    return res.status(500).json({ success: false, error: 'Failed to fetch voting period' });
  }
});

// ── PHASE 2: Mount voting router ──
app.use(votingRouter);

// ── PHASE 3: Mount analytics router ──
app.use(analyticsRouter);

// ── PHASE 2: Frontend page routes ──
app.get('/voting', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'voting.html'));
});
app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});
app.get('/advanced-leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'advanced-leaderboard.html'));
});
app.get('/admin-voting', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-voting.html'));
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