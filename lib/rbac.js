// ══════════════════════════════════════════════════════════════════════
// lib/rbac.js — Phase 4A.1: RBAC Foundation (authorization infrastructure)
// ══════════════════════════════════════════════════════════════════════
// Defines the role model and reusable authorization helpers for the
// County → Constituency → Ward architecture.
//
// PHASE 4A.1 SCOPE — foundation only:
//   • Nothing exported here is attached to any route yet.
//   • No endpoint behavior changes as a result of this file existing.
//   • Wiring these into routes (protecting admin APIs) is Phase 4A.2.
//
// These helpers read from req.userId / req.userRole / req.adminScope,
// which are populated by the existing session middleware in server.js
// (same session-cookie → users.id → DB-lookup trust chain already used
// for req.wardId — see the comment block above that middleware). This
// module does not touch sessions, authentication, or that lookup itself;
// it only reads what the middleware already attaches to req.
// ══════════════════════════════════════════════════════════════════════

const ROLES = Object.freeze({
  SUPER_ADMIN:        'SUPER_ADMIN',
  COUNTY_ADMIN:       'COUNTY_ADMIN',
  CONSTITUENCY_ADMIN: 'CONSTITUENCY_ADMIN',
  WARD_ADMIN:         'WARD_ADMIN',
  MODERATOR:          'MODERATOR',
  VOTER:              'VOTER',
});

const VALID_ROLES = Object.freeze(Object.values(ROLES));

// Linear rank for "at least this level" checks (requireMinRole / hasPermission).
// MODERATOR is a content-permission tier rather than a geographic authority
// level, but still needs a rank relative to VOTER and the admin roles —
// placed above VOTER, below WARD_ADMIN. Future phases can layer finer,
// non-hierarchical permission logic on top without changing this order.
const ROLE_RANK = Object.freeze({
  [ROLES.SUPER_ADMIN]:        100,
  [ROLES.COUNTY_ADMIN]:        80,
  [ROLES.CONSTITUENCY_ADMIN]:  60,
  [ROLES.WARD_ADMIN]:          40,
  [ROLES.MODERATOR]:           20,
  [ROLES.VOTER]:                0,
});

function isValidRole(role) {
  return VALID_ROLES.includes(role);
}

// Unknown/missing role ranks below VOTER so it never accidentally passes
// a requireMinRole(VOTER) check.
function rankOf(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, role) ? ROLE_RANK[role] : -1;
}

// ── Middleware factories ────────────────────────────────────────────────
// None of these are attached to any route in this phase — they are
// exported for Phase 4A.2 to apply to specific admin routes.

// Exact-role match. Example: requireRole(ROLES.SUPER_ADMIN)
function requireRole(role) {
  return function (req, res, next) {
    if (req.userRole === role) return next();
    return res.status(403).json({ success: false, error: 'Forbidden' });
  };
}

// Match any of a list of roles. Example: requireAnyRole([ROLES.SUPER_ADMIN, ROLES.COUNTY_ADMIN])
function requireAnyRole(roles) {
  return function (req, res, next) {
    if (Array.isArray(roles) && roles.includes(req.userRole)) return next();
    return res.status(403).json({ success: false, error: 'Forbidden' });
  };
}

// Hierarchy-aware "at least this level". Example: requireMinRole(ROLES.WARD_ADMIN)
// admits WARD_ADMIN, CONSTITUENCY_ADMIN, COUNTY_ADMIN, and SUPER_ADMIN.
function requireMinRole(role) {
  const threshold = rankOf(role);
  return function (req, res, next) {
    if (rankOf(req.userRole) >= threshold) return next();
    return res.status(403).json({ success: false, error: 'Forbidden' });
  };
}

// ── Scope-aware permission check (plain helper, not middleware) ─────────
// For future phases that need "is this user allowed to act on THIS
// specific county/constituency/ward", not just "do they hold this role
// at all". Reads req.userRole and req.adminScope (already populated by
// the existing session middleware — see header comment above).
//
// Usage sketch for a later phase:
//   if (!hasPermission(req, { role: ROLES.WARD_ADMIN, wardId: targetWardId })) { ... }
function hasPermission(req, { role, countyId, constituencyId, wardId } = {}) {
  const userRole = req && req.userRole;
  if (!userRole) return false;

  // SUPER_ADMIN passes every check regardless of requested scope.
  if (userRole === ROLES.SUPER_ADMIN) return true;

  // Caller's role must meet the requested minimum level, if one was given.
  if (role && rankOf(userRole) < rankOf(role)) return false;

  // If a specific geographic scope was requested, the caller's own admin
  // scope (attached to req by the session middleware) must match it.
  const scope = (req && req.adminScope) || {};
  if (countyId != null       && scope.countyId       !== countyId)       return false;
  if (constituencyId != null && scope.constituencyId !== constituencyId) return false;
  if (wardId != null         && scope.wardId         !== wardId)         return false;

  return true;
}

module.exports = {
  ROLES,
  ROLE_RANK,
  VALID_ROLES,
  isValidRole,
  rankOf,
  requireRole,
  requireAnyRole,
  requireMinRole,
  hasPermission,
};