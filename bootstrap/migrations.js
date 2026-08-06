// bootstrap/migrations.js
// Phase 4B.1: extracted verbatim from server.js. Every function here was
// individually verified to depend only on `pool` (and, for
// ensureVotingPeriodsTable, the already-stable transitionPeriod/
// broadcastVoteUpdate references) plus process.env — no other
// module-level state from server.js. ensurePhase2Migrations() is NOT here:
// it mutates NGOLIBA_WARD_ID, a mutable module-level variable that
// server.js's auth middleware and several route handlers still read
// directly, so it stays in server.js — see the Phase 4B.1 report for why.

const { pool } = require('./database');
const { transitionPeriod } = require('../lib/period-engine');
const votingRouterModule = require('../routes/voting');
const broadcastVoteUpdate = votingRouterModule.broadcastVoteUpdate || function () {};

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
    
    // Stage 3B.1: seed notices are Ngoliba-specific content. They are only
    // seeded when (a) the notices table is empty AND (b) this is the Ngoliba
    // founding deployment, identified by FOUNDING_WARD_NAME env var.
    // A new deployment for a different ward starts with an empty noticeboard
    // rather than receiving Ngoliba's sample content.
    console.log('📋 Checking notices seed...');
    const noticeCount = await pool.query('SELECT COUNT(*) FROM notices');
    const foundingWardName = process.env.FOUNDING_WARD_NAME || 'Ngoliba';
    if (parseInt(noticeCount.rows[0].count) === 0 && foundingWardName === 'Ngoliba') {
      // Resolve the founding ward_id for the seed rows — notices now carry
      // ward_id, so orphaned (null ward) seed rows must be avoided.
      const seedWardRes = await pool.query(`
        SELECT w.id FROM wards w
        JOIN constituencies con ON con.id = w.constituency_id
        JOIN counties cty ON cty.id = con.county_id
        WHERE cty.name = $1 AND con.name = $2 AND w.name = $3 LIMIT 1
      `, [
        process.env.FOUNDING_COUNTY_NAME       || 'Kiambu',
        process.env.FOUNDING_CONSTITUENCY_NAME || 'Thika Town',
        foundingWardName
      ]);
      const seedWardId = seedWardRes.rows[0]?.id || null;
      await pool.query(`
        INSERT INTO notices (title, content, category, priority, expires_at, created_by, ward_id) VALUES
        (
          'Ngoliba Farmers Market - Every Saturday',
          'Fresh produce, dairy, and crafts from local farmers. Open 7AM-1PM at the Ngoliba Market grounds. Bulk orders welcome. Contact: 0712 111 222',
          'business', 'normal', NOW() + INTERVAL '90 days', 'system', $1
        ),
        (
          'Water Rationing Notice - Kilimambogo',
          'Kenya Water Authority advises that Kilimambogo sublocation will experience reduced water supply Mon-Wed for 30 days due to pipeline maintenance. Residents should store water accordingly. Helpline: 0800 723 232',
          'public', 'high', NOW() + INTERVAL '30 days', 'system', $1
        ),
        (
          'Boda Boda Riders Wanted - Ngoliba Express',
          'Ngoliba Express Logistics is recruiting 10 boda boda riders for parcel delivery. Must have valid licence. Earn KES 800-1,500 daily. Apply in person at Ngoliba Town Centre. Contact: 0798 456 789',
          'jobs', 'normal', NOW() + INTERVAL '60 days', 'system', $1
        ),
        (
          'Community Health Camp - Mwea Ward',
          'Free health screening and vaccination services. Dates: First Saturday of every month. Location: Mwea Ward Market. Services: Blood pressure check, BMI assessment, Immunizations. Bring ID. Contact: 0789 654 321',
          'health', 'normal', NOW() + INTERVAL '120 days', 'system', $1
        ),
        (
          'Road Maintenance - Ngoliba-Ruiru Highway',
          'Notice: The Ngoliba-Ruiru main highway will be under maintenance from June 15-22, 2024. Expect delays. Alternative routes recommended. Updates: www.krb.go.ke',
          'public', 'high', NOW() + INTERVAL '45 days', 'system', $1
        )
      `, [seedWardId]);
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

    // Stage 3B.1: same founding-ward guard as the notices seed in initDB().
    // Only seeds Ngoliba-specific content when this is the founding deployment.
    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM notices');
    const _foundingWard = process.env.FOUNDING_WARD_NAME || 'Ngoliba';
    if (parseInt(rows[0].count) === 0 && _foundingWard === 'Ngoliba') {
      const _seedWardRes = await pool.query(`
        SELECT w.id FROM wards w
        JOIN constituencies con ON con.id = w.constituency_id
        JOIN counties cty ON cty.id = con.county_id
        WHERE cty.name = $1 AND con.name = $2 AND w.name = $3 LIMIT 1
      `, [
        process.env.FOUNDING_COUNTY_NAME       || 'Kiambu',
        process.env.FOUNDING_CONSTITUENCY_NAME || 'Thika Town',
        _foundingWard
      ]);
      const _seedWardId = _seedWardRes.rows[0]?.id || null;
      await pool.query(`
        INSERT INTO notices (title, content, category, priority, expires_at, created_by, ward_id) VALUES
        ('Ngoliba Farmers Market - Every Saturday',
         'Fresh produce, dairy, and crafts from local farmers. Open 7AM-1PM at the Ngoliba Market grounds.',
         'business', 'normal', NOW() + INTERVAL '90 days', 'system', $1),
        ('Water Rationing Notice - Kilimambogo',
         'Kenya Water Authority advises reduced supply Mon-Wed for 30 days due to pipeline maintenance. Store water accordingly. Helpline: 0800 723 232',
         'public', 'high', NOW() + INTERVAL '30 days', 'system', $1),
        ('Boda Boda Riders Wanted - Ngoliba Express',
         'Ngoliba Express Logistics recruiting 10 boda boda riders for parcel delivery. Must have valid licence. Earn KES 800-1,500 daily. Apply: Ngoliba Town Centre.',
         'jobs', 'normal', NOW() + INTERVAL '60 days', 'system', $1),
        ('Community Health Camp - Mwea Ward',
         'Free health screening and vaccination. First Saturday of every month, Mwea Ward Market. Bring ID.',
         'health', 'normal', NOW() + INTERVAL '120 days', 'system', $1),
        ('Road Maintenance - Ngoliba-Ruiru Highway',
         'The Ngoliba-Ruiru highway will be under maintenance June 15-22. Expect delays. Use alternative routes.',
         'public', 'high', NOW() + INTERVAL '45 days', 'system', $1)
      `, [_seedWardId]);
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
      const boot = await transitionPeriod(pool, broadcastVoteUpdate, { triggerSource: 'startup', mode: 'bootstrap' });
      if (boot.transitioned) {
        console.log(`\u2705 Active voting period created (id=${boot.newPeriod}, ends ${new Date(boot.endsAt).toISOString()})`);
      } else {
        // 'already-active' — a concurrent process won the bootstrap race; nothing to do.
        console.log(`\u2139\ufe0f  Bootstrap skipped (${boot.reason}) — an active period already exists`);
      }
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
        // force:true here because period age was determined by wall-clock
        // comparison above (isExpired/isTooLong), not by re-checking inside
        // the transaction — transitionPeriod still re-validates the row
        // under its own lock before doing anything.
        const startupRoll = await transitionPeriod(pool, broadcastVoteUpdate, { triggerSource: 'startup', mode: 'force', force: true });
        if (startupRoll.transitioned) {
          console.log(`✅ Fresh voting period created (id=${startupRoll.newPeriod}, archived stale period ${startupRoll.completedPeriod} as archive ${startupRoll.archiveId})`);
        } else {
          console.log(`\u2139\ufe0f  Startup rollover skipped (${startupRoll.reason})`);
        }
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

async function ensureActivePeriod() {
  const existing = await pool.query(
    'SELECT id FROM voting_periods WHERE is_active = true LIMIT 1'
  );

  if (existing.rows.length === 0) {
    // create period
  }
}

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

    // ── Seed: Founding geographic hierarchy ──────────────────────────────
    // Stage 3B.1: was hardcoded to 'Kiambu → Thika Town → Ngoliba'. Now
    // read from environment variables with those values as defaults, so
    // existing deployments continue working with zero configuration change,
    // while a new deployment for a different ward supplies its own values.
    // ON CONFLICT ensures running startup multiple times never creates duplicates.
    const FOUNDING_COUNTY       = process.env.FOUNDING_COUNTY_NAME       || 'Kiambu';
    const FOUNDING_CONSTITUENCY = process.env.FOUNDING_CONSTITUENCY_NAME || 'Thika Town';
    const FOUNDING_WARD         = process.env.FOUNDING_WARD_NAME         || 'Ngoliba';

    await pool.query(`
      INSERT INTO counties (name)
      VALUES ($1)
      ON CONFLICT ON CONSTRAINT counties_name_unique DO NOTHING
    `, [FOUNDING_COUNTY]);

    await pool.query(`
      INSERT INTO constituencies (county_id, name)
      SELECT id, $1
        FROM counties
       WHERE name = $2
      ON CONFLICT ON CONSTRAINT constituencies_county_name DO NOTHING
    `, [FOUNDING_CONSTITUENCY, FOUNDING_COUNTY]);

    await pool.query(`
      INSERT INTO wards (constituency_id, name)
      SELECT con.id, $1
        FROM constituencies con
        JOIN counties       cty ON cty.id = con.county_id
       WHERE cty.name = $2
         AND con.name = $3
      ON CONFLICT ON CONSTRAINT wards_constituency_name DO NOTHING
    `, [FOUNDING_WARD, FOUNDING_COUNTY, FOUNDING_CONSTITUENCY]);

    console.log(`✅ geography tables ready — founding hierarchy: ${FOUNDING_COUNTY} → ${FOUNDING_CONSTITUENCY} → ${FOUNDING_WARD}`);
  } catch (e) {
    console.error('❌ ensureGeographyTables error:', e.message);
    // Non-fatal: geography tables are Phase 1 foundation only.
    // Existing functionality is unaffected if this fails.
  }
}

async function seedKiambuHierarchy() {
  try {
    console.log('🗺️  Seeding Kiambu County administrative hierarchy...');

    // ── 1. Ensure Kiambu County exists ──────────────────────────────────
    await pool.query(`
      INSERT INTO counties (name)
      VALUES ('Kiambu')
      ON CONFLICT ON CONSTRAINT counties_name_unique DO NOTHING
    `);

    const countyRes = await pool.query(
      `SELECT id FROM counties WHERE name = 'Kiambu' LIMIT 1`
    );
    if (!countyRes.rows.length) {
      console.warn('⚠️  seedKiambuHierarchy: Kiambu county row not found after insert — skipping.');
      return;
    }
    const countyId = countyRes.rows[0].id;

    // ── 2. Constituency + ward data (official IEBC mapping) ─────────────
    // Format: [ constituencyName, [ ward, ward, … ] ]
    const KIAMBU_HIERARCHY = [
      ['Gatundu South', [
        'Kiganjo', 'Mutarakwa', 'Kinoo', 'Gituamba', 'Githobokoni'
      ]],
      ['Gatundu North', [
        'Githiga', 'Kiamwangi', 'Kigoro', 'Gatuanyaga', 'Chania'
      ]],
      ['Juja', [
        'Theta', 'Juja Farm', 'Witeithie', 'Kalimoni', 'Murera'
      ]],
      ['Thika Town', [
        'Township', 'Kamenu', 'Hospital', 'Gatuanyaga', 'Ngoliba'
      ]],
      ['Ruiru', [
        'Gitothua', 'Biashara', 'Gatongora', 'Kahawa Sukari',
        'Kahawa Wendani', 'Mwiki', 'Mwihoko'
      ]],
      ['Githunguri', [
        'Githunguri', 'Githiga', 'Ikinu', 'Ngewa', 'Komothai'
      ]],
      ['Kiambu', [
        'Kiambu', "Ting'ang'a", 'Ndenderu', 'Kinoo', 'Kabete'
      ]],
      ['Kiambaa', [
        'Cianda', 'Karuri', 'Ndumberi', 'Tinganga', 'Kihara'
      ]],
      ['Kabete', [
        'Gitaru', 'Muguga', 'Nyadhuna', 'Kabete', 'Uthiru/Ruthimitu'
      ]],
      ['Kikuyu', [
        'Karai', 'Nachu', 'Sigona', 'Kikuyu', 'Kinoo'
      ]],
      ['Limuru', [
        'Ndeiya', 'Limuru Central', 'Ngecha/Tigoni', 'Kamirithu', 'Kinale'
      ]],
      ['Lari', [
        'Kijabe', 'Nyanduma', 'Kirenga', "Lari/Kirenga", 'Kinale'
      ]]
    ];

    // ── 3. Insert each constituency then its wards ───────────────────────
    let consInserted = 0, wardInserted = 0;
    for (const [consName, wards] of KIAMBU_HIERARCHY) {
      // Insert constituency if missing
      const consInsert = await pool.query(`
        INSERT INTO constituencies (county_id, name)
        VALUES ($1, $2)
        ON CONFLICT ON CONSTRAINT constituencies_county_name DO NOTHING
        RETURNING id
      `, [countyId, consName]);
      if (consInsert.rows.length > 0) consInserted++;

      // Always resolve the constituency id (whether just inserted or pre-existing)
      const consRes = await pool.query(
        `SELECT id FROM constituencies WHERE county_id = $1 AND name = $2 LIMIT 1`,
        [countyId, consName]
      );
      if (!consRes.rows.length) {
        console.warn(`⚠️  seedKiambuHierarchy: constituency '${consName}' not found after insert — skipping its wards.`);
        continue;
      }
      const consId = consRes.rows[0].id;

      // Insert each ward if missing
      for (const wardName of wards) {
        const wardInsert = await pool.query(`
          INSERT INTO wards (constituency_id, name)
          VALUES ($1, $2)
          ON CONFLICT ON CONSTRAINT wards_constituency_name DO NOTHING
          RETURNING id
        `, [consId, wardName]);
        if (wardInsert.rows.length > 0) wardInserted++;
      }
    }

    console.log(`✅ Kiambu hierarchy seeded — ${consInserted} new constituency(ies), ${wardInserted} new ward(s) added.`);
  } catch (err) {
    // Non-fatal: log and continue startup. Existing data is unaffected.
    console.error('❌ seedKiambuHierarchy error (non-fatal):', err.message);
  }
}

async function ensureRBACFoundation() {
  try {
    // ── Step 1: role column, defaulted to VOTER ──
    // DEFAULT 'VOTER' backfills existing rows automatically when the
    // column is added, and makes every future INSERT INTO users (which
    // doesn't list `role`) get VOTER with zero changes to the
    // registration code path.
    await pool.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(30) DEFAULT 'VOTER'`
    );
    // Defensive backfill in case the column already existed without a
    // default from some earlier partial run — idempotent, no-op once done.
    await pool.query(`UPDATE users SET role = 'VOTER' WHERE role IS NULL`);

    // Constrain to the known role set (idempotent — duplicate_object is
    // swallowed the same way the ward_id FK constraints do it above).
    await pool.query(`
      DO $$
      BEGIN
        ALTER TABLE users
          ADD CONSTRAINT users_role_check
          CHECK (role IN ('SUPER_ADMIN','COUNTY_ADMIN','CONSTITUENCY_ADMIN','WARD_ADMIN','MODERATOR','VOTER'));
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END $$
    `);

    // ── Step 2: geographic admin-scope columns ──
    // Only populated for COUNTY_ADMIN / CONSTITUENCY_ADMIN / WARD_ADMIN
    // respectively; NULL for SUPER_ADMIN, MODERATOR, and VOTER.
    const SCOPE_COLUMNS = [
      { column: 'admin_county_id',       table: 'counties',       fkName: 'users_admin_county_id_fk'       },
      { column: 'admin_constituency_id', table: 'constituencies', fkName: 'users_admin_constituency_id_fk' },
      { column: 'admin_ward_id',         table: 'wards',          fkName: 'users_admin_ward_id_fk'         },
    ];

    for (const { column, table, fkName } of SCOPE_COLUMNS) {
      await pool.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS ${column} INT`
      );
      await pool.query(`
        DO $$
        BEGIN
          ALTER TABLE users
            ADD CONSTRAINT ${fkName} FOREIGN KEY (${column}) REFERENCES ${table}(id);
        EXCEPTION WHEN duplicate_object THEN
          NULL;
        END $$
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_users_${column} ON users(${column})`
      );
    }

    console.log('✅ RBAC foundation ready (role + admin-scope columns on users, default VOTER)');
  } catch (e) {
    console.error('❌ ensureRBACFoundation error:', e.message);
    console.error(e.stack);
    // Non-fatal: role defaults to VOTER at the DB level regardless of
    // whether this migration fully completes, so existing flows continue
    // unchanged either way.
  }
}

async function ensureSuperAdminBootstrap() {
  const phone = process.env.SUPER_ADMIN_PHONE;
  if (!phone) return; // not configured — do nothing, as specified

  try {
    const result = await pool.query(
      `UPDATE users SET role = 'SUPER_ADMIN' WHERE phone = $1 AND role = 'VOTER' RETURNING id`,
      [phone]
    );
    if (result.rowCount > 0) {
      console.log(`✅ SUPER_ADMIN bootstrap: promoted user id=${result.rows[0].id} (phone ${phone}) from VOTER to SUPER_ADMIN`);
      return;
    }
    // No row updated — either the phone doesn't exist, or it exists but
    // isn't VOTER anymore (already promoted in an earlier run, or manually
    // reassigned to a different role since). Informational logging only,
    // per spec — never treated as an error.
    const existing = await pool.query(`SELECT id, role FROM users WHERE phone = $1`, [phone]);
    if (existing.rows.length === 0) {
      console.log(`ℹ️  SUPER_ADMIN bootstrap: no registered user found with phone ${phone} — nothing to do.`);
    } else if (existing.rows[0].role !== 'SUPER_ADMIN') {
      console.log(`ℹ️  SUPER_ADMIN bootstrap: user id=${existing.rows[0].id} (phone ${phone}) already has role '${existing.rows[0].role}', not VOTER — leaving unchanged.`);
    }
    // else: already SUPER_ADMIN from an earlier run — silently idempotent, nothing to log.
  } catch (e) {
    console.error('❌ ensureSuperAdminBootstrap error:', e.message);
    // Non-fatal — startup continues regardless.
  }
}


module.exports = {
  initDB,
  ensureNoticesTable,
  ensureVotingPeriodsTable,
  ensureActivePeriod,
  ensureCandidatesTable,
  ensureGeographyTables,
  seedKiambuHierarchy,
  ensureRBACFoundation,
  ensureSuperAdminBootstrap,
};
