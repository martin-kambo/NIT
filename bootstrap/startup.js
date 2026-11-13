// bootstrap/startup.js
// Phase 4B.1: extracted verbatim from server.js — the startup orchestration
// sequence (migration order), app.listen(), the 30s period-rollover
// interval, and the SIGTERM graceful-shutdown handler.
//
// This module takes every dependency as a parameter rather than requiring
// server.js directly, specifically so it can be called with
// ensurePhase2Migrations (which stays in server.js — see the Phase 4B.1
// report) without creating a circular require. The sequence, every log
// line, the timer interval, and the shutdown behavior are all unchanged
// from the original inline IIFE — only how the pieces are wired together
// changed, not what runs or when.
//
// Phase 4B.44: two notice-scope readiness checks are wired into the sequence
// (bootstrap/notice-scope-readiness.js; ensurePhase2Migrations itself is unchanged):
//   1. immediately BEFORE ensurePhase2Migrations(): its ward backfill must never run against a
//      notices table whose notice-scope schema is partly installed or invalid;
//   2. immediately AFTER ensureNoticesTable() (which installs the scope schema): the schema must
//      now be complete and valid.
// If either throws, startServer() rejects BEFORE app.listen(), so the server never accepts traffic.
// startServerOrExit() is the entry point server.js uses so that rejection is logged and exits non-zero.
const noticeScopeReadiness = require('./notice-scope-readiness');

async function startServer({
  app,
  PORT,
  pool,
  testDBConnection,
  transitionPeriod,
  broadcastVoteUpdate,
  initDB,
  ensureVotingPeriodsTable,
  ensureActivePeriod,
  ensureCandidatesTable,
  ensureGeographyTables,
  seedKiambuHierarchy,
  ensurePhase2Migrations,
  ensureRBACFoundation,
  ensureSuperAdminBootstrap,
  ensureNoticesTable,
  // Phase 4B.44 (default to the real verifiers; injectable for tests)
  verifyNoticeScopeBeforeBackfill = noticeScopeReadiness.verifyNoticeScopeBeforeBackfill,
  verifyNoticeScopeReady = noticeScopeReadiness.verifyNoticeScopeReady,
}) {
  const connected = await testDBConnection();
  if (connected) {
    await initDB();
    await ensureVotingPeriodsTable();  // ← must run BEFORE ensureActivePeriod so schema is ready
    await ensureActivePeriod();        // now a no-op alias for backward compat
    await ensureCandidatesTable();     // multi-category candidates (preserves MCA IDs 0-6)
    await ensureGeographyTables();     // Phase 1: additive geographic foundation — no existing behaviour changes
    await seedKiambuHierarchy();       // Phase 3B: complete Kiambu County administrative reference data
    await verifyNoticeScopeBeforeBackfill(pool); // Phase 4B.44: GATE - throws (and nothing below runs) unless the notice-scope schema is NOT_INSTALLED or fully INSTALLED
    await ensurePhase2Migrations();    // Phase 2: add ward_id columns, backfill existing rows, cache NGOLIBA_WARD_ID
    await ensureRBACFoundation();      // Phase 4A.1: add role + admin-scope columns to users, default VOTER (foundation only, not enforced)
    await ensureSuperAdminBootstrap();  // Phase 4A.2: one-time VOTER->SUPER_ADMIN promotion via SUPER_ADMIN_PHONE, idempotent
    await require('../routes/community-reports').ensureCommunityReportsTables(); // Engage: additive tables + demo seed
    await ensureNoticesTable();        // Phase 3B Polish: moved after ensurePhase2Migrations() so the
                                        // notices.ward_id column and NGOLIBA_WARD_ID already exist before
                                        // this function's seed INSERT runs (was throwing “column ward_id
                                        // does not exist” on a brand-new database, which silently skipped
                                        // both the notice seed and the forum/avatar migrations later in
                                        // this same function).
    await verifyNoticeScopeReady(pool); // Phase 4B.44: throws (so the server never listens) unless the notice-scope schema is now fully INSTALLED and valid
  } else {
    console.warn('⚠️  Continuing without database. Some features may not work.');
    console.warn('⚠️  Notice-scope schema readiness was NOT verified (database unavailable): no migration ran, and the notice scope columns, constraints and trigger have not been checked.');
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
  // thin wrappers around the exact same transitionPeriod() call.
  setInterval(async () => {
    try {
      const result = await transitionPeriod(pool, broadcastVoteUpdate, { triggerSource: 'interval', mode: 'auto' });
      if (result.transitioned) {
        console.log(`[interval] Period ${result.completedPeriod} → archived (archive ${result.archiveId}); new period ${result.newPeriod}`);
      }
      // result.transitioned === false (not-expired / no-active-period) is the
      // normal, silent case on most ticks — nothing to log.
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

  return server;
}

// Phase 4B.44: the entry point server.js uses. Same as startServer(), except that a start-up failure
// (for example a NoticeScopeNotReadyError) is logged clearly and ends the process with a non-zero exit
// code instead of becoming an unhandled promise rejection. The server has not started listening when
// this happens. It never rejects.
async function startServerOrExit(deps, { exit = (code) => process.exit(code), logger = console } = {}) {
  try {
    return await startServer(deps);
  } catch (err) {
    logger.error('❌ Startup aborted — the server will NOT listen.');
    if (err && err.code === 'NOTICE_SCOPE_NOT_READY') {
      logger.error(err.message); // already names the schema state, each failed requirement and why startup stopped
    } else {
      logger.error(err && err.stack ? err.stack : String(err));
    }
    exit(1);
    return undefined;
  }
}

module.exports = { startServer, startServerOrExit };
