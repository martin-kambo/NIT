// server.js — Ngoliba InfoTrack
// PostgreSQL version (no Netlify dependency)
// Production-ready for Render
require('dotenv').config();
const analyticsRouter = require('./routes/analytics');
const candidatesRouter = require('./routes/candidates'); // Phase 4B.2B
const noticesRouter = require('./routes/notices'); // Phase 4B.2C
const forumRouter = require('./routes/forum'); // Phase 4B.2D
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
// forumReplyLimiter moved to routes/forum.js (Phase 4B.2D) — its only
// consumer, POST /api/forum/replies, moved there too.
const cors = require('cors');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');
const axios = require('axios');
// notices routes are defined inline — no separate router file needed

// ── PHASE 2: Voting Router ──
const votingRouterModule = require('./routes/voting');
const { getAllCandidates, getCandidatesByCategory, FALLBACK_CANDIDATES, getCandidateWard, createCandidate, updateCandidate, deleteCandidate } = require('./lib/candidates');
const { createNoticeWithDays, createNoticeWithExpiresAt, getNoticeWard, updateNotice, deleteNotice } = require('./lib/notices');
const { getAdminForumPosts, createForumPost, toggleLikePost, listForumPosts } = require('./lib/forum');
const { transitionPeriod } = require('./lib/period-engine');
const RBAC = require('./lib/rbac'); // Phase 4A.1: role model + unattached authorization helpers
const votingRouter          = votingRouterModule.router || votingRouterModule;
const broadcastVoteUpdate   = votingRouterModule.broadcastVoteUpdate || function(){};

const app = express();
const PORT = process.env.PORT || 10000;

// ── PostgreSQL Connection Pool ──
// Increased timeout for Render's free tier (which hibernates)
const { pool, testDBConnection } = require('./bootstrap/database'); // Phase 4B.1: extracted verbatim
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
// initDB() moved to bootstrap/migrations.js (Phase 4B.1)
// ── Ensure notices table exists (runs every startup, independent of initDB early-exit) ──
// ensureNoticesTable() moved to bootstrap/migrations.js (Phase 4B.1)
// Test database connection
// testDBConnection() moved to bootstrap/database.js (Phase 4B.1)
// ─────────────────────────────────────────────────────────────────────────
// Pre-Phase 3B Task 3: in-memory cache for rarely-changing reference data.
// Used ONLY for: counties, constituencies, wards, candidate lists. NOT
// used for votes, leaderboards, analytics, forum, notices, or anything
// per-user — those remain fully live, unchanged by this task.
//
// A plain Map is sufficient and intentional here, not a placeholder for
// something more sophisticated: this is a single Node.js process (no
// clustering, confirmed elsewhere in this codebase), and Node is
// single-threaded for JS execution, so there is no concurrent-write race
// risk on this Map the way there would be with shared state across
// multiple processes — that's also exactly why this does NOT reach for
// Redis, which is explicitly out of scope for this phase.
//
// The TTL below is a safety net only, not the correctness mechanism — the
// real guarantee against stale data is invalidateStaticCache(), called
// synchronously right after each successful admin write (counties,
// constituencies, wards, candidates create/update/delete), before that
// write's response is sent. The TTL exists purely to bound staleness in
// the hypothetical case an invalidation call is ever missed in a future
// edit; it is not relied upon as the primary guarantee.
const staticDataCache = new Map();
const STATIC_CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute safety net

function getCached(key) {
  const entry = staticDataCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.time > STATIC_CACHE_TTL_MS) {
    staticDataCache.delete(key);
    return undefined;
  }
  return entry.value;
}
function setCached(key, value) {
  staticDataCache.set(key, { value, time: Date.now() });
}
// Clears every cached entry whose key starts with any of the given
// prefixes. Called after a successful admin write so the very next read —
// even one racing in immediately after — sees fresh data. Coarse-grained
// by design (clears the whole dataset's cache rather than computing
// exactly which filtered sub-keys are affected): these admin writes are
// infrequent, so the small extra cost of one cold cache repopulation per
// write is the deliberately conservative, low-risk choice.
function invalidateStaticCache(...prefixes) {
  for (const key of staticDataCache.keys()) {
    if (prefixes.some(p => key.startsWith(p))) staticDataCache.delete(key);
  }
}

app.use(async (req, res, next) => {
  req.pool = pool;

  // Stage 3B.1 — user-derived req.wardId.
  // Previously this always set req.wardId = NGOLIBA_WARD_ID (the global
  // startup-resolved singleton), meaning every read path — leaderboard,
  // candidates, notices, forum — returned only the founding ward's data
  // regardless of which user was asking. For multi-ward correctness,
  // req.wardId must reflect the *requesting user's* own ward.
  //
  // Trust chain (matches the forum-post and vote-INSERT patterns):
  //   session cookie (HMAC-verified, cannot be spoofed)
  //   → session.userId
  //   → server-side DB lookup on users.id (PK, indexed, sub-millisecond)
  //   → user.ward_id written to req.wardId
  //
  // For unauthenticated requests (no valid session cookie), falls back to
  // NGOLIBA_WARD_ID so public routes that don't require login continue
  // working exactly as before. This backward-compat path will become
  // less relevant as multi-ward onboarding progresses (a user from Ward B
  // visiting the site will always have a session cookie once logged in).
  const session = verifySession(req.headers.cookie);
  if (session?.userId) {
    try {
      // Phase 4A.1: same query now also selects role + admin-scope columns
      // so req.user is available for future phases (see lib/rbac.js) —
      // req.wardId's own logic below is unchanged.
      const result = await pool.query(
        'SELECT ward_id, role, admin_county_id, admin_constituency_id, admin_ward_id FROM users WHERE id = $1',
        [session.userId]
      );
      const row = result.rows[0];
      const userWardId = row?.ward_id;
      req.wardId = userWardId || NGOLIBA_WARD_ID;

      // Phase 4A.1 (refined) — RBAC foundation, consolidated into a single
      // req.user object (id, role, adminCountyId, adminConstituencyId,
      // adminWardId) rather than separate req.userId/req.userRole/
      // req.adminScope fields. The scope fields are prefixed admin* —
      // deliberately NOT req.user.wardId — because req.wardId above is a
      // different, already-everywhere-used concept (the ward this user
      // votes in), and an admin's administered ward is not guaranteed to
      // be the same ward. Reusing the bare name wardId here would invite
      // exactly the kind of mix-up two similarly-named-but-different
      // fields tend to cause. Not read or enforced anywhere yet.
      req.user = {
        id: session.userId,
        role: row?.role || null,
        adminCountyId: row?.admin_county_id ?? null,
        adminConstituencyId: row?.admin_constituency_id ?? null,
        adminWardId: row?.admin_ward_id ?? null,
      };
    } catch (_) {
      // DB error during ward resolution — fall back to the founding ward
      // rather than failing the whole request. Logged for observability.
      console.error('[middleware] ward_id lookup failed, using NGOLIBA_WARD_ID fallback:', _.message);
      req.wardId = NGOLIBA_WARD_ID;
      req.user = null;
    }
  } else {
    req.wardId = NGOLIBA_WARD_ID;
    req.user = null;
  }

  next();
});

// transitionPeriod() now lives in ./lib/period-engine.js — see require at top of file.


// Initialize on startup — server only starts listening AFTER all migrations complete
// Startup orchestration moved to bootstrap/startup.js (Phase 4B.1).
// ensurePhase2Migrations stays here (see the Phase 4B.1 report for why) and
// is passed in explicitly, alongside the app/pool/PORT this file already
// owns and the migration functions that did move — this avoids
// bootstrap/startup.js ever needing to require server.js itself, so there
// is no circular dependency. The sequence, every log line, the 30s
// interval, and the SIGTERM handler are all unchanged from the original
// inline IIFE — see bootstrap/startup.js.
const migrations = require('./bootstrap/migrations');
const { startServer } = require('./bootstrap/startup');
startServer({
  app,
  PORT,
  pool,
  testDBConnection,
  transitionPeriod,
  broadcastVoteUpdate,
  ...migrations,
  ensurePhase2Migrations,
});

// ── Ensure voting_periods table exists with correct schema ──
// ensureVotingPeriodsTable() moved to bootstrap/migrations.js (Phase 4B.1)
// ── Ensure Active Voting Period (legacy alias) ──
// Superseded by ensureVotingPeriodsTable() — kept so the startup call still works.
// ensureActivePeriod() moved to bootstrap/migrations.js (Phase 4B.1)
// ══════════════════════════════════════════════════════════════════
// CANDIDATES TABLE — multi-category support
// Preserves all existing MCA candidate IDs (0-6) for vote backward-compat
// ══════════════════════════════════════════════════════════════════
// CANDIDATE_CATEGORIES moved to lib/candidates.js (Phase 4B.2B), imported above

// ensureCandidatesTable() moved to bootstrap/migrations.js (Phase 4B.1)
// ══════════════════════════════════════════════════════════════════
// PHASE 1: GEOGRAPHIC FOUNDATION — County / Constituency / Ward
// Additive only. No existing tables, columns, or routes are modified.
// Future phases will wire ward_id into users/votes — not this phase.
// ══════════════════════════════════════════════════════════════════
// ensureGeographyTables() moved to bootstrap/migrations.js (Phase 4B.1)
// ══════════════════════════════════════════════════════════════════
// PHASE 3B — KIAMBU COUNTY COMPLETE REFERENCE DATA SEED
// Idempotent: ON CONFLICT DO NOTHING on every insert.
// Safe to run on every server startup — creates only what is missing.
// Does NOT delete, truncate, or renumber any existing rows.
// Does NOT touch users, votes, candidates, forum_posts, or notices.
// Source: official IEBC administrative hierarchy for Kiambu County.
// ══════════════════════════════════════════════════════════════════
// seedKiambuHierarchy() moved to bootstrap/migrations.js (Phase 4B.1)
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

    // ── Step 2: Resolve the founding ward_id ──────────────────────────────
    // Stage 3B.1: was hardcoded to 'Kiambu → Thika Town → Ngoliba'. Now
    // reads the same env vars used by the seed above, so both sides of
    // startup always resolve the same founding ward regardless of environment.
    const FOUNDING_COUNTY       = process.env.FOUNDING_COUNTY_NAME       || 'Kiambu';
    const FOUNDING_CONSTITUENCY = process.env.FOUNDING_CONSTITUENCY_NAME || 'Thika Town';
    const FOUNDING_WARD         = process.env.FOUNDING_WARD_NAME         || 'Ngoliba';

    const wardRes = await pool.query(`
      SELECT w.id
        FROM wards        w
        JOIN constituencies con ON con.id = w.constituency_id
        JOIN counties       cty ON cty.id = con.county_id
       WHERE cty.name = $1
         AND con.name = $2
         AND w.name   = $3
       LIMIT 1
    `, [FOUNDING_COUNTY, FOUNDING_CONSTITUENCY, FOUNDING_WARD]);

    if (!wardRes.rows.length) {
      console.warn(`⚠️  [Phase 2] Founding ward '${FOUNDING_WARD}' not found — backfill skipped. Ensure ensureGeographyTables() ran successfully first.`);
      return;
    }

    const wardId = wardRes.rows[0].id;
    NGOLIBA_WARD_ID = wardId; // module-level cache — resolved from config, not hardcoded to Ngoliba

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

    console.log(`✅ Phase 2 complete — founding ward '${FOUNDING_WARD}' resolved (id=${wardId})`);
  } catch (e) {
    console.error('❌ ensurePhase2Migrations error:', e.message);
    console.error(e.stack);
    // Non-fatal: ward_id is nullable — all existing flows continue unchanged.
  }
}

// ── Phase 4A.1: RBAC Foundation ──
// Adds role + admin-scope columns to users. Foundation only — see
// lib/rbac.js. Nothing in this function changes any existing behavior:
// role defaults to VOTER for every row (new and existing), nothing reads
// or enforces it yet, and no other table is touched. Fully idempotent —
// safe to run on every startup. Runs after ensurePhase2Migrations() so
// the counties/constituencies/wards tables it references already exist.
//
// Design note (role + 3 columns, no new table): a user holds exactly one
// role at a time, so a single VARCHAR column is enough for the role
// itself — a separate roles table would be unnecessary. COUNTY_ADMIN /
// CONSTITUENCY_ADMIN / WARD_ADMIN are each scoped to exactly one
// specific county / constituency / ward, so each gets its own nullable,
// FK-constrained column — mirroring the named-FK style already used for
// ward_id elsewhere in this file — rather than one polymorphic
// "scope_id" column, which would lose referential integrity (a single
// column can't have a real FK pointing at three different tables
// depending on role). SUPER_ADMIN, MODERATOR, and VOTER leave all three
// scope columns NULL.
// ensureRBACFoundation() moved to bootstrap/migrations.js (Phase 4B.1)
// ── Middleware ──

// ── Phase 4A.2: SUPER_ADMIN bootstrap ──
// Bridges the legacy shared-secret admin system and the new per-user role
// model: if SUPER_ADMIN_PHONE is set, promote that registered user from
// VOTER to SUPER_ADMIN exactly once. Idempotent by construction — the
// WHERE role='VOTER' clause means re-running this after the first
// successful promotion matches zero rows and changes nothing, and it
// never touches a user whose role isn't (or is no longer) VOTER, so a
// manually-assigned or already-promoted role is never overwritten or
// downgraded.
// ensureSuperAdminBootstrap() moved to bootstrap/migrations.js (Phase 4B.1)
// ALLOWED_ORIGINS + compression/cors/json/static registration moved to
// config/middleware.js (Phase 4B.1) — called here, in the exact same
// position, right after the custom auth middleware above and before any
// route registration below.
const { applyCoreMiddleware } = require('./config/middleware');
applyCoreMiddleware(app);

// POST /api/admin/candidates/upload-photo moved to routes/candidates.js
// (Phase 4B.2B) — cache-independent, fully self-contained (multer config
// included), safe to move as a complete route.

// ── Shared Utilities ──
// hashPassword() moved to lib/auth/password.js (Phase 4B.2A)
// createSession()/verifySession() moved to lib/auth/session.js (Phase 4B.2A)
// sanitizeUser() stays here: it's used by /api/me and /api/profile too (not
// auth-exclusive), so per this phase's Stop Condition 5 it is reported, not
// moved or duplicated — see the Phase 4B.2A report.
const { hashPassword, generateSalt } = require('./lib/auth/password');
const { createSession, verifySession } = require('./lib/auth/session');



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

// Phase 4A.3C: createAdminToken() removed — provably dead code (confirmed
// zero callers anywhere in the project; it was defined but never invoked,
// even before this phase's migration work).
// Phase 4A.3D: verifyAdminToken() also removed — its one remaining caller,
// POST /api/admin/notices/verify, was just removed too (admin-notices.html
// now logs in via /api/auth like every other page). Re-confirmed zero
// callers project-wide before deleting.

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
// ROUTE: /api/candidates (PUBLIC - NO AUTH REQUIRED)
// Supports ?category=MCA|MP|Governor|WomenRep
// Defaults to all candidates when no category specified (backward compat)
// Candidate data now comes exclusively from lib/candidates.js, which reads
// the `candidates` table — no in-memory candidate list lives in this file
// anymore (Phase 2.6C candidate fragmentation fix).
// ════════════════════════════════════════════════
app.get('/api/candidates', async (req, res) => {
  try {
    const { category } = req.query;
    const cacheKey = category
      ? `candidates:cat:${category}:ward:${req.wardId}`
      : `candidates:all:ward:${req.wardId}`;
    let candidates = getCached(cacheKey);
    if (candidates === undefined) {
      candidates = category
        ? await getCandidatesByCategory(pool, category, req.wardId)
        : await getAllCandidates(pool, req.wardId);
      setCached(cacheKey, candidates);
    }

    return res.json({ success: true, candidates });
  } catch (e) {
    console.error('/api/candidates error:', e);
    return res.json({ success: true, candidates: FALLBACK_CANDIDATES.map(c => ({ ...c, category: 'MCA' })) });
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

      // Phase 3A Task 4: was hardcoded NGOLIBA_WARD_ID. wardId is now read
      // from the request body (sent by index.html's new County→Constituency→
      // Ward selector), falling back to NGOLIBA_WARD_ID so old clients that
      // don't send it yet keep registering exactly as before.
      const resolvedWardId = parseInt(wardId, 10) || NGOLIBA_WARD_ID;

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
    //
    // Stage 3B.1 — ward_id data-integrity correction:
    // Extending the existing user lookup (which was already SELECT sublocation)
    // to also fetch ward_id. The trust chain is:
    //   session.userId (HMAC-verified, cannot be spoofed by client)
    //   → server-side DB lookup using only that verified userId
    //   → user.ward_id used in INSERT
    // No client request parameter is accepted for ward — identical pattern
    // to forum posts (Phase 3A: authorWardId = u.ward_id || NGOLIBA_WARD_ID).
    const userResult = await pool.query(
      'SELECT sublocation, ward_id FROM users WHERE id = $1',
      [session.userId]
    );
    const user = userResult.rows[0];
    // Null-safety fallback: only fires for users who pre-date the ward
    // backfill (ward_id IS NULL). For all users created after Phase 2.6,
    // user.ward_id is always set.
    const voteWardId = user?.ward_id || NGOLIBA_WARD_ID;

    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);

    const insertResult = await pool.query(
      // DEPRECATED: sublocation ($5) — kept for backward compat; ward_id ($8) is the authoritative geographic field.
      // Phase 3: remove sublocation from this INSERT and from vote-based analytics queries.
      `INSERT INTO votes (user_id, candidate_id, period_id, category, sublocation, ip_hash, timestamp, ward_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, period_id, category) DO NOTHING
       RETURNING id`,
      [session.userId, candidateId, periodId, voteCategory, user?.sublocation || null, ipHash, Date.now(), voteWardId]
    );

    // If no row was inserted, a concurrent request already recorded a vote (race condition)
    if (insertResult.rowCount === 0) {
      return res.status(409).json({ error: `Already voted for ${voteCategory} this period`, alreadyVoted: true, category: voteCategory });
    }

    // total_votes counter removed — totalVotes is now counted live from the votes table

    // ── Count totals and per-candidate ────────────────────────────────────
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    // Phase 2.6E: the SSE broadcast below is ward-partitioned too — each
    // connected client's wardId is captured at connection time and
    // broadcastVoteUpdate() only delivers to clients whose wardId matches
    // (see routes/voting.js), so this stays correct as more wards are added.
    const totalParams = [periodId];
    let totalWardClause = '';
    if (req.wardId != null) {
      totalParams.push(req.wardId);
      totalWardClause = 'AND ward_id = $2';
    }
    const totalRes = await pool.query(
      `SELECT COUNT(*) as count FROM votes WHERE period_id = $1 ${totalWardClause}`,
      totalParams
    );
    const voterCount = parseInt(totalRes.rows[0].count);

    let badge = null;
    if (voterCount === 1) badge = '1st';
    else if (voterCount === 2) badge = '2nd';
    else if (voterCount === 3) badge = '3rd';

    // Per-candidate counts for faceoff / live display
    const perCandParams = [periodId];
    let perCandWardClause = '';
    if (req.wardId != null) {
      perCandParams.push(req.wardId);
      perCandWardClause = 'AND ward_id = $2';
    }
    const perCandRes = await pool.query(
      `SELECT candidate_id, COUNT(*) as vote_count FROM votes WHERE period_id = $1 ${perCandWardClause} GROUP BY candidate_id`,
      perCandParams
    );
    const votesByCandidate = {};
    perCandRes.rows.forEach(r => {
      votesByCandidate[r.candidate_id] = parseInt(r.vote_count);
    });

    // ── Broadcast to SSE subscribers in THIS ward only (Phase 2.6E) ──────
    // Was a global broadcast to every connected client regardless of ward;
    // now targeted via the third (optional) wardId argument added to
    // broadcastVoteUpdate in routes/voting.js.
    broadcastVoteUpdate('vote-received', {
      candidateId,
      periodId,
      totalVotes: voterCount,
      votes: votesByCandidate[candidateId] || 1,
      votesByCandidate
    }, req.wardId);

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
    // Phase 2.6D Group 3: this is the ward_id join the old comment below
    // said "Phase 3" would add — votes.sublocation stays as a freetext
    // display value, ward_id is now the actual filter.
    const votesParams = [period.id];
    let votesWardClause = '';
    if (req.wardId != null) {
      votesParams.push(req.wardId);
      votesWardClause = 'AND ward_id = $2';
    }
    const votesResult = await pool.query(
      `SELECT candidate_id, sublocation, COUNT(*) as count FROM votes WHERE period_id = $1 ${votesWardClause} GROUP BY candidate_id, sublocation`,
      votesParams
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
    const liveTotalParams = [period.id];
    let liveTotalWardClause = '';
    if (req.wardId != null) {
      liveTotalParams.push(req.wardId);
      liveTotalWardClause = 'AND ward_id = $2';
    }
    const liveTotalRes = await pool.query(
      `SELECT COUNT(*) AS count FROM votes WHERE period_id = $1 ${liveTotalWardClause}`, liveTotalParams
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
      // Phase 2.6D Group 3: ward_id join, same as /api/polling-results above.
      const votesParams = [period.id];
      let votesWardClause = '';
      if (req.wardId != null) {
        votesParams.push(req.wardId);
        votesWardClause = 'AND ward_id = $2';
      }
      const votesResult = await pool.query(
        `SELECT candidate_id, sublocation, COUNT(*) as count FROM votes WHERE period_id = $1 ${votesWardClause} GROUP BY candidate_id, sublocation`,
        votesParams
      );

      const votesByCandidate = {};
      let periodTotalVotes = 0;
      votesResult.rows.forEach(row => {
        if (!votesByCandidate[row.candidate_id]) {
          votesByCandidate[row.candidate_id] = { total: 0, sublocations: {} };
        }
        const count = parseInt(row.count);
        votesByCandidate[row.candidate_id].total += count;
        votesByCandidate[row.candidate_id].sublocations[row.sublocation || 'Unknown'] = count;
        periodTotalVotes += count;
      });

      periods.push({
        periodId: period.id,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        // Phase 2.6D Group 3: was period.total_votes (the global per-period
        // counter incremented by EVERY ward combined — voting_periods has
        // no ward_id column, see lib/period-engine.js). Now the sum of the
        // ward-filtered rows above, so it's actually filterable. Identical
        // number today (one ward); correct once a second ward exists.
        totalVotes: req.wardId != null ? periodTotalVotes : period.total_votes,
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
    const category = req.query.category || 'MCA';

    // 1. Cumulative vote counts across ALL periods (no period filter)
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set —
    // defense-in-depth on top of the candidate-list join below (candidate
    // ids never collide across wards, so the join alone already isolates).
    const voteParams = [];
    let voteWardClause = '';
    if (req.wardId != null) {
      voteParams.push(req.wardId);
      voteWardClause = `WHERE ward_id = $${voteParams.length}`;
    }
    const voteRes = await pool.query(`
      SELECT   candidate_id,
               COUNT(*) AS vote_count
      FROM     votes
      ${voteWardClause}
      GROUP BY candidate_id
    `, voteParams);

    // Build a lookup map: candidate_id (int) → vote_count (int)
    const countMap = {};
    let totalVotes = 0;
    voteRes.rows.forEach(row => {
      const id    = parseInt(row.candidate_id);
      const count = parseInt(row.vote_count);
      countMap[id] = count;
      totalVotes  += count;
    });

    // 2. Fetch candidates for the requested category from the DB (authoritative source)
    // Phase 2.6D: this used to be hardcoded to category = 'MCA' with no
    // parameter at all — ?category= now defaults to MCA so existing
    // callers keep the exact same behavior.
    // Phase 2.6D Group 3: also filtered by ward_id when req.wardId is set.
    const candParams = [category];
    let candWardClause = '';
    if (req.wardId != null) {
      candParams.push(req.wardId);
      candWardClause = 'AND ward_id = $2';
    }
    const candRes = await pool.query(`
      SELECT id, name, party, img
      FROM   candidates
      WHERE  category = $1
      ${candWardClause}
      ORDER BY id
    `, candParams);

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
        category,
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
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    const candParams = [];
    let candWardClause = '';
    if (req.wardId != null) {
      candParams.push(req.wardId);
      candWardClause = 'WHERE ward_id = $1';
    }
    const candResult = await pool.query(
      `SELECT id, name, category FROM candidates ${candWardClause} ORDER BY id`,
      candParams
    );
    const candidateMap = {};
    candResult.rows.forEach(c => { candidateMap[c.id] = c; });

    const periods = [];
    for (const period of periodsResult.rows) {
      // Aggregate votes per candidate for this period
      // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set —
      // defense-in-depth on top of the candidateMap join above.
      const voteParams = [period.id];
      let voteWardClause = '';
      if (req.wardId != null) {
        voteParams.push(req.wardId);
        voteWardClause = 'AND ward_id = $2';
      }
      const votesResult = await pool.query(
        `SELECT candidate_id, COUNT(*) AS vote_count
           FROM votes
          WHERE period_id = $1
          ${voteWardClause}
          GROUP BY candidate_id`,
        voteParams
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
    // In-memory fallback for original MCA candidates — single canonical
    // source (lib/candidates.js). This used to be a fourth local copy with
    // party affiliations that had drifted out of sync with every other
    // candidate list in the codebase (Phase 2.6C finding).
    const candsFallback = FALLBACK_CANDIDATES;

    const votes = result.rows.map(row => {
      const cid = parseInt(row.candidate_id);
      const cand = candMap[cid] || candsFallback.find(c => c.id === cid) || {};
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

// GET /api/admin/candidates moved to routes/candidates.js (Phase 4B.2B)
// — cache-independent (this route never touched getCached/setCached/
// invalidateStaticCache), safe to move as a complete route.

// POST /api/admin/candidates — add a new candidate
// Phase 4A.2: WARD_ADMIN+, scope-checked against the target wardId.
app.post('/api/admin/candidates', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  const { name, party, bio, img, category, incumbent, wardId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'name is required' });
  // Phase 4B.2B: `cat` normalization now happens inside createCandidate()
  // itself (lib/candidates.js) — no longer needed here.
  // Phase 3A Task 6: was hardcoded NGOLIBA_WARD_ID. wardId now read from
  // body (sent by admin.html's new County→Constituency→Ward selector),
  // falling back so existing calls that don't send it keep working.
  const resolvedWardId = parseInt(wardId, 10) || NGOLIBA_WARD_ID;
  // Phase 4A.2: caller must actually administer the ward they're creating
  // this candidate in (SUPER_ADMIN bypasses via hasPermission's own check).
  if (!requirePermission(req, res, { wardId: resolvedWardId })) return;
  try {
    // Phase 4B.2B: SQL moved to lib/candidates.js createCandidate() — same
    // max-display_order-then-INSERT logic, called here instead of inline.
    const candidate = await createCandidate(pool, { name, party, bio, img, category, incumbent, wardId: resolvedWardId });
    // Pre-Phase 3B Task 3: invalidate the candidates cache so the very
    // next read (even one racing in immediately after this response)
    // sees the newly-created candidate, not a stale cached list.
    invalidateStaticCache('candidates');
    res.json({ success: true, candidate });
  } catch (err) {
    console.error('POST /api/admin/candidates error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/candidates/:id — edit an existing candidate
// Phase 4A.2: WARD_ADMIN+, scope-checked against the candidate's current
// ward (so a WARD_ADMIN can't edit a candidate outside their own ward just
// by omitting wardId from the request) and, if the request also reassigns
// the candidate to a different ward, against that target ward too.
app.put('/api/admin/candidates/:id', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  const { name, party, bio, img, category, incumbent, wardId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'name is required' });
  // Phase 4B.2B: `cat` normalization now happens inside updateCandidate()
  // itself (lib/candidates.js) — no longer needed here.
  try {
    // Phase 4B.2B: SQL moved to lib/candidates.js getCandidateWard().
    const currentWard = await getCandidateWard(pool, req.params.id);
    if (currentWard === undefined) return res.status(404).json({ success: false, error: 'Candidate not found' });
    if (!requirePermission(req, res, { wardId: currentWard })) return;

    // Phase 3A Task 7: ward_id is only updated when wardId is supplied in
    // the request — omitting it (as every pre-existing caller does) leaves
    // the candidate's ward exactly as it was, so existing edits keep
    // working unchanged.
    const parsedWardId = parseInt(wardId, 10);
    const hasWardId = !isNaN(parsedWardId);
    if (hasWardId && !requirePermission(req, res, { wardId: parsedWardId })) return;

    // Phase 4B.2B: SQL moved to lib/candidates.js updateCandidate() — same
    // conditional (with/without ward_id) UPDATE, called here instead of inline.
    const candidate = await updateCandidate(pool, req.params.id, { name, party, bio, img, category, incumbent, wardId: parsedWardId, hasWardId });
    if (!candidate) return res.status(404).json({ success: false, error: 'Candidate not found' });
    invalidateStaticCache('candidates');
    res.json({ success: true, candidate });
  } catch (err) {
    console.error('PUT /api/admin/candidates/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/candidates/:id — remove a candidate
// Phase 4A.2: WARD_ADMIN+, scope-checked against the candidate's current ward.
app.delete('/api/admin/candidates/:id', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  try {
    // Phase 4B.2B: SQL moved to lib/candidates.js getCandidateWard()/deleteCandidate().
    const currentWard = await getCandidateWard(pool, req.params.id);
    if (currentWard === undefined) return res.status(404).json({ success: false, error: 'Candidate not found' });
    if (!requirePermission(req, res, { wardId: currentWard })) return;

    const deleted = await deleteCandidate(pool, req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Candidate not found' });
    invalidateStaticCache('candidates');
    res.json({ success: true, deleted });
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
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    const votersParams = [];
    let votersWardClause = '';
    if (req.wardId != null) {
      votersParams.push(req.wardId);
      votersWardClause = 'WHERE ward_id = $1';
    }
    const votersResult = await pool.query(`SELECT COUNT(*) as count FROM users ${votersWardClause}`, votersParams);
    const registeredVoters = parseInt(votersResult.rows[0].count || 0);

    const periodResult = await pool.query(
      'SELECT id, total_votes, period_start, period_end FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );
    const period = periodResult.rows[0] || null;

    const votesByCandidate = {};
    if (period) {
      const votesParams = [period.id];
      let votesWardClause = '';
      if (req.wardId != null) {
        votesParams.push(req.wardId);
        votesWardClause = 'AND ward_id = $2';
      }
      const votesResult = await pool.query(
        `SELECT candidate_id, COUNT(*) as vote_count FROM votes WHERE period_id = $1 ${votesWardClause} GROUP BY candidate_id`,
        votesParams
      );
      votesResult.rows.forEach(row => {
        votesByCandidate[row.candidate_id] = parseInt(row.vote_count);
      });
    }

    // Real sublocation breakdown from users table
    const sublocParams = [];
    let sublocWardClause = '';
    if (req.wardId != null) {
      sublocParams.push(req.wardId);
      sublocWardClause = 'WHERE ward_id = $1';
    }
    const sublocResult = await pool.query(
      `SELECT COALESCE(sublocation, 'Unknown') as sublocation, COUNT(*) as count
       FROM users ${sublocWardClause} GROUP BY sublocation`,
      sublocParams
    );
    const votersBySubLocation = {};
    sublocResult.rows.forEach(r => { votersBySubLocation[r.sublocation] = parseInt(r.count); });

    // Live count for current period
    let statsTotalVotes = 0;
    if (period) {
      const statsTotalParams = [period.id];
      let statsTotalWardClause = '';
      if (req.wardId != null) {
        statsTotalParams.push(req.wardId);
        statsTotalWardClause = 'AND ward_id = $2';
      }
      const statsTotalRes = await pool.query(
        `SELECT COUNT(*) AS count FROM votes WHERE period_id = $1 ${statsTotalWardClause}`, statsTotalParams
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
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    const votersParams = [];
    let votersWardClause = '';
    if (req.wardId != null) {
      votersParams.push(req.wardId);
      votersWardClause = 'WHERE ward_id = $1';
    }
    const votersRes = await pool.query(`SELECT COUNT(*) AS count FROM users ${votersWardClause}`, votersParams);
    const registeredVoters = parseInt(votersRes.rows[0].count || 0);

    // 2. Active period
    const periodRes = await pool.query(
      'SELECT id, period_start, period_end, total_votes FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );
    const period   = periodRes.rows[0] || null;
    const periodId = period ? period.id : null;

    // 3. Votes this cycle — live count from votes table (authoritative)
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    let votesThisCycle = 0;
    if (periodId !== null) {
      const cycleParams = [periodId];
      let cycleWardClause = '';
      if (req.wardId != null) {
        cycleParams.push(req.wardId);
        cycleWardClause = 'AND ward_id = $2';
      }
      const cycleRes = await pool.query(
        `SELECT COUNT(*) AS count FROM votes WHERE period_id = $1 ${cycleWardClause}`, cycleParams
      );
      votesThisCycle = parseInt(cycleRes.rows[0].count || 0);
    }

    // 4. All-time total votes across every period
    // Phase 2.6D Group 3: voting_periods.total_votes is a per-period counter
    // incremented by EVERY ward's votes combined (voting_periods has no
    // ward_id column — periods are global by design, see GEO_TABLES above).
    // That makes it structurally impossible to filter. Reading directly
    // from the votes table instead gives the identical number today (one
    // ward) and becomes correctly filterable once a second ward exists.
    const allTimeParams = [];
    let allTimeWardClause = '';
    if (req.wardId != null) {
      allTimeParams.push(req.wardId);
      allTimeWardClause = 'WHERE ward_id = $1';
    }
    const allTimeRes = await pool.query(
      `SELECT COUNT(*) AS total FROM votes ${allTimeWardClause}`, allTimeParams
    );
    const allTimeVotes = parseInt(allTimeRes.rows[0].total || 0);

    // 5. Turnout rate for this cycle
    const turnoutRate = registeredVoters > 0
      ? parseFloat(((votesThisCycle / registeredVoters) * 100).toFixed(1))
      : 0;

    // 6. Registered voters per sublocation — also used to derive heatmap sublocation list
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    const subVotersParams = [];
    let subVotersWardClause = '';
    if (req.wardId != null) {
      subVotersParams.push(req.wardId);
      subVotersWardClause = 'WHERE ward_id = $1';
    }
    const subVotersRes = await pool.query(
      `SELECT COALESCE(sublocation, 'Unknown') AS sub, COUNT(*) AS cnt FROM users ${subVotersWardClause} GROUP BY sublocation`,
      subVotersParams
    );
    const votersBySubLocation = {};
    subVotersRes.rows.forEach(r => { votersBySubLocation[r.sub] = parseInt(r.cnt); });

    // 7. Votes per sublocation in current period
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    let subVotesRes = { rows: [] };
    if (periodId !== null) {
      const subVotesParams = [periodId];
      let subVotesWardClause = '';
      if (req.wardId != null) {
        subVotesParams.push(req.wardId);
        subVotesWardClause = 'AND ward_id = $2';
      }
      subVotesRes = await pool.query(
        `SELECT COALESCE(sublocation, 'Unknown') AS sub, COUNT(*) AS cnt
         FROM votes WHERE period_id = $1 ${subVotesWardClause} GROUP BY sublocation`,
        subVotesParams
      );
    }
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
      const hourlyParams = [];
      let hourlyWardClause = '';
      if (req.wardId != null) {
        hourlyParams.push(req.wardId);
        hourlyWardClause = `AND ward_id = $${hourlyParams.length}`;
      }
      const hourlyRes = await pool.query(
        `SELECT
           EXTRACT(HOUR FROM (to_timestamp(timestamp::bigint / 1000) + INTERVAL '3 hours')) AS hr,
           COUNT(*) AS cnt
         FROM votes
         WHERE timestamp::bigint >= (EXTRACT(EPOCH FROM (NOW() - INTERVAL '24 hours')) * 1000)
         ${hourlyWardClause}
         GROUP BY hr
         ORDER BY hr`,
        hourlyParams
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
    // Phase 2.6D fix: this query had a `WHERE c.category = 'MCA'` filter
    // that directly contradicted its own comment and every other section
    // of this route (registered voters, votes this cycle, heatmap, hourly
    // votes) — none of which filter by category at all. Removed so the
    // prediction widget is consistent with the rest of the dashboard.
    let prediction = { leader: null, confidence: 50 };
    try {
      const predParams = [];
      let predWardClause = '';
      if (req.wardId != null) {
        predParams.push(req.wardId);
        predWardClause = `WHERE c.ward_id = $${predParams.length}`;
      }
      const allVotesRes = await pool.query(
        `SELECT v.candidate_id, COUNT(*) AS cnt, c.name
         FROM votes v
         JOIN candidates c ON c.id = v.candidate_id
         ${predWardClause}
         GROUP BY v.candidate_id, c.name
         ORDER BY cnt DESC
         LIMIT 2`,
        predParams
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

// FORUM_CATEGORIES, formatPost(), formatReply() moved to lib/forum.js
// (Phase 4B.2D), imported below where the remaining forum routes need them.

// ────────────────────────────────────────────────────────────────
// GET /api/forum  — list posts, optional ?category= filter
// ────────────────────────────────────────────────────────────────
// GET /api/forum moved to routes/forum.js (Phase 4B.2D) — no dependency
// on requirePermission()/NGOLIBA_WARD_ID, safe to move whole.

// GET /api/admin/forum-posts — Phase 3A Task 12. Admin-only, backend
// support only — no corresponding UI is built in this phase, per the
// explicit instruction not to invent new admin pages. A future
// forum-moderation panel would consume this. Mirrors get_users' filter
// priority (wardId > constituencyId > countyId) for consistency.
// Phase 4A.2: MODERATOR+ (forum moderation). Scope-checked against
// whichever geography filter was actually requested.
// Phase 4A.4: no explicit filter -> auto-apply the caller's own scope
// (was: reject with 403 unless SUPER_ADMIN). MODERATOR still sees every
// ward unfiltered (no geographic scope by design, see lib/rbac.js);
// COUNTY_ADMIN/CONSTITUENCY_ADMIN/WARD_ADMIN now default to their own
// scope instead of being rejected outright.
app.get('/api/admin/forum-posts', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  try {
    const { wardId, constituencyId, countyId } = req.query;
    if (wardId != null) {
      if (!requirePermission(req, res, { wardId: parseInt(wardId, 10) })) return;
    } else if (constituencyId != null) {
      if (!requirePermission(req, res, { constituencyId: parseInt(constituencyId, 10) })) return;
    } else if (countyId != null) {
      if (!requirePermission(req, res, { countyId: parseInt(countyId, 10) })) return;
    }

    // Phase 4B.2D: query-building + SQL moved to lib/forum.js getAdminForumPosts().
    const { posts, total } = await getAdminForumPosts(pool, req.user, { wardId, constituencyId, countyId });
    res.json({ success: true, posts, total });
  } catch (error) {
    console.error('GET /api/admin/forum-posts error:', error.message);
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

    // Sanitise: strip raw HTML tags to prevent XSS (stored as plain text, escaped on render)
    const safeText = trimmed.replace(/<[^>]*>/g, '');

    try {
      // Phase 3A Task 10: was hardcoded NGOLIBA_WARD_ID, ignoring the
      // author's own ward entirely. ward_id is NOT accepted from the
      // client (trust boundary) — it's derived from the author's own
      // users row, with NGOLIBA_WARD_ID only as a null-safety fallback
      // (shouldn't occur post-backfill, but never insert a null ward_id).
      const user = await pool.query(
        'SELECT id, first_name, surname, profile_photo, ward_id FROM users WHERE id = $1',
        [session.userId]
      );
      if (!user.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
      const u = user.rows[0];
      const author = `${u.first_name} ${u.surname}`.trim() || 'Anonymous';
      const authorWardId = u.ward_id || NGOLIBA_WARD_ID;

      // Phase 4B.2D: INSERT moved to lib/forum.js createForumPost() — the
      // ward fallback above still happens here since it needs NGOLIBA_WARD_ID.
      const post = await createForumPost(pool, { userId: u.id, authorName: author, phone: session.phone, title, text: safeText, category, wardId: authorWardId });
      res.json({ success: true, post });
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

      // Phase 4B.2D: toggle logic moved to lib/forum.js toggleLikePost().
      const { likes, liked } = await toggleLikePost(pool, postId, userId);
      res.json({ success: true, likes, liked });
    } catch (error) {
      console.error('POST /api/forum like_post error:', error.message);
      res.status(500).json({ success: false, error: 'Failed to like post' });
    }

  // ── list_posts (legacy POST action — keep for backward compat) ──
  } else if (action === 'list_posts') {
    try {
      // Phase 4B.2D: consolidated into the same lib/forum.js
      // listForumPosts() that GET /api/forum (routes/forum.js) now uses —
      // this was already an exact duplicate of that query before this
      // extraction, not a rewrite.
      const posts = await listForumPosts(pool, { category: req.body.category, wardId: req.wardId });
      res.json({ success: true, posts });
    } catch (error) {
      console.error('POST /api/forum list_posts error:', error.message);
      res.status(500).json({ success: false, error: 'Failed to list posts' });
    }

  } else {
    res.status(400).json({ success: false, error: 'Unknown action' });
  }
});

// GET /api/forum/replies/:postId and POST /api/forum/replies moved to
// routes/forum.js (Phase 4B.2D) — neither depends on requirePermission()
// or NGOLIBA_WARD_ID, safe to move whole.

// GET /api/faceoff - Top 2 candidates by CUMULATIVE votes across all cycles
// Supports ?category=MCA|MP|Governor|WomenRep (defaults to MCA for backward compat)
app.get('/api/faceoff', async (req, res) => {
  try {
    const category = req.query.category || 'MCA';

    // Single canonical candidate source (lib/candidates.js) — same helper
    // /api/candidates, routes/voting.js, and routes/analytics.js now use.
    const candidates = await getCandidatesByCategory(pool, category, req.wardId);

    if (candidates.length === 0) {
      return res.json({ success: true, candidates: [], allCandidates: [], periodId: null, totalVotes: 0 });
    }

    // Cumulative vote counts for this category's candidates
    // Phase 2.6D Group 3: ward_id filter added as defense-in-depth on top
    // of the candidate_id = ANY($1) filter, which already disambiguates
    // since candidate ids never collide across wards.
    const candidateIds = candidates.map(c => c.id);
    const voteParams = [candidateIds];
    let voteWardClause = '';
    if (req.wardId != null) {
      voteParams.push(req.wardId);
      voteWardClause = 'AND ward_id = $2';
    }
    const allVotes = await pool.query(
      `SELECT candidate_id, COUNT(*) AS vote_count
         FROM votes
        WHERE candidate_id = ANY($1)
        ${voteWardClause}
        GROUP BY candidate_id`,
      voteParams
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
// GET /api/notices moved to routes/notices.js (Phase 4B.2C) — no
// dependency on requirePermission()/NGOLIBA_WARD_ID, safe to move whole.

// ══════════════════════════════════════════════
// POST /api/notices — admin: add a new notice
// ══════════════════════════════════════════════
// Phase 4A.2: MODERATOR+, scope-checked against the target ward. Replaces
// the legacy body.adminSecret === process.env.ADMIN_SECRET check.
app.post('/api/notices', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  try {
    const { title, content, category, priority, days, wardId } = req.body;
    if (!title || !content) {
      return res.status(400).json({ success: false, error: 'title and content are required' });
    }
    // Phase 3A Task 9: was hardcoded NGOLIBA_WARD_ID. wardId now read from
    // body, falling back so existing callers that don't send it keep working.
    const resolvedWardId = parseInt(wardId, 10) || NGOLIBA_WARD_ID;
    if (!requirePermission(req, res, { wardId: resolvedWardId })) return;
    // Phase 4B.2C: SQL moved to lib/notices.js createNoticeWithDays().
    const notice = await createNoticeWithDays(pool, { title, content, category, priority, days, wardId: resolvedWardId });
    res.json({ success: true, notice });
  } catch (error) {
    console.error('/api/notices POST error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/notices/:id — admin: remove a notice
// Phase 4A.2: MODERATOR+, scope-checked against the notice's current ward
// when it exists. If it doesn't exist, there's nothing to scope-check —
// falls through to the original no-op-delete-then-success behavior so the
// response contract for that case is unchanged from before this phase.
app.delete('/api/notices/:id', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  try {
    // Phase 4B.2C: SQL moved to lib/notices.js getNoticeWard()/deleteNotice().
    const currentWard = await getNoticeWard(pool, req.params.id);
    if (currentWard !== undefined && !requirePermission(req, res, { wardId: currentWard })) return;

    await deleteNotice(pool, req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// ══════════════════════════════════════════════════════
// /api/admin/notices — notice management endpoints
// ══════════════════════════════════════════════════════
// Phase 4A.3C: checkNoticeAdminAuth() removed — provably dead code.
// Confirmed zero callers anywhere in the project: every route that used
// to call it was migrated to RBAC.requireMinRole/requireRole in Phase
// 4A.2 (candidates, notices, forum-posts, ad-requests, period/next,
// geography creation) and this session (routes/voting.js,
// routes/analytics.js). Its ADMIN_SECRET fallback and Bearer-token check
// used the same mechanism POST /api/admin/notices/verify used — that
// route and verifyAdminToken() were both removed in Phase 4A.3D once
// admin-notices.html (the route's last caller) migrated to /api/auth.

// (Historical note, Phase 4A.2: checkNoticeAdminAuth() used to sit here as
// the legacy shared-secret check, superseded by lib/rbac.js for every
// route that called it. It was left defined-but-unused at the time; Phase
// 4A.3C removed it once its zero-callers status was reconfirmed — see the
// comment above this one.)

// Thin wrapper around the centralized RBAC.hasPermission() for route
// handlers that need a scope check on data only available once the
// request body/params/query have been parsed (so it can't be expressed as
// route-level Express middleware the way requireRole/requireAnyRole/
// requireMinRole can). The authorization DECISION still lives entirely in
// RBAC.hasPermission — this only adapts its boolean return into the same
// “check, auto-respond, tell the caller whether to continue” shape every
// route handler below already uses (matches the existing
// checkNoticeAdminAuth(req,res) calling convention it replaces).
function requirePermission(req, res, opts) {
  if (RBAC.hasPermission(req, opts)) return true;
  res.status(403).json({ success: false, error: 'Forbidden' });
  return false;
}

// Phase 4A.3D: POST /api/admin/notices/verify removed. It was
// admin-notices.html's login check — that page now calls POST /api/auth
// like every other page in the app. Confirmed zero remaining callers
// anywhere in the project (server.js, routes/, every mounted router, and
// every .html file) before removing it.

// GET /api/admin/notices moved to routes/notices.js (Phase 4B.2C) — uses
// only pool and the pure, stateless RBAC.resolveReadScope/buildScopeFilter
// helpers, safe to move whole.

// Phase 4A.2: MODERATOR+, scope-checked against the target ward.
app.post('/api/admin/notices', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  const { title, content, category, priority, expiresAt, wardId } = req.body;
  if (!title || !content) return res.status(400).json({ success: false, error: 'title and content are required' });
  // Phase 3A Task 9: was hardcoded NGOLIBA_WARD_ID. wardId now read from
  // body, falling back so existing callers that don't send it keep working.
  const resolvedWardId = parseInt(wardId, 10) || NGOLIBA_WARD_ID;
  if (!requirePermission(req, res, { wardId: resolvedWardId })) return;
  try {
    // Phase 4B.2C: SQL moved to lib/notices.js createNoticeWithExpiresAt().
    const notice = await createNoticeWithExpiresAt(pool, { title, content, category, priority, expiresAt, wardId: resolvedWardId });
    res.json({ success: true, notice });
  } catch (err) {
    console.error('POST /api/admin/notices error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Phase 4A.2: MODERATOR+, scope-checked against the notice's current ward
// (this route doesn't accept wardId in the body at all, so the only way to
// scope-check is against the existing record).
app.put('/api/admin/notices/:id', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  const { title, content, category, priority, expiresAt } = req.body;
  if (!title || !content) return res.status(400).json({ success: false, error: 'title and content are required' });
  try {
    // Phase 4B.2C: SQL moved to lib/notices.js getNoticeWard()/updateNotice().
    const currentWard = await getNoticeWard(pool, req.params.id);
    if (currentWard === undefined) return res.status(404).json({ success: false, error: 'Notice not found' });
    if (!requirePermission(req, res, { wardId: currentWard })) return;

    const notice = await updateNotice(pool, req.params.id, { title, content, category, priority, expiresAt });
    if (!notice) return res.status(404).json({ success: false, error: 'Notice not found' });
    res.json({ success: true, notice });
  } catch (err) {
    console.error('PUT /api/admin/notices error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Phase 4A.2: MODERATOR+, scope-checked against the notice's current ward
// when it exists (falls through to the original no-op-then-success
// behavior when it doesn't, matching the pre-existing response contract).
app.delete('/api/admin/notices/:id', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  try {
    // Phase 4B.2C: SQL moved to lib/notices.js getNoticeWard()/deleteNotice().
    const currentWard = await getNoticeWard(pool, req.params.id);
    if (currentWard !== undefined && !requirePermission(req, res, { wardId: currentWard })) return;

    await deleteNotice(pool, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/notices error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin', async (req, res) => {
  const { action, password, token } = req.body;

  // Phase 4A.3D: admin_login action removed. It issued a Bearer token
  // that, as of this phase, is accepted by zero routes anywhere in the
  // project — the last route that checked it (POST /api/admin/notices/
  // verify) and the last frontend page that called it (admin-notices.html)
  // were both removed/migrated in this same phase. Re-confirmed zero
  // remaining callers (grepped every .html file) before removing it.
  // Administrators now authenticate the same way every other user does:
  // POST /api/auth -> session cookie -> req.user -> RBAC below.

  // Phase 4A.2: the token-presence check this replaced never actually
  // validated the token's signature (verifyAdminToken() was never called
  // here) — any non-empty string passed. Replaced with a real RBAC check:
  // every action below now requires at least WARD_ADMIN, with per-action
  // tightening below where warranted.
  if (!requirePermission(req, res, { role: RBAC.ROLES.WARD_ADMIN })) return;

  // ✅ GET STATS - Fixed column names (period_start, period_end instead of created_at, ends_at)
if (action === 'get_stats') {
  try {
    // Phase 4A.4: read-side scope added — SUPER_ADMIN/MODERATOR see
    // system-wide totals unchanged; COUNTY_ADMIN/CONSTITUENCY_ADMIN/
    // WARD_ADMIN now see only their own scope's registered-voter and
    // current-period vote counts.
    const scope = RBAC.resolveReadScope(req.user);
    const votersFilter = RBAC.buildScopeFilter(
      scope, { ward: 'u.ward_id', constituency: 'w.constituency_id', county: 'con.county_id' }, []
    );
    const votersWhere = votersFilter.clause ? `WHERE ${votersFilter.clause}` : '';
    const voters = await pool.query(
      `SELECT COUNT(*) as count FROM users u
         LEFT JOIN wards w ON w.id = u.ward_id
         LEFT JOIN constituencies con ON con.id = w.constituency_id
       ${votersWhere}`,
      votersFilter.params
    );
    const period = await pool.query('SELECT * FROM voting_periods WHERE is_active = true ORDER BY period_start DESC LIMIT 1');
    let votes = { rows: [{ count: 0 }] };
    if (period.rows.length) {
      const votesFilter = RBAC.buildScopeFilter(
        scope, { ward: 'v.ward_id', constituency: 'w.constituency_id', county: 'con.county_id' }, [period.rows[0].id]
      );
      const votesWhere = votesFilter.clause ? `WHERE v.period_id = $1 AND ${votesFilter.clause}` : 'WHERE v.period_id = $1';
      votes = await pool.query(
        `SELECT COUNT(*) as count FROM votes v
           LEFT JOIN wards w ON w.id = v.ward_id
           LEFT JOIN constituencies con ON con.id = w.constituency_id
         ${votesWhere}`,
        votesFilter.params
      );
    }

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
 // Phase 4A.4: no scope filtering applied here — voting_periods has no
 // ward_id/constituency_id/county_id column at all (confirmed: not in
 // GEO_TABLES, see ensurePhase2Migrations above). This isn't a missing
 // relationship that should exist; periods are global by architecture —
 // a single electoral cycle runs across every ward simultaneously — so
 // every administrator, regardless of scope, sees the same period list.
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
    // Phase 3A Task 11: implements the join this comment block recommended —
    // w.name/con.name/cty.name alongside the existing freetext sublocation,
    // plus optional wardId/constituencyId/countyId filters. Filters are
    // optional and additive: omitting all three (every existing caller,
    // since admin.html doesn't send any yet) reproduces the exact same
    // unfiltered result set as before for SUPER_ADMIN/MODERATOR — see the
    // Phase 4A.4 note just below for every other role.
    const { wardId, constituencyId, countyId } = req.body;
    // Phase 4A.2: an EXPLICIT filter is scope-checked against the caller's
    // own geography — a WARD_ADMIN can't pass someone else's wardId.
    if (wardId != null) {
      if (!requirePermission(req, res, { wardId: parseInt(wardId, 10) })) return;
    } else if (constituencyId != null) {
      if (!requirePermission(req, res, { constituencyId: parseInt(constituencyId, 10) })) return;
    } else if (countyId != null) {
      if (!requirePermission(req, res, { countyId: parseInt(countyId, 10) })) return;
    }
    // Phase 4A.4: no explicit filter -> auto-apply the caller's own scope
    // (was: reject with 403 unless SUPER_ADMIN). SUPER_ADMIN/MODERATOR
    // still see every user unfiltered; COUNTY_ADMIN/CONSTITUENCY_ADMIN/
    // WARD_ADMIN now see their own scope by default instead of being
    // rejected outright.
    const explicitFilter = wardId != null || constituencyId != null || countyId != null;
    const scope = explicitFilter ? null : RBAC.resolveReadScope(req.user);

    const params = [];
    let whereClause = '';
    if (wardId != null) {
      params.push(parseInt(wardId, 10));
      whereClause = `WHERE u.ward_id = $${params.length}`;
    } else if (constituencyId != null) {
      params.push(parseInt(constituencyId, 10));
      whereClause = `WHERE w.constituency_id = $${params.length}`;
    } else if (countyId != null) {
      params.push(parseInt(countyId, 10));
      whereClause = `WHERE con.county_id = $${params.length}`;
    } else {
      const scopeFilter = RBAC.buildScopeFilter(
        scope, { ward: 'u.ward_id', constituency: 'w.constituency_id', county: 'con.county_id' }, []
      );
      if (scopeFilter.clause) { whereClause = `WHERE ${scopeFilter.clause}`; params.push(...scopeFilter.params); }
    }

    const result = await pool.query(
      `SELECT u.id, u.phone, u.first_name, u.surname, u.sublocation, u.created_at,
              w.name   AS ward_name,
              con.name AS constituency_name,
              cty.name AS county_name
         FROM users u
         LEFT JOIN wards         w   ON w.id = u.ward_id
         LEFT JOIN constituencies con ON con.id = w.constituency_id
         LEFT JOIN counties      cty ON cty.id = con.county_id
         ${whereClause}
         ORDER BY u.created_at DESC
         LIMIT 100`,
      params
    );
    return res.json({ success: true, users: result.rows, total: result.rowCount });
  } catch (error) {
    console.error('Error in get_users:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

  // ✅ ADD PERIOD — WRAPPER around transitionPeriod(mode:'force'). No longer
  // touches voting_periods directly; this used to bypass the archive engine
  // entirely (Phase 2.6C finding). Now funnels through the same single
  // control function as every other trigger, so the closing period (if any)
  // is always archived before the new one opens.
if (action === 'add_period') {
  // Phase 4A.2: voting periods are global, not ward-scoped, so this is
  // SUPER_ADMIN-only regardless of the WARD_ADMIN+ gate already passed above.
  if (!requirePermission(req, res, { role: RBAC.ROLES.SUPER_ADMIN })) return;
  const durationMinutes = req.body.durationMinutes ?? req.body.durationDays; // legacy field name accepted, always treated as minutes
  try {
    const result = await transitionPeriod(pool, broadcastVoteUpdate, {
      triggerSource: 'admin',
      mode: 'force',
      force: true,
      durationMinutes
    });

    if (!result.transitioned) {
      return res.status(409).json({ success: false, error: result.reason });
    }

    console.log(`[add_period] New period created: id=${result.newPeriod}, ends=${result.endsAt}`);
    return res.json({
      success: true,
      period: { id: result.newPeriod, period_end: result.endsAt, is_active: true, total_votes: 0 }
    });
  } catch (error) {
    console.error('Error in add_period:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
// ✅ END PERIOD — WRAPPER around transitionPeriod(mode:'end'). Previously
// flipped is_active straight to false with NO archive write (Phase 2.6C
// finding — votes for that period were silently lost). Now always archives
// before closing, and refuses to act if the given periodId isn't actually
// the live active period (boundary guard against stale admin UI state).
if (action === 'end_period') {
  // Phase 4A.2: same reasoning as add_period — global, SUPER_ADMIN-only.
  if (!requirePermission(req, res, { role: RBAC.ROLES.SUPER_ADMIN })) return;
  const { periodId } = req.body;
  if (!periodId) return res.status(400).json({ success: false, error: 'Period ID required' });
  try {
    const result = await transitionPeriod(pool, broadcastVoteUpdate, {
      triggerSource: 'admin',
      mode: 'end',
      force: true,
      periodId
    });

    if (!result.transitioned) {
      return res.status(409).json({ success: false, error: result.reason });
    }

    return res.json({ success: true, archivedPeriod: result.completedPeriod, archiveId: result.archiveId });
  } catch (error) {
    console.error('Error in end_period:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
  // Phase 4A.2: destructive + system-wide (cascades vote deletion for any
  // user in any ward) — SUPER_ADMIN-only regardless of the WARD_ADMIN+
  // gate already passed above.
if (action === 'delete_user') {
  if (!requirePermission(req, res, { role: RBAC.ROLES.SUPER_ADMIN })) return;
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
// All 8 ad-request routes moved to routes/notices.js (Phase 4B.2C) —
// none of them touch requirePermission(), NGOLIBA_WARD_ID, or the shared
// cache (ad_requests has no ward_id column at all — confirmed in the
// Phase 4A.4 report — so there was never a scope check to preserve here).

// ════════════════════════════════════════════════
// ROUTE: /api/period/next  — start a new voting cycle (admin only)
// MANUAL WRAPPER around the single control function transitionPeriod().
// mode:'force' preserves the existing admin feature of ending a period
// early with a custom duration (the auto interval/webhook path only rolls
// over once period_end has actually passed) — that is the one intentional
// behavioral difference between this trigger and the automatic ones, now
// expressed as a parameter rather than a second copy of the logic.
// ════════════════════════════════════════════════
// Phase 4A.2: SUPER_ADMIN-only — global period control, not ward-scoped.
app.post('/api/period/next', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {

  const { durationMinutes } = req.body;

  try {
    const result = await transitionPeriod(pool, broadcastVoteUpdate, {
      triggerSource: 'manual',
      mode: 'force',
      force: true,
      durationMinutes
    });

    if (!result.transitioned) {
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

    // 2. If none exists, auto-create one via the single control function (safety net)
    if (periodRes.rows.length === 0) {
      console.warn('[voting-period] No active period found — bootstrapping one');
      const boot = await transitionPeriod(pool, broadcastVoteUpdate, { triggerSource: 'safety-net', mode: 'bootstrap' });
      const nextId = boot.transitioned ? boot.newPeriod : null;
      periodRes = nextId
        ? await pool.query(
            `SELECT id, period_start, period_end, total_votes
               FROM voting_periods WHERE id = $1`, [nextId]
          )
        : await pool.query(
            `SELECT id, period_start, period_end, total_votes
               FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1`
          ); // boot.reason === 'already-active': a concurrent caller won the race, just re-read it
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
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    const vpLiveParams = [period.id];
    let vpLiveWardClause = '';
    if (req.wardId != null) {
      vpLiveParams.push(req.wardId);
      vpLiveWardClause = 'AND ward_id = $2';
    }
    const vpLiveRes = await pool.query(
      `SELECT COUNT(*) AS count FROM votes WHERE period_id = $1 ${vpLiveWardClause}`, vpLiveParams
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
// BACKUP WRAPPER around the single control function transitionPeriod().
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
    const result = await transitionPeriod(pool, broadcastVoteUpdate, { triggerSource: 'webhook', mode: 'auto' });

    if (!result.transitioned) {
      if (result.reason === 'no-active-period') {
        return res.json({ success: true, message: 'No active period' });
      }
      // not-expired / already-claimed / archive-exists — another trigger
      // handled it already, or it's not due yet.
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
app.use(candidatesRouter); // Phase 4B.2B
app.use(noticesRouter); // Phase 4B.2C
app.use(forumRouter); // Phase 4B.2D

// ── PHASE 2: Frontend page routes ──
app.get('/voting', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'voting.html'));
});
app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});
// 'advanced-leaderboard.html' was an improved version of leaderboard.html
// that has now superseded it — the improved file is deployed as
// public/leaderboard.html itself, so this route is kept only as a
// redirect for anyone with the old URL bookmarked, rather than a 404.
app.get('/advanced-leaderboard', (req, res) => {
  res.redirect(301, '/leaderboard');
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
// ════════════════════════════════════════════════
// PHASE 3A — Geographic hierarchy administration
// Tables already exist (ensureGeographyTables, above) with the UNIQUE
// constraints needed — counties.name, constituencies(county_id,name),
// wards(constituency_id,name). These endpoints are new write-paths onto
// that existing schema; no migration, no new table.
// ════════════════════════════════════════════════

// POST /api/admin/counties  { name }
// Phase 4A.2: SUPER_ADMIN-only — top of the geography hierarchy, no parent scope to check against.
app.post('/api/admin/counties', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const existing = await pool.query('SELECT id FROM counties WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: `County '${name}' already exists` });
    }

    const result = await pool.query(
      'INSERT INTO counties (name) VALUES ($1) RETURNING id, name, created_at',
      [name]
    );
    invalidateStaticCache('counties');
    return res.status(201).json({ success: true, county: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') { // unique_violation — race with the pre-check above
      return res.status(409).json({ success: false, error: 'County already exists' });
    }
    console.error('[POST /api/admin/counties] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to create county' });
  }
});

// POST /api/admin/constituencies  { name, countyId }
// Phase 4A.2: COUNTY_ADMIN+, scope-checked against the target county.
app.post('/api/admin/constituencies', RBAC.requireMinRole(RBAC.ROLES.COUNTY_ADMIN), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const countyId = parseInt(req.body.countyId, 10);
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!countyId || isNaN(countyId)) {
      return res.status(400).json({ success: false, error: 'countyId is required' });
    }
    if (!requirePermission(req, res, { countyId })) return;

    const county = await pool.query('SELECT id FROM counties WHERE id = $1', [countyId]);
    if (county.rows.length === 0) {
      return res.status(404).json({ success: false, error: `County ${countyId} does not exist` });
    }

    const existing = await pool.query(
      'SELECT id FROM constituencies WHERE county_id = $1 AND name = $2',
      [countyId, name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: `Constituency '${name}' already exists in this county` });
    }

    const result = await pool.query(
      'INSERT INTO constituencies (county_id, name) VALUES ($1, $2) RETURNING id, county_id, name, created_at',
      [countyId, name]
    );
    invalidateStaticCache('constituencies');
    return res.status(201).json({ success: true, constituency: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ success: false, error: 'Constituency already exists in this county' });
    }
    console.error('[POST /api/admin/constituencies] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to create constituency' });
  }
});

// POST /api/admin/wards  { name, constituencyId }
// Phase 4A.2: CONSTITUENCY_ADMIN+, scope-checked against the target constituency.
app.post('/api/admin/wards', RBAC.requireMinRole(RBAC.ROLES.CONSTITUENCY_ADMIN), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const constituencyId = parseInt(req.body.constituencyId, 10);
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!constituencyId || isNaN(constituencyId)) {
      return res.status(400).json({ success: false, error: 'constituencyId is required' });
    }
    if (!requirePermission(req, res, { constituencyId })) return;

    const constituency = await pool.query('SELECT id FROM constituencies WHERE id = $1', [constituencyId]);
    if (constituency.rows.length === 0) {
      return res.status(404).json({ success: false, error: `Constituency ${constituencyId} does not exist` });
    }

    const existing = await pool.query(
      'SELECT id FROM wards WHERE constituency_id = $1 AND name = $2',
      [constituencyId, name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: `Ward '${name}' already exists in this constituency` });
    }

    const result = await pool.query(
      'INSERT INTO wards (constituency_id, name) VALUES ($1, $2) RETURNING id, constituency_id, name, created_at',
      [constituencyId, name]
    );
    invalidateStaticCache('wards');
    return res.status(201).json({ success: true, ward: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ success: false, error: 'Ward already exists in this constituency' });
    }
    console.error('[POST /api/admin/wards] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to create ward' });
  }
});


// ════════════════════════════════════════════════════════════
// PHASE 4A.3 — ADMINISTRATOR IDENTITY MANAGEMENT (SUPER_ADMIN only)
// New standalone endpoints, not part of the legacy /api/admin dispatcher.
// All five routes below are gated with RBAC.requireRole(SUPER_ADMIN) —
// exact match, not requireMinRole, since nothing outranks SUPER_ADMIN and
// the task requires these specific actions to be SUPER_ADMIN-only, not
// "SUPER_ADMIN and up".
// ══════════════════════════════════════════════════════════

// Validates a requested role + geographic scope against the DB, per the
// hierarchy rules: SUPER_ADMIN/MODERATOR carry no geographic assignment;
// COUNTY_ADMIN needs exactly a countyId; CONSTITUENCY_ADMIN needs exactly
// a constituencyId; WARD_ADMIN needs exactly a wardId. If more than one
// geography id is supplied together, the parent/child relationship
// between them is cross-checked against the actual geography tables
// (never trusts client-supplied hierarchy). Shared by both the promote
// and update-scope endpoints so the validation logic lives in one place.
async function validateAdminScope(role, { countyId, constituencyId, wardId }) {
  countyId = countyId != null && countyId !== '' ? parseInt(countyId, 10) : null;
  constituencyId = constituencyId != null && constituencyId !== '' ? parseInt(constituencyId, 10) : null;
  wardId = wardId != null && wardId !== '' ? parseInt(wardId, 10) : null;

  if (role === RBAC.ROLES.SUPER_ADMIN || role === RBAC.ROLES.MODERATOR) {
    if (countyId != null || constituencyId != null || wardId != null) {
      return { ok: false, error: `${role} must not have a geographic assignment` };
    }
    return { ok: true, scope: { admin_county_id: null, admin_constituency_id: null, admin_ward_id: null } };
  }

  if (role === RBAC.ROLES.COUNTY_ADMIN) {
    if (countyId == null) return { ok: false, error: 'COUNTY_ADMIN requires countyId' };
    if (constituencyId != null || wardId != null) {
      return { ok: false, error: 'COUNTY_ADMIN must not have constituencyId or wardId' };
    }
    const county = await pool.query('SELECT id FROM counties WHERE id = $1', [countyId]);
    if (!county.rows.length) return { ok: false, error: `County ${countyId} does not exist` };
    return { ok: true, scope: { admin_county_id: countyId, admin_constituency_id: null, admin_ward_id: null } };
  }

  if (role === RBAC.ROLES.CONSTITUENCY_ADMIN) {
    if (constituencyId == null) return { ok: false, error: 'CONSTITUENCY_ADMIN requires constituencyId' };
    if (wardId != null) return { ok: false, error: 'CONSTITUENCY_ADMIN must not have wardId' };
    const con = await pool.query('SELECT id, county_id FROM constituencies WHERE id = $1', [constituencyId]);
    if (!con.rows.length) return { ok: false, error: `Constituency ${constituencyId} does not exist` };
    if (countyId != null && con.rows[0].county_id !== countyId) {
      return { ok: false, error: `Constituency ${constituencyId} does not belong to county ${countyId}` };
    }
    return { ok: true, scope: { admin_county_id: null, admin_constituency_id: constituencyId, admin_ward_id: null } };
  }

  if (role === RBAC.ROLES.WARD_ADMIN) {
    if (wardId == null) return { ok: false, error: 'WARD_ADMIN requires wardId' };
    const ward = await pool.query('SELECT id, constituency_id FROM wards WHERE id = $1', [wardId]);
    if (!ward.rows.length) return { ok: false, error: `Ward ${wardId} does not exist` };
    if (constituencyId != null && ward.rows[0].constituency_id !== constituencyId) {
      return { ok: false, error: `Ward ${wardId} does not belong to constituency ${constituencyId}` };
    }
    if (countyId != null) {
      const con = await pool.query('SELECT county_id FROM constituencies WHERE id = $1', [ward.rows[0].constituency_id]);
      if (con.rows.length && con.rows[0].county_id !== countyId) {
        return { ok: false, error: `Ward ${wardId} does not belong to county ${countyId}` };
      }
    }
    return { ok: true, scope: { admin_county_id: null, admin_constituency_id: null, admin_ward_id: wardId } };
  }

  return { ok: false, error: `Unknown role '${role}'` };
}

// Console-only audit trail, matching the existing bracket-prefixed log
// style used elsewhere (e.g. [add_period], [checkNoticeAdminAuth]). No
// audit table yet — explicitly out of scope for this phase.
function logAdminIdentityAction(req, action, targetUserId, details) {
  console.log(
    `[admin-identity] ${new Date().toISOString()} actor=${req.user.id} action=${action} target=${targetUserId} ${JSON.stringify(details)}`
  );
}

// GET /api/admin/administrators — list every non-VOTER user with their
// geographic assignment names resolved for display.
// Phase 4A.4: audited, not modified. This route (and /search below) uses
// RBAC.requireRole(SUPER_ADMIN) — an exact match, not requireMinRole —
// so no caller below SUPER_ADMIN can ever reach this data in the first
// place. Since SUPER_ADMIN is specified to see everything unfiltered,
// there is nothing to restrict here; the existing exact-role gate already
// satisfies read isolation for this endpoint by construction.
app.get('/api/admin/administrators', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.first_name, u.surname, u.phone, u.role,
             u.admin_county_id, cty.name AS admin_county_name,
             u.admin_constituency_id, con.name AS admin_constituency_name,
             u.admin_ward_id, w.name AS admin_ward_name
        FROM users u
        LEFT JOIN counties cty ON cty.id = u.admin_county_id
        LEFT JOIN constituencies con ON con.id = u.admin_constituency_id
        LEFT JOIN wards w ON w.id = u.admin_ward_id
       WHERE u.role IS NOT NULL AND u.role != 'VOTER'
       ORDER BY u.role, u.first_name
    `);
    res.json({ success: true, administrators: result.rows });
  } catch (err) {
    console.error('GET /api/admin/administrators error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/administrators/search?q=... — search ANY user (not just
// current administrators) by phone or name, so a SUPER_ADMIN can find a
// plain VOTER to promote. Needed by the promote UI — the promote endpoint
// below requires a userId, and this is how the caller finds one.
app.get('/api/admin/administrators/search', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, users: [] });
    const result = await pool.query(
      `SELECT id, first_name, surname, phone, role FROM users
        WHERE phone ILIKE $1 OR first_name ILIKE $1 OR surname ILIKE $1
        ORDER BY created_at DESC LIMIT 20`,
      [`%${q}%`]
    );
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error('GET /api/admin/administrators/search error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/administrators/promote  { userId, role, countyId?, constituencyId?, wardId? }
app.post('/api/admin/administrators/promote', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { userId, role, countyId, constituencyId, wardId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });
    if (!role || !RBAC.isValidRole(role)) {
      return res.status(400).json({ success: false, error: 'role must be one of: ' + RBAC.VALID_ROLES.join(', ') });
    }
    if (role === RBAC.ROLES.VOTER) {
      return res.status(400).json({ success: false, error: 'Use the demote endpoint to set a user back to VOTER' });
    }
    // Prevent dangerous operations: no self-service role changes.
    if (String(userId) === String(req.user.id)) {
      return res.status(403).json({ success: false, error: 'You cannot change your own role' });
    }

    const target = await pool.query('SELECT id, role, admin_county_id, admin_constituency_id, admin_ward_id FROM users WHERE id = $1', [userId]);
    if (!target.rows.length) {
      // Covers both "never existed" and "deleted" — this app hard-deletes users, so there's no separate soft-delete state to distinguish.
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const validation = await validateAdminScope(role, { countyId, constituencyId, wardId });
    if (!validation.ok) return res.status(400).json({ success: false, error: validation.error });
    const { scope } = validation;

    const existing = target.rows[0];
    if (
      existing.role === role &&
      existing.admin_county_id === scope.admin_county_id &&
      existing.admin_constituency_id === scope.admin_constituency_id &&
      existing.admin_ward_id === scope.admin_ward_id
    ) {
      return res.status(409).json({ success: false, error: 'User already has this exact role and scope' });
    }

    const result = await pool.query(
      `UPDATE users SET role = $1, admin_county_id = $2, admin_constituency_id = $3, admin_ward_id = $4
        WHERE id = $5
        RETURNING id, first_name, surname, phone, role, admin_county_id, admin_constituency_id, admin_ward_id`,
      [role, scope.admin_county_id, scope.admin_constituency_id, scope.admin_ward_id, userId]
    );

    logAdminIdentityAction(req, 'promote', userId, { newRole: role, scope });
    res.json({ success: true, administrator: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/administrators/promote error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/administrators/demote  { userId }
app.post('/api/admin/administrators/demote', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });
    // Prevent dangerous operations: no self-service role changes.
    if (String(userId) === String(req.user.id)) {
      return res.status(403).json({ success: false, error: 'You cannot change your own role' });
    }

    const target = await pool.query('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (!target.rows.length) return res.status(404).json({ success: false, error: 'User not found' });

    if (target.rows[0].role === RBAC.ROLES.VOTER) {
      return res.status(409).json({ success: false, error: 'User is already a VOTER' });
    }

    if (target.rows[0].role === RBAC.ROLES.SUPER_ADMIN) {
      const count = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'SUPER_ADMIN'`);
      if (count.rows[0].n <= 1) {
        return res.status(403).json({ success: false, error: 'Cannot remove the last SUPER_ADMIN' });
      }
    }

    const result = await pool.query(
      `UPDATE users SET role = 'VOTER', admin_county_id = NULL, admin_constituency_id = NULL, admin_ward_id = NULL
        WHERE id = $1
        RETURNING id, first_name, surname, phone, role`,
      [userId]
    );

    logAdminIdentityAction(req, 'demote', userId, { newRole: 'VOTER', scope: null });
    res.json({ success: true, administrator: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/administrators/demote error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/administrators/:id/scope  { countyId?, constituencyId?, wardId? }
// Changes an existing administrator's geographic assignment without
// changing their role — re-validates the new scope against their current
// role's requirements using the same validateAdminScope() used by promote.
app.patch('/api/admin/administrators/:id/scope', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const userId = req.params.id;
    const { countyId, constituencyId, wardId } = req.body;

    const target = await pool.query('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (!target.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    if (target.rows[0].role === RBAC.ROLES.VOTER) {
      return res.status(400).json({ success: false, error: 'User is not an administrator — promote them first' });
    }

    const validation = await validateAdminScope(target.rows[0].role, { countyId, constituencyId, wardId });
    if (!validation.ok) return res.status(400).json({ success: false, error: validation.error });
    const { scope } = validation;

    const result = await pool.query(
      `UPDATE users SET admin_county_id = $1, admin_constituency_id = $2, admin_ward_id = $3
        WHERE id = $4
        RETURNING id, first_name, surname, phone, role, admin_county_id, admin_constituency_id, admin_ward_id`,
      [scope.admin_county_id, scope.admin_constituency_id, scope.admin_ward_id, userId]
    );

    logAdminIdentityAction(req, 'update_scope', userId, { role: target.rows[0].role, scope });
    res.json({ success: true, administrator: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/admin/administrators/:id/scope error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/counties', async (req, res) => {
  try {
    const cacheKey = 'counties:all';
    let counties = getCached(cacheKey);
    if (counties === undefined) {
      const result = await pool.query(
        'SELECT id, name, created_at FROM counties ORDER BY name ASC'
      );
      counties = result.rows;
      setCached(cacheKey, counties);
    }
    return res.json({ success: true, counties });
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
    const cacheKey = county_id ? `constituencies:county:${county_id}` : 'constituencies:all';
    let constituencies = getCached(cacheKey);
    if (constituencies === undefined) {
      const result = county_id
        ? await pool.query(
            'SELECT id, county_id, name, created_at FROM constituencies WHERE county_id = $1 ORDER BY name ASC',
            [parseInt(county_id, 10)]
          )
        : await pool.query(
            'SELECT id, county_id, name, created_at FROM constituencies ORDER BY name ASC'
          );
      constituencies = result.rows;
      setCached(cacheKey, constituencies);
    }
    return res.json({ success: true, constituencies });
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
    const cacheKey = constituency_id ? `wards:constituency:${constituency_id}` : 'wards:all';
    let wards = getCached(cacheKey);
    if (wards === undefined) {
      const result = constituency_id
        ? await pool.query(
            'SELECT id, constituency_id, name, created_at FROM wards WHERE constituency_id = $1 ORDER BY name ASC',
            [parseInt(constituency_id, 10)]
          )
        : await pool.query(
            'SELECT id, constituency_id, name, created_at FROM wards ORDER BY name ASC'
          );
      wards = result.rows;
      setCached(cacheKey, wards);
    }
    return res.json({ success: true, wards });
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