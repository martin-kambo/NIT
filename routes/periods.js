// routes/periods.js
// Phase 4B.12: extracted verbatim from server.js. The three standalone
// Period Control HTTP routes -- POST /api/period/next (manual admin
// trigger), GET /api/voting-period (current period + timer, polled by
// the frontend), and POST /api/webhook (external resilience-net
// trigger, called by the deployment cron job in cron-period-reset.js
// via render.yaml's separate cron service -- not by any bundled
// frontend page).
//
// All three remain thin orchestration layers around the single
// canonical transitionPeriod() in lib/period-engine.js, exactly as
// they were in server.js -- this file introduces no new period logic,
// no new state machine, and does not touch the automatic 30s rollover
// interval or the SIGTERM handler, both of which remain solely owned
// by bootstrap/startup.js. The legacy POST /api/admin dispatcher's
// add_period/end_period actions also call transitionPeriod()
// independently and are explicitly out of scope for this phase --
// they remain in server.js, unchanged, alongside the pool/RBAC/
// broadcastVoteUpdate/transitionPeriod references they still need.
//
// broadcastVoteUpdate is obtained the same way server.js itself
// already obtains it: require the voting router module directly and
// read its exported broadcastVoteUpdate (falling back to a no-op, same
// fallback server.js uses), rather than inventing a new way to pass it
// in. routes/voting.js has no dependency on this file, so this isn't
// circular -- it's the same access pattern server.js uses, one layer
// down.
//
// Every query, transitionPeriod() argument, broadcast call, RBAC
// check, and response shape below is byte-for-byte identical to the
// original inline version (line endings normalized from CRLF to LF,
// matching the convention already used by every other route file
// created during this modularization).

const express = require('express');
const { pool } = require('../bootstrap/database');
const RBAC = require('../lib/rbac');
const { verifySession } = require('../lib/auth/session');
const { transitionPeriod } = require('../lib/period-engine');
const votingRouterModule = require('./voting');
const broadcastVoteUpdate = votingRouterModule.broadcastVoteUpdate || function () {};

const router = express.Router();

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
router.post('/api/period/next', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {

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
router.get('/api/voting-period', async (req, res) => {
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
router.post('/api/webhook', async (req, res) => {
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


module.exports = router;
