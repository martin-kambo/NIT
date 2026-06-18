// ════════════════════════════════════════════════════════════════════════
// SINGLE PERIOD CONTROL FUNCTION  (Phase 2.6C)
// ════════════════════════════════════════════════════════════════════════
// transitionPeriod() is the ONLY function in this entire codebase allowed to:
//   - read/lock the active voting period
//   - decide whether it has expired
//   - write to period_archives
//   - flip voting_periods.is_active
//   - insert a new voting_periods row (including the very first one ever)
//
// It lives here, in its own lib module with zero dependencies on
// server.js or routes/voting.js, specifically so BOTH of those files can
// require it without creating a circular dependency. The SSE broadcast
// function is passed in as a parameter (broadcastFn) rather than imported,
// for the same reason — routes/voting.js defines broadcastVoteUpdate
// itself, and server.js imports it from there, so this module can't
// import it from either side without creating a cycle.
//
// Every entry point that used to touch voting_periods/period_archives
// directly — setInterval, /api/webhook, /api/period/next, /api/admin
// (add_period, end_period), the startup stale-period cleanup, the
// /api/voting-period "no active period" safety net, and routes/voting.js's
// getCurrentPeriod() bootstrap-on-empty path — now calls this function
// instead. None of them contain SQL against those two tables anymore;
// they only pass parameters in and format the result for their own
// response shape.
//
// Params:
//   triggerSource  'interval' | 'webhook' | 'manual' | 'admin' | 'startup' | 'safety-net'
//   mode           'auto'      — expiry-checked rollover (interval/webhook default)
//                  'force'     — admin-forced rollover, ends early, custom duration
//                  'end'       — admin-forced close, archives but does NOT open a new period
//                  'bootstrap' — create the very first period when none exist at all
//                                (no period to archive, so this is the one explicit,
//                                 narrow exception to "transitions FROM a period")
//   force          bypasses the expiry check (irrelevant for 'end'/'bootstrap')
//   durationMinutes new period length in minutes, 1–60, only used when force=true
//   periodId       optional explicit target (used by end_period); if it doesn't
//                  match the live active period, the call is refused rather than
//                  silently acting on stale state
//
// BOUNDARY GUARDS (hard exits, no exceptions):
//   - no active period exists (outside 'bootstrap')        → EXIT, nothing written
//   - an active period exists but mode is 'bootstrap'       → EXIT, nothing written
//   - the period is no longer is_active (already closed)    → EXIT, nothing written
//   - an archive row already exists for this period id       → EXIT, nothing written
//   - a concurrent caller already claimed this period         → EXIT, nothing written
//
// CONCURRENCY GUARD (no schema changes — existing columns only):
//   The whole sequence runs inside ONE Postgres transaction that opens with
//   `SELECT ... FOR UPDATE` on the active period row. A second simultaneous
//   caller targeting the same row blocks at that statement until the first
//   transaction COMMITs; by the time it unblocks, that row is no longer
//   is_active, so its own lookup now resolves to the freshly-created period
//   (not expired) and it exits cleanly via a boundary guard having written
//   nothing. Double-archiving the same period is structurally impossible.
// ════════════════════════════════════════════════════════════════════════
// SINGLE PERIOD CONTROL FUNCTION  (Phase 2.6C)
// ════════════════════════════════════════════════════════════════════════
// transitionPeriod() is the ONLY function in this entire codebase allowed to:
//   - read/lock the active voting period
//   - decide whether it has expired
//   - write to period_archives
//   - flip voting_periods.is_active
//   - insert a new voting_periods row (including the very first one ever)
//
// Every entry point that used to touch voting_periods/period_archives
// directly — setInterval, /api/webhook, /api/period/next, /api/admin
// (add_period, end_period), the startup stale-period cleanup, and the
// /api/voting-period "no active period" safety net — now calls this
// function instead. None of them contain SQL against those two tables
// anymore; they only pass parameters in and format the result for their
// own response shape.
//
// Params:
//   triggerSource  'interval' | 'webhook' | 'manual' | 'admin' | 'startup' | 'safety-net'
//   mode           'auto'      — expiry-checked rollover (interval/webhook default)
//                  'force'     — admin-forced rollover, ends early, custom duration
//                  'end'       — admin-forced close, archives but does NOT open a new period
//                  'bootstrap' — create the very first period when none exist at all
//                                (no period to archive, so this is the one explicit,
//                                 narrow exception to "transitions FROM a period")
//   force          bypasses the expiry check (irrelevant for 'end'/'bootstrap')
//   durationMinutes new period length in minutes, 1–60, only used when force=true
//   periodId       optional explicit target (used by end_period); if it doesn't
//                  match the live active period, the call is refused rather than
//                  silently acting on stale state
//
// BOUNDARY GUARDS (hard exits, no exceptions):
//   - no active period exists (outside 'bootstrap')        → EXIT, nothing written
//   - an active period exists but mode is 'bootstrap'       → EXIT, nothing written
//   - the period is no longer is_active (already closed)    → EXIT, nothing written
//   - an archive row already exists for this period id       → EXIT, nothing written
//   - a concurrent caller already claimed this period         → EXIT, nothing written
//
// CONCURRENCY GUARD (no schema changes — existing columns only):
//   The whole sequence runs inside ONE Postgres transaction that opens with
//   `SELECT ... FOR UPDATE` on the active period row. A second simultaneous
//   caller targeting the same row blocks at that statement until the first
//   transaction COMMITs; by the time it unblocks, that row is no longer
//   is_active, so its own lookup now resolves to the freshly-created period
//   (not expired) and it exits cleanly via a boundary guard having written
//   nothing. Double-archiving the same period is structurally impossible.
async function transitionPeriod(pool, broadcastFn, {
  triggerSource,
  mode = 'auto',
  force = false,
  durationMinutes = 5,
  periodId = null
} = {}) {
  const client = await pool.connect();
  const logExit = (reason, extra = {}) => {
    console.log(JSON.stringify({
      event: 'period-transition-rejected',
      trigger_source: triggerSource,
      mode,
      reason,
      timestamp: new Date().toISOString(),
      ...extra
    }));
  };

  try {
    await client.query('BEGIN');

    const activeRes = await client.query(
      `SELECT * FROM voting_periods WHERE is_active = true ORDER BY id DESC LIMIT 1 FOR UPDATE`
    );

    // ── BOOTSTRAP: the one path allowed to create a period from nothing ──
    if (activeRes.rows.length === 0) {
      if (mode !== 'bootstrap') {
        await client.query('ROLLBACK');
        logExit('no-active-period');
        return { transitioned: false, reason: 'no-active-period', triggerSource, mode };
      }

      const now     = new Date();
      const mins    = Math.min(Math.max(parseInt(durationMinutes) || 5, 1), 60);
      const endTime = new Date(now.getTime() + mins * 60 * 1000);
      const maxRes  = await client.query('SELECT COALESCE(MAX(id), 0) AS maxid FROM voting_periods');
      const nextId  = parseInt(maxRes.rows[0].maxid) + 1;
      await client.query(
        `INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
           VALUES ($1, $2, $3, true, 0)`,
        [nextId, now, endTime]
      );
      await client.query('COMMIT');

      console.log(JSON.stringify({
        event:             'period-transition',
        trigger_source:    triggerSource,
        mode,
        period_id_before:  null,
        period_id_after:   nextId,
        archive_id:        null,
        timestamp:         new Date().toISOString()
      }));

      broadcastFn('period-rollover', { newPeriodId: nextId, endsAt: endTime });
      return { transitioned: true, triggerSource, mode, completedPeriod: null, archiveId: null, winner: null, newPeriod: nextId, endsAt: endTime };
    }

    if (mode === 'bootstrap') {
      // An active period already exists — nothing to bootstrap.
      await client.query('ROLLBACK');
      logExit('already-active', { periodId: activeRes.rows[0].id });
      return { transitioned: false, reason: 'already-active', triggerSource, mode, periodId: activeRes.rows[0].id };
    }

    const period = activeRes.rows[0];

    // ── BOUNDARY GUARD: explicit target must match the live active period ──
    if (periodId != null && parseInt(periodId) !== period.id) {
      await client.query('ROLLBACK');
      logExit('period-mismatch', { requestedPeriodId: periodId, activePeriodId: period.id });
      return { transitioned: false, reason: 'period-mismatch', triggerSource, mode, periodId: period.id };
    }

    // ── BOUNDARY GUARD: already transitioned ──
    // (Unreachable in practice — the row above only matches is_active = true —
    // but kept explicit per the required hard safety rule.)
    if (period.is_active !== true) {
      await client.query('ROLLBACK');
      logExit('already-transitioned', { periodId: period.id });
      return { transitioned: false, reason: 'already-transitioned', triggerSource, mode, periodId: period.id };
    }

    const expired = new Date(period.period_end) <= new Date();
    if (!force && !expired) {
      await client.query('ROLLBACK');
      return { transitioned: false, reason: 'not-expired', periodId: period.id, endsAt: period.period_end, triggerSource, mode };
    }

    // ── BOUNDARY GUARD: archive already exists for this period id ──
    const existingArchive = await client.query(`SELECT id FROM period_archives WHERE id = $1`, [period.id]);
    if (existingArchive.rows.length > 0) {
      await client.query('ROLLBACK');
      logExit('archive-exists', { periodId: period.id });
      return { transitioned: false, reason: 'archive-exists', periodId: period.id, triggerSource, mode };
    }

    // ── Atomic claim: only proceed if WE are the one flipping is_active. ──
    // Defense-in-depth on top of the row lock above — belt and suspenders.
    const claim = await client.query(
      `UPDATE voting_periods SET is_active = false WHERE id = $1 AND is_active = true RETURNING id`,
      [period.id]
    );
    if (claim.rows.length === 0) {
      await client.query('ROLLBACK');
      logExit('already-claimed', { periodId: period.id });
      return { transitioned: false, reason: 'already-claimed', periodId: period.id, endsAt: period.period_end, triggerSource, mode };
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

    // ── Archive the closed period — every mode passes through here, including 'end' ──
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
    const archiveId = archiveInsert.rows[0]?.id ?? period.id;

    // ── 'end' mode closes the period and stops here — no new period created ──
    if (mode === 'end') {
      await client.query('COMMIT');

      console.log(JSON.stringify({
        event:             'period-transition',
        trigger_source:    triggerSource,
        mode,
        period_id_before:  period.id,
        period_id_after:   null,
        archive_id:        archiveId,
        timestamp:         new Date().toISOString()
      }));

      broadcastFn('period-ended', { period: period.id, winner: winner?.id, winnerVotes: winner?.votes });
      return { transitioned: true, triggerSource, mode, completedPeriod: period.id, archiveId, winner, newPeriod: null, endsAt: null };
    }

    // ── Create the next period (auto / force modes) ──
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
      event:             'period-transition',
      trigger_source:    triggerSource,
      mode,
      period_id_before:  period.id,
      period_id_after:   nextId,
      archive_id:        archiveId,
      timestamp:         new Date().toISOString()
    }));

    broadcastFn('period-rollover', { newPeriodId: nextId, endsAt: endTime });

    return {
      transitioned:    true,
      triggerSource,
      mode,
      completedPeriod: period.id,
      archiveId,
      winner,
      newPeriod:       nextId,
      endsAt:          endTime
    };

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(`[transitionPeriod:${triggerSource}:${mode}] ERROR:`, e.message);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { transitionPeriod };