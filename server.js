// server.js — Ngoliba InfoTrack
// PostgreSQL version (no Netlify dependency)
// Production-ready for Render
require('dotenv').config();
const analyticsRouter = require('./routes/analytics');
const express = require('express');
const { rateLimit } = require('express-rate-limit');

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

// ── Forum Rate Limiters ──
// Applied only to content-creation actions (create_post, submit reply).
// Read actions (list posts, fetch replies, likes) are NOT limited.

// 10 new posts per 15 minutes per IP
const forumPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  statusCode: 429,
  message: { success: false, message: 'Too many forum submissions. Please wait before posting again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 30 replies per 15 minutes per IP
const forumReplyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  statusCode: 429,
  message: { success: false, message: 'Too many forum submissions. Please wait before posting again.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
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

// ── Phase 2: Ngoliba ward_id runtime cache ──
// Populated once by ensurePhase2Migrations() at startup.
// Injected into every new users / votes / notices / forum_posts / candidates row.
// Stays null if geography tables are unavailable — all columns are nullable so
// existing functionality is never broken.
let NGOLIBA_WARD_ID = null;


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
        category VARCHAR(50) DEFAULT 'MCA',
        sublocation VARCHAR(100),
        ip_hash VARCHAR(16),
        timestamp BIGINT,
        UNIQUE (user_id, period_id, category)
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
    // Same fix for forum tables (uuid-ossp extension not available on this deployment)
    await pool.query(`
      ALTER TABLE forum_posts
        ALTER COLUMN id SET DEFAULT gen_random_uuid()
    `);
    await pool.query(`
      ALTER TABLE forum_replies
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

    // ── FORUM SCHEMA MIGRATION ──
    // Runs here so it is guaranteed to complete before the server accepts requests.
    try {
      await pool.query(`ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS category  VARCHAR(30)  DEFAULT 'general'`);
      await pool.query(`ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS is_hidden  BOOLEAN      DEFAULT false`);
      await pool.query(`ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN      DEFAULT false`);
      await pool.query(`ALTER TABLE forum_replies ADD COLUMN IF NOT EXISTS is_hidden  BOOLEAN    DEFAULT false`);
      await pool.query(`ALTER TABLE forum_replies ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN    DEFAULT false`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_forum_posts_category ON forum_posts(category)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_forum_posts_created  ON forum_posts(created_at DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_forum_replies_post   ON forum_replies(post_id)`);
      console.log('✅ Forum schema ready');
    } catch (forumMigErr) {
      console.warn('⚠️  Forum schema migration (non-fatal):', forumMigErr.message);
    }

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

// ════════════════════════════════════════════════════════════════════════
// SINGLE AUTHORITATIVE ROLLOVER PATH  (Phase 3 determinism hardening)
// ════════════════════════════════════════════════════════════════════════
// createArchiveAndRollPeriod() is the ONLY place that may:
//   - read the active voting period
//   - decide whether it has expired
//   - write to period_archives
//   - flip voting_periods.is_active
//   - create the next voting_periods row
//
// Every trigger in this file (setInterval, /api/webhook, /api/period/next)
// calls this exact function instead of duplicating the logic. This removes
// the three near-identical copies that previously existed and that could
// race against each other.
//
// IDEMPOTENCY GUARD (no schema changes — uses existing columns only):
//   The whole check-and-roll sequence runs inside ONE Postgres transaction
//   that opens with `SELECT ... FOR UPDATE` on the active period row. That
//   row lock is the "database lock" — any second caller (interval tick,
//   cron webhook, admin click) that targets the SAME period blocks at the
//   FOR UPDATE statement until the first transaction COMMITs. By the time
//   it unblocks, that period is no longer is_active (the first transaction
//   already rolled it), so the second caller's own active-period lookup
//   resolves to the freshly-created period instead — which is not expired —
//   and it exits via the "not-expired" branch having written nothing.
//   This makes double-archiving structurally impossible, regardless of how
//   many triggers fire at the exact same instant.
//
// trigger_source values: 'interval' | 'webhook' | 'manual'
async function createArchiveAndRollPeriod(pool, { triggerSource, force = false, durationMinutes = 5 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row-level lock on the current active period — this IS the concurrency guard.
    const activeRes = await client.query(
      `SELECT * FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1 FOR UPDATE`
    );

    if (activeRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { rolled: false, reason: 'no-active-period', triggerSource };
    }

    const period  = activeRes.rows[0];
    const expired = new Date(period.period_end) <= new Date();

    if (!force && !expired) {
      await client.query('ROLLBACK');
      return { rolled: false, reason: 'not-expired', periodId: period.id, endsAt: period.period_end, triggerSource };
    }

    // ── Atomic claim: only proceed if WE are the one flipping is_active. ──
    // Defense-in-depth on top of the row lock above — belt and suspenders.
    const claim = await client.query(
      `UPDATE voting_periods SET is_active = false WHERE id = $1 AND is_active = true RETURNING id`,
      [period.id]
    );
    if (claim.rows.length === 0) {
      await client.query('ROLLBACK');
      return { rolled: false, reason: 'already-claimed', periodId: period.id, endsAt: period.period_end, triggerSource };
    }

    // ── Per-cycle winner (unchanged business logic) ──
    const cycleCounts = await client.query(`
      SELECT   candidate_id, COUNT(*) AS vote_count
      FROM     votes
      WHERE    period_id = $1
      GROUP BY candidate_id
      ORDER BY vote_count DESC
      LIMIT    1
    `, [period.id]);

    let winner = null;
    if (cycleCounts.rows.length > 0) {
      winner = {
        id:    parseInt(cycleCounts.rows[0].candidate_id),
        votes: parseInt(cycleCounts.rows[0].vote_count)
      };
      await client.query(
        `UPDATE voting_periods SET winner_id = $1, winner_votes = $2 WHERE id = $3`,
        [winner.id, winner.votes, period.id]
      );
    }

    // ── Sublocation breakdown (unchanged business logic) ──
    const sublocRes = await client.query(`
      SELECT   sublocation, candidate_id, COUNT(*) AS vote_count
      FROM     votes
      WHERE    period_id = $1 AND sublocation IS NOT NULL
      GROUP BY sublocation, candidate_id
      ORDER BY sublocation, vote_count DESC
    `, [period.id]);

    const breakdown = {};
    sublocRes.rows.forEach(row => {
      if (!breakdown[row.sublocation]) breakdown[row.sublocation] = [];
      breakdown[row.sublocation].push({
        candidateId: parseInt(row.candidate_id),
        votes:       parseInt(row.vote_count)
      });
    });

    // ── Archive the closed period ──
    const archiveInsert = await client.query(`
      INSERT INTO period_archives (id, period_data, winner_id, winner_votes, total_votes)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `, [
      period.id,
      JSON.stringify({
        ...period,
        winner_id:      winner?.id    ?? null,
        winner_votes:   winner?.votes ?? 0,
        total_votes:    period.total_votes,
        vote_breakdown: breakdown
      }),
      winner?.id    ?? null,
      winner?.votes ?? 0,
      period.total_votes
    ]);
    const archiveId = archiveInsert.rows[0]?.id ?? period.id; // ON CONFLICT still means "this id is the archive"

    // ── Create the next period ──
    const mins    = force ? Math.min(Math.max(parseInt(durationMinutes) || 5, 1), 60) : 5;
    const now     = new Date();
    const endTime = new Date(now.getTime() + mins * 60 * 1000);
    const maxRes  = await client.query('SELECT COALESCE(MAX(id), 0) AS maxid FROM voting_periods');
    const nextId  = parseInt(maxRes.rows[0].maxid) + 1;
    await client.query(
      `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
         VALUES ($1, $2, $3, true, 0)`,
      [nextId, now, endTime]
    );

    await client.query('COMMIT');

    // ── Execution trace log (auditability requirement) ──
    console.log(JSON.stringify({
      event:          'period-rollover',
      trigger_source: triggerSource,
      period_id:      period.id,
      archive_id:     archiveId,
      new_period_id:  nextId,
      winner_id:      winner?.id ?? null,
      winner_votes:   winner?.votes ?? 0,
      timestamp:      new Date().toISOString()
    }));

    broadcastVoteUpdate('period-rollover', { newPeriodId: nextId, endsAt: endTime });

    return {
      rolled:         true,
      triggerSource,
      completedPeriod: period.id,
      archiveId,
      winner,
      newPeriod:      nextId,
      endsAt:         endTime
    };

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(`[createArchiveAndRollPeriod:${triggerSource}] ERROR:`, e.message);
    throw e;
  } finally {
    client.release();
  }
}


// Initialize on startup — server only starts listening AFTER all migrations complete
(async () => {
  const connected = await testDBConnection();
  if (connected) {
    await initDB();
    await ensureNoticesTable();
    await ensureVotingPeriodsTable();  // ← must run BEFORE ensureActivePeriod so schema is ready
    await ensureActivePeriod();        // now a no-op alias for backward compat
    await ensureCandidatesTable();     // multi-category candidates (preserves MCA IDs 0-6)
    await ensureGeographyTables();     // Phase 1: additive geographic foundation — no existing behaviour changes
    await ensurePhase2Migrations();    // Phase 2: add ward_id columns, backfill existing rows, cache NGOLIBA_WARD_ID
  } else {
    console.warn('⚠️  Continuing without database. Some features may not work.');
  }

  // ── Start listening ONLY after all migrations are done ──
  const server = app.listen(PORT, () => {
    console.log(`✅ Ngoliba InfoTrack server running on port ${PORT}`);
    console.log(`📚 Database: PostgreSQL (check connection above)`);
    console.log(`🔐 Session Secret: ${process.env.SESSION_SECRET ? '✓ Configured' : '✗ Missing'}`);
    console.log(`📱 M-Pesa: ${process.env.MPESA_CONSUMER_KEY ? '✓ Configured' : '✗ Not configured'}`);
    console.log(`\n🌐 Access the app at: http://localhost:${PORT}`);
  });

  // ── AUTHORITATIVE TRIGGER: check every 30s for expired periods and roll over. ──
  // This in-process timer is the system's primary, self-contained rollover
  // mechanism — it has no dependency on any external service being reachable
  // or correctly configured. /api/webhook and /api/period/next below are now
  // thin wrappers around the exact same createArchiveAndRollPeriod() call.
  setInterval(async () => {
    try {
      const result = await createArchiveAndRollPeriod(pool, { triggerSource: 'interval' });
      if (result.rolled) {
        console.log(`[interval] Period ${result.completedPeriod} → archived (archive ${result.archiveId}); new period ${result.newPeriod}`);
      }
      // result.rolled === false (not-expired / no-active-period) is the normal,
      // silent case on most ticks — nothing to log.
    } catch (e) {
      console.error('[interval] ERROR:', e.message);
    }
  }, 30_000);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
      pool.end();
      process.exit(0);
    });
  });
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
        category     VARCHAR(50) DEFAULT 'MCA',
        sublocation  VARCHAR(100),
        ip_hash      VARCHAR(32),
        timestamp    BIGINT
      )
    `);
    // Add category column to existing deployments that don't have it yet
    try { await pool.query(`ALTER TABLE votes ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'MCA'`); } catch(_){}
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_votes_candidate ON votes (candidate_id)`); } catch(_){}
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_votes_user_period ON votes (user_id, period_id)`); } catch(_){}
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_votes_period ON votes (period_id)`); } catch(_){}
    // Drop old one-vote-per-period constraint (too broad) and replace with per-category constraint
    try { await pool.query(`ALTER TABLE votes DROP CONSTRAINT IF EXISTS votes_user_period_unique`); } catch(_){}
    // Enforce one-vote-per-user-per-period-per-category at the DB level (safety net against races)
    try { await pool.query(`ALTER TABLE votes ADD CONSTRAINT votes_user_period_category_unique UNIQUE (user_id, period_id, category)`); } catch(_){}

    // 4. Also ensure period_archives table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS period_archives (
        id          INT PRIMARY KEY,
        period_data JSONB,
        archived_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // 4a. Idempotent analytics columns on period_archives (required by analytics router)
    try { await pool.query(`ALTER TABLE period_archives ADD COLUMN IF NOT EXISTS winner_id    INT`);           } catch(_){}
    try { await pool.query(`ALTER TABLE period_archives ADD COLUMN IF NOT EXISTS winner_votes INT DEFAULT 0`); } catch(_){}
    try { await pool.query(`ALTER TABLE period_archives ADD COLUMN IF NOT EXISTS total_votes  INT DEFAULT 0`); } catch(_){}

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
      const endTime = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes

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
      const now = new Date();
      const isExpired = new Date(period.period_end) < now;

      // Detect abnormally long durations (> 60 min is invalid for this system)
      const MAX_ALLOWED_MS = 60 * 60 * 1000; // 60-minute absolute ceiling
      const periodLengthMs = new Date(period.period_end) - new Date(period.period_start || now);
      const isTooLong = periodLengthMs > MAX_ALLOWED_MS;

      if (isExpired || isTooLong) {
        if (isTooLong && !isExpired) {
          console.warn(`⚠️  Period ${period.id} has abnormal duration (${Math.round(periodLengthMs / 60000)} min — max 60) — replacing with fresh 5-min period`);
        } else {
          console.log(`⚠️  Period ${period.id} has expired — closing and creating new one`);
        }
        await pool.query(`UPDATE voting_periods SET is_active = false WHERE id = $1`, [period.id]);

        const endTime  = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes
        const maxIdRes = await pool.query('SELECT COALESCE(MAX(id), 0) AS maxid FROM voting_periods');
        const nextId   = parseInt(maxIdRes.rows[0].maxid) + 1;

        await pool.query(
          `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
           VALUES ($1, $2, $3, true, 0)`,
          [nextId, now, endTime]
        );
        console.log(`✅ Fresh voting period created (id=${nextId}, ends ${endTime.toISOString()})`);
      } else {
        console.log(`✅ Active voting period OK (id=${period.id}, ends ${new Date(period.period_end).toISOString()})`);
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
  const existing = await pool.query(
    'SELECT id FROM voting_periods WHERE is_active = true LIMIT 1'
  );

  if (existing.rows.length === 0) {
    // create period
  }
}

// ══════════════════════════════════════════════════════════════════
// CANDIDATES TABLE — multi-category support
// Preserves all existing MCA candidate IDs (0-6) for vote backward-compat
// ══════════════════════════════════════════════════════════════════
const CANDIDATE_CATEGORIES = ['MCA', 'WomenRep', 'MP', 'Senator', 'Governor', 'President'];

async function ensureCandidatesTable() {
  try {
    // Create table with INT primary key so we control IDs (0-6 match existing votes)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS candidates (
        id         SERIAL  PRIMARY KEY,
        name       VARCHAR(200) NOT NULL,
        party      VARCHAR(100) DEFAULT '',
        bio        TEXT         DEFAULT '',
        img        VARCHAR(600) DEFAULT '',
        category   VARCHAR(50)  DEFAULT 'MCA',
        incumbent  BOOLEAN      DEFAULT false,
        display_order INT       DEFAULT 0,
        created_at TIMESTAMP    DEFAULT NOW()
      )
    `);

    // Idempotent migrations
    await pool.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS category      VARCHAR(50)  DEFAULT 'MCA'`);
    await pool.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS incumbent     BOOLEAN      DEFAULT false`);
    await pool.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS display_order INT          DEFAULT 0`);
    await pool.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS bio           TEXT         DEFAULT ''`);
    await pool.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS img           VARCHAR(600) DEFAULT ''`);

    // Indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_candidates_category ON candidates(category)`);

    // Seed the original 7 MCA candidates (IDs 0-6) if table is empty.
    // Using explicit IDs preserves all existing vote records that reference 0-6.
    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM candidates');
    if (parseInt(rows[0].count) === 0) {
      const defaults = [
        { id:0, name:'Hon. James Mwangi', party:'UDA (Incumbent)',  bio:'Two-term MCA, water projects.',    img:'https://randomuser.me/api/portraits/men/32.jpg',    incumbent:true  },
        { id:1, name:'Grace Wanjiku',     party:'Independent',      bio:'Teacher & community organizer.',   img:'https://randomuser.me/api/portraits/women/68.jpg',  incumbent:false },
        { id:2, name:'Peter Kimani',      party:'Jubilee',          bio:'Agri-business entrepreneur.',      img:'https://randomuser.me/api/portraits/men/45.jpg',    incumbent:false },
        { id:3, name:'Sarah Nduati',      party:'Wiper',            bio:'Public health expert.',            img:'https://randomuser.me/api/portraits/women/22.jpg',  incumbent:false },
        { id:4, name:'John Otieno',       party:'Independent',      bio:'Farmer cooperative leader.',       img:'https://randomuser.me/api/portraits/men/89.jpg',    incumbent:false },
        { id:5, name:'Mary Wambui',       party:'Maendeleo',        bio:'ICT & agribusiness graduate.',     img:'https://randomuser.me/api/portraits/women/54.jpg', incumbent:false },
        { id:6, name:'David Kiprotich',   party:'Roots',            bio:'Governance activist.',             img:'https://randomuser.me/api/portraits/men/99.jpg',    incumbent:false }
      ];
      for (const c of defaults) {
        await pool.query(
          `INSERT INTO candidates (id, name, party, bio, img, category, incumbent, display_order)
           VALUES ($1,$2,$3,$4,$5,'MCA',$6,$1)
           ON CONFLICT (id) DO NOTHING`,
          [c.id, c.name, c.party, c.bio, c.img, c.incumbent]
        );
      }
      console.log('✅ Default MCA candidates seeded (IDs 0-6)');
    }

    // Ensure the sequence starts ABOVE the max existing ID so new inserts
    // never clash with the original 0-6 MCA candidate IDs.
    await pool.query(`
      SELECT setval(
        pg_get_serial_sequence('candidates', 'id'),
        GREATEST(7, (SELECT COALESCE(MAX(id), 6) + 1 FROM candidates)),
        false
      )
    `);

    console.log('✅ candidates table ready');
  } catch (e) {
    console.error('❌ ensureCandidatesTable error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// PHASE 1: GEOGRAPHIC FOUNDATION — County / Constituency / Ward
// Additive only. No existing tables, columns, or routes are modified.
// Future phases will wire ward_id into users/votes — not this phase.
// ══════════════════════════════════════════════════════════════════
async function ensureGeographyTables() {
  try {
    // ── Create tables with named constraints (idempotent on re-run) ──

    await pool.query(`
      CREATE TABLE IF NOT EXISTS counties (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT counties_name_unique UNIQUE (name)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS constituencies (
        id         SERIAL PRIMARY KEY,
        county_id  INT NOT NULL,
        name       VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT constituencies_county_fk   FOREIGN KEY (county_id) REFERENCES counties(id),
        CONSTRAINT constituencies_county_name UNIQUE (county_id, name)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS wards (
        id              SERIAL PRIMARY KEY,
        constituency_id INT NOT NULL,
        name            VARCHAR(100) NOT NULL,
        created_at      TIMESTAMP DEFAULT NOW(),
        CONSTRAINT wards_constituency_fk   FOREIGN KEY (constituency_id) REFERENCES constituencies(id),
        CONSTRAINT wards_constituency_name UNIQUE (constituency_id, name)
      )
    `);

    // ── Indexes for FK look-up performance (idempotent) ──
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_constituencies_county_id ON constituencies(county_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wards_constituency_id    ON wards(constituency_id)`);

    // ── Seed: Kiambu County → Thika Town Constituency → Ngoliba Ward ──
    // ON CONFLICT ensures running startup multiple times never creates duplicates.

    await pool.query(`
      INSERT INTO counties (name)
      VALUES ('Kiambu')
      ON CONFLICT ON CONSTRAINT counties_name_unique DO NOTHING
    `);

    await pool.query(`
      INSERT INTO constituencies (county_id, name)
      SELECT id, 'Thika Town'
        FROM counties
       WHERE name = 'Kiambu'
      ON CONFLICT ON CONSTRAINT constituencies_county_name DO NOTHING
    `);

    await pool.query(`
      INSERT INTO wards (constituency_id, name)
      SELECT con.id, 'Ngoliba'
        FROM constituencies con
        JOIN counties       cty ON cty.id = con.county_id
       WHERE cty.name = 'Kiambu'
         AND con.name = 'Thika Town'
      ON CONFLICT ON CONSTRAINT wards_constituency_name DO NOTHING
    `);

    console.log('✅ geography tables ready (counties / constituencies / wards)');
  } catch (e) {
    console.error('❌ ensureGeographyTables error:', e.message);
    // Non-fatal: geography tables are Phase 1 foundation only.
    // Existing functionality is unaffected if this fails.
  }
}

// ══════════════════════════════════════════════════════════════════
// PHASE 2: ATTACH GEOGRAPHIC OWNERSHIP TO DATA
// Additive only. No existing columns, queries, or routes are modified.
// All new ward_id columns are nullable — existing rows and all
// current functionality continue working with zero behaviour change.
// ══════════════════════════════════════════════════════════════════
async function ensurePhase2Migrations() {
  try {
    // ── Step 1: Add nullable ward_id + FK constraint to all 5 tables ──
    // ADD COLUMN IF NOT EXISTS  → idempotent on every startup.
    // DO $$ EXCEPTION block     → idempotent FK constraint (survives re-runs).
    // CREATE INDEX IF NOT EXISTS → idempotent index for future-phase filtering.
    const GEO_TABLES = [
      { table: 'users',       fkName: 'users_ward_id_fk'       },
      { table: 'votes',       fkName: 'votes_ward_id_fk'       },
      { table: 'notices',     fkName: 'notices_ward_id_fk'     },
      { table: 'forum_posts', fkName: 'forum_posts_ward_id_fk' },
      { table: 'candidates',  fkName: 'candidates_ward_id_fk'  },
    ];

    for (const { table, fkName } of GEO_TABLES) {
      // Column (no-op if already present)
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ward_id INT`
      );
      // FK constraint (no-op if already present — caught by EXCEPTION block)
      await pool.query(`
        DO $$
        BEGIN
          ALTER TABLE ${table}
            ADD CONSTRAINT ${fkName} FOREIGN KEY (ward_id) REFERENCES wards(id);
        EXCEPTION WHEN duplicate_object THEN
          NULL;
        END $$
      `);
      // Index for efficient ward-scoped queries in future phases
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_${table}_ward_id ON ${table}(ward_id)`
      );
    }

    // ── Step 2: Resolve the Ngoliba ward_id ──
    // Depends on Phase 1 seed (Kiambu → Thika Town → Ngoliba) being present.
    const wardRes = await pool.query(`
      SELECT w.id
        FROM wards        w
        JOIN constituencies con ON con.id = w.constituency_id
        JOIN counties       cty ON cty.id = con.county_id
       WHERE cty.name = 'Kiambu'
         AND con.name = 'Thika Town'
         AND w.name   = 'Ngoliba'
       LIMIT 1
    `);

    if (!wardRes.rows.length) {
      console.warn('⚠️  [Phase 2] Ngoliba ward row not found — backfill skipped. Ensure ensureGeographyTables() ran successfully first.');
      return;
    }

    const wardId = wardRes.rows[0].id;
    NGOLIBA_WARD_ID = wardId; // cache for all new-record creation flows

    // ── Step 3: Backfill all existing records ──
    // WHERE ward_id IS NULL guarantees full idempotency:
    //   • Already-backfilled rows are never touched again.
    //   • Safe to rerun on every deployment with zero side effects.
    //   • No data is deleted or overwritten.
    for (const { table } of GEO_TABLES) {
      const res = await pool.query(
        `UPDATE ${table} SET ward_id = $1 WHERE ward_id IS NULL`,
        [wardId]
      );
      if (res.rowCount > 0) {
        console.log(`  ↳ [Phase 2] backfilled ${res.rowCount} ${table} row(s) → ward_id=${wardId}`);
      }
    }

    console.log(`✅ Phase 2 complete — NGOLIBA_WARD_ID=${wardId}`);
  } catch (e) {
    console.error('❌ ensurePhase2Migrations error:', e.message);
    console.error(e.stack);
    // Non-fatal: ward_id is nullable — all existing flows continue unchanged.
  }
}

// ── Middleware ──
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:10000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (!process.env.ALLOWED_ORIGIN) {
  console.warn('[CORS] ALLOWED_ORIGIN env var not set — restricting to localhost only. Set it to your Render URL in production.');
}

app.use(cors({
  origin: (incomingOrigin, callback) => {
    // Allow server-to-server requests (no Origin header, e.g. curl, Render health checks)
    if (!incomingOrigin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(incomingOrigin)) return callback(null, true);
    console.warn(`[CORS] Blocked request from unlisted origin: ${incomingOrigin}`);
    callback(new Error(`CORS: origin ${incomingOrigin} is not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Password']
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Candidate Photo Upload (Multer) ──
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'candidates');
// Ensure upload directory exists at startup (no crash if already present)
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const candidateStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, unique);
  }
});

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const candidateUpload = multer({
  storage: candidateStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, JPEG, PNG, and WEBP images are allowed'));
  }
});

// POST /api/admin/candidates/upload-photo — upload a candidate photo, return its public path
app.post('/api/admin/candidates/upload-photo', (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  candidateUpload.single('photo')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: 'Image must be smaller than 5 MB' });
      return res.status(400).json({ success: false, error: err.message });
    }
    if (err) return res.status(400).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    // Return a public URL path that works with express.static
    const publicPath = `/uploads/candidates/${req.file.filename}`;
    return res.json({ success: true, url: publicPath });
  });
});

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
  { id: 0, name: 'Hon. James Mwangi', party: 'UDA (Incumbent)', bio: 'Two-term MCA, water projects.',   img: 'https://randomuser.me/api/portraits/men/32.jpg',   incumbent: true },
  { id: 1, name: 'Grace Wanjiku',     party: 'Independent',     bio: 'Teacher & community organizer.',  img: 'https://randomuser.me/api/portraits/women/68.jpg' },
  { id: 2, name: 'Peter Kimani',      party: 'Jubilee',         bio: 'Agri-business entrepreneur.',      img: 'https://randomuser.me/api/portraits/men/45.jpg'   },
  { id: 3, name: 'Sarah Nduati',      party: 'Wiper',           bio: 'Public health expert.',            img: 'https://randomuser.me/api/portraits/women/22.jpg' },
  { id: 4, name: 'John Otieno',       party: 'Independent',     bio: 'Farmer cooperative leader.',       img: 'https://randomuser.me/api/portraits/men/89.jpg'   },
  { id: 5, name: 'Mary Wambui',       party: 'Maendeleo',       bio: 'ICT & agribusiness graduate.',     img: 'https://randomuser.me/api/portraits/women/54.jpg' },
  { id: 6, name: 'David Kiprotich',   party: 'Roots',           bio: 'Governance activist.',             img: 'https://randomuser.me/api/portraits/men/99.jpg'   }
];

// ════════════════════════════════════════════════
// ROUTE: /api/candidates (PUBLIC - NO AUTH REQUIRED)
// Supports ?category=MCA|MP|Governor|WomenRep
// Defaults to all candidates when no category specified (backward compat)
// ════════════════════════════════════════════════
app.get('/api/candidates', async (req, res) => {
  try {
    const { category } = req.query;
    let result;
    if (category) {
      result = await pool.query(
        `SELECT id, name, party, bio, img, category, incumbent
           FROM candidates
          WHERE category = $1
          ORDER BY display_order, id`,
        [category]
      );
    } else {
      result = await pool.query(
        `SELECT id, name, party, bio, img, category, incumbent
           FROM candidates
          ORDER BY category, display_order, id`
      );
    }

    // If DB has no rows yet (first boot race condition), fall back to in-memory list
    const candidates = result.rows.length > 0 ? result.rows : CANDIDATES.map(c => ({ ...c, category: 'MCA' }));

    return res.json({ success: true, candidates });
  } catch (e) {
    console.error('/api/candidates error:', e);
    // Fall back to in-memory for any DB error
    return res.json({ success: true, candidates: CANDIDATES.map(c => ({ ...c, category: 'MCA' })) });
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
app.post('/api/auth', authLimiter, async (req, res) => {
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
        `INSERT INTO users (id, phone, first_name, surname, dob, sublocation, email, national_id, language, voter_number, password_hash, salt, ward_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())`,
        [id, phone, firstName, surname, dob || null, sublocation || null, email || null, nationalId || null, language || 'en', voterNumber, passwordHash, salt, NGOLIBA_WARD_ID]
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
// ROUTE: /api/reset-password
// ════════════════════════════════════════════════
// action='request' — generate a 6-digit OTP, store it server-side in the otps
//   table, and return it in the response (DEV/DEMO mode — replace the return
//   value with an Africa's Talking SMS call when ready for production).
// action='confirm' — verify the OTP from the DB before allowing the password
//   change. Rate-limited to 5 attempts per OTP to prevent brute-force.
app.post('/api/reset-password', async (req, res) => {
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
      const salt         = crypto.randomBytes(16).toString('hex');
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

    // Resolve the candidate's category from the DB (fall back to 'MCA' for legacy in-memory candidates)
    const CANDS_FALLBACK_CAT = { 0:'MCA',1:'MCA',2:'MCA',3:'MCA',4:'MCA',5:'MCA',6:'MCA' };
    let voteCategory = 'MCA';
    try {
      const candRes = await pool.query('SELECT category FROM candidates WHERE id = $1', [candidateId]);
      if (candRes.rows.length > 0) voteCategory = candRes.rows[0].category || 'MCA';
      else voteCategory = CANDS_FALLBACK_CAT[candidateId] || 'MCA';
    } catch(_) { voteCategory = CANDS_FALLBACK_CAT[candidateId] || 'MCA'; }

    // Eligibility check: one vote per user per period PER CATEGORY
    const voteCheck = await pool.query(
      'SELECT id FROM votes WHERE user_id = $1 AND period_id = $2 AND category = $3',
      [session.userId, periodId, voteCategory]
    );
    if (voteCheck.rows.length > 0)
      return res.status(409).json({ error: `Already voted for ${voteCategory} this period`, alreadyVoted: true, category: voteCategory });

    // ── DEPRECATED: votes.sublocation ──────────────────────────────────────
    // Phase 2.5: votes.sublocation is deprecated as a geographic field.
    // It is a freetext copy of users.sublocation at vote cast-time and has
    // no FK constraint or hierarchy link. It can diverge from the user's
    // actual geographic record if their profile is updated after voting.
    //
    // Geographic source of truth is now: votes.ward_id → wards → constituencies → counties
    //
    // DO NOT add new queries that filter or group by votes.sublocation.
    // Phase 3 migration will replace sublocation-based analytics with ward_id joins.
    // This read and the write below are retained for backward compatibility only.
    // ────────────────────────────────────────────────────────────────────────
    const userResult = await pool.query(
      'SELECT sublocation FROM users WHERE id = $1',
      [session.userId]
    );
    const user = userResult.rows[0];

    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);

    const insertResult = await pool.query(
      // DEPRECATED: sublocation ($5) — kept for backward compat; ward_id ($8) is the authoritative geographic field.
      // Phase 3: remove sublocation from this INSERT and from vote-based analytics queries.
      `INSERT INTO votes (user_id, candidate_id, period_id, category, sublocation, ip_hash, timestamp, ward_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, period_id, category) DO NOTHING
       RETURNING id`,
      [session.userId, candidateId, periodId, voteCategory, user?.sublocation || null, ipHash, Date.now(), NGOLIBA_WARD_ID]
    );

    // If no row was inserted, a concurrent request already recorded a vote (race condition)
    if (insertResult.rowCount === 0) {
      return res.status(409).json({ error: `Already voted for ${voteCategory} this period`, alreadyVoted: true, category: voteCategory });
    }

    // total_votes counter removed — totalVotes is now counted live from the votes table

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
      periodId,
      category: voteCategory
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
    // DEPRECATED: votes.sublocation grouping — Phase 3 replaces with ward_id join.
    // votes.sublocation is a freetext snapshot; ward_id is the authoritative geographic field.
      'SELECT candidate_id, sublocation, COUNT(*) as count FROM votes WHERE period_id = $1 GROUP BY candidate_id, sublocation',
      [period.id]
    );

    // Check which categories the authenticated user has voted in this period
    let hasVoted = false;
    let votedCategories = {};
    const session = verifySession(req.headers.cookie || '');
    if (session && session.userId) {
      const voteCheck = await pool.query(
        'SELECT category FROM votes WHERE user_id = $1 AND period_id = $2',
        [session.userId, period.id]
      );
      if (voteCheck.rows.length > 0) {
        hasVoted = true; // backward-compat: true if voted in ANY category
        voteCheck.rows.forEach(r => { votedCategories[r.category] = true; });
      }
    }

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

    // Live count — always accurate regardless of deletes or restores
    const liveTotalRes = await pool.query(
      'SELECT COUNT(*) AS count FROM votes WHERE period_id = $1', [period.id]
    );
    const liveTotalVotes = parseInt(liveTotalRes.rows[0].count || 0);

    return res
      .set('Cache-Control', 'private, no-cache')
      .json({
        periodId: period.id,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        isActive: period.is_active,
        totalVotes: liveTotalVotes,
        hasVoted,
        votedCategories,
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
        // DEPRECATED: votes.sublocation grouping — Phase 3 replaces with ward_id join.
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
// ROUTE: GET /api/voting-results
// Returns CUMULATIVE vote totals across ALL periods, joined to the
// candidates table (DB-backed). Mirrors the contract previously served
// by routes/voting.js so frontend consumers need no changes.
//
// Response shape:
//   { success, data: { periodId, results[ candidateId, name, party, img, votes, percentage ], totalVotes, updatedAt } }
//
// Vote semantics: lifetime cumulative (no period filter) — identical to
// the voting.js implementation which used SELECT … FROM votes GROUP BY candidate_id.
// ════════════════════════════════════════════════
app.get('/api/voting-results', async (req, res) => {
  try {
    // 1. Cumulative vote counts across ALL periods (no period filter)
    const voteRes = await pool.query(`
      SELECT   candidate_id,
               COUNT(*) AS vote_count
      FROM     votes
      GROUP BY candidate_id
    `);

    // Build a lookup map: candidate_id (int) → vote_count (int)
    const countMap = {};
    let totalVotes = 0;
    voteRes.rows.forEach(row => {
      const id    = parseInt(row.candidate_id);
      const count = parseInt(row.vote_count);
      countMap[id] = count;
      totalVotes  += count;
    });

    // 2. Fetch all MCA candidates from the DB (authoritative source)
    const candRes = await pool.query(`
      SELECT id, name, party, img
      FROM   candidates
      WHERE  category = 'MCA'
      ORDER BY id
    `);

    // 3. Build results array — every candidate appears even with 0 votes
    const results = candRes.rows.map(c => {
      const votes = countMap[parseInt(c.id)] || 0;
      return {
        candidateId: parseInt(c.id),
        name:        c.name,
        party:       c.party  || '',
        img:         c.img    || '',
        votes,
        percentage:  totalVotes > 0 ? ((votes / totalVotes) * 100).toFixed(1) : '0.0'
      };
    }).sort((a, b) => b.votes - a.votes);

    // 4. Current active period id for cycle context (mirrors voting.js behaviour)
    const periodRes = await pool.query(
      `SELECT id FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1`
    );
    const periodId = periodRes.rows.length > 0 ? periodRes.rows[0].id : null;

    return res.json({
      success: true,
      data: {
        periodId,
        results,
        totalVotes,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (e) {
    console.error('[/api/voting-results] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch voting results' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: GET /api/period-history
// Returns completed voting periods with per-candidate vote totals.
// Source of truth: voting_periods (is_active=false) + votes + candidates tables.
// Does NOT depend on localStorage or period_archives.
// ════════════════════════════════════════════════
app.get('/api/period-history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    // Fetch completed periods only (is_active = false), most recent first
    const periodsResult = await pool.query(`
      SELECT id, period_start, period_end, total_votes
        FROM voting_periods
       WHERE is_active = false
       ORDER BY id DESC
       LIMIT $1
    `, [limit]);

    if (periodsResult.rows.length === 0) {
      return res.json({ success: true, periods: [] });
    }

    // Fetch all candidates once (id, name, category) to avoid N+1 lookups
    const candResult = await pool.query(
      `SELECT id, name, category FROM candidates ORDER BY id`
    );
    const candidateMap = {};
    candResult.rows.forEach(c => { candidateMap[c.id] = c; });

    const periods = [];
    for (const period of periodsResult.rows) {
      // Aggregate votes per candidate for this period
      const votesResult = await pool.query(
        `SELECT candidate_id, COUNT(*) AS vote_count
           FROM votes
          WHERE period_id = $1
          GROUP BY candidate_id`,
        [period.id]
      );

      const candidates = votesResult.rows.map(row => {
        const cand = candidateMap[row.candidate_id] || {};
        return {
          candidateId:   String(row.candidate_id),
          candidateName: cand.name     || `Candidate ${row.candidate_id}`,
          category:      cand.category || 'MCA',
          votes:         parseInt(row.vote_count),
        };
      });

      periods.push({
        periodId:   String(period.id),
        periodName: `Cycle ${period.id}`,
        startDate:  period.period_start,
        endDate:    period.period_end,
        candidates,
      });
    }

    return res.json({ success: true, periods });
  } catch (e) {
    console.error('/api/period-history error:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch period history' });
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

    // Enrich with candidate name + category from DB (fall back to in-memory for MCA 0-6)
    const candIdsNeeded = [...new Set(result.rows.map(r => parseInt(r.candidate_id)))];
    let candMap = {};
    if (candIdsNeeded.length > 0) {
      try {
        const cr = await pool.query(
          `SELECT id, name, party, category FROM candidates WHERE id = ANY($1)`,
          [candIdsNeeded]
        );
        cr.rows.forEach(c => { candMap[c.id] = c; });
      } catch (_) {}
    }
    // In-memory fallback for original MCA candidates
    const CANDS_FALLBACK = [
      { id: 0, name: 'Hon. James Mwangi', party: 'Jubilee',      category: 'MCA' },
      { id: 1, name: 'Grace Wanjiku',     party: 'ODM',          category: 'MCA' },
      { id: 2, name: 'Peter Kimani',      party: 'UDA',          category: 'MCA' },
      { id: 3, name: 'Sarah Nduati',      party: 'Wiper',        category: 'MCA' },
      { id: 4, name: 'John Otieno',       party: 'ANC',          category: 'MCA' },
      { id: 5, name: 'Mary Wambui',       party: 'Ford-K',       category: 'MCA' },
      { id: 6, name: 'David Kiprotich',   party: 'Independent',  category: 'MCA' }
    ];

    const votes = result.rows.map(row => {
      const cid = parseInt(row.candidate_id);
      const cand = candMap[cid] || CANDS_FALLBACK.find(c => c.id === cid) || {};
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


// ══════════════════════════════════════════════════════════════════════
// ADMIN CANDIDATE MANAGEMENT — Multi-category support
// All routes require X-Admin-Password header (same as notices admin)
// ══════════════════════════════════════════════════════════════════════

// GET /api/admin/candidates?category=MCA — list candidates (optionally filtered)
app.get('/api/admin/candidates', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  const { category } = req.query;
  try {
    const result = category
      ? await pool.query(
          `SELECT * FROM candidates WHERE category = $1 ORDER BY display_order, id`,
          [category]
        )
      : await pool.query(
          `SELECT * FROM candidates ORDER BY category, display_order, id`
        );
    res.json({ success: true, candidates: result.rows });
  } catch (err) {
    console.error('GET /api/admin/candidates error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/candidates — add a new candidate
app.post('/api/admin/candidates', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  const { name, party, bio, img, category, incumbent } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'name is required' });
  const cat = CANDIDATE_CATEGORIES.includes(category) ? category : 'MCA';
  try {
    // display_order = 1 + current max within category
    const maxOrd = await pool.query(
      `SELECT COALESCE(MAX(display_order), -1) AS max_ord FROM candidates WHERE category = $1`,
      [cat]
    );
    const nextOrd = parseInt(maxOrd.rows[0].max_ord) + 1;
    const result = await pool.query(
      `INSERT INTO candidates (name, party, bio, img, category, incumbent, display_order, ward_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [name.trim(), party || '', bio || '', img || '', cat, incumbent === true || incumbent === 'true', nextOrd, NGOLIBA_WARD_ID]
    );
    res.json({ success: true, candidate: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/candidates error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/candidates/:id — edit an existing candidate
app.put('/api/admin/candidates/:id', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  const { name, party, bio, img, category, incumbent } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'name is required' });
  const cat = CANDIDATE_CATEGORIES.includes(category) ? category : 'MCA';
  try {
    const result = await pool.query(
      `UPDATE candidates
          SET name=$1, party=$2, bio=$3, img=$4, category=$5, incumbent=$6
        WHERE id=$7
        RETURNING *`,
      [name.trim(), party || '', bio || '', img || '', cat, incumbent === true || incumbent === 'true', req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Candidate not found' });
    res.json({ success: true, candidate: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/admin/candidates/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/candidates/:id — remove a candidate
app.delete('/api/admin/candidates/:id', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;
  try {
    const result = await pool.query(
      `DELETE FROM candidates WHERE id=$1 RETURNING id, name, category`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Candidate not found' });
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/admin/candidates/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
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

    // Live count for current period
    let statsTotalVotes = 0;
    if (period) {
      const statsTotalRes = await pool.query(
        'SELECT COUNT(*) AS count FROM votes WHERE period_id = $1', [period.id]
      );
      statsTotalVotes = parseInt(statsTotalRes.rows[0].count || 0);
    }

    res.json({
      success: true,
      registeredVoters,
      currentPeriod: period ? {
        periodId: period.id,
        totalVotes: statsTotalVotes,
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

// ════════════════════════════════════════════════════════════════════════════
// GET /api/analytics/dashboard — all data needed by the Analytics tab
// Returns: votesThisCycle, registeredVoters, turnoutRate, allTimeVotes,
//          per-sublocation heatmap, real hourly distribution, AI prediction
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    // ── Phase 2.5: KNOWN_SUBLOCATIONS removed ──────────────────────────────
    // Previously: const KNOWN_SUBLOCATIONS = ['Ngoliba','Gatiiguru','Kilimambogo','Magogoni']
    // That array silently excluded any sublocation not in the list.
    // Replacement: derive sublocations live from the users table so new
    // sublocations appear in the heatmap automatically with zero code changes.
    // Heatmap shape, calculations, and API response format are unchanged.
    // ────────────────────────────────────────────────────────────────────────

    // 1. Registered voters
    const votersRes = await pool.query('SELECT COUNT(*) AS count FROM users');
    const registeredVoters = parseInt(votersRes.rows[0].count || 0);

    // 2. Active period
    const periodRes = await pool.query(
      'SELECT id, period_start, period_end, total_votes FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );
    const period   = periodRes.rows[0] || null;
    const periodId = period ? period.id : null;

    // 3. Votes this cycle — live count from votes table (authoritative)
    let votesThisCycle = 0;
    if (periodId !== null) {
      const cycleRes = await pool.query(
        'SELECT COUNT(*) AS count FROM votes WHERE period_id = $1', [periodId]
      );
      votesThisCycle = parseInt(cycleRes.rows[0].count || 0);
    }

    // 4. All-time total votes across every period
    const allTimeRes = await pool.query(
      'SELECT COALESCE(SUM(total_votes), 0) AS total FROM voting_periods'
    );
    const allTimeVotes = parseInt(allTimeRes.rows[0].total || 0);

    // 5. Turnout rate for this cycle
    const turnoutRate = registeredVoters > 0
      ? parseFloat(((votesThisCycle / registeredVoters) * 100).toFixed(1))
      : 0;

    // 6. Registered voters per sublocation — also used to derive heatmap sublocation list
    const subVotersRes = await pool.query(
      `SELECT COALESCE(sublocation, 'Unknown') AS sub, COUNT(*) AS cnt FROM users GROUP BY sublocation`
    );
    const votersBySubLocation = {};
    subVotersRes.rows.forEach(r => { votersBySubLocation[r.sub] = parseInt(r.cnt); });

    // 7. Votes per sublocation in current period
    const subVotesRes = periodId !== null
      ? await pool.query(
          `SELECT COALESCE(sublocation, 'Unknown') AS sub, COUNT(*) AS cnt
           FROM votes WHERE period_id = $1 GROUP BY sublocation`, [periodId]
        )
      : { rows: [] };
    const votesBySubLocation = {};
    subVotesRes.rows.forEach(r => { votesBySubLocation[r.sub] = parseInt(r.cnt); });

    // 8. Heatmap — per-sublocation accuracy
    // Phase 2.5: sublocation list is now derived from registered users (step 6 above).
    // Any sublocation present in the users table appears automatically — no hardcoded list.
    // Excludes 'Unknown' (NULL users) from the heatmap as they carry no geographic meaning.
    // Sorted alphabetically so order is stable and deterministic across restarts.
    const derivedSublocations = Object.keys(votersBySubLocation)
      .filter(sub => sub !== 'Unknown')
      .sort();
    const heatmap = derivedSublocations.map(sub => {
      const registered = votersBySubLocation[sub] || 0;
      const votes      = votesBySubLocation[sub]  || 0;
      const pct        = registered > 0 ? parseFloat(((votes / registered) * 100).toFixed(1)) : 0;
      return { sublocation: sub, votes, registered, pct };
    });

    // 9. Hourly vote distribution — real data from votes.timestamp (EAT = UTC+3)
    //    Shows votes cast in the last 24 hours, bucketed by local hour
    let hourlyVotes = [];
    try {
      const hourlyRes = await pool.query(
        `SELECT
           EXTRACT(HOUR FROM (to_timestamp(timestamp::bigint / 1000) + INTERVAL '3 hours')) AS hr,
           COUNT(*) AS cnt
         FROM votes
         WHERE timestamp::bigint >= (EXTRACT(EPOCH FROM (NOW() - INTERVAL '24 hours')) * 1000)
         GROUP BY hr
         ORDER BY hr`
      );
      const hrMap = {};
      hourlyRes.rows.forEach(r => { hrMap[parseInt(r.hr)] = parseInt(r.cnt); });
      // 13 slots: 6 AM → 6 PM (Nairobi business hours)
      hourlyVotes = Array.from({ length: 13 }, (_, i) => {
        const h = i + 6;
        return { hour: h, votes: hrMap[h] || 0 };
      });
    } catch (hourlyErr) {
      console.warn('[analytics/dashboard] hourly query failed (non-fatal):', hourlyErr.message);
      hourlyVotes = Array.from({ length: 13 }, (_, i) => ({ hour: i + 6, votes: 0 }));
    }

    // 10. AI Prediction — leading candidate by cumulative all-category votes
    let prediction = { leader: null, confidence: 50 };
    try {
      const allVotesRes = await pool.query(
        `SELECT v.candidate_id, COUNT(*) AS cnt, c.name
         FROM votes v
         JOIN candidates c ON c.id = v.candidate_id
         WHERE c.category = 'MCA'
         GROUP BY v.candidate_id, c.name
         ORDER BY cnt DESC
         LIMIT 2`
      );
      if (allVotesRes.rows.length > 0) {
        const top    = allVotesRes.rows[0];
        const second = allVotesRes.rows[1];
        const total  = parseInt(top.cnt) + (second ? parseInt(second.cnt) : 0);
        prediction = {
          leader:     top.name,
          confidence: total > 0 ? Math.min(99, Math.round((parseInt(top.cnt) / total) * 100)) : 50
        };
      }
    } catch (predErr) {
      console.warn('[analytics/dashboard] prediction query failed (non-fatal):', predErr.message);
    }

    res.json({
      success:          true,
      votesThisCycle,
      registeredVoters,
      turnoutRate,
      allTimeVotes,
      currentPeriodId:  periodId,
      periodStart:      period?.period_start || null,
      periodEnd:        period?.period_end   || null,
      heatmap,
      hourlyVotes,
      prediction,
      votersBySubLocation
    });

  } catch (error) {
    console.error('/api/analytics/dashboard error:', error.message, error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Allowed forum categories — extend this array to add new ones
const FORUM_CATEGORIES = ['general', 'water', 'roads', 'health', 'youth'];

// Helper: map post row → API shape
function formatPost(p) {
  return {
    id: p.id,
    author: p.author_name || 'Anonymous',
    authorPhone: p.author_phone || null,
    text: p.content,
    title: p.title,
    category: p.category || 'general',
    likes: parseInt(p.like_count) || 0,
    reply_count: parseInt(p.reply_count) || 0,
    created_at: p.created_at,
    last_activity_at: p.last_activity_at
  };
}

// Helper: map reply row → API shape
function formatReply(r) {
  return {
    id: r.id,
    postId: r.post_id,
    author: r.author_name || 'Anonymous',
    text: r.content,
    likes: parseInt(r.like_count) || 0,
    created_at: r.created_at
  };
}

// ────────────────────────────────────────────────────────────────
// GET /api/forum  — list posts, optional ?category= filter
// ────────────────────────────────────────────────────────────────
app.get('/api/forum', async (req, res) => {
  try {
    const cat = req.query.category;
    const validCat = cat && FORUM_CATEGORIES.includes(cat) ? cat : null;

    const result = validCat
      ? await pool.query(
          `SELECT * FROM forum_posts
            WHERE COALESCE(is_deleted, false) = false
              AND COALESCE(is_hidden,  false) = false
              AND category = $1
            ORDER BY last_activity_at DESC LIMIT 60`,
          [validCat]
        )
      : await pool.query(
          `SELECT * FROM forum_posts
            WHERE COALESCE(is_deleted, false) = false
              AND COALESCE(is_hidden,  false) = false
            ORDER BY last_activity_at DESC LIMIT 60`
        );

    res.json({ success: true, posts: result.rows.map(formatPost) });
  } catch (error) {
    console.error('GET /api/forum error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to get forum posts' });
  }
});

// ────────────────────────────────────────────────────────────────
// POST /api/forum  — create post | like post | list posts (legacy)
// ────────────────────────────────────────────────────────────────
app.post('/api/forum', async (req, res) => {
  const { action, text, title, postId, category } = req.body;

  // ── create_post ──────────────────────────────────────────────
  if (action === 'create_post') {
    // Rate-limit post creation only — likes and reads are unaffected
    const limited = await new Promise(resolve => forumPostLimiter(req, res, resolve));
    if (res.headersSent) return; // limiter already sent 429
    const session = verifySession(req.headers.cookie || '');
    if (!session) return res.status(401).json({ success: false, error: 'Login required to post' });

    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.length < 3)
      return res.status(400).json({ success: false, error: 'Post must be at least 3 characters' });
    if (trimmed.length > 2000)
      return res.status(400).json({ success: false, error: 'Post cannot exceed 2000 characters' });

    const safeCategory = FORUM_CATEGORIES.includes(category) ? category : 'general';
    // Sanitise: strip raw HTML tags to prevent XSS (stored as plain text, escaped on render)
    const safeText = trimmed.replace(/<[^>]*>/g, '');

    try {
      const user = await pool.query(
        'SELECT id, first_name, surname, profile_photo FROM users WHERE id = $1',
        [session.userId]
      );
      if (!user.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
      const u = user.rows[0];
      const author = `${u.first_name} ${u.surname}`.trim() || 'Anonymous';
      const autoTitle = title?.trim() || safeText.slice(0, 80);

      const post = await pool.query(
        `INSERT INTO forum_posts
           (title, content, author_id, author_name, author_phone, category, ward_id, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
        [autoTitle, safeText, u.id, author, session.phone, safeCategory, NGOLIBA_WARD_ID]
      );

      res.json({ success: true, post: formatPost(post.rows[0]) });
    } catch (error) {
      console.error('POST /api/forum create_post error:', error.message, error.stack);
      res.status(500).json({ success: false, error: 'Failed to create post' });
    }

  // ── like_post ────────────────────────────────────────────────
  } else if (action === 'like_post') {
    const session = verifySession(req.headers.cookie || '');
    if (!session) return res.status(401).json({ success: false, error: 'Login required to like' });
    if (!postId) return res.status(400).json({ success: false, error: 'postId required' });

    try {
      const userRes = await pool.query('SELECT id FROM users WHERE id = $1', [session.userId]);
      if (!userRes.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
      const userId = userRes.rows[0].id;

      // Toggle: insert or delete
      const existing = await pool.query(
        'SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]
      );
      if (existing.rows.length) {
        await pool.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
      } else {
        await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, userId]);
      }
      // Sync count
      await pool.query(
        'UPDATE forum_posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1) WHERE id = $1',
        [postId]
      );
      const updated = await pool.query('SELECT like_count FROM forum_posts WHERE id = $1', [postId]);
      res.json({ success: true, likes: parseInt(updated.rows[0]?.like_count) || 0, liked: !existing.rows.length });
    } catch (error) {
      console.error('POST /api/forum like_post error:', error.message);
      res.status(500).json({ success: false, error: 'Failed to like post' });
    }

  // ── list_posts (legacy POST action — keep for backward compat) ──
  } else if (action === 'list_posts') {
    try {
      const cat = req.body.category;
      const validCat = cat && FORUM_CATEGORIES.includes(cat) ? cat : null;
      const result = validCat
        ? await pool.query(
            `SELECT * FROM forum_posts WHERE COALESCE(is_deleted,false)=false AND COALESCE(is_hidden,false)=false AND category=$1 ORDER BY last_activity_at DESC LIMIT 60`,
            [validCat]
          )
        : await pool.query(
            `SELECT * FROM forum_posts WHERE COALESCE(is_deleted,false)=false AND COALESCE(is_hidden,false)=false ORDER BY last_activity_at DESC LIMIT 60`
          );
      res.json({ success: true, posts: result.rows.map(formatPost) });
    } catch (error) {
      console.error('POST /api/forum list_posts error:', error.message);
      res.status(500).json({ success: false, error: 'Failed to list posts' });
    }

  } else {
    res.status(400).json({ success: false, error: 'Unknown action' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/forum/replies/:postId  — list replies for a post
// ────────────────────────────────────────────────────────────────
app.get('/api/forum/replies/:postId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM forum_replies
        WHERE post_id = $1
          AND COALESCE(is_deleted, false) = false
          AND COALESCE(is_hidden,  false) = false
        ORDER BY created_at ASC`,
      [req.params.postId]
    );
    res.json({ success: true, replies: result.rows.map(formatReply) });
  } catch (error) {
    console.error('GET /api/forum/replies error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to get replies' });
  }
});

// ────────────────────────────────────────────────────────────────
// POST /api/forum/replies  — add a reply to a post
// ────────────────────────────────────────────────────────────────
app.post('/api/forum/replies', forumReplyLimiter, async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Login required to reply' });

  const { postId, text } = req.body;
  if (!postId) return res.status(400).json({ success: false, error: 'postId required' });

  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length < 1)
    return res.status(400).json({ success: false, error: 'Reply cannot be empty' });
  if (trimmed.length > 1000)
    return res.status(400).json({ success: false, error: 'Reply cannot exceed 1000 characters' });

  const safeText = trimmed.replace(/<[^>]*>/g, '');

  try {
    // Verify post exists and is not deleted/hidden
    const postCheck = await pool.query(
      `SELECT id FROM forum_posts WHERE id = $1 AND COALESCE(is_deleted,false)=false AND COALESCE(is_hidden,false)=false`,
      [postId]
    );
    if (!postCheck.rows.length)
      return res.status(404).json({ success: false, error: 'Post not found' });

    const user = await pool.query(
      'SELECT id, first_name, surname FROM users WHERE id = $1', [session.userId]
    );
    if (!user.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    const u = user.rows[0];
    const author = `${u.first_name} ${u.surname}`.trim() || 'Anonymous';

    const reply = await pool.query(
      `INSERT INTO forum_replies (post_id, content, author_id, author_name, author_phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [postId, safeText, u.id, author, session.phone]
    );

    // Update reply_count and last_activity_at on the parent post
    await pool.query(
      `UPDATE forum_posts
         SET reply_count = (SELECT COUNT(*) FROM forum_replies WHERE post_id = $1 AND COALESCE(is_deleted,false)=false),
             last_activity_at = NOW()
       WHERE id = $1`,
      [postId]
    );

    res.json({ success: true, reply: formatReply(reply.rows[0]) });
  } catch (error) {
    console.error('POST /api/forum/replies error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to post reply' });
  }
});

// GET /api/faceoff - Top 2 candidates by CUMULATIVE votes across all cycles
// Supports ?category=MCA|MP|Governor|WomenRep (defaults to MCA for backward compat)
app.get('/api/faceoff', async (req, res) => {
  try {
    const category = req.query.category || 'MCA';

    // Load candidates for this category from DB
    let candRes;
    try {
      candRes = await pool.query(
        `SELECT id, name, party, bio, img, category, incumbent
           FROM candidates
          WHERE category = $1
          ORDER BY display_order, id`,
        [category]
      );
    } catch (_) { candRes = { rows: [] }; }

    // Fallback to in-memory CANDIDATES if DB not ready / empty
    const candidates = candRes.rows.length > 0
      ? candRes.rows
      : (category === 'MCA' ? CANDIDATES.map(c => ({ ...c, category: 'MCA' })) : []);

    if (candidates.length === 0) {
      return res.json({ success: true, candidates: [], allCandidates: [], periodId: null, totalVotes: 0 });
    }

    // Cumulative vote counts for this category's candidates
    const candidateIds = candidates.map(c => c.id);
    const allVotes = await pool.query(
      `SELECT candidate_id, COUNT(*) AS vote_count
         FROM votes
        WHERE candidate_id = ANY($1)
        GROUP BY candidate_id`,
      [candidateIds]
    );

    const voteMap = {};
    allVotes.rows.forEach(r => {
      voteMap[parseInt(r.candidate_id)] = parseInt(r.vote_count);
    });

    const totalVotes = Object.values(voteMap).reduce((s, n) => s + n, 0);

    const ranked = candidates.map(c => ({
      ...c,
      vote_count: voteMap[c.id] || 0,
      percentage: totalVotes > 0 ? (((voteMap[c.id] || 0) / totalVotes) * 100).toFixed(1) : '0.0'
    })).sort((a, b) => b.vote_count - a.vote_count);

    const top2 = ranked.slice(0, 2);

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
    const secret = process.env.ADMIN_SECRET;
    if (!secret) return res.status(503).json({ success: false, error: 'Admin service not configured.' });
    if (adminSecret !== secret) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    if (!title || !content) {
      return res.status(400).json({ success: false, error: 'title and content are required' });
    }
    const result = await pool.query(
      `INSERT INTO notices (title, content, category, priority, expires_at, created_by, ward_id)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::INTERVAL, 'admin', $6)
       RETURNING *`,
      [title, content, category || 'general', priority || 'normal', String(days || 30), NGOLIBA_WARD_ID]
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
    const secret = process.env.ADMIN_SECRET;
    if (!secret) return res.status(503).json({ success: false, error: 'Admin service not configured.' });
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
  // ── PRIMARY PATH: JWT Bearer token (same credential the admin panel already holds) ──
  // This fixes the two-headed auth mismatch where ADMIN_PASSWORD_HASH (login) and
  // ADMIN_SECRET (candidate/notice routes) were independent env vars that could diverge.
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ') && verifyAdminToken(authHeader)) {
    return true;
  }

  // ── FALLBACK PATH: legacy x-admin-password header (keeps direct API access working) ──
  const secret   = process.env.ADMIN_SECRET;
  if (!secret) {
    console.error('[checkNoticeAdminAuth] ADMIN_SECRET environment variable is not set.');
    res.status(503).json({ success: false, error: 'Admin service not configured.' });
    return false;
  }
  const provided = req.headers['x-admin-password'];
  if (provided && provided === secret) {
    return true;
  }

  res.status(401).json({ success: false, error: 'Unauthorized' });
  return false;
}

app.post('/api/admin/notices/verify', (req, res) => {
  // Accept JWT Bearer token (preferred) or legacy x-admin-password
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ') && verifyAdminToken(authHeader)) return res.json({ success: true });
  const secret   = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ success: false, error: 'Admin service not configured.' });
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
      'INSERT INTO notices (title,content,category,priority,expires_at,created_by,ward_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [title, content, category||'general', priority||'normal', expiresAt||null, 'admin', NGOLIBA_WARD_ID]
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

    if (!adminHash || inputHash !== adminHash.toUpperCase()) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }

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
    // Phase 2.5 NOTE — admin user list currently shows users.sublocation (freetext, no FK).
    // Current behavior: correct for single-ward deployment; sublocation is user-entered text.
    // Phase 3 migration recommendation: add ward join to expose w.name, con.name, cty.name
    // alongside sublocation so admins see the full verified hierarchy, not just freetext.
    // No code change required here until Phase 3.
    const result = await pool.query('SELECT id, phone, first_name, surname, sublocation, created_at FROM users ORDER BY created_at DESC LIMIT 100');
    return res.json({ success: true, users: result.rows, total: result.rowCount });
  } catch (error) {
    console.error('Error in get_users:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

  // ✅ ADD PERIOD - uses minutes (1–60), never days; hard cap prevents runaway durations
if (action === 'add_period') {
  // Accept durationMinutes (preferred) or legacy durationDays field — always treat as minutes.
  const raw = parseInt(req.body.durationMinutes ?? req.body.durationDays) || 5;
  const mins = Math.min(Math.max(raw, 1), 60); // clamp: 1 min ≤ duration ≤ 60 min
  if (raw !== mins) {
    console.warn(`[add_period] durationMinutes ${raw} clamped to ${mins}`);
  }
  try {
    // Deactivate any currently active periods first
    await pool.query('UPDATE voting_periods SET is_active = false WHERE is_active = true');
    const result = await pool.query(
      `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
       VALUES (
         COALESCE((SELECT MAX(id) FROM voting_periods), 0) + 1,
         NOW(), NOW() + ($1 || ' minutes')::INTERVAL, true, 0
       )
       RETURNING id, period_start, period_end, is_active, total_votes`,
      [String(mins)]
    );
    console.log(`[add_period] New period created: id=${result.rows[0].id}, duration=${mins}min, ends=${result.rows[0].period_end}`);
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
// MANUAL WRAPPER around the single authoritative createArchiveAndRollPeriod().
// force:true preserves the existing admin feature of ending a period early
// (the auto interval/webhook path only rolls over once period_end has
// actually passed) — that is the one intentional behavioral difference
// between this trigger and the other two, and it is now expressed as a
// parameter rather than a second copy of the rollover logic.
// ════════════════════════════════════════════════
app.post('/api/period/next', async (req, res) => {
  if (!checkNoticeAdminAuth(req, res)) return;

  const { durationMinutes } = req.body;

  try {
    const result = await createArchiveAndRollPeriod(pool, {
      triggerSource: 'manual',
      force: true,
      durationMinutes
    });

    if (!result.rolled) {
      // Practically unreachable with force:true unless there's truly no
      // active period row at all — still handled cleanly rather than crashing.
      return res.status(409).json({ success: false, error: result.reason });
    }

    if (result.winner) {
      broadcastVoteUpdate('period-ended', {
        period:      result.completedPeriod,
        winner:      result.winner.id,
        winnerVotes: result.winner.votes
      });
    }

    console.log(`[/api/period/next] New period created: id=${result.newPeriod}, ends=${result.endsAt}`);
    return res.json({ success: true, data: { newPeriod: result.newPeriod, endsAt: result.endsAt } });
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
      const endTime = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes
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

    // 3. Check which categories the authenticated user has voted in this cycle
    let userHasVoted = false;
    let votedCategories = {};
    const session = verifySession(req.headers.cookie || '');
    if (session && session.userId) {
      const voteCheck = await pool.query(
        `SELECT category FROM votes WHERE user_id = $1 AND period_id = $2`,
        [session.userId, period.id]
      );
      if (voteCheck.rows.length > 0) {
        userHasVoted = true; // backward-compat: true if voted in ANY category
        voteCheck.rows.forEach(r => { votedCategories[r.category] = true; });
      }
    }

    // Live count — not the drifting counter column
    const vpLiveRes = await pool.query(
      'SELECT COUNT(*) AS count FROM votes WHERE period_id = $1', [period.id]
    );
    const periodLiveCount = parseInt(vpLiveRes.rows[0].count || 0);

    return res.json({
      success: true,
      data: {
        periodId:         period.id,
        startedAt:        period.period_start,
        endsAt:           period.period_end,
        endsIn:           endsInMs,
        secondsRemaining,
        totalVotes:       periodLiveCount,
        isActive:         true,
        userHasVoted,
        votedCategories
      }
    });

  } catch (e) {
    console.error('[/api/voting-period] ERROR:', e.message);
    console.error(e.stack);
    return res.status(500).json({ success: false, error: 'Failed to fetch voting period' });
  }
});

// ════════════════════════════════════════════════
// ROUTE: /api/webhook  — optional external ping (e.g. cron-period-reset.js)
// BACKUP WRAPPER around the single authoritative createArchiveAndRollPeriod().
//
// This is intentionally NOT the authoritative trigger. The in-process
// setInterval above already checks for expiry every 30s and needs nothing
// external to function correctly. This endpoint exists purely as a
// resilience net for platforms (e.g. Render free tier) where the process
// can be put to sleep and an external ping is what wakes it back up — in
// that scenario this fires the exact same guarded function the interval
// would have fired anyway. The system's correctness no longer depends on
// any external cron script reaching this URL on schedule; if it never
// fires again, the interval alone keeps rollovers happening.
// Protected by CRON_SECRET header to prevent unauthenticated calls.
// ════════════════════════════════════════════════
app.post('/api/webhook', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const result = await createArchiveAndRollPeriod(pool, { triggerSource: 'webhook' });

    if (!result.rolled) {
      if (result.reason === 'no-active-period') {
        return res.json({ success: true, message: 'No active period' });
      }
      // not-expired / already-claimed — another trigger handled it, or it's not due yet
      return res.json({ success: true, message: 'Period still active', endsAt: result.endsAt });
    }

    return res.json({
      success: true,
      completedPeriod: result.completedPeriod,
      newPeriod: result.newPeriod,
      endsAt: result.endsAt
    });
  } catch (e) {
    console.error('[webhook] ERROR:', e.message);
    return res.status(500).json({ success: false, error: e.message });
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

// ══════════════════════════════════════════════════════════════════
// PHASE 1: READ-ONLY GEOGRAPHIC ENDPOINTS
// These are purely additive. They do not touch authentication,
// session handling, voting, timers, candidates, or any existing route.
// ══════════════════════════════════════════════════════════════════

// GET /api/counties
// Returns all counties ordered alphabetically.
app.get('/api/counties', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, created_at FROM counties ORDER BY name ASC'
    );
    return res.json({ success: true, counties: result.rows });
  } catch (e) {
    console.error('[/api/counties] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch counties' });
  }
});

// GET /api/constituencies
// Optional query param: ?county_id=<integer>
// Returns all constituencies, or only those belonging to a specific county.
app.get('/api/constituencies', async (req, res) => {
  try {
    const { county_id } = req.query;
    const result = county_id
      ? await pool.query(
          'SELECT id, county_id, name, created_at FROM constituencies WHERE county_id = $1 ORDER BY name ASC',
          [parseInt(county_id, 10)]
        )
      : await pool.query(
          'SELECT id, county_id, name, created_at FROM constituencies ORDER BY name ASC'
        );
    return res.json({ success: true, constituencies: result.rows });
  } catch (e) {
    console.error('[/api/constituencies] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch constituencies' });
  }
});

// GET /api/wards
// Optional query param: ?constituency_id=<integer>
// Returns all wards, or only those belonging to a specific constituency.
app.get('/api/wards', async (req, res) => {
  try {
    const { constituency_id } = req.query;
    const result = constituency_id
      ? await pool.query(
          'SELECT id, constituency_id, name, created_at FROM wards WHERE constituency_id = $1 ORDER BY name ASC',
          [parseInt(constituency_id, 10)]
        )
      : await pool.query(
          'SELECT id, constituency_id, name, created_at FROM wards ORDER BY name ASC'
        );
    return res.json({ success: true, wards: result.rows });
  } catch (e) {
    console.error('[/api/wards] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch wards' });
  }
});

// ── Catch-all: serve index.html for any unmatched GET ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// server.listen, auto-rollover setInterval, and SIGTERM handler
// are all started inside the startup IIFE above, after migrations complete.