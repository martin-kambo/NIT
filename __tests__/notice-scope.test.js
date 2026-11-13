'use strict';

// ============================================================================
// Notice geographic scope tests — Phase 4B.42 (isolated harness)
// ============================================================================
// Same approach as __tests__/notices.test.js: the REAL routes/notices.js router
// (with the real lib/rbac.js, lib/notices.js, lib/notice-scope.js) is mounted on a
// test-only Express app, the database is an in-memory fake that records every
// statement and FAILS CLOSED on any SQL nobody registered, and a test-only
// middleware stands in for the session middleware of server.js (it sets req.user /
// req.wardId from the x-test-persona / x-test-ward-id headers).
//
// WHAT THIS FILE PROVES
//   * lib/notice-scope.js: request shape rules, the permission each scope needs, the
//     levels each persona may offer, the public-feed predicate text.
//   * POST /api/admin/notices with a scope: every administrator role against every
//     scope (own and foreign), invalid geography, payload tricks, nothing is written
//     before every check has passed.
//   * PUT / DELETE on scoped and legacy notices: who may touch what; the scope is
//     immutable through PUT.
//   * GET /api/notices: the scope predicate is added, bound to the VIEWER'S ward as the
//     session middleware set it (never to anything the client sent); expiry, archive and
//     category filters are still applied; the ad query and the response array are unchanged.
//   * GET /api/admin/notices and GET /api/admin/notice-scope-options.
//   * bootstrap/migrations.js ensureNoticeScopeColumns(): only additive, idempotent
//     statements; nothing reads, rewrites or deletes a row. (Phase 4B.44: they run inside one
//     transaction on one pool client; the readiness inspection around them is stubbed here and is
//     tested for real in __tests__/notice-scope-readiness.test.js.)
//
// WHAT IT CANNOT PROVE
//   The fake database records SQL text and bound parameters; it does not evaluate
//   predicates. Whether the public predicate returns the right ROWS, whether the CHECK
//   and foreign-key constraints reject contradictory rows, and whether the migration is
//   idempotent on a real server were run against a disposable PostgreSQL 16 (see the
//   Phase 4B.42 report and evidence folder); none of that is exercised by this file.
//   Hierarchy fixtures below are synthetic (ids 1 and 10 mirror the production shape
//   described in 4B.41: ward 1 'Ngoliba' under Juja, ward 10 'Ngoliba' under Thika Town).
// ============================================================================

const express = require('express');
const request = require('supertest');

// ───────────────────────── Fake database ──────────────────────────────────

const squash = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const rows = (...r) => ({ rows: r });

function createFakeDb() {
  let rules = [];
  const calls = [];
  const unexpected = [];
  const released = []; // Phase 4B.44: 'released' | 'destroyed' per client returned to the pool
  const direct = [];   // statements sent straight to pool.query (not through a checked-out client)

  async function query(sql, params) {
    const text = squash(sql);
    const values = params === undefined ? [] : params;
    calls.push({ sql: text, params: values });
    const rule = rules.find((r) => r.pattern.test(text));
    if (!rule) {
      unexpected.push(text);
      throw new Error(`UNEXPECTED QUERY (no fake registered): ${text.slice(0, 160)}`);
    }
    return rule.respond(text, values);
  }

  const client = { query, release: (arg) => { released.push(arg === true ? 'destroyed' : 'released'); } };

  return {
    pool: {
      query: (sql, params) => { direct.push(squash(sql)); return query(sql, params); },
      connect: async () => client,
    },
    calls,
    unexpected,
    released,
    direct,
    on(pattern, respond) {
      rules.unshift({ pattern, respond: typeof respond === 'function' ? respond : async () => respond });
    },
    reset() {
      rules = [];
      calls.length = 0;
      unexpected.length = 0;
      released.length = 0;
      direct.length = 0;
    },
    writes() {
      return calls.filter((c) => /^(INSERT|UPDATE|DELETE)\b/.test(c.sql));
    },
  };
}

const SQL = {
  listNotices: /^SELECT id, title, content, category, priority, created_at, expires_at, NULL AS contact_phone, NULL AS business_name, false AS is_ad FROM notices WHERE /,
  listAds: /^SELECT id, business_name AS title, ad_content AS content, .* FROM ad_requests WHERE status = 'approved'/,
  adminList: /^SELECT n\.\*, w\.name AS ward_name, con\.name AS constituency_name, cty\.name AS county_name FROM notices n LEFT JOIN wards w ON w\.id = n\.ward_id LEFT JOIN constituencies con ON con\.id = COALESCE\(w\.constituency_id, n\.constituency_id\) LEFT JOIN counties cty ON cty\.id = COALESCE\(con\.county_id, n\.county_id\) /,
  countyById: /^SELECT id FROM counties WHERE id = \$1$/,
  constituencyById: /^SELECT id, county_id FROM constituencies WHERE id = \$1$/,
  wardChain: /^SELECT w\.id, w\.constituency_id, c\.county_id FROM wards w JOIN constituencies c ON c\.id = w\.constituency_id WHERE w\.id = \$1$/,
  insertScoped: /^INSERT INTO notices \(title,content,category,priority,expires_at,created_by,scope_level,county_id,constituency_id,ward_id\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10\) RETURNING \*$/,
  insertLegacy: /^INSERT INTO notices \(title,content,category,priority,expires_at,created_by,ward_id\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7\) RETURNING \*$/,
  noticeScope: /^SELECT ward_id, category, scope_level, county_id, constituency_id FROM notices WHERE id = \$1$/,
  scopeOfNotice: /^SELECT ward_id, scope_level, county_id, constituency_id FROM notices WHERE id = \$1$/,
  update: /^UPDATE notices SET title = \$1, content = \$2, category = \$3, priority = \$4, expires_at = CASE WHEN \$7::boolean THEN \$5::timestamp ELSE expires_at END, updated_at = NOW\(\) WHERE id = \$6 AND \(\$3 <> \$8 OR category = \$8\) RETURNING \*$/,
  del: /^DELETE FROM notices WHERE id = \$1$/,
  optWard: /^SELECT w\.id, w\.name, c\.id AS constituency_id, c\.name AS constituency_name, k\.id AS county_id, k\.name AS county_name FROM wards w JOIN constituencies c ON c\.id = w\.constituency_id JOIN counties k ON k\.id = c\.county_id WHERE w\.id = \$1$/,
  optConstituency: /^SELECT c\.id, c\.name, k\.id AS county_id, k\.name AS county_name FROM constituencies c JOIN counties k ON k\.id = c\.county_id WHERE c\.id = \$1$/,
  optCounty: /^SELECT id, name FROM counties WHERE id = \$1$/,
};

// ───────────────────────── Geography fixture ──────────────────────────────
// County 5 Kiambu: constituency 7 Thika Town (wards 10 Ngoliba, 11 Biashara) and
// constituency 8 Juja (ward 1 'Ngoliba' -- the legacy ward, same NAME as ward 10).
// County 6 Nairobi: constituency 9 Westlands (ward 13). The two 'Ngoliba' wards exist
// on purpose: nothing may be decided by name.

const GEO = {
  counties: { 5: 'Kiambu', 6: 'Nairobi' },
  constituencies: { 7: { county: 5, name: 'Thika Town' }, 8: { county: 5, name: 'Juja' }, 9: { county: 6, name: 'Westlands' } },
  wards: { 10: { con: 7, name: 'Ngoliba' }, 11: { con: 7, name: 'Biashara' }, 1: { con: 8, name: 'Ngoliba' }, 13: { con: 9, name: 'Parklands' } },
};

function stubGeography() {
  db.on(SQL.countyById, (_s, p) => (GEO.counties[p[0]] ? rows({ id: p[0] }) : rows()));
  db.on(SQL.constituencyById, (_s, p) => (GEO.constituencies[p[0]] ? rows({ id: p[0], county_id: GEO.constituencies[p[0]].county }) : rows()));
  db.on(SQL.wardChain, (_s, p) => {
    const w = GEO.wards[p[0]];
    return w ? rows({ id: p[0], constituency_id: w.con, county_id: GEO.constituencies[w.con].county }) : rows();
  });
}

function stubInsertScopedEcho() {
  db.on(SQL.insertScoped, (_s, p) => rows({
    id: 201, title: p[0], content: p[1], category: p[2], priority: p[3], expires_at: p[4], created_by: p[5],
    scope_level: p[6], county_id: p[7], constituency_id: p[8], ward_id: p[9],
  }));
}

// ───────────────────────── Personas ───────────────────────────────────────

const P = (id, role, county = null, constituency = null, ward = null) =>
  ({ id, role, adminCountyId: county, adminConstituencyId: constituency, adminWardId: ward });

const PERSONAS = {
  none: null,
  voter: P(11, 'VOTER'),
  moderator: P(12, 'MODERATOR'),
  // A MODERATOR row that (wrongly) carries a ward assignment: the role floor in every
  // scoped permission must still refuse it.
  moderatorAssigned: P(19, 'MODERATOR', 5, 7, 10),
  superAdmin: P(15, 'SUPER_ADMIN'),
  unknownRole: P(16, 'GUEST_EDITOR'),
  countyAdmin5: P(21, 'COUNTY_ADMIN', 5),
  countyAdmin6: P(22, 'COUNTY_ADMIN', 6),
  constituencyAdmin7: P(23, 'CONSTITUENCY_ADMIN', null, 7),
  constituencyAdmin8: P(24, 'CONSTITUENCY_ADMIN', null, 8),
  wardAdmin10: P(25, 'WARD_ADMIN', null, null, 10),
  wardAdmin11: P(26, 'WARD_ADMIN', null, null, 11),
  wardAdmin1: P(27, 'WARD_ADMIN', null, null, 1),
};

// ───────────────────────── Harness wiring ─────────────────────────────────

const FOUNDING_WARD = 10;

let db;
let wardCache;
let noticesRouter;
let NoticeScope;
let app;
let errSpy;

function buildApp(router) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    const persona = req.get('x-test-persona') || 'none';
    if (!Object.prototype.hasOwnProperty.call(PERSONAS, persona)) {
      return res.status(500).json({ harnessError: `unknown test persona: ${persona}` });
    }
    const p = PERSONAS[persona];
    req.user = p ? { ...p } : null;
    const w = req.get('x-test-ward-id');
    if (w === undefined) req.wardId = wardCache.getFoundingWardId();
    else req.wardId = w === 'none' ? null : parseInt(w, 10);
    next();
  });
  a.use(router);
  return a;
}

const api = (persona = 'none', wardId) => {
  const h = (r) => {
    r.set('x-test-persona', persona);
    if (wardId !== undefined) r.set('x-test-ward-id', String(wardId));
    return r;
  };
  return {
    get: (url) => h(request(app).get(url)),
    post: (url) => h(request(app).post(url)),
    put: (url) => h(request(app).put(url)),
    delete: (url) => h(request(app).delete(url)),
  };
};

beforeAll(() => {
  db = createFakeDb();
  jest.doMock('../bootstrap/database', () => ({
    pool: db.pool,
    testDBConnection: async () => { throw new Error('testDBConnection must not be called by notice tests'); },
  }));
  jest.doMock('pg', () => { throw new Error('the real pg driver must not be loaded by notice tests'); });
  jest.doMock('../server', () => { throw new Error('notice tests must never load server.js'); });
  jest.doMock('../bootstrap/startup', () => { throw new Error('notice tests must never load bootstrap/startup'); });

  wardCache = require('../lib/ward-cache');
  NoticeScope = require('../lib/notice-scope');
  noticesRouter = require('../routes/notices');
  app = buildApp(noticesRouter);
});

afterAll(() => {
  if (wardCache) wardCache.setFoundingWardId(null);
});

beforeEach(() => {
  db.reset();
  wardCache.setFoundingWardId(FOUNDING_WARD);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  const loggedErrors = errSpy.mock.calls.slice();
  errSpy.mockRestore();
  expect(db.unexpected).toEqual([]);
  expect(loggedErrors).toEqual([]);
});

const BODY = {
  title: 'Community clean-up day',
  content: 'Join us on Saturday at the market.',
  category: 'event',
  priority: 'normal',
  expiresAt: '2030-01-01T00:00:00.000Z',
};
const UPDATE_BODY = {
  title: 'Updated Notice Title',
  content: 'Updated content for the notice.',
  category: 'public',
  priority: 'high',
  expiresAt: '2031-01-01T00:00:00.000Z',
};

// ============================================================================
// lib/notice-scope.js — pure functions
// ============================================================================

describe('parseScopeInput', () => {
  const ok = (body) => NoticeScope.parseScopeInput(body);

  test('no scopeLevel and no scope ids: the legacy payload (not "supplied")', () => {
    expect(ok({})).toEqual({ ok: true, supplied: false });
    expect(ok({ wardId: 10 })).toEqual({ ok: true, supplied: false });
    expect(ok(undefined)).toEqual({ ok: true, supplied: false });
    expect(ok(null)).toEqual({ ok: true, supplied: false });
    expect(ok({ scopeLevel: null })).toEqual({ ok: true, supplied: false });
  });

  test('each level accepts exactly its own shape', () => {
    expect(ok({ scopeLevel: 'PLATFORM' })).toEqual({ ok: true, supplied: true, scope: { level: 'PLATFORM', countyId: null, constituencyId: null, wardId: null } });
    expect(ok({ scopeLevel: 'COUNTY', countyId: 5 }).scope).toEqual({ level: 'COUNTY', countyId: 5, constituencyId: null, wardId: null });
    expect(ok({ scopeLevel: 'CONSTITUENCY', constituencyId: 7 }).scope).toEqual({ level: 'CONSTITUENCY', countyId: null, constituencyId: 7, wardId: null });
    expect(ok({ scopeLevel: 'WARD', wardId: 10 }).scope).toEqual({ level: 'WARD', countyId: null, constituencyId: null, wardId: 10 });
  });

  test('ancestors may be named (they are verified later against the real tables)', () => {
    expect(ok({ scopeLevel: 'CONSTITUENCY', countyId: 5, constituencyId: 7 }).scope).toEqual({ level: 'CONSTITUENCY', countyId: 5, constituencyId: 7, wardId: null });
    expect(ok({ scopeLevel: 'WARD', countyId: 5, constituencyId: 7, wardId: 10 }).scope).toEqual({ level: 'WARD', countyId: 5, constituencyId: 7, wardId: 10 });
  });

  test('canonical numeric strings are accepted as numbers', () => {
    expect(ok({ scopeLevel: 'WARD', wardId: '10' }).scope.wardId).toBe(10);
    expect(ok({ scopeLevel: 'COUNTY', countyId: '5' }).scope.countyId).toBe(5);
  });

  test('the level must be one of the four, in upper case', () => {
    ['platform', 'Ward', 'COUNTRY', '', ' WARD', 'WARD ', 'ALL', 0, 1, true, [], {}, ['WARD']].forEach((bad) => {
      const r = ok({ scopeLevel: bad, wardId: 10 });
      expect({ bad, ok: r.ok }).toEqual({ bad, ok: false });
    });
  });

  test('contradictory combinations are rejected', () => {
    const bad = [
      { scopeLevel: 'PLATFORM', countyId: 5 },
      { scopeLevel: 'PLATFORM', constituencyId: 7 },
      { scopeLevel: 'PLATFORM', wardId: 10 },
      { scopeLevel: 'COUNTY' },
      { scopeLevel: 'COUNTY', countyId: 5, constituencyId: 7 },
      { scopeLevel: 'COUNTY', countyId: 5, wardId: 10 },
      { scopeLevel: 'CONSTITUENCY' },
      { scopeLevel: 'CONSTITUENCY', countyId: 5 },
      { scopeLevel: 'CONSTITUENCY', constituencyId: 7, wardId: 10 },
      { scopeLevel: 'WARD' },
      { scopeLevel: 'WARD', countyId: 5 },
      { scopeLevel: 'WARD', constituencyId: 7 },
    ];
    bad.forEach((b) => {
      const r = ok(b);
      expect({ b, ok: r.ok }).toEqual({ b, ok: false });
      expect(typeof r.error).toBe('string');
    });
  });

  test('scope ids without a scopeLevel are rejected, never silently ignored', () => {
    expect(ok({ countyId: 5 }).ok).toBe(false);
    expect(ok({ constituencyId: 7 }).ok).toBe(false);
  });

  test('ids must be canonical positive 32-bit integers', () => {
    ['0', '-1', '007', '1.5', ' 5', '5 ', '5e1', '0x10', 'abc', '', 0, -1, 1.5, NaN, Infinity, 2147483648, '2147483648', true, [5], { id: 5 }].forEach((bad) => {
      const r = ok({ scopeLevel: 'WARD', wardId: bad });
      expect({ bad: String(bad), ok: r.ok }).toEqual({ bad: String(bad), ok: false });
    });
    expect(ok({ scopeLevel: 'WARD', wardId: 2147483647 }).ok).toBe(true);
  });

  test('geographic names are not ids: a name alone names nothing', () => {
    expect(ok({ scopeLevel: 'WARD', wardName: 'Ngoliba' }).ok).toBe(false);
    expect(ok({ scopeLevel: 'COUNTY', countyName: 'Kiambu' }).ok).toBe(false);
    expect(ok({ scopeLevel: 'WARD', wardId: 'Ngoliba' }).ok).toBe(false);
  });
});

describe('permissionFor', () => {
  test('one permission per level, naming the minimum role and exactly the one entity', () => {
    expect(NoticeScope.permissionFor({ level: 'PLATFORM' })).toEqual({ role: 'SUPER_ADMIN' });
    expect(NoticeScope.permissionFor({ level: 'COUNTY', countyId: 5 })).toEqual({ role: 'COUNTY_ADMIN', countyId: 5 });
    expect(NoticeScope.permissionFor({ level: 'CONSTITUENCY', constituencyId: 7 })).toEqual({ role: 'CONSTITUENCY_ADMIN', constituencyId: 7 });
    expect(NoticeScope.permissionFor({ level: 'WARD', wardId: 10 })).toEqual({ role: 'WARD_ADMIN', wardId: 10 });
  });

  test('an unknown level or no scope yields null (the caller refuses)', () => {
    expect(NoticeScope.permissionFor({ level: 'COUNTRY' })).toBe(null);
    expect(NoticeScope.permissionFor({})).toBe(null);
    expect(NoticeScope.permissionFor(null)).toBe(null);
    expect(NoticeScope.permissionFor(undefined)).toBe(null);
  });
});

describe('allowedScopeLevels (what the form may offer; derived from the RBAC check itself)', () => {
  const levels = (persona) => NoticeScope.allowedScopeLevels({ user: PERSONAS[persona] });

  test('SUPER_ADMIN: all four', () => {
    expect(levels('superAdmin')).toEqual(['PLATFORM', 'COUNTY', 'CONSTITUENCY', 'WARD']);
  });
  test('COUNTY_ADMIN: county only (the existing exact-match policy)', () => {
    expect(levels('countyAdmin5')).toEqual(['COUNTY']);
  });
  test('CONSTITUENCY_ADMIN: constituency only', () => {
    expect(levels('constituencyAdmin7')).toEqual(['CONSTITUENCY']);
  });
  test('WARD_ADMIN: ward only', () => {
    expect(levels('wardAdmin10')).toEqual(['WARD']);
  });
  test('MODERATOR (even with an assignment on the row), VOTER, anonymous and unknown roles: none', () => {
    ['moderator', 'moderatorAssigned', 'voter', 'none', 'unknownRole'].forEach((p) => {
      expect({ p, levels: levels(p) }).toEqual({ p, levels: [] });
    });
    expect(NoticeScope.allowedScopeLevels(undefined)).toEqual([]);
    expect(NoticeScope.allowedScopeLevels({})).toEqual([]);
  });
  test('an administrator without an assignment is offered nothing', () => {
    expect(NoticeScope.allowedScopeLevels({ user: P(40, 'WARD_ADMIN') })).toEqual([]);
    expect(NoticeScope.allowedScopeLevels({ user: P(41, 'COUNTY_ADMIN') })).toEqual([]);
  });
});

describe('publicScopeClause', () => {
  test('binds only the viewer ward parameter, at the position given', () => {
    const c = NoticeScope.publicScopeClause(3);
    expect(c).toMatch(/\$3/);
    expect(c.replace(/\s+/g, ' ')).not.toMatch(/\$[124-9]/);
  });

  test('contains one branch per scope level plus the legacy rule', () => {
    const c = NoticeScope.publicScopeClause(1).replace(/\s+/g, ' ');
    expect(c).toContain("(scope_level IS NULL AND ward_id = $1)");
    expect(c).toContain("(scope_level = 'WARD' AND ward_id = $1)");
    expect(c).toContain("(scope_level = 'CONSTITUENCY' AND constituency_id = (SELECT wv.constituency_id FROM wards wv WHERE wv.id = $1))");
    expect(c).toContain("(scope_level = 'COUNTY' AND county_id = (SELECT cv.county_id FROM wards wv JOIN constituencies cv ON cv.id = wv.constituency_id WHERE wv.id = $1))");
    expect(c).toContain("OR scope_level = 'PLATFORM'");
  });

  test('the unlocated-viewer predicate admits only legacy and PLATFORM notices', () => {
    expect(NoticeScope.UNLOCATED_VIEWER_CLAUSE).toBe("(scope_level IS NULL OR scope_level = 'PLATFORM')");
  });

  test('PLATFORM is not tied to any ward, constituency, county or the founding ward', () => {
    const c = NoticeScope.publicScopeClause(1).replace(/\s+/g, ' ');
    const platformBranch = c.slice(c.indexOf("scope_level = 'PLATFORM'"));
    expect(platformBranch).not.toMatch(/ward_id|constituency_id|county_id|\$1/);
  });
});

// ============================================================================
// GET /api/notices — public feed
// ============================================================================

describe('GET /api/notices — geographic scope in the public feed', () => {
  const noticesCall = () => db.calls.find((c) => /^SELECT id, title, content, category, priority, created_at, expires_at, NULL AS contact_phone/.test(c.sql));
  const adsCall = () => db.calls.find((c) => /FROM ad_requests/.test(c.sql));
  const stubFeed = (notices = [], ads = []) => {
    db.on(SQL.listNotices, rows(...notices));
    db.on(SQL.listAds, rows(...ads));
  };

  test('the scope predicate is ANDed with the expiry and archive filters, bound to the viewer ward', async () => {
    stubFeed();
    const res = await api('voter', 10).get('/api/notices');
    expect(res.status).toBe(200);
    const q = noticesCall();
    expect(q.params).toEqual([10]);
    expect(q.sql).toContain('(expires_at IS NULL OR expires_at > NOW()) AND COALESCE(is_archived, false) = false AND (');
    expect(q.sql).toContain("(scope_level IS NULL AND ward_id = $1)");
    expect(q.sql).toContain("scope_level = 'COUNTY' AND county_id = (SELECT cv.county_id FROM wards wv JOIN constituencies cv ON cv.id = wv.constituency_id WHERE wv.id = $1)");
    expect(q.sql).toContain("scope_level = 'CONSTITUENCY' AND constituency_id = (SELECT wv.constituency_id FROM wards wv WHERE wv.id = $1)");
    expect(q.sql).toContain("OR scope_level = 'PLATFORM'");
  });

  test('expiry and archive filtering are not replaced by the scope predicate', async () => {
    stubFeed();
    await api('voter', 10).get('/api/notices');
    const q = noticesCall();
    // the two filters come first and are joined to the predicate with AND, never OR
    expect(q.sql).toMatch(/WHERE \(expires_at IS NULL OR expires_at > NOW\(\)\) AND COALESCE\(is_archived, false\) = false AND \(/);
  });

  test('the category filter keeps its parameter; the viewer ward is the next one', async () => {
    stubFeed();
    await api('voter', 10).get('/api/notices?cat=event');
    const q = noticesCall();
    expect(q.params).toEqual(['event', 10]);
    expect(q.sql).toContain('AND category = $1 AND (');
    expect(q.sql).toContain("(scope_level IS NULL AND ward_id = $2)");
    expect(q.sql).not.toMatch(/\$3/);
  });

  test('a logged-in viewer is placed by the ward the session middleware attached', async () => {
    stubFeed();
    await api('voter', 11).get('/api/notices');
    expect(noticesCall().params).toEqual([11]);
  });

  test('a visitor with no session is placed by the founding ward (the existing policy), nothing else', async () => {
    stubFeed();
    const res = await api('none').get('/api/notices');
    expect(res.status).toBe(200);
    expect(noticesCall().params).toEqual([FOUNDING_WARD]);
  });

  test('nothing the client sends can change the viewer geography', async () => {
    stubFeed();
    await request(app)
      .get('/api/notices?wardId=1&countyId=6&constituencyId=9&scope=PLATFORM&scopeLevel=COUNTY&ward_id=13')
      .set('x-test-persona', 'voter')
      .set('x-test-ward-id', '10')
      .set('x-ward-id', '1')
      .set('x-county-id', '6')
      .send({ wardId: 1, countyId: 6 });
    expect(noticesCall().params).toEqual([10]);
    expect(noticesCall().sql).not.toMatch(/\$2/);
  });

  test('when no ward is known at all: legacy notices stay unfiltered as before, PLATFORM applies, no geographic scope is matched', async () => {
    stubFeed();
    await api('none', 'none').get('/api/notices');
    const q = noticesCall();
    expect(q.params).toEqual([]);
    expect(q.sql).toContain("AND (scope_level IS NULL OR scope_level = 'PLATFORM')");
    expect(q.sql).not.toContain('ward_id');
    expect(q.sql).not.toMatch(/'(COUNTY|CONSTITUENCY|WARD)'/);
    expect(q.sql).toContain('(expires_at IS NULL OR expires_at > NOW()) AND COALESCE(is_archived, false) = false');
  });

  test('advertisements: the ad query is separate, has no scope predicate and keeps its own parameters', async () => {
    stubFeed();
    await api('voter', 10).get('/api/notices');
    expect(adsCall().sql).not.toMatch(/scope_level|county_id|constituency_id|ward_id|wardId/);
    expect(adsCall().params).toEqual([]);

    db.reset();
    stubFeed();
    await api('voter', 10).get('/api/notices?cat=business');
    expect(adsCall().params).toEqual(['business']);
    expect(adsCall().sql).not.toMatch(/scope_level|county_id|constituency_id|ward_id/);
  });

  test('the response is still one array: notices then ads merged by priority and date, with the same row shape', async () => {
    const notice = {
      id: 1, title: 'Platform notice', content: 'For everyone.', category: 'public', priority: 'normal',
      created_at: '2026-05-01T08:00:00.000Z', expires_at: null, contact_phone: null, business_name: null, is_ad: false,
    };
    const ad = {
      id: 'b1a5c0de-0000-4000-8000-000000000001', title: 'Hardware', content: 'Cement.', category: 'business', priority: 'normal',
      created_at: '2026-05-02T08:00:00.000Z', expires_at: null, contact_phone: '0712345678', business_name: 'Hardware', is_ad: true,
    };
    stubFeed([notice], [ad]);
    const res = await api('voter', 10).get('/api/notices');
    expect(res.body).toEqual({ success: true, notices: [ad, notice] });
    expect(Object.keys(res.body.notices[1]).sort()).toEqual(Object.keys(notice).sort());
  });

  test('the notice query selects no new columns (the response contract with notice-board.html is unchanged)', async () => {
    stubFeed();
    await api('voter', 10).get('/api/notices');
    expect(noticesCall().sql).toMatch(/^SELECT id, title, content, category, priority, created_at, expires_at, NULL AS contact_phone, NULL AS business_name, false AS is_ad FROM notices WHERE /);
  });

  test('a database failure is still a 500 with the same body shape', async () => {
    db.on(SQL.listNotices, async () => { throw new Error('boom'); });
    db.on(SQL.listAds, rows());
    const res = await api('voter', 10).get('/api/notices');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.notices).toEqual([]);
    errSpy.mockClear();
  });
});

// ============================================================================
// POST /api/admin/notices — scoped create
// ============================================================================

describe('POST /api/admin/notices — scoped create: authorization matrix', () => {
  const REQUESTS = {
    PLATFORM: { scopeLevel: 'PLATFORM' },
    COUNTY_5: { scopeLevel: 'COUNTY', countyId: 5 },
    COUNTY_6: { scopeLevel: 'COUNTY', countyId: 6 },
    CONSTITUENCY_7: { scopeLevel: 'CONSTITUENCY', constituencyId: 7 },
    CONSTITUENCY_8: { scopeLevel: 'CONSTITUENCY', constituencyId: 8 },
    CONSTITUENCY_9: { scopeLevel: 'CONSTITUENCY', constituencyId: 9 },
    WARD_10: { scopeLevel: 'WARD', wardId: 10 },
    WARD_11: { scopeLevel: 'WARD', wardId: 11 },
    WARD_1: { scopeLevel: 'WARD', wardId: 1 },
    WARD_13: { scopeLevel: 'WARD', wardId: 13 },
  };
  const ALL = Object.keys(REQUESTS);

  // persona -> the requests it may make. Everything else must be refused with 403 and write nothing.
  const ALLOWED = {
    superAdmin: ALL,
    countyAdmin5: ['COUNTY_5'],
    countyAdmin6: ['COUNTY_6'],
    constituencyAdmin7: ['CONSTITUENCY_7'],
    constituencyAdmin8: ['CONSTITUENCY_8'],
    wardAdmin10: ['WARD_10'],
    wardAdmin11: ['WARD_11'],
    wardAdmin1: ['WARD_1'],
    moderator: [],
    moderatorAssigned: [],
  };

  Object.keys(ALLOWED).forEach((persona) => {
    test(`${persona}: may publish only at ${ALLOWED[persona].join(', ') || 'no scope'}`, async () => {
      const outcome = {};
      for (const key of ALL) {
        db.reset();
        stubGeography();
        stubInsertScopedEcho();
        const res = await api(persona).post('/api/admin/notices').send({ ...BODY, ...REQUESTS[key] });
        outcome[key] = { status: res.status, wrote: db.writes().length };
      }
      const expected = {};
      ALL.forEach((key) => {
        expected[key] = ALLOWED[persona].includes(key) ? { status: 200, wrote: 1 } : { status: 403, wrote: 0 };
      });
      expect(outcome).toEqual(expected);
    });
  });

  test('VOTER is refused by the role gate before anything is read or written', async () => {
    stubGeography();
    stubInsertScopedEcho();
    const res = await api('voter').post('/api/admin/notices').send({ ...BODY, ...REQUESTS.WARD_10 });
    expect(res.status).toBe(403);
    expect(db.calls).toEqual([]);
  });

  test('an unauthenticated request is refused (the existing role gate answers 403 for no session) before anything is read or written', async () => {
    stubGeography();
    stubInsertScopedEcho();
    const res = await api('none').post('/api/admin/notices').send({ ...BODY, ...REQUESTS.PLATFORM });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.calls).toEqual([]);
  });

  test('an unrecognised role is refused and nothing is written', async () => {
    stubGeography();
    stubInsertScopedEcho();
    const res = await api('unknownRole').post('/api/admin/notices').send({ ...BODY, ...REQUESTS.PLATFORM });
    expect(res.status).toBe(403);
    expect(db.calls).toEqual([]);
  });
});

describe('POST /api/admin/notices — scoped create: what is stored', () => {
  beforeEach(() => { stubGeography(); stubInsertScopedEcho(); });
  const insertParams = () => db.writes()[0].params;

  test('PLATFORM stores the level and no geography', async () => {
    const res = await api('superAdmin').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'PLATFORM' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(insertParams()).toEqual([BODY.title, BODY.content, 'event', 'normal', BODY.expiresAt, 'admin', 'PLATFORM', null, null, null]);
    expect(res.body.notice.scope_level).toBe('PLATFORM');
  });

  test('COUNTY / CONSTITUENCY / WARD store the level and only that level\'s id', async () => {
    await api('superAdmin').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'COUNTY', countyId: 5 });
    expect(insertParams().slice(6)).toEqual(['COUNTY', 5, null, null]);
    db.reset(); stubGeography(); stubInsertScopedEcho();
    await api('superAdmin').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'CONSTITUENCY', constituencyId: 7 });
    expect(insertParams().slice(6)).toEqual(['CONSTITUENCY', null, 7, null]);
    db.reset(); stubGeography(); stubInsertScopedEcho();
    await api('superAdmin').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'WARD', wardId: 10 });
    expect(insertParams().slice(6)).toEqual(['WARD', null, null, 10]);
  });

  test('verified ancestors are accepted but never stored on a lower-level notice', async () => {
    const res = await api('superAdmin').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'WARD', countyId: 5, constituencyId: 7, wardId: 10 });
    expect(res.status).toBe(200);
    expect(insertParams().slice(6)).toEqual(['WARD', null, null, 10]);
  });

  test('the creator is recorded as for every other create (admin); the category and priority defaults are unchanged', async () => {
    await api('superAdmin').post('/api/admin/notices').send({ title: 'Plain notice title', content: 'Plain notice content.', scopeLevel: 'PLATFORM' });
    const p = insertParams();
    expect(p[2]).toBe('general');
    expect(p[3]).toBe('normal');
    expect(p[4]).toBe(null);
    expect(p[5]).toBe('admin');
  });

  test('the existing field validation still runs first (400) and touches no table', async () => {
    const res = await api('superAdmin').post('/api/admin/notices').send({ ...BODY, title: 'abc', scopeLevel: 'PLATFORM' });
    expect(res.status).toBe(400);
    expect(db.calls).toEqual([]);
  });

  test('payload fields that look like stored columns or identity are ignored', async () => {
    const res = await api('superAdmin').post('/api/admin/notices').send({
      ...BODY, scopeLevel: 'COUNTY', countyId: 5,
      scope_level: 'PLATFORM', county_id: 6, ward_id: 1, constituency_id: 9, created_by: 'someone-else',
      role: 'SUPER_ADMIN', adminCountyId: 6, adminWardId: 1, id: 999,
    });
    expect(res.status).toBe(200);
    expect(insertParams()).toEqual([BODY.title, BODY.content, 'event', 'normal', BODY.expiresAt, 'admin', 'COUNTY', 5, null, null]);
  });
});

describe('POST /api/admin/notices — scoped create: no escalation through the payload', () => {
  beforeEach(() => { stubGeography(); stubInsertScopedEcho(); });

  test('a ward administrator cannot raise their own role or scope with body fields', async () => {
    const attempts = [
      { scopeLevel: 'PLATFORM', role: 'SUPER_ADMIN' },
      { scopeLevel: 'COUNTY', countyId: 5, role: 'COUNTY_ADMIN', adminCountyId: 5 },
      { scopeLevel: 'CONSTITUENCY', constituencyId: 7, adminConstituencyId: 7, role: 'CONSTITUENCY_ADMIN' },
      { scopeLevel: 'WARD', wardId: 11, adminWardId: 11 },
      { scopeLevel: 'WARD', wardId: 11, user: { role: 'SUPER_ADMIN' } },
    ];
    for (const a of attempts) {
      const res = await api('wardAdmin10').post('/api/admin/notices').send({ ...BODY, ...a });
      expect({ a, status: res.status }).toEqual({ a, status: 403 });
    }
    expect(db.writes()).toEqual([]);
  });

  test('a county administrator asking for another county is refused, not narrowed to their own', async () => {
    const res = await api('countyAdmin5').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'COUNTY', countyId: 6 });
    expect(res.status).toBe(403);
    expect(db.writes()).toEqual([]);
  });

  test('a constituency administrator asking for a ward is refused, even a ward inside their constituency (existing exact-match policy)', async () => {
    const res = await api('constituencyAdmin7').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'WARD', wardId: 10 });
    expect(res.status).toBe(403);
    expect(db.writes()).toEqual([]);
  });

  test('a county administrator asking for a constituency inside their county is refused (existing exact-match policy)', async () => {
    const res = await api('countyAdmin5').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'CONSTITUENCY', constituencyId: 7 });
    expect(res.status).toBe(403);
    expect(db.writes()).toEqual([]);
  });

  test('a ward administrator naming a correct ancestor chain for a foreign ward is still refused', async () => {
    const res = await api('wardAdmin10').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'WARD', countyId: 5, constituencyId: 7, wardId: 11 });
    expect(res.status).toBe(403);
    expect(db.writes()).toEqual([]);
  });

  test('the two wards named Ngoliba are told apart by id, never by name', async () => {
    // wardAdmin10 administers the Thika Town 'Ngoliba' (10), not the Juja 'Ngoliba' (1)
    const legacyWard = await api('wardAdmin10').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'WARD', wardId: 1 });
    expect(legacyWard.status).toBe(403);
    const ownWard = await api('wardAdmin10').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'WARD', wardId: 10 });
    expect(ownWard.status).toBe(200);
  });
});

describe('POST /api/admin/notices — scoped create: invalid geography is a client error', () => {
  beforeEach(() => { stubGeography(); stubInsertScopedEcho(); });

  const bad = (body) => api('superAdmin').post('/api/admin/notices').send({ ...BODY, ...body });

  test('malformed or contradictory scope: 400 with no table touched', async () => {
    const cases = [
      { scopeLevel: 'GLOBAL' },
      { scopeLevel: 'ward', wardId: 10 },
      { scopeLevel: 'PLATFORM', wardId: 10 },
      { scopeLevel: 'COUNTY' },
      { scopeLevel: 'COUNTY', countyId: 5, wardId: 10 },
      { scopeLevel: 'CONSTITUENCY', constituencyId: 7, wardId: 10 },
      { scopeLevel: 'WARD' },
      { scopeLevel: 'WARD', wardId: 'Ngoliba' },
      { scopeLevel: 'WARD', wardId: -3 },
      { countyId: 5 },
      { constituencyId: 7 },
    ];
    for (const c of cases) {
      db.reset(); stubGeography(); stubInsertScopedEcho();
      const res = await bad(c);
      expect({ c, status: res.status, calls: db.calls.length }).toEqual({ c, status: 400, calls: 0 });
      expect(res.body.success).toBe(false);
      expect(typeof res.body.error).toBe('string');
    }
  });

  test('an entity that does not exist: 400, nothing written, never substituted', async () => {
    for (const c of [
      { scopeLevel: 'COUNTY', countyId: 99 },
      { scopeLevel: 'CONSTITUENCY', constituencyId: 99 },
      { scopeLevel: 'WARD', wardId: 99 },
    ]) {
      db.reset(); stubGeography(); stubInsertScopedEcho();
      const res = await bad(c);
      expect({ c, status: res.status }).toEqual({ c, status: 400 });
      expect(db.writes()).toEqual([]);
    }
  });

  test('a constituency that is not in the named county: 400', async () => {
    const res = await bad({ scopeLevel: 'CONSTITUENCY', countyId: 6, constituencyId: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/constituencyId does not belong to the supplied countyId/);
    expect(db.writes()).toEqual([]);
  });

  test('a ward that is not in the named constituency or county: 400', async () => {
    const a = await bad({ scopeLevel: 'WARD', constituencyId: 8, wardId: 10 });
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/wardId does not belong to the supplied constituencyId/);
    const b = await bad({ scopeLevel: 'WARD', countyId: 6, wardId: 10 });
    expect(b.status).toBe(400);
    expect(b.body.error).toMatch(/wardId does not belong to the supplied countyId/);
    expect(db.writes()).toEqual([]);
  });

  test('the hierarchy is read from the real relationship: ward 10 is under Thika Town, ward 1 under Juja', async () => {
    const thika = await bad({ scopeLevel: 'WARD', constituencyId: 7, wardId: 10 });
    expect(thika.status).toBe(200);
    db.reset(); stubGeography(); stubInsertScopedEcho();
    const juja = await bad({ scopeLevel: 'WARD', constituencyId: 8, wardId: 1 });
    expect(juja.status).toBe(200);
    db.reset(); stubGeography(); stubInsertScopedEcho();
    const crossed = await bad({ scopeLevel: 'WARD', constituencyId: 7, wardId: 1 });
    expect(crossed.status).toBe(400);
  });

  test('an unknown-geography 400 is returned to a scoped administrator too, before the permission decision', async () => {
    const res = await api('wardAdmin10').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'WARD', wardId: 99 });
    expect(res.status).toBe(400);
  });

  test('a database failure while resolving the geography is a generic 500 and writes nothing', async () => {
    db.on(SQL.wardChain, async () => { throw new Error('connection reset secret-host'); });
    const res = await bad({ scopeLevel: 'WARD', wardId: 10 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host/);
    expect(db.writes()).toEqual([]);
    errSpy.mockClear();
  });
});

describe('POST /api/admin/notices — the legacy payload (no scopeLevel) is unchanged', () => {
  test('a ward administrator still creates a notice in their ward through wardId, with no scope statement issued', async () => {
    db.on(SQL.insertLegacy, (_s, p) => rows({ id: 101, title: p[0], ward_id: p[6] }));
    const res = await api('wardAdmin10').post('/api/admin/notices').send({ ...BODY, wardId: 10 });
    expect(res.status).toBe(200);
    expect(db.writes()).toHaveLength(1);
    expect(db.writes()[0].sql).toMatch(/^INSERT INTO notices \(title,content,category,priority,expires_at,created_by,ward_id\)/);
    expect(db.calls.some((c) => /counties|constituencies|wards/.test(c.sql))).toBe(false);
  });

  test('the legacy path with no wardId still uses the founding ward and is still RBAC-checked', async () => {
    db.on(SQL.insertLegacy, (_s, p) => rows({ id: 101, ward_id: p[6] }));
    const ok = await api('wardAdmin10').post('/api/admin/notices').send(BODY);
    expect(ok.status).toBe(200);
    expect(db.writes()[0].params[6]).toBe(FOUNDING_WARD);
    db.reset();
    db.on(SQL.insertLegacy, (_s, p) => rows({ id: 102, ward_id: p[6] }));
    const refused = await api('wardAdmin11').post('/api/admin/notices').send(BODY);
    expect(refused.status).toBe(403);
    expect(db.writes()).toEqual([]);
  });
});

// ============================================================================
// PUT / DELETE — scoped notices
// ============================================================================

describe('PUT/DELETE /api/admin/notices/:id — who may touch a stored notice', () => {
  const STORED = {
    platform: { ward_id: null, category: 'public', scope_level: 'PLATFORM', county_id: null, constituency_id: null },
    county5: { ward_id: null, category: 'public', scope_level: 'COUNTY', county_id: 5, constituency_id: null },
    constituency7: { ward_id: null, category: 'public', scope_level: 'CONSTITUENCY', county_id: null, constituency_id: 7 },
    ward10: { ward_id: 10, category: 'public', scope_level: 'WARD', county_id: null, constituency_id: null },
    legacy1: { ward_id: 1, category: 'public', scope_level: null, county_id: null, constituency_id: null },
    legacyNoWard: { ward_id: null, category: 'public', scope_level: null, county_id: null, constituency_id: null },
  };
  const IDS = { platform: 1, county5: 2, constituency7: 3, ward10: 4, legacy1: 5, legacyNoWard: 6 };

  const stubStored = () => {
    const byId = {};
    Object.keys(STORED).forEach((k) => { byId[IDS[k]] = STORED[k]; });
    db.on(SQL.noticeScope, (_s, p) => (byId[p[0]] ? rows(byId[p[0]]) : rows()));
    db.on(SQL.scopeOfNotice, (_s, p) => {
      const r = byId[p[0]];
      return r ? rows({ ward_id: r.ward_id, scope_level: r.scope_level, county_id: r.county_id, constituency_id: r.constituency_id }) : rows();
    });
    db.on(SQL.update, (_s, p) => rows({ id: Number(p[5]), title: p[0] }));
    db.on(SQL.del, rows());
  };

  // notice -> personas that may edit/delete it. Every other persona gets 403 and no write.
  const MAY = {
    platform: ['superAdmin'],
    county5: ['superAdmin', 'countyAdmin5'],
    constituency7: ['superAdmin', 'constituencyAdmin7'],
    ward10: ['superAdmin', 'wardAdmin10'],
    legacy1: ['superAdmin', 'wardAdmin1'],
    legacyNoWard: ['superAdmin'],
  };
  const PERSONA_LIST = ['superAdmin', 'countyAdmin5', 'countyAdmin6', 'constituencyAdmin7', 'constituencyAdmin8', 'wardAdmin10', 'wardAdmin11', 'wardAdmin1', 'moderator', 'moderatorAssigned'];

  Object.keys(MAY).forEach((name) => {
    test(`PUT ${name}: only ${MAY[name].join(', ')}`, async () => {
      const outcome = {};
      for (const persona of PERSONA_LIST) {
        db.reset(); stubStored();
        const res = await api(persona).put(`/api/admin/notices/${IDS[name]}`).send(UPDATE_BODY);
        outcome[persona] = { status: res.status, wrote: db.writes().length };
      }
      const expected = {};
      PERSONA_LIST.forEach((p) => { expected[p] = MAY[name].includes(p) ? { status: 200, wrote: 1 } : { status: 403, wrote: 0 }; });
      expect(outcome).toEqual(expected);
    });

    test(`DELETE ${name}: only ${MAY[name].join(', ')}`, async () => {
      const outcome = {};
      for (const persona of PERSONA_LIST) {
        db.reset(); stubStored();
        const res = await api(persona).delete(`/api/admin/notices/${IDS[name]}`);
        outcome[persona] = { status: res.status, wrote: db.writes().length };
      }
      const expected = {};
      PERSONA_LIST.forEach((p) => { expected[p] = MAY[name].includes(p) ? { status: 200, wrote: 1 } : { status: 403, wrote: 0 }; });
      expect(outcome).toEqual(expected);
    });
  });

  test('the legacy DELETE /api/notices/:id follows the same scope rule', async () => {
    stubStored();
    const refused = await api('wardAdmin10').delete(`/api/notices/${IDS.county5}`);
    expect(refused.status).toBe(403);
    expect(db.writes()).toEqual([]);
    const allowed = await api('countyAdmin5').delete(`/api/notices/${IDS.county5}`);
    expect(allowed.status).toBe(200);
    expect(db.writes()).toHaveLength(1);
  });

  test('VOTER and unauthenticated callers cannot edit or delete (no lookup either)', async () => {
    stubStored();
    for (const persona of ['voter', 'none']) {
      const put = await api(persona).put(`/api/admin/notices/${IDS.ward10}`).send(UPDATE_BODY);
      const del = await api(persona).delete(`/api/admin/notices/${IDS.ward10}`);
      expect([persona, put.status, del.status]).toEqual([persona, 403, 403]);
    }
    expect(db.calls).toEqual([]);
  });

  test('the scope is immutable through PUT: scope fields in the body change nothing', async () => {
    stubStored();
    const res = await api('superAdmin').put(`/api/admin/notices/${IDS.ward10}`).send({
      ...UPDATE_BODY, scopeLevel: 'PLATFORM', countyId: 5, constituencyId: 7, wardId: 1, ward_id: 1, scope_level: 'PLATFORM',
    });
    expect(res.status).toBe(200);
    const update = db.writes()[0];
    expect(update.sql).not.toMatch(/scope_level|county_id|constituency_id|ward_id/);
    expect(update.params).toEqual([UPDATE_BODY.title, UPDATE_BODY.content, 'public', 'high', UPDATE_BODY.expiresAt, String(IDS.ward10), true, 'health']);
  });

  test('an unknown notice: PUT is 404; DELETE keeps its existing no-op success', async () => {
    stubStored();
    const put = await api('superAdmin').put('/api/admin/notices/999').send(UPDATE_BODY);
    expect(put.status).toBe(404);
    const del = await api('superAdmin').delete('/api/admin/notices/999');
    expect(del.status).toBe(200);
  });

  test('a stored scope level the code does not know is refused for everyone below SUPER_ADMIN-by-rule (fail closed)', async () => {
    db.on(SQL.noticeScope, rows({ ward_id: null, category: 'public', scope_level: 'GLOBAL', county_id: null, constituency_id: null }));
    const res = await api('superAdmin').put('/api/admin/notices/7').send(UPDATE_BODY);
    expect(res.status).toBe(403);
    expect(db.writes()).toEqual([]);
  });
});

// ============================================================================
// GET /api/admin/notices — admin list
// ============================================================================

describe('GET /api/admin/notices — read scope of the admin list', () => {
  const listCall = () => db.calls.find((c) => /^SELECT n\.\*/.test(c.sql));

  test('SUPER_ADMIN and MODERATOR read globally (existing read policy), with no WHERE', async () => {
    for (const persona of ['superAdmin', 'moderator']) {
      db.reset();
      db.on(SQL.adminList, rows());
      const res = await api(persona).get('/api/admin/notices');
      expect(res.status).toBe(200);
      expect(listCall().sql).not.toContain('WHERE');
      expect(listCall().params).toEqual([]);
    }
  });

  test('COUNTY_ADMIN: notices of their county, whichever level holds the county', async () => {
    db.on(SQL.adminList, rows());
    await api('countyAdmin5').get('/api/admin/notices');
    expect(listCall().sql).toContain('WHERE COALESCE(con.county_id, n.county_id) = $1');
    expect(listCall().params).toEqual([5]);
  });

  test('CONSTITUENCY_ADMIN: notices of their constituency, whether it is the notice\'s own or its ward\'s', async () => {
    db.on(SQL.adminList, rows());
    await api('constituencyAdmin7').get('/api/admin/notices');
    expect(listCall().sql).toContain('WHERE con.id = $1');
    expect(listCall().params).toEqual([7]);
  });

  test('WARD_ADMIN: notices of their ward', async () => {
    db.on(SQL.adminList, rows());
    await api('wardAdmin10').get('/api/admin/notices');
    expect(listCall().sql).toContain('WHERE n.ward_id = $1');
    expect(listCall().params).toEqual([10]);
  });

  test('a scoped administrator with no assignment sees nothing (fails closed)', async () => {
    PERSONAS.orphanAdmin = P(50, 'WARD_ADMIN');
    try {
      db.on(SQL.adminList, rows());
      await api('orphanAdmin').get('/api/admin/notices');
      expect(listCall().sql).toContain('WHERE 1 = 0');
    } finally {
      delete PERSONAS.orphanAdmin;
    }
  });

  test('the rows, including the three display names and the scope columns, are returned as the database gave them', async () => {
    const row = { id: 1, title: 't', scope_level: 'COUNTY', county_id: 5, ward_id: null, ward_name: null, constituency_name: null, county_name: 'Kiambu' };
    db.on(SQL.adminList, rows(row));
    const res = await api('superAdmin').get('/api/admin/notices');
    expect(res.body).toEqual({ success: true, data: { notices: [row] } });
  });

  test('VOTER and anonymous are refused', async () => {
    expect((await api('voter').get('/api/admin/notices')).status).toBe(403);
    expect((await api('none').get('/api/admin/notices')).status).toBe(403);
    expect(db.calls).toEqual([]);
  });
});

// ============================================================================
// GET /api/admin/notice-scope-options — what the form may offer
// ============================================================================

describe('GET /api/admin/notice-scope-options', () => {
  const opts = (persona) => api(persona).get('/api/admin/notice-scope-options');

  test('SUPER_ADMIN: all four levels, no fixed assignment, no database access', async () => {
    const res = await opts('superAdmin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { role: 'SUPER_ADMIN', levels: ['PLATFORM', 'COUNTY', 'CONSTITUENCY', 'WARD'], assignment: { county: null, constituency: null, ward: null } },
    });
    expect(db.calls).toEqual([]);
  });

  test('WARD_ADMIN: the ward level and the ward / constituency / county they are fixed to, read from their stored ward', async () => {
    db.on(SQL.optWard, (_s, p) => rows({ id: p[0], name: 'Ngoliba', constituency_id: 7, constituency_name: 'Thika Town', county_id: 5, county_name: 'Kiambu' }));
    const res = await opts('wardAdmin10');
    expect(res.body.data).toEqual({
      role: 'WARD_ADMIN',
      levels: ['WARD'],
      assignment: { county: { id: 5, name: 'Kiambu' }, constituency: { id: 7, name: 'Thika Town' }, ward: { id: 10, name: 'Ngoliba' } },
    });
    expect(db.calls[0].params).toEqual([10]);
  });

  test('CONSTITUENCY_ADMIN and COUNTY_ADMIN: their own level and the entities above it', async () => {
    db.on(SQL.optConstituency, (_s, p) => rows({ id: p[0], name: 'Thika Town', county_id: 5, county_name: 'Kiambu' }));
    const con = await opts('constituencyAdmin7');
    expect(con.body.data).toEqual({
      role: 'CONSTITUENCY_ADMIN', levels: ['CONSTITUENCY'],
      assignment: { county: { id: 5, name: 'Kiambu' }, constituency: { id: 7, name: 'Thika Town' }, ward: null },
    });
    db.on(SQL.optCounty, (_s, p) => rows({ id: p[0], name: 'Kiambu' }));
    const cty = await opts('countyAdmin5');
    expect(cty.body.data).toEqual({
      role: 'COUNTY_ADMIN', levels: ['COUNTY'],
      assignment: { county: { id: 5, name: 'Kiambu' }, constituency: null, ward: null },
    });
  });

  test('MODERATOR: no levels (the form offers nothing)', async () => {
    const res = await opts('moderator');
    expect(res.status).toBe(200);
    expect(res.body.data.levels).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  test('VOTER and anonymous are refused', async () => {
    expect((await opts('voter')).status).toBe(403);
    expect((await opts('none')).status).toBe(403);
    expect(db.calls).toEqual([]);
  });

  test('a database failure is a generic 500', async () => {
    db.on(SQL.optWard, async () => { throw new Error('db down at secret-host'); });
    const res = await opts('wardAdmin10');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    errSpy.mockClear();
  });

  test('it is informational only: offering a level does not authorize it (the create route decides)', async () => {
    // wardAdmin10 is told WARD only; a hand-made COUNTY request is still refused by POST.
    stubGeography();
    const res = await api('wardAdmin10').post('/api/admin/notices').send({ ...BODY, scopeLevel: 'COUNTY', countyId: 5 });
    expect(res.status).toBe(403);
  });
});

// ============================================================================
// Route inventory — no duplicate or unmounted notice endpoints
// ============================================================================

describe('route inventory', () => {
  test('each notice route is registered once; the only new route is notice-scope-options', () => {
    const seen = {};
    noticesRouter.stack.filter((l) => l.route).forEach((l) => {
      Object.keys(l.route.methods).forEach((m) => {
        const key = `${m.toUpperCase()} ${l.route.path}`;
        seen[key] = (seen[key] || 0) + 1;
      });
    });
    Object.keys(seen).forEach((k) => expect({ k, n: seen[k] }).toEqual({ k, n: 1 }));
    expect(seen['GET /api/admin/notice-scope-options']).toBe(1);
    expect(seen['POST /api/admin/notices']).toBe(1);
    expect(seen['PUT /api/admin/notices/:id']).toBe(1);
    // there is no archive / unarchive route in this repository, and this phase adds none
    expect(Object.keys(seen).filter((k) => /archive/i.test(k))).toEqual([]);
  });
});

// ============================================================================
// bootstrap/migrations.js — ensureNoticeScopeColumns()
// ============================================================================

describe('ensureNoticeScopeColumns (migration)', () => {
  // bootstrap/migrations.js is loaded here (and only here) on top of the same fake database as
  // the route tests above; its two unrelated imports (the voting router and the period engine)
  // are replaced by stubs so nothing but the migration function itself runs.
  //
  // Phase 4B.44: the installer now runs on ONE pool client inside ONE transaction and inspects the
  // schema before and after the DDL (bootstrap/notice-scope-readiness.js). That inspection is replaced
  // here by a queue of canned results (before the DDL: nothing installed; after it: fully installed)
  // so these tests keep checking exactly what they always checked: the DDL statements themselves.
  let migrations;
  let logSpy;
  let inspections; // queued results for inspectNoticeScopeSchema()
  const readiness = require('../bootstrap/notice-scope-readiness'); // the real module (it has no dependencies)
  const ids = readiness.SCOPE_OBJECTS.map((o) => o.id);
  const NOT_INSTALLED = () => ({ state: 'NOT_INSTALLED', tableExists: true, present: [], missing: ids.slice(), invalid: [], diagnostics: null });
  const INSTALLED = () => ({ state: 'INSTALLED', tableExists: true, present: ids.slice(), missing: [], invalid: [], diagnostics: null });
  const freshInstall = () => { inspections = [NOT_INSTALLED(), INSTALLED()]; };

  beforeAll(() => {
    jest.doMock('../lib/period-engine', () => ({ transitionPeriod: async () => {} }));
    jest.doMock('../routes/voting', () => ({ broadcastVoteUpdate: () => {} }));
    jest.doMock('../bootstrap/notice-scope-readiness', () => Object.assign({}, readiness, {
      inspectNoticeScopeSchema: async () => {
        if (!inspections.length) throw new Error('UNEXPECTED inspection (no canned result queued)');
        return inspections.shift();
      },
    }));
    migrations = require('../bootstrap/migrations');
  });

  beforeEach(() => {
    // accept every statement and answer with no rows; the statements are read back from db.calls
    db.on(/.*/, rows());
    freshInstall();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); });

  // the transaction control statements are not DDL
  const CONTROL = /^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory_xact_lock\(\$1, \$2\))$/;
  const allStatements = () => db.calls.map((c) => c.sql);
  const statements = () => allStatements().filter((s) => !CONTROL.test(s));

  test('runs in ONE transaction on ONE pool client: BEGIN, advisory lock, the DDL, COMMIT; nothing goes through pool.query', async () => {
    await migrations.ensureNoticeScopeColumns();
    const all = allStatements();
    expect(all[0]).toBe('BEGIN');
    expect(all[1]).toBe('SELECT pg_advisory_xact_lock($1, $2)');
    expect(all[all.length - 1]).toBe('COMMIT');
    expect(all).not.toContain('ROLLBACK');
    expect(db.calls[1].params).toEqual([readiness.NOTICE_SCOPE_INSTALL_LOCK.key1, readiness.NOTICE_SCOPE_INSTALL_LOCK.key2]);
    expect(db.direct).toEqual([]);
    expect(db.released).toEqual(['released']);
  });

  test('is exported and runs only additive, guarded statements', async () => {
    expect(typeof migrations.ensureNoticeScopeColumns).toBe('function');
    await migrations.ensureNoticeScopeColumns();
    expect(statements().length > 0).toBe(true);
    statements().forEach((s) => {
      expect(s).toMatch(/^(ALTER TABLE notices ADD COLUMN IF NOT EXISTS |DO \$\$ BEGIN ALTER TABLE notices ADD CONSTRAINT |CREATE INDEX IF NOT EXISTS |CREATE OR REPLACE FUNCTION notices_keep_scoped_ward_null\(\) |DO \$\$ BEGIN IF NOT EXISTS \( SELECT 1 FROM pg_trigger WHERE tgname = 'notices_keep_scoped_ward_null')/);
    });
  });

  test('never reads, inserts, updates or deletes a row, and drops or truncates nothing', async () => {
    await migrations.ensureNoticeScopeColumns();
    // the guard (tested separately below) legitimately mentions UPDATE and SELECT in its trigger header
    const all = statements().filter((s) => !/notices_keep_scoped_ward_null/.test(s)).join('\n');
    expect(all).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|DROP|TRUNCATE|RENAME)\b/i);
    expect(all).not.toMatch(/\bSET\b/i);
  });

  test('the Phase 2 backfill guard: a trigger that only ever skips a ward stamp on a ward-less scoped notice', async () => {
    await migrations.ensureNoticeScopeColumns();
    const fn = statements().find((s) => /^CREATE OR REPLACE FUNCTION notices_keep_scoped_ward_null/.test(s));
    expect(fn).toContain("IF OLD.scope_level IN ('PLATFORM', 'COUNTY', 'CONSTITUENCY') THEN RETURN NULL; END IF; RETURN NEW;");
    // it never modifies, inserts or deletes anything itself
    expect(fn).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b|NEW\.\w+\s*:?=/i);
    const trg = statements().find((s) => /CREATE TRIGGER/.test(s));
    expect(trg).toContain('BEFORE UPDATE OF ward_id ON notices FOR EACH ROW WHEN (OLD.ward_id IS NULL AND NEW.ward_id IS NOT NULL)');
    // installed once: re-runs find it and do nothing
    expect(trg).toContain('IF NOT EXISTS ( SELECT 1 FROM pg_trigger');
    // the guard does not name the founding ward or touch the resolver
    expect(fn + trg).not.toMatch(/founding|NGOLIBA|wards/i);
  });

  test('adds the four columns, with no default and no NOT NULL (so no existing row is rewritten)', async () => {
    await migrations.ensureNoticeScopeColumns();
    const cols = statements().filter((s) => /ADD COLUMN/.test(s));
    expect(cols.map((s) => s.replace(/^ALTER TABLE notices ADD COLUMN IF NOT EXISTS /, '')).sort()).toEqual(
      ['constituency_id INT', 'county_id INT', 'scope_level VARCHAR(20)', 'ward_id INT']
    );
    cols.forEach((s) => expect(s).not.toMatch(/DEFAULT|NOT NULL/i));
  });

  test('the CHECK accepts a legacy row (all scope columns NULL) and pins each level to its one id', async () => {
    await migrations.ensureNoticeScopeColumns();
    const check = statements().find((s) => /notices_scope_check/.test(s));
    // a CHECK that evaluates to NULL ACCEPTS the row in PostgreSQL; with scope_level NULL several branches are NULL,
    // so the whole expression must be forced to false (found by the real-database run)
    expect(check).toContain('CHECK (COALESCE( (scope_level IS NULL');
    expect(check).toContain(', false));');
    expect(check).toContain('scope_level IS NULL AND county_id IS NULL AND constituency_id IS NULL)');
    expect(check).toContain("scope_level = 'PLATFORM' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NULL)");
    expect(check).toContain("scope_level = 'COUNTY' AND county_id IS NOT NULL AND constituency_id IS NULL AND ward_id IS NULL)");
    expect(check).toContain("scope_level = 'CONSTITUENCY' AND county_id IS NULL AND constituency_id IS NOT NULL AND ward_id IS NULL)");
    expect(check).toContain("scope_level = 'WARD' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NOT NULL)");
  });

  test('foreign keys point at the real geography tables; every constraint is guarded for re-runs', async () => {
    await migrations.ensureNoticeScopeColumns();
    const all = statements().join('\n');
    expect(all).toContain('notices_county_id_fk FOREIGN KEY (county_id) REFERENCES counties(id)');
    expect(all).toContain('notices_constituency_id_fk FOREIGN KEY (constituency_id) REFERENCES constituencies(id)');
    statements().filter((s) => /ADD CONSTRAINT/.test(s)).forEach((s) => expect(s).toContain('EXCEPTION WHEN duplicate_object THEN NULL'));
  });

  test('it touches no table other than notices and no ward id value', async () => {
    await migrations.ensureNoticeScopeColumns();
    const all = statements().join('\n');
    expect(all).not.toMatch(/\b(users|candidates|votes|forum_posts|community_reports|ad_requests|wards)\b\s*(SET|\()/i);
    expect(all).not.toMatch(/ward_id\s*=\s*\d/);
    expect(all).not.toMatch(/founding|NGOLIBA/i);
  });

  test('a failure ROLLS BACK, releases the client and rethrows the ORIGINAL error (it is no longer swallowed here)', async () => {
    const boom = new Error('permission denied');
    db.on(/^CREATE OR REPLACE FUNCTION/, async () => { throw boom; });
    let caught = null;
    try { await migrations.ensureNoticeScopeColumns(); } catch (e) { caught = e; }
    expect(caught).toBe(boom);
    const all = allStatements();
    expect(all).toContain('ROLLBACK');
    expect(all).not.toContain('COMMIT');
    expect(db.released).toEqual(['released']);
    expect(errSpy.mock.calls.length).toBe(0); // logging the failure is ensureNoticesTable's job, not the installer's
  });

  test('running it twice issues the same statements (idempotent by construction)', async () => {
    await migrations.ensureNoticeScopeColumns();
    const first = statements();
    db.calls.length = 0;
    freshInstall();
    await migrations.ensureNoticeScopeColumns();
    expect(statements()).toEqual(first);
  });
});
