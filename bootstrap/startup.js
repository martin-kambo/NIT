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
}) {
  const connected = await testDBConnection();
  if (connected) {
    await initDB();
    await ensureVotingPeriodsTable();  // ← must run BEFORE ensureActivePeriod so schema is ready
    await ensureActivePeriod();        // now a no-op alias for backward compat
    await ensureCandidatesTable();     // multi-category candidates (preserves MCA IDs 0-6)
    await ensureGeographyTables();     // Phase 1: additive geographic foundation — no existing behaviour changes
    await seedKiambuHierarchy();       // Phase 3B: complete Kiambu County administrative reference data
    await ensurePhase2Migrations();    // Phase 2: add ward_id columns, backfill existing rows, cache NGOLIBA_WARD_ID
    await ensureRBACFoundation();      // Phase 4A.1: add role + admin-scope columns to users, default VOTER (foundation only, not enforced)
    await ensureSuperAdminBootstrap();  // Phase 4A.2: one-time VOTER->SUPER_ADMIN promotion via SUPER_ADMIN_PHONE, idempotent
    await ensureNoticesTable();        // Phase 3B Polish: moved after ensurePhase2Migrations() so the
                                        // notices.ward_id column and NGOLIBA_WARD_ID already exist before
                                        // this function's seed INSERT runs (was throwing “column ward_id
                                        // does not exist” on a brand-new database, which silently skipped
                                        // both the notice seed and the forum/avatar migrations later in
                                        // this same function).
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

module.exports = { startServer };
