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
// These helpers read from a single req.user object — { id, role,
// adminCountyId, adminConstituencyId, adminWardId } when a session is
// present, or null otherwise — populated by the existing session
// middleware in server.js (same session-cookie → users.id → DB-lookup
// trust chain already used for req.wardId — see the comment block above
// that middleware). This module does not touch sessions, authentication,
// or that lookup itself; it only reads what the middleware attaches.
//
// Note: req.user's scope fields are named adminCountyId/adminConstituencyId/
// adminWardId, not the bare countyId/constituencyId/wardId — req.wardId is
// a separate, already-widely-used field elsewhere in this codebase (the
// ward a user votes in), and an admin's administered ward isn't guaranteed
// to be the same ward, so the admin-scope fields are deliberately
// prefixed to avoid confusion with it.
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
    if (req.user && req.user.role === role) return next();
    return res.status(403).json({ success: false, error: 'Forbidden' });
  };
}

// Match any of a list of roles. Example: requireAnyRole([ROLES.SUPER_ADMIN, ROLES.COUNTY_ADMIN])
function requireAnyRole(roles) {
  return function (req, res, next) {
    if (req.user && Array.isArray(roles) && roles.includes(req.user.role)) return next();
    return res.status(403).json({ success: false, error: 'Forbidden' });
  };
}

// Hierarchy-aware "at least this level". Example: requireMinRole(ROLES.WARD_ADMIN)
// admits WARD_ADMIN, CONSTITUENCY_ADMIN, COUNTY_ADMIN, and SUPER_ADMIN.
function requireMinRole(role) {
  const threshold = rankOf(role);
  return function (req, res, next) {
    if (req.user && rankOf(req.user.role) >= threshold) return next();
    return res.status(403).json({ success: false, error: 'Forbidden' });
  };
}

// ── Scope-aware permission check (plain helper, not middleware) ─────────
// For future phases that need "is this user allowed to act on THIS
// specific county/constituency/ward", not just "do they hold this role
// at all". Reads req.user (already populated by the existing session
// middleware — see header comment above).
//
// Usage sketch for a later phase:
//   if (!hasPermission(req, { role: ROLES.WARD_ADMIN, wardId: targetWardId })) { ... }
// (the third argument's wardId/countyId/constituencyId here describe the
// geography being acted ON, and are matched against req.user's
// adminWardId/adminCountyId/adminConstituencyId internally.)
function hasPermission(req, { role, countyId, constituencyId, wardId } = {}) {
  const user = req && req.user;
  if (!user || !user.role) return false;

  // SUPER_ADMIN passes every check regardless of requested scope.
  if (user.role === ROLES.SUPER_ADMIN) return true;

  // Caller's role must meet the requested minimum level, if one was given.
  if (role && rankOf(user.role) < rankOf(role)) return false;

  // If a specific geographic scope was requested, the caller's own admin
  // scope (attached to req.user by the session middleware) must match it.
  if (countyId != null       && user.adminCountyId       !== countyId)       return false;
  if (constituencyId != null && user.adminConstituencyId !== constituencyId) return false;
  if (wardId != null         && user.adminWardId         !== wardId)         return false;

  return true;
}

// ── Read-side scope resolution (Phase 4A.4) ─────────────────────────────
// Write-side authorization (hasPermission, above) answers "is this user
// allowed to write to THIS specific ward/constituency/county". These two
// helpers answer the read-side question instead: "which records is this
// user allowed to see AT ALL", used by admin listing endpoints to build a
// WHERE clause rather than a single accept/reject decision.

// Resolves which geographic level (if any) a user's reads should be
// restricted to. SUPER_ADMIN resolves to 'global' because it's authorized
// to see everything by design. MODERATOR also resolves to 'global' — not
// because it's been granted broad access, but because MODERATOR carries
// no geographic scope at all in this architecture (see the ROLE_RANK
// comment above): validateAdminScope() in server.js rejects any
// county/constituency/ward assignment for MODERATOR, the same as
// SUPER_ADMIN. There is no ward/constituency/county value to restrict a
// MODERATOR's reads to, so global is the only behavior available without
// inventing a scope concept that doesn't otherwise exist for this role —
// this is documented, not chosen for convenience.
function resolveReadScope(user) {
  if (!user) return { level: 'none' };
  switch (user.role) {
    case ROLES.SUPER_ADMIN:
    case ROLES.MODERATOR:
      return { level: 'global' };
    case ROLES.COUNTY_ADMIN:
      return { level: 'county', id: user.adminCountyId };
    case ROLES.CONSTITUENCY_ADMIN:
      return { level: 'constituency', id: user.adminConstituencyId };
    case ROLES.WARD_ADMIN:
      return { level: 'ward', id: user.adminWardId };
    default:
      // VOTER, or any unrecognized value — routes calling this are
      // already gated by requireMinRole/requireRole so a VOTER should
      // never reach this code, but 'none' fails safe (zero rows) rather
      // than assuming 'global' if that assumption is ever wrong.
      return { level: 'none' };
  }
}

// Turns a resolveReadScope() result into a bound SQL WHERE fragment,
// given the column reference valid for each level in the caller's own
// FROM/JOIN structure (only supply the ones your query actually joins to
// — e.g. a query with no county join can still pass `county: undefined`).
// Appends the parameter to a copy of existingParams (does not mutate the
// array passed in) so callers can build clause/params incrementally
// alongside their own filters (e.g. an existing category or search term).
//
// Returns { clause, params }:
//   - level 'global'                       -> clause '' (append nothing)
//   - level 'none', or no matching column   -> clause '1 = 0' (fail safe:
//     no rows, never "no filter" — an unavailable column for the scope's
//     level is treated the same as having no access, not full access)
//   - otherwise                             -> `${columnRef} = $N`
function buildScopeFilter(scope, columns, existingParams) {
  const params = (existingParams || []).slice();
  if (!scope || scope.level === 'global') return { clause: '', params };
  if (scope.level === 'none') return { clause: '1 = 0', params };

  const columnRef = columns && columns[scope.level];
  if (!columnRef || scope.id == null) return { clause: '1 = 0', params };

  params.push(scope.id);
  return { clause: `${columnRef} = $${params.length}`, params };
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
  resolveReadScope,
  buildScopeFilter,
};