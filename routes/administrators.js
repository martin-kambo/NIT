// ──────────────────────────────────────────
// routes/administrators.js — Phase 4B.6: extracted verbatim from
// server.js. Administrator identity management (list, search, promote,
// demote, scope-patch) plus its two local helpers (validateAdminScope(),
// logAdminIdentityAction()). Confirmed (Phase 4B.3/4B.4 audits) to have
// zero dependency on requirePermission(), the static-data cache, or the
// founding-ward singleton -- every route here is gated with
// RBAC.requireRole(SUPER_ADMIN) directly, and reads req.user (set by the
// auth-context middleware in server.js, upstream of every router mount,
// same as every other extracted route file). Every query, validation
// rule, and status code below is byte-for-byte identical to the original
// inline version.

const express = require('express');
const { pool } = require('../bootstrap/database');
const RBAC = require('../lib/rbac');

const router = express.Router();

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
router.get('/api/admin/administrators', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
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
router.get('/api/admin/administrators/search', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
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
router.post('/api/admin/administrators/promote', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
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
router.post('/api/admin/administrators/demote', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
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
router.patch('/api/admin/administrators/:id/scope', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
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

module.exports = router;
