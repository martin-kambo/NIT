// server.js — Ngoliba InfoTrack
// PostgreSQL version (no Netlify dependency)
// Production-ready for Render
require('dotenv').config();
const analyticsRouter = require('./routes/analytics');
const candidatesRouter = require('./routes/candidates'); // Phase 4B.2B
const noticesRouter = require('./routes/notices'); // Phase 4B.2C
const forumRouter = require('./routes/forum'); // Phase 4B.2D
const authRouter = require('./routes/auth'); // Phase 4B.6
const administratorsRouter = require('./routes/administrators'); // Phase 4B.6
const geographyRouter = require('./routes/geography'); // Phase 4B.11
const periodsRouter = require('./routes/periods'); // Phase 4B.12
const transactionsRouter = require('./routes/transactions'); // Phase 4B.13
const express = require('express');
// require('express-rate-limit') removed (Phase 4B.10): its only consumer
// in this file, forumPostLimiter, moved to routes/forum.js -- that file
// already had its own rateLimit import from before this phase.

// forumPostLimiter moved to routes/forum.js (Phase 4B.10) -- its only
// consumer, POST /api/forum, moved there too.

// 30 replies per 15 minutes per IP
// forumReplyLimiter moved to routes/forum.js (Phase 4B.2D) — its only
// consumer, POST /api/forum/replies, moved there too.
const cors = require('cors');
const compression = require('compression');
// crypto require removed (Phase 4B.7): its only caller in this file was
// POST /api/vote's IP-hashing, which moved to routes/voting.js -- that
// file already had its own `const crypto = require('crypto');` from
// before this phase, so no new import was needed there.
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');
const axios = require('axios');
// notices routes are defined inline — no separate router file needed

// ── PHASE 2: Voting Router ──
const votingRouterModule = require('./routes/voting');
// require('./lib/candidates') removed (Phase 4B.8): all 7 named imports
// (getAllCandidates, getCandidatesByCategory, FALLBACK_CANDIDATES,
// getCandidateWard, createCandidate, updateCandidate, deleteCandidate)
// were used exclusively by the candidate routes that moved to
// routes/candidates.js this phase, which imports the same module fresh.
// require('./lib/notices') removed (Phase 4B.9): all 5 named imports
// (createNoticeWithDays, createNoticeWithExpiresAt, getNoticeWard,
// updateNotice, deleteNotice) were used exclusively by the notice routes
// that moved to routes/notices.js this phase, which imports the same
// module fresh.
// require('./lib/forum') removed (Phase 4B.10): all 4 named imports
// (getAdminForumPosts, createForumPost, toggleLikePost, listForumPosts)
// were used exclusively by the forum routes that moved to
// routes/forum.js this phase, which imports the same module fresh.
const { transitionPeriod } = require('./lib/period-engine');
const RBAC = require('./lib/rbac'); // Phase 4A.1: role model + unattached authorization helpers
// Phase 4B.5: requirePermission() now lives in lib/rbac.js (moved from a
// local function declaration below) -- destructured once here so every
// existing bare `requirePermission(...)` call site below is unchanged.
const { requirePermission } = RBAC;
// Phase 4B.5: the founding-ward singleton (formerly a bare
// module-scoped `let`) moved to lib/ward-cache.js, accessed here via
// getFoundingWardId()/setFoundingWardId(). Single writer
// (ensurePhase2Migrations(), below), many readers -- unchanged in
// every other respect.
const { getFoundingWardId, setFoundingWardId } = require('./lib/ward-cache');
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

// ── Initialize Database Tables ──
// ✅ NOW WITH BETTER ERROR HANDLING & SKIP IF TABLES EXIST
// initDB() moved to bootstrap/migrations.js (Phase 4B.1)
// ── Ensure notices table exists (runs every startup, independent of initDB early-exit) ──
// ensureNoticesTable() moved to bootstrap/migrations.js (Phase 4B.1)
// Test database connection
// testDBConnection() moved to bootstrap/database.js (Phase 4B.1)
// ─────────────────────────────────────
// staticDataCache (Map), STATIC_CACHE_TTL_MS, getCached(), setCached(),
// and invalidateStaticCache() moved to lib/static-cache.js (Phase 4B.5),
// verbatim -- same Map, same TTL, same invalidation behavior, same cache
// key format. See lib/static-cache.js for the full original comment
// explaining the design (single-process Map, TTL as safety net only,
// invalidateStaticCache() as the real guarantee).
// require('./lib/static-cache') removed (Phase 4B.11): its last two
// callers in this file were the candidate routes (moved to
// routes/candidates.js, Phase 4B.8) and the geography routes (moved to
// routes/geography.js, this phase) -- both import the module fresh where
// they now live. Zero remaining callers of getCached/setCached/
// invalidateStaticCache anywhere in this file.

app.use(async (req, res, next) => {
  req.pool = pool;

  // Stage 3B.1 — user-derived req.wardId.
  // Previously this always set req.wardId = getFoundingWardId() (the global
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
  // getFoundingWardId() so public routes that don't require login continue
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
      req.wardId = userWardId || getFoundingWardId();

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
      console.error('[middleware] ward_id lookup failed, using getFoundingWardId() fallback:', _.message);
      req.wardId = getFoundingWardId();
      req.user = null;
    }
  } else {
    req.wardId = getFoundingWardId();
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
    setFoundingWardId(wardId); // resolved from config, not hardcoded to Ngoliba

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
// hashPassword()/generateSalt() (lib/auth/password.js, Phase 4B.2A) and
// createSession() (lib/auth/session.js, Phase 4B.2A) are no longer needed
// in this file: their only callers were the five auth routes, which moved
// to routes/auth.js in Phase 4B.6 (which imports both fresh). sanitizeUser()
// and getNextVoterNumber() moved with them for the same reason — repo-wide
// grep confirmed zero remaining callers of any of these outside that route
// group. verifySession() stays imported here: the auth-context middleware
// above and roughly a dozen other route handlers still in this file all
// depend on it.
const { verifySession } = require('./lib/auth/session');

// Phase 4A.3C: createAdminToken() removed — provably dead code (confirmed
// zero callers anywhere in the project; it was defined but never invoked,
// even before this phase's migration work).
// Phase 4A.3D: verifyAdminToken() also removed — its one remaining caller,
// POST /api/admin/notices/verify, was just removed too (admin-notices.html
// now logs in via /api/auth like every other page). Re-confirmed zero
// callers project-wide before deleting.

// GET /api/candidates moved to routes/candidates.js (Phase 4B.8),
// verbatim -- cache read/populate and the FALLBACK_CANDIDATES
// error-path fallback both unchanged.

// GET /api/me, POST /api/auth, POST /api/profile,
// POST /api/reset-password, and POST /api/change-password all moved to
// routes/auth.js (Phase 4B.6), verbatim -- along with sanitizeUser(),
// getNextVoterNumber(), and the auth-specific rate limiter that used to
// sit near the top of this file. All five were confirmed (Phase
// 4B.3/4B.4 audits) to have zero dependency on requirePermission(), the
// static-data cache, or the founding-ward singleton in any way that
// blocked moving them. Mounted below alongside the other routers.

// POST /api/vote moved to routes/voting.js (Phase 4B.7), verbatim --
// duplicate-vote prevention, period validation, vote insertion, vote
// counting, broadcastVoteUpdate() call, and ward filtering all
// unchanged.

// GET /api/polling-results moved to routes/voting.js (Phase 4B.7),
// verbatim -- kept as a separate implementation from
// /api/voting-results/by-sublocation per the repository audit
// (different NULL-sublocation handling, different response shape);
// not merged or rewritten.

// GET /api/history moved to routes/voting.js (Phase 4B.7), verbatim.
// No frontend consumer identified during the repository audit.
// Preserved unchanged for backward compatibility.

// GET /api/voting-results moved to routes/voting.js (Phase 4B.7),
// verbatim -- kept as a separate implementation from /api/leaderboard
// per the repository audit (different consumer, different response
// shape); not merged or rewritten.

// GET /api/period-history moved to routes/voting.js (Phase 4B.7),
// verbatim.

// POST /api/transaction moved to routes/transactions.js
// (Phase 4B.13), verbatim.

// POST /api/transaction/confirm moved to routes/transactions.js
// (Phase 4B.13), verbatim.

// GET /api/my-votes moved to routes/voting.js (Phase 4B.7), verbatim.

// POST/PUT/DELETE /api/admin/candidates moved to
// routes/candidates.js (Phase 4B.8), verbatim -- RBAC role gate,
// requirePermission() scope checks, lib/candidates.js calls, and
// invalidateStaticCache('candidates') calls all unchanged.

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

// GET /api/stats moved to routes/analytics.js (Phase 4B.14),
// verbatim.

// GET /api/analytics/dashboard moved to routes/analytics.js
// (Phase 4B.14), verbatim -- heatmap, hourly distribution, and
// prediction calculations all unchanged.

// FORUM_CATEGORIES, formatPost(), formatReply() moved to lib/forum.js
// (Phase 4B.2D), imported below where the remaining forum routes need them.

// ────────────────────────────────────────────────────────────────
// GET /api/forum  — list posts, optional ?category= filter
// ────────────────────────────────────────────────────────────────
// GET /api/forum moved to routes/forum.js (Phase 4B.2D) — no dependency
// on requirePermission()/getFoundingWardId(), safe to move whole.

// GET /api/admin/forum-posts moved to routes/forum.js (Phase 4B.10),
// verbatim -- RBAC role gate and requirePermission() scope checks
// unchanged.

// POST /api/forum moved to routes/forum.js (Phase 4B.10), verbatim --
// create_post/like_post/list_posts action-dispatcher, rate limiting,
// and the getFoundingWardId() ward-fallback all unchanged.

// GET /api/forum/replies/:postId and POST /api/forum/replies moved to
// routes/forum.js (Phase 4B.2D) — neither depends on requirePermission()
// or getFoundingWardId(), safe to move whole.

// GET /api/faceoff moved to routes/voting.js (Phase 4B.7), verbatim.

// ══════════════════════════════════════════════
// GET /api/notices — fetch all active notices
// ══════════════════════════════════════════════
// GET /api/notices moved to routes/notices.js (Phase 4B.2C) — no
// dependency on requirePermission()/getFoundingWardId(), safe to move whole.

// POST /api/notices moved to routes/notices.js (Phase 4B.9),
// verbatim -- RBAC role gate and requirePermission() scope check
// unchanged.

// DELETE /api/notices/:id moved to routes/notices.js (Phase 4B.9),
// verbatim.
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

// requirePermission() moved to lib/rbac.js (Phase 4B.5) -- imported at
// the top of this file as `const { requirePermission } = RBAC;`. Every
// call site below is unchanged; only the definition's location moved.

// Phase 4A.3D: POST /api/admin/notices/verify removed. It was
// admin-notices.html's login check — that page now calls POST /api/auth
// like every other page in the app. Confirmed zero remaining callers
// anywhere in the project (server.js, routes/, every mounted router, and
// every .html file) before removing it.

// GET /api/admin/notices moved to routes/notices.js (Phase 4B.2C) — uses
// only pool and the pure, stateless RBAC.resolveReadScope/buildScopeFilter
// helpers, safe to move whole.

// POST /api/admin/notices moved to routes/notices.js (Phase 4B.9),
// verbatim.

// PUT /api/admin/notices/:id moved to routes/notices.js (Phase 4B.9),
// verbatim.

// DELETE /api/admin/notices/:id moved to routes/notices.js
// (Phase 4B.9), verbatim.

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
// none of them touch requirePermission(), getFoundingWardId(), or the shared
// cache (ad_requests has no ward_id column at all — confirmed in the
// Phase 4A.4 report — so there was never a scope check to preserve here).

// POST /api/period/next moved to routes/periods.js (Phase 4B.12),
// verbatim -- RBAC role gate and transitionPeriod() call unchanged.

// GET /api/voting-period moved to routes/periods.js (Phase 4B.12),
// verbatim -- timer fields, live vote count, and the bootstrap
// safety-net call to transitionPeriod() all unchanged.

// POST /api/webhook moved to routes/periods.js (Phase 4B.12),
// verbatim -- CRON_SECRET header check, transitionPeriod() call, and
// response shape all unchanged. Consumed by the deployment cron job
// (cron-period-reset.js, run every minute by render.yaml's separate
// cron service), not by any bundled frontend page.

// ── PHASE 2: Mount voting router ──
app.use(votingRouter);

// ── PHASE 3: Mount analytics router ──
app.use(analyticsRouter);
app.use(candidatesRouter); // Phase 4B.2B
app.use(noticesRouter); // Phase 4B.2C
app.use(forumRouter); // Phase 4B.2D
app.use(authRouter); // Phase 4B.6
app.use(administratorsRouter); // Phase 4B.6
app.use(geographyRouter); // Phase 4B.11
app.use(periodsRouter); // Phase 4B.12
app.use(transactionsRouter); // Phase 4B.13

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

// POST /api/admin/counties, POST /api/admin/constituencies, and
// POST /api/admin/wards moved to routes/geography.js (Phase 4B.11),
// verbatim -- RBAC role gates, requirePermission() scope checks, and
// invalidateStaticCache() calls all unchanged.


// Administrator identity management (list, search, promote, demote,
// scope-patch) moved to routes/administrators.js (Phase 4B.6), verbatim
// -- along with its two local helpers, validateAdminScope() and
// logAdminIdentityAction(). Confirmed to have zero dependency on
// requirePermission(), the static-data cache, or the founding-ward
// singleton. Mounted below alongside the other routers.

// GET /api/counties, GET /api/constituencies, and GET /api/wards
// moved to routes/geography.js (Phase 4B.11), verbatim -- cache
// read/populate for all three unchanged.

// ── Catch-all: serve index.html for any unmatched GET ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// server.listen, auto-rollover setInterval, and SIGTERM handler
// are all started inside the startup IIFE above, after migrations complete.