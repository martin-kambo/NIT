// lib/notice-scope.js
// Phase 4B.42: geographic scope for notices (PLATFORM, COUNTY, CONSTITUENCY, WARD).
//
// What lives here
//   * parseScopeInput()      shape-checks the scope fields of a create request (pure)
//   * resolveScopeTarget()   checks the named geography against the REAL tables and
//                            returns the normalised scope to store (reads the database)
//   * permissionFor()        the options for the existing RBAC check, per scope (pure)
//   * allowedScopeLevels()   which levels a caller may publish at, derived from that
//                            same RBAC check so the form and the server cannot disagree
//   * publicScopeClause()    the SQL predicate for the public feed (pure)
//   * UNLOCATED_VIEWER_CLAUSE the predicate for a viewer whose ward is unknown (pure)
//   * ADMIN_READ_COLUMNS     column references for RBAC.buildScopeFilter on the admin list
//
// What does NOT live here: authorization itself. Every permission decision is made by
// RBAC.hasPermission() (reached through RBAC.requirePermission() in the route), exactly as
// for every other write. lib/rbac.js is untouched. This module only says WHICH check to run.
//
// Scope model (columns on notices; see bootstrap/migrations.js ensureNoticeScopeColumns)
//   scope_level      NULL | PLATFORM | COUNTY | CONSTITUENCY | WARD
//   county_id        set only for COUNTY
//   constituency_id  set only for CONSTITUENCY
//   ward_id          set only for WARD (and, as before, for LEGACY rows)
//   NULL scope_level = LEGACY: created before this phase, or through a route that does not
//   name a scope. It keeps its old meaning (it belongs to ward_id) and is read by the old rule.
//
// Pure functions never throw for bad input; they return { ok: false, error } instead.

const RBAC = require('./rbac');
const { ROLES } = RBAC;

const SCOPE_LEVELS = Object.freeze({
  PLATFORM: 'PLATFORM',
  COUNTY: 'COUNTY',
  CONSTITUENCY: 'CONSTITUENCY',
  WARD: 'WARD',
});
const SCOPE_LEVEL_LIST = Object.freeze(Object.values(SCOPE_LEVELS));

// counties.id, constituencies.id and wards.id are 32-bit integers.
const MAX_GEO_ID = 2147483647;

const MESSAGES = Object.freeze({
  level: 'scopeLevel must be one of PLATFORM, COUNTY, CONSTITUENCY, WARD',
  levelRequired: 'scopeLevel is required when countyId or constituencyId is supplied',
  countyId: 'countyId must be a positive whole number',
  constituencyId: 'constituencyId must be a positive whole number',
  wardId: 'wardId must be a positive whole number',
  platformNoGeo: 'a PLATFORM notice must not name a county, constituency or ward',
  countyRequired: 'countyId is required for a COUNTY notice',
  countyOnly: 'a COUNTY notice must not name a constituency or ward',
  constituencyRequired: 'constituencyId is required for a CONSTITUENCY notice',
  constituencyOnly: 'a CONSTITUENCY notice must not name a ward',
  wardRequired: 'wardId is required for a WARD notice',
  noCounty: 'countyId does not match an existing county',
  noConstituency: 'constituencyId does not match an existing constituency',
  noWard: 'wardId does not match an existing ward',
  constituencyNotInCounty: 'constituencyId does not belong to the supplied countyId',
  wardNotInConstituency: 'wardId does not belong to the supplied constituencyId',
  wardNotInCounty: 'wardId does not belong to the supplied countyId',
});

const fail = (error) => ({ ok: false, error });

// A geographic id: a number or a canonical decimal string (no sign, no leading zero, no
// whitespace) from 1 to MAX_GEO_ID. Same rule as notice-validation.parseWardId. Omitted or
// null means "not named"; anything else that is not a valid id is an error (an empty string
// is a bad id, never "not named").
function parseGeoId(value, message) {
  if (value === undefined || value === null) return { ok: true, present: false };
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)) {
    n = Number(value);
  } else {
    return fail(message);
  }
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_GEO_ID) return fail(message);
  return { ok: true, present: true, id: n };
}

// Shape check of the scope fields of a create request body.
//   { ok:true, supplied:false }                no scopeLevel: the caller is using the legacy
//                                              payload (ward from wardId or the founding ward)
//   { ok:true, supplied:true, scope:{ level, countyId, constituencyId, wardId } }
//   { ok:false, error }
// A scope is only "supplied" by an explicit scopeLevel. countyId/constituencyId without one
// are rejected, because they would otherwise be silently ignored.
function parseScopeInput(body) {
  const src = body !== null && typeof body === 'object' ? body : {};
  const level = src.scopeLevel;

  if (level === undefined || level === null) {
    if (src.countyId !== undefined && src.countyId !== null) return fail(MESSAGES.levelRequired);
    if (src.constituencyId !== undefined && src.constituencyId !== null) return fail(MESSAGES.levelRequired);
    return { ok: true, supplied: false };
  }
  if (typeof level !== 'string' || !SCOPE_LEVEL_LIST.includes(level)) return fail(MESSAGES.level);

  const county = parseGeoId(src.countyId, MESSAGES.countyId);
  if (!county.ok) return county;
  const constituency = parseGeoId(src.constituencyId, MESSAGES.constituencyId);
  if (!constituency.ok) return constituency;
  const ward = parseGeoId(src.wardId, MESSAGES.wardId);
  if (!ward.ok) return ward;

  switch (level) {
    case SCOPE_LEVELS.PLATFORM:
      if (county.present || constituency.present || ward.present) return fail(MESSAGES.platformNoGeo);
      break;
    case SCOPE_LEVELS.COUNTY:
      if (!county.present) return fail(MESSAGES.countyRequired);
      if (constituency.present || ward.present) return fail(MESSAGES.countyOnly);
      break;
    case SCOPE_LEVELS.CONSTITUENCY:
      if (!constituency.present) return fail(MESSAGES.constituencyRequired);
      if (ward.present) return fail(MESSAGES.constituencyOnly);
      break;
    default: // WARD
      if (!ward.present) return fail(MESSAGES.wardRequired);
      break;
  }

  return {
    ok: true,
    supplied: true,
    scope: {
      level,
      countyId: county.present ? county.id : null,
      constituencyId: constituency.present ? constituency.id : null,
      wardId: ward.present ? ward.id : null,
    },
  };
}

// Checks the named geography against the real tables and returns the scope to STORE:
// { level, countyId, constituencyId, wardId } where only the id that belongs to the level is
// set (the others are null, as the CHECK constraint requires). Ancestors the caller named
// are verified against the actual parent relationship; a mismatch is rejected, never
// corrected. Nothing is inferred from names. Database errors are not caught here.
async function resolveScopeTarget(pool, scope) {
  const none = { countyId: null, constituencyId: null, wardId: null };

  if (scope.level === SCOPE_LEVELS.PLATFORM) {
    return { ok: true, scope: { level: scope.level, ...none } };
  }

  if (scope.level === SCOPE_LEVELS.COUNTY) {
    const r = await pool.query('SELECT id FROM counties WHERE id = $1', [scope.countyId]);
    if (!r.rows.length) return fail(MESSAGES.noCounty);
    return { ok: true, scope: { level: scope.level, ...none, countyId: r.rows[0].id } };
  }

  if (scope.level === SCOPE_LEVELS.CONSTITUENCY) {
    const r = await pool.query('SELECT id, county_id FROM constituencies WHERE id = $1', [scope.constituencyId]);
    if (!r.rows.length) return fail(MESSAGES.noConstituency);
    const row = r.rows[0];
    if (scope.countyId !== null && scope.countyId !== row.county_id) return fail(MESSAGES.constituencyNotInCounty);
    return { ok: true, scope: { level: scope.level, ...none, constituencyId: row.id } };
  }

  if (scope.level === SCOPE_LEVELS.WARD) {
    const r = await pool.query(
      `SELECT w.id, w.constituency_id, c.county_id
         FROM wards w
         JOIN constituencies c ON c.id = w.constituency_id
        WHERE w.id = $1`,
      [scope.wardId]
    );
    if (!r.rows.length) return fail(MESSAGES.noWard);
    const row = r.rows[0];
    if (scope.constituencyId !== null && scope.constituencyId !== row.constituency_id) return fail(MESSAGES.wardNotInConstituency);
    if (scope.countyId !== null && scope.countyId !== row.county_id) return fail(MESSAGES.wardNotInCounty);
    return { ok: true, scope: { level: scope.level, ...none, wardId: row.id } };
  }

  return fail(MESSAGES.level);
}

// The options for RBAC.requirePermission()/hasPermission() that authorize publishing,
// editing or deleting a notice AT this scope. Returns null for an unknown level (the caller
// must treat null as "refuse").
//   PLATFORM      SUPER_ADMIN only.
//   COUNTY        a COUNTY_ADMIN (or higher) assigned to exactly that county.
//   CONSTITUENCY  a CONSTITUENCY_ADMIN (or higher) assigned to exactly that constituency.
//   WARD          a WARD_ADMIN (or higher) assigned to exactly that ward.
// hasPermission() lets SUPER_ADMIN through everything and otherwise compares the caller's
// own assignment for exact equality, so a county administrator is NOT thereby allowed to
// publish for a constituency or ward inside the county (the existing, narrower policy is
// kept). The minimum role is named in every case so a MODERATOR can never pass, even if a
// geographic assignment were ever written onto a moderator row.
function permissionFor(scope) {
  if (!scope) return null;
  switch (scope.level) {
    case SCOPE_LEVELS.PLATFORM: return { role: ROLES.SUPER_ADMIN };
    case SCOPE_LEVELS.COUNTY: return { role: ROLES.COUNTY_ADMIN, countyId: scope.countyId };
    case SCOPE_LEVELS.CONSTITUENCY: return { role: ROLES.CONSTITUENCY_ADMIN, constituencyId: scope.constituencyId };
    case SCOPE_LEVELS.WARD: return { role: ROLES.WARD_ADMIN, wardId: scope.wardId };
    default: return null;
  }
}

// Which levels the caller may publish at. Derived from hasPermission() itself (testing each
// level against the caller's OWN assignment) so this can never promise more than the server
// allows. SUPER_ADMIN: all four. A county / constituency / ward administrator: their own
// level only. MODERATOR, VOTER, anonymous and unknown roles: none.
function allowedScopeLevels(req) {
  const user = req && req.user;
  if (!user || !user.role) return [];
  const levels = [];
  if (RBAC.hasPermission(req, permissionFor({ level: SCOPE_LEVELS.PLATFORM }))) levels.push(SCOPE_LEVELS.PLATFORM);
  const isSuper = user.role === ROLES.SUPER_ADMIN;
  if (isSuper || (user.adminCountyId != null &&
    RBAC.hasPermission(req, permissionFor({ level: SCOPE_LEVELS.COUNTY, countyId: user.adminCountyId })))) {
    levels.push(SCOPE_LEVELS.COUNTY);
  }
  if (isSuper || (user.adminConstituencyId != null &&
    RBAC.hasPermission(req, permissionFor({ level: SCOPE_LEVELS.CONSTITUENCY, constituencyId: user.adminConstituencyId })))) {
    levels.push(SCOPE_LEVELS.CONSTITUENCY);
  }
  if (isSuper || (user.adminWardId != null &&
    RBAC.hasPermission(req, permissionFor({ level: SCOPE_LEVELS.WARD, wardId: user.adminWardId })))) {
    levels.push(SCOPE_LEVELS.WARD);
  }
  return levels;
}

// The public-feed predicate, to be ANDed with the expiry / archive / category filters.
// `p` is the 1-based position of the VIEWER'S WARD parameter in the query. The viewer's
// constituency and county are derived inside the statement from that ward through the real
// wards -> constituencies relationship, so the only input is the ward the server itself
// attached to the request (users.ward_id, or the founding ward for a visitor with no
// session); nothing the client sends takes part.
//   LEGACY (NULL scope)  the old rule: the notice's ward is the viewer's ward
//   WARD                 same, for an explicit ward notice
//   CONSTITUENCY         the notice's constituency is the viewer's constituency
//   COUNTY               the notice's county is the viewer's county
//   PLATFORM             always applicable
// A scope_level that is none of these (impossible under the CHECK constraint) matches nothing.
function publicScopeClause(p) {
  const w = `$${p}`;
  return `(
        (scope_level IS NULL AND ward_id = ${w})
     OR (scope_level = 'WARD' AND ward_id = ${w})
     OR (scope_level = 'CONSTITUENCY' AND constituency_id = (SELECT wv.constituency_id FROM wards wv WHERE wv.id = ${w}))
     OR (scope_level = 'COUNTY' AND county_id = (SELECT cv.county_id FROM wards wv JOIN constituencies cv ON cv.id = wv.constituency_id WHERE wv.id = ${w}))
     OR scope_level = 'PLATFORM'
  )`;
}

// The predicate for a viewer whose ward could not be determined at all (req.wardId is null: no
// usable session AND no founding ward resolved). LEGACY notices (scope_level NULL) stay
// unfiltered, as they always were; PLATFORM notices apply to everyone; a COUNTY / CONSTITUENCY /
// WARD notice needs the viewer's location to be matched, so it is not shown.
const UNLOCATED_VIEWER_CLAUSE = "(scope_level IS NULL OR scope_level = 'PLATFORM')";

// Column references for RBAC.buildScopeFilter() on the admin list. The list joins
// wards w (via n.ward_id) and constituencies con (via the notice's effective constituency:
// the ward's, or the notice's own for a CONSTITUENCY notice). A county administrator therefore
// sees COUNTY notices of their county and every constituency / ward notice inside it, a
// constituency administrator sees their constituency's notices and its wards', and a ward
// administrator sees notices of their ward. PLATFORM notices are not part of a scoped
// administrator's list; SUPER_ADMIN and MODERATOR read globally (RBAC.resolveReadScope).
const ADMIN_READ_COLUMNS = Object.freeze({
  ward: 'n.ward_id',
  constituency: 'con.id',
  county: 'COALESCE(con.county_id, n.county_id)',
});

module.exports = {
  SCOPE_LEVELS,
  SCOPE_LEVEL_LIST,
  MAX_GEO_ID,
  MESSAGES,
  parseScopeInput,
  resolveScopeTarget,
  permissionFor,
  allowedScopeLevels,
  publicScopeClause,
  UNLOCATED_VIEWER_CLAUSE,
  ADMIN_READ_COLUMNS,
};
