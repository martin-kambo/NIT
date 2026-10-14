'use strict';

// ============================================================================
// Notice API tests — Phase 4B.34 (isolated harness)
// ============================================================================
// These tests mount the REAL router from routes/notices.js (and the real
// lib/rbac.js, lib/notices.js and lib/ward-cache.js behind it) on a tiny
// test-only Express app. They never import server.js.
//
// What is faked, and what is not
//   • bootstrap/database  → replaced BEFORE the router is required by an
//     in-memory fake whose `pool.query` records every statement and FAILS
//     CLOSED: any SQL no test registered a rule for rejects with
//     "UNEXPECTED QUERY". No real PostgreSQL pool is ever constructed.
//   • pg, server.js, bootstrap/startup, bootstrap/migrations → replaced with
//     factories that THROW if anything tries to load them.
//   • The session middleware that lives in server.js (cookie → users row →
//     req.user / req.wardId) is NOT importable without starting the server,
//     so a test-only middleware sets req.user / req.wardId from the
//     `x-test-persona` / `x-test-ward-id` request headers. The shapes mirror
//     what server.js attaches (see lib/rbac.js header comment). That
//     middleware itself is therefore NOT covered by this file.
//   • lib/rbac.js, lib/notices.js and lib/ward-cache.js are the real modules.
//   • Nothing here reads .env or any environment variable.
//
// The mock database proves SQL TEXT and BOUND PARAMETERS, not PostgreSQL
// semantics (e.g. WHERE filters are asserted as predicates, not evaluated).
// Cases that depend on real Postgres behaviour are marked EMULATED.
//
// ----------------------------------------------------------------------------
// Disposition of the 37 legacy tests (identified by their old line numbers)
// ----------------------------------------------------------------------------
//  Rewritten to the current API (outdated expectation):
//    L55 L81 L135 L152 L163 L204 L214 L296 L315 L331 L374 L383 L397 L434
//    L442 L451 L460 L518 L527 L544 L560 L587 L598
//  Deferred as test.todo (functionality does not exist today):
//    L67 L92 L103 L116 L127 L180 L189 L224 L235 L251 L265 L279 L472 L492
//    plus the pagination part of L55, createdAt/createdBy part of L135 and the
//    soft-delete intent of L460.
//  Timing assertions (L587, L598) were dropped: against a mocked DB a
//  "< 500 ms" check measures nothing. Their request shapes are kept.
//  Added (no legacy equivalent): harness-safety checks, ward-scope and role-gate
//  cases, DB-failure cases, and coverage of the other notice routes
//  (POST /api/notices, DELETE /api/notices/:id, GET /api/admin/notices).
//
//  Gap IDs used below (follow-ups, NOT implemented in this phase):
//    G1  GET /api/notices reads only ?cat — no priority/search/page/limit and
//        no ?category= alias (public/notice-board.html sends them)
//    G2  feed rows are snake_case and carry no created_by (legacy expected
//        camelCase + createdBy inside a { data } wrapper)
//    G3  no GET /api/notices/stream (SSE)
//    G4  no GET /api/notices/categories or /priorities
//    G5  no server-side validation beyond "title and content are required"
//    G6  DELETE is a hard delete; is_archived is read but never written
//  Observations recorded by characterization tests:
//    O1  a MODERATOR passes the role gate but is refused by the ward-scope
//        check on writes whenever the ward id is non-null
//    O2  a non-integer id reaches the DB layer (notices.id is SERIAL) → 500
//    O3  GET /api/admin/notices answers { success, data: { notices } } while
//        the other notice routes answer flat { success, notices | notice }
//
// ----------------------------------------------------------------------------
// Phase 4B.36 (validation and ward-security hardening)
// ----------------------------------------------------------------------------
//  G5 is closed for the write routes: five of the sixteen todos became real
//  tests (title/content length, category, priority) or were replaced by an
//  approved decision (past expiry is PERMITTED, so the "rejects a past expiry"
//  todo is superseded by tests that assert it is accepted). Eleven todos remain
//  (G1 x6, G3 x2, G4 x2, G6 x1) -- none is in scope for 4B.36.
//  The "Phase 4B.36" describe blocks at the end of this file cover validation,
//  the legacy `health` category, expiry, wardId, the NULL-ward and
//  unresolved-founding-ward safeguards, and 500-error hygiene.
//  Existing tests changed only where an approved decision changes the
//  contract: PUT now looks the notice up with ONE statement (ward + category),
//  the UPDATE statement changed, 500 bodies no longer echo the raw error text,
//  and two bodies that were 1-2 characters long are now valid-length.
//  Reminder: this fake database proves SQL text and bound parameters only. The
//  new UPDATE statement and the foreign-key error shape were checked separately
//  against a disposable local PostgreSQL 16 (see the Phase 4B.36 report); NONE
//  of that is exercised by this file.
// ============================================================================

const express = require('express');
const request = require('supertest');

// ───────────────────────── Fake database ──────────────────────────────────

const squash = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const rows = (...r) => ({ rows: r });

function createFakeDb() {
  let rules = [];
  const calls = [];       // every statement issued: { sql, params }
  const unexpected = [];  // statements no rule matched

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

  return {
    pool: { query },
    calls,
    unexpected,
    // Newest rule wins. `respond` is either a result object or a function
    // (sql, params) => result | throws.
    on(pattern, respond) {
      rules.unshift({
        pattern,
        respond: typeof respond === 'function' ? respond : async () => respond,
      });
    },
    reset() {
      rules = [];
      calls.length = 0;
      unexpected.length = 0;
    },
    writes() {
      return calls.filter((c) => /^(INSERT|UPDATE|DELETE)\b/.test(c.sql));
    },
  };
}

// Patterns for the statements the current notice routes issue (whitespace is
// collapsed before matching). Deliberately specific so a changed statement
// shows up as UNEXPECTED QUERY rather than silently "succeeding".
const SQL = {
  listNotices: /^SELECT id, title, content, category, priority, created_at, expires_at, NULL AS contact_phone, NULL AS business_name, false AS is_ad FROM notices WHERE /,
  listAds: /^SELECT id, business_name AS title, ad_content AS content, .* FROM ad_requests WHERE status = 'approved'/,
  adminList: /^SELECT n\.\* FROM notices n LEFT JOIN wards w ON w\.id = n\.ward_id LEFT JOIN constituencies con ON con\.id = w\.constituency_id /,
  wardOf: /^SELECT ward_id FROM notices WHERE id = \$1$/,
  // Phase 4B.36: PUT loads ward AND category in one statement.
  noticeScope: /^SELECT ward_id, category FROM notices WHERE id = \$1$/,
  insertWithExpiry: /^INSERT INTO notices \(title,content,category,priority,expires_at,created_by,ward_id\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7\) RETURNING \*$/,
  insertWithDays: /^INSERT INTO notices \(title, content, category, priority, expires_at, created_by, ward_id\) VALUES \(\$1, \$2, \$3, \$4, NOW\(\) \+ \(\$5 \|\| ' days'\)::INTERVAL, 'admin', \$6\) RETURNING \*$/,
  // Phase 4B.36: params are [title, content, category, priority, expires_at,
  // id, setExpiry, legacyCategory]. $7 = false keeps the stored expiry.
  update: /^UPDATE notices SET title = \$1, content = \$2, category = \$3, priority = \$4, expires_at = CASE WHEN \$7::boolean THEN \$5::timestamp ELSE expires_at END, updated_at = NOW\(\) WHERE id = \$6 AND \(\$3 <> \$8 OR category = \$8\) RETURNING \*$/,
  del: /^DELETE FROM notices WHERE id = \$1$/,
};

// ───────────────────────── Test personas ──────────────────────────────────
// Shapes mirror req.user as attached by server.js's session middleware.

const WARD = 1;
const OTHER_WARD = 2;

const scope = (adminWardId = null) => ({
  adminCountyId: null,
  adminConstituencyId: null,
  adminWardId,
});

const PERSONAS = {
  none: null, // no valid session → req.user === null
  voter: { id: 11, role: 'VOTER', ...scope() },
  moderator: { id: 12, role: 'MODERATOR', ...scope() },
  wardAdmin1: { id: 13, role: 'WARD_ADMIN', ...scope(WARD) },
  wardAdmin2: { id: 14, role: 'WARD_ADMIN', ...scope(OTHER_WARD) },
  superAdmin: { id: 15, role: 'SUPER_ADMIN', ...scope() },
  unknownRole: { id: 16, role: 'GUEST_EDITOR', ...scope() },
  // Phase 4B.36: the two remaining administrator roles. Their scope fields
  // mirror routes/administrators.js validateAdminScope(): a COUNTY_ADMIN has
  // only a county, a CONSTITUENCY_ADMIN only a constituency, neither has a ward.
  countyAdmin: { id: 17, role: 'COUNTY_ADMIN', adminCountyId: 5, adminConstituencyId: null, adminWardId: null },
  constituencyAdmin: { id: 18, role: 'CONSTITUENCY_ADMIN', adminCountyId: null, adminConstituencyId: 7, adminWardId: null },
};

// ───────────────────────── Fixtures ───────────────────────────────────────

const noticeRow = (over = {}) => ({
  id: 1,
  title: 'Water outage on Monday',
  content: 'Water will be off from 8am to 2pm.',
  category: 'public',
  priority: 'normal',
  created_at: '2026-05-01T08:00:00.000Z',
  expires_at: null,
  contact_phone: null,
  business_name: null,
  is_ad: false,
  ...over,
});

const adRow = (over = {}) => ({
  id: 'b1a5c0de-0000-4000-8000-000000000001',
  title: "Njeri's Hardware",
  content: 'Cement and iron sheets, delivered.',
  category: 'business',
  priority: 'normal',
  created_at: '2026-05-02T08:00:00.000Z',
  expires_at: null,
  contact_phone: '0712345678',
  business_name: "Njeri's Hardware",
  is_ad: true,
  ...over,
});

const VALID_ADMIN_BODY = {
  title: 'Community clean-up day',
  content: 'Join us on Saturday at the market.',
  category: 'event',
  priority: 'normal',
  expiresAt: '2030-01-01T00:00:00.000Z',
  wardId: WARD,
};

const VALID_UPDATE_BODY = {
  title: 'Updated Notice Title',
  content: 'Updated content for the notice.',
  category: 'public',
  priority: 'high',
  expiresAt: '2031-01-01T00:00:00.000Z',
};

// ───────────────────────── Harness wiring ─────────────────────────────────

let db;
let wardCache;
let noticesRouter;
let app;
let errSpy;

function buildApp(router) {
  const a = express();
  a.use(express.json());
  // TEST-ONLY stand-in for the session middleware in server.js.
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

const api = (persona = 'none') => ({
  get: (url) => request(app).get(url).set('x-test-persona', persona),
  post: (url) => request(app).post(url).set('x-test-persona', persona),
  put: (url) => request(app).put(url).set('x-test-persona', persona),
  delete: (url) => request(app).delete(url).set('x-test-persona', persona),
});

function stubFeed({ notices = [], ads = [] } = {}) {
  db.on(SQL.listNotices, rows(...notices));
  db.on(SQL.listAds, rows(...ads));
}

// EMULATION of PostgreSQL's integer cast. notices.id is SERIAL
// (bootstrap/migrations.js), so a non-integer id makes the real server reject
// the statement (SQLSTATE 22P02). Real pg behaviour is NOT exercised here.
function pgIntegerIdOrThrow(value) {
  if (!/^\d+$/.test(String(value))) {
    const err = new Error(`invalid input syntax for type integer: "${value}"`);
    err.code = '22P02';
    throw err;
  }
}

// wards: { '<noticeId>': wardId } — ids absent from the map do not exist.
function stubNoticeWards(wards) {
  db.on(SQL.wardOf, (_sql, params) => {
    const id = String(params[0]);
    pgIntegerIdOrThrow(id);
    return Object.prototype.hasOwnProperty.call(wards, id)
      ? rows({ ward_id: wards[id] })
      : rows();
  });
}

function stubInsertWithExpiryEcho() {
  db.on(SQL.insertWithExpiry, (_sql, p) =>
    rows({ id: 101, title: p[0], content: p[1], category: p[2], priority: p[3], expires_at: p[4], created_by: p[5], ward_id: p[6] }));
}

function stubInsertWithDaysEcho() {
  db.on(SQL.insertWithDays, (_sql, p) =>
    rows({ id: 102, title: p[0], content: p[1], category: p[2], priority: p[3], created_by: 'admin', ward_id: p[5] }));
}

// Phase 4B.36: PUT's one-statement lookup. scopes: { '<noticeId>': { ward_id,
// category } } -- ids absent from the map do not exist. Same integer-cast
// emulation as stubNoticeWards().
function stubNoticeScopes(scopes) {
  db.on(SQL.noticeScope, (_sql, params) => {
    const id = String(params[0]);
    pgIntegerIdOrThrow(id);
    return Object.prototype.hasOwnProperty.call(scopes, id)
      ? rows({ ward_id: scopes[id].ward_id, category: scopes[id].category })
      : rows();
  });
}

// UPDATE params: [title, content, category, priority, expires_at, id, setExpiry, legacyCategory].
// The echo mirrors the SQL: expires_at is replaced only when setExpiry is true.
function stubUpdateEcho() {
  db.on(SQL.update, (_sql, p) => {
    const row = { id: Number(p[5]), title: p[0], content: p[1], category: p[2], priority: p[3], ward_id: WARD };
    if (p[6]) row.expires_at = p[4];
    return rows(row);
  });
}

// A pg-style error: SQLSTATE in `code`, constraint name in `constraint`.
function pgError(message, code, constraint) {
  const err = new Error(message);
  if (code) err.code = code;
  if (constraint) err.constraint = constraint;
  return err;
}

beforeAll(() => {
  db = createFakeDb();

  // Register every mock BEFORE the router (and anything it requires) is loaded.
  jest.doMock('../bootstrap/database', () => ({
    pool: db.pool,
    testDBConnection: async () => {
      throw new Error('testDBConnection must not be called by notice tests');
    },
  }));
  jest.doMock('pg', () => {
    throw new Error('the real pg driver must not be loaded by notice tests');
  });
  jest.doMock('../server', () => {
    throw new Error('notice tests must never load server.js');
  });
  jest.doMock('../bootstrap/startup', () => {
    throw new Error('notice tests must never load bootstrap/startup');
  });
  jest.doMock('../bootstrap/migrations', () => {
    throw new Error('notice tests must never load bootstrap/migrations');
  });

  wardCache = require('../lib/ward-cache');
  noticesRouter = require('../routes/notices');
  app = buildApp(noticesRouter);
});

afterAll(() => {
  if (wardCache) wardCache.setFoundingWardId(null);
});

beforeEach(() => {
  db.reset();
  // Emulates the single production writer (startup) so the "founding ward"
  // fallback behaves as it does in a running server.
  wardCache.setFoundingWardId(WARD);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  const loggedErrors = errSpy.mock.calls.slice();
  errSpy.mockRestore();
  // No query may ever fall through to "no rule registered" — including ones a
  // handler would swallow (the ads query in GET /api/notices is non-fatal).
  expect(db.unexpected).toEqual([]);
  // Happy paths must not log errors; failure tests assert then mockClear().
  expect(loggedErrors).toEqual([]);
});

// ============================================================================
// Harness safety
// ============================================================================

describe('isolated harness', () => {
  test('mounts the real routes/notices.js router with the expected notice routes', () => {
    expect(require('../routes/notices')).toBe(noticesRouter);
    expect(require.resolve('../routes/notices')).toMatch(/routes[\\/]notices\.js$/);
    const mounted = noticesRouter.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`));
    expect(mounted).toEqual(expect.arrayContaining([
      'GET /api/notices',
      'GET /api/admin/notices',
      'POST /api/notices',
      'DELETE /api/notices/:id',
      'POST /api/admin/notices',
      'PUT /api/admin/notices/:id',
      'DELETE /api/admin/notices/:id',
    ]));
  });

  test('the router talks to the in-memory fake, never to a real pool', () => {
    expect(require('../bootstrap/database').pool).toBe(db.pool);
  });

  test('server.js, startup, migrations and the pg driver are blocked (fail closed)', () => {
    expect(() => require('../server')).toThrow(/must never load server\.js/);
    expect(() => require('../bootstrap/startup')).toThrow(/bootstrap\/startup/);
    expect(() => require('../bootstrap/migrations')).toThrow(/bootstrap\/migrations/);
    expect(() => require('pg')).toThrow(/real pg driver must not be loaded/);
  });

  test('the fake database rejects SQL nobody registered', async () => {
    await expect(db.pool.query('SELECT 1')).rejects.toThrow(/UNEXPECTED QUERY/);
    expect(db.unexpected).toEqual(['SELECT 1']);
    db.unexpected.length = 0; // deliberate probe — clear so afterEach stays strict
  });

  test('an unknown test persona is a harness error, not a silent anonymous request', async () => {
    const res = await request(app).get('/api/admin/notices').set('x-test-persona', 'typo');
    expect(res.status).toBe(500);
    expect(res.body.harnessError).toMatch(/unknown test persona/);
    expect(db.calls).toEqual([]);
  });
});

// ============================================================================
// GET /api/notices   (public feed: notices + approved ads)
// ============================================================================

describe('GET /api/notices', () => {
  // legacy L55 — rewritten: current contract is flat { success, notices }.
  // (public/notice-board.html documents it: "no data wrapper or pagination".)
  test('returns the flat { success, notices } feed with notices and approved ads merged (high priority first, then newest) [legacy L55]', async () => {
    const n1 = noticeRow({ id: 1, created_at: '2026-05-01T08:00:00.000Z' });
    const n2 = noticeRow({ id: 2, priority: 'high', created_at: '2026-04-01T08:00:00.000Z' });
    const ad = adRow();
    stubFeed({ notices: [n1, n2], ads: [ad] });

    const res = await api('none').get('/api/notices');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.notices)).toBe(true);
    expect(res.body).not.toHaveProperty('data');
    expect(res.body.notices.map((n) => n.id)).toEqual([2, ad.id, 1]);
  });

  // legacy L135 — rewritten to the current (snake_case) row shape. The
  // camelCase/createdBy part is deferred (G2).
  test('rows carry the current snake_case field set and the query selects exactly those columns [legacy L135]', async () => {
    stubFeed({ notices: [noticeRow()], ads: [adRow()] });

    const res = await api('none').get('/api/notices');

    expect(res.status).toBe(200);
    for (const row of res.body.notices) {
      expect(Object.keys(row).sort()).toEqual([
        'business_name', 'category', 'contact_phone', 'content', 'created_at',
        'expires_at', 'id', 'is_ad', 'priority', 'title',
      ]);
    }
    expect(db.calls[0].sql).toContain('SELECT id, title, content, category, priority, created_at, expires_at');
  });

  // legacy L81 — rewritten: the filter that exists is ?cat, bound as a parameter.
  test('?cat=<category> filters both queries through bound parameters [legacy L81]', async () => {
    stubFeed();

    const res = await api('none').get('/api/notices?cat=event');

    expect(res.status).toBe(200);
    expect(db.calls).toHaveLength(2);
    const [notices, ads] = db.calls;
    expect(notices.sql).toContain('category = $1');
    expect(notices.sql).toContain('ward_id = $2');
    expect(notices.params).toEqual(['event', WARD]);
    expect(ads.sql).toContain("COALESCE(category, 'general') = $1");
    expect(ads.params).toEqual(['event']);
    expect(notices.sql).not.toContain('event');
  });

  test('?cat=all applies no category filter', async () => {
    stubFeed();

    await api('none').get('/api/notices?cat=all');

    const [notices, ads] = db.calls;
    expect(notices.sql).not.toMatch(/AND category = \$/);
    expect(notices.params).toEqual([WARD]);
    expect(ads.sql).not.toContain("COALESCE(category, 'general') = $1");
    expect(ads.params).toEqual([]);
  });

  // legacy L81 / G1 — characterization: public/notice-board.html sends
  // ?category= but the route reads only ?cat.
  test('ignores the ?category= alias, only ?cat is read (gap G1) [legacy L81]', async () => {
    stubFeed();

    const res = await api('none').get('/api/notices?category=event');

    expect(res.status).toBe(200);
    const [notices] = db.calls;
    expect(notices.sql).not.toMatch(/AND category = \$/);
    expect(notices.params).toEqual([WARD]);
  });

  test('adds a ward_id predicate when req.wardId is set and omits it when it is null', async () => {
    stubFeed();

    await api('none').get('/api/notices').set('x-test-ward-id', '7');
    expect(db.calls[0].sql).toContain('ward_id = $1');
    expect(db.calls[0].params).toEqual([7]);

    db.reset();
    stubFeed();
    await api('none').get('/api/notices').set('x-test-ward-id', 'none');
    expect(db.calls[0].sql).not.toContain('ward_id =');
    expect(db.calls[0].params).toEqual([]);
  });

  // legacy L152 — predicate-level assertion (a mock cannot evaluate filters).
  test('the notices query excludes archived rows [legacy L152]', async () => {
    stubFeed();
    await api('none').get('/api/notices');
    expect(db.calls[0].sql).toContain('COALESCE(is_archived, false) = false');
  });

  // legacy L163 — predicate-level assertion.
  test('the notices query excludes expired rows, and the ads query only returns approved, non-hidden ads [legacy L163]', async () => {
    stubFeed();
    await api('none').get('/api/notices');
    expect(db.calls[0].sql).toContain('(expires_at IS NULL OR expires_at > NOW())');
    expect(db.calls[1].sql).toContain("status = 'approved'");
    expect(db.calls[1].sql).toContain('COALESCE(is_hidden, false) = false');
  });

  test('a failing ads query is non-fatal: the feed still returns the notices', async () => {
    db.on(SQL.listNotices, rows(noticeRow()));
    db.on(SQL.listAds, () => {
      throw new Error('relation "ad_requests" does not exist');
    });

    const res = await api('none').get('/api/notices');

    expect(res.status).toBe(200);
    expect(res.body.notices).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledWith(
      '/api/notices ads query error (non-fatal):',
      'relation "ad_requests" does not exist');
    errSpy.mockClear();
  });

  test('a failing notices query returns 500 { success:false, notices:[], error }', async () => {
    db.on(SQL.listNotices, () => {
      throw new Error('connection terminated');
    });
    db.on(SQL.listAds, rows());

    const res = await api('none').get('/api/notices');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, notices: [], error: 'connection terminated' });
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockClear();
  });

  // legacy L587 — timing assertion dropped (meaningless against a mocked DB).
  // What stays: the feed is public and costs exactly two queries.
  test('is public (no session) and issues exactly two queries [legacy L587]', async () => {
    stubFeed();

    const res = await api('none').get('/api/notices');

    expect(res.status).toBe(200);
    expect(db.calls).toHaveLength(2);
  });

  // legacy L598 — timing dropped; request shape kept. G1 characterization.
  test('ignores page and limit — no LIMIT/OFFSET, no pagination parameters (gap G1) [legacy L598]', async () => {
    const all = [noticeRow({ id: 1 }), noticeRow({ id: 2 }), noticeRow({ id: 3 })];
    stubFeed({ notices: all });

    const res = await api('none').get('/api/notices?page=10&limit=50');

    expect(res.status).toBe(200);
    expect(res.body.notices).toHaveLength(3);
    expect(db.calls[0].sql).not.toMatch(/\b(LIMIT|OFFSET)\b/);
    expect(db.calls[0].params).toEqual([WARD]);
  });

  // legacy L518 — rewritten and strengthened: hostile input is never part of
  // any SQL text; ?cat is only ever a bound parameter; ?search is not read.
  test('hostile query-string values never reach the SQL text [legacy L518]', async () => {
    stubFeed();
    const hostileSearch = "'; DROP TABLE notices; --";
    const hostileCat = "' OR 1=1 --";

    const res = await api('none').get('/api/notices').query({ search: hostileSearch, cat: hostileCat });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    for (const call of db.calls) {
      expect(call.sql).not.toContain('DROP');
      expect(call.sql).not.toContain('1=1');
    }
    expect(db.calls[0].params).toEqual([hostileCat, WARD]);
    expect(db.calls[1].params).toEqual([hostileCat]);
    expect(JSON.stringify(db.calls.map((c) => c.params))).not.toContain('DROP TABLE');
  });

  // Deferred: functionality does not exist today.
  test.todo('[G1] returns pagination metadata alongside the notices (legacy L55 pagination part, L67)');
  test.todo('[G1] filters by ?priority= (legacy L92)');
  test.todo('[G1] searches title and content with ?search= using a parameterised query (legacy L103)');
  test.todo('[G1] honours ?page= and ?limit= (legacy L116)');
  test.todo('[G1] returns an empty list for a non-matching ?search= (legacy L127)');
  test.todo('[G2] exposes createdAt / createdBy on feed rows (legacy L135 camelCase/createdBy part)');
});

// ============================================================================
// GET /api/notices/stream, /categories, /priorities — not implemented
// ============================================================================

describe('endpoints that do not exist yet', () => {
  test.todo('[G3] GET /api/notices/stream establishes an SSE connection (legacy L180)');
  test.todo('[G3] GET /api/notices/stream sends text/event-stream headers (legacy L189)');
  test.todo('[G4] GET /api/notices/categories returns the category list (legacy L472)');
  test.todo('[G4] GET /api/notices/priorities returns the priority list (legacy L492)');
});

// ============================================================================
// POST /api/admin/notices
// ============================================================================

describe('POST /api/admin/notices', () => {
  // legacy L204 — outdated: no session → 403 (not 401); nothing touches the DB.
  test('without a session answers 403 Forbidden and performs no database access [legacy L204]', async () => {
    const res = await api('none').post('/api/admin/notices').send(VALID_ADMIN_BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.calls).toEqual([]);
  });

  // legacy L214 — outdated: x-admin-password was retired; it authenticates nothing.
  test('the retired x-admin-password header does not authenticate [legacy L214]', async () => {
    const res = await api('none')
      .post('/api/admin/notices')
      .set('x-admin-password', 'dummy-value-not-a-secret')
      .send(VALID_ADMIN_BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.calls).toEqual([]);
  });

  test('a signed-in VOTER is below the MODERATOR gate → 403, no database access', async () => {
    const res = await api('voter').post('/api/admin/notices').send(VALID_ADMIN_BODY);

    expect(res.status).toBe(403);
    expect(db.calls).toEqual([]);
  });

  // legacy L296 — rewritten: 200 { success, notice }, INSERT fully parameterised.
  test('a WARD_ADMIN of the target ward creates a notice → 200 { success, notice } [legacy L296]', async () => {
    stubInsertWithExpiryEcho();

    const res = await api('wardAdmin1').post('/api/admin/notices').send(VALID_ADMIN_BODY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.notice).toMatchObject({
      id: 101,
      title: VALID_ADMIN_BODY.title,
      category: 'event',
      ward_id: WARD,
    });
    expect(res.body).not.toHaveProperty('data');
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].params).toEqual([
      VALID_ADMIN_BODY.title,
      VALID_ADMIN_BODY.content,
      'event',
      'normal',
      VALID_ADMIN_BODY.expiresAt,
      'admin',
      WARD,
    ]);
    expect(db.calls[0].sql).not.toContain(VALID_ADMIN_BODY.title);
  });

  test('a SUPER_ADMIN can create a notice in any ward', async () => {
    stubInsertWithExpiryEcho();

    const res = await api('superAdmin').post('/api/admin/notices').send({ ...VALID_ADMIN_BODY, wardId: OTHER_WARD });

    expect(res.status).toBe(200);
    expect(db.calls[0].params[6]).toBe(OTHER_WARD);
  });

  test('defaults category to general, priority to normal, expiry to null and ward to the founding ward', async () => {
    stubInsertWithExpiryEcho();

    const res = await api('superAdmin').post('/api/admin/notices').send({ title: 'Plain', content: 'Plain body' });

    expect(res.status).toBe(200);
    expect(db.calls[0].params).toEqual(['Plain', 'Plain body', 'general', 'normal', null, 'admin', WARD]);
  });

  test('a WARD_ADMIN of a different ward is refused by the scope check and nothing is written', async () => {
    const res = await api('wardAdmin2').post('/api/admin/notices').send(VALID_ADMIN_BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.calls).toEqual([]);
  });

  // O1 — characterization, NOT an endorsement: hasPermission() compares the
  // target ward with user.adminWardId, which is null for a MODERATOR.
  test('a MODERATOR passes the role gate but is refused by the ward-scope check (observation O1)', async () => {
    const res = await api('moderator').post('/api/admin/notices').send(VALID_ADMIN_BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.calls).toEqual([]);
  });

  // The only server-side validation that exists today (G5 covers the rest).
  test.each([
    ['missing title', { content: 'Body only' }],
    ['missing content', { title: 'Title only' }],
    ['empty title', { title: '', content: 'Body' }],
    ['empty content', { title: 'Title', content: '' }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const res = await api('superAdmin').post('/api/admin/notices').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'title and content are required' });
    expect(db.calls).toEqual([]);
  });

  // legacy L315 / L331 / L527 / L544 — rewritten. The legacy tests expected the
  // SERVER to HTML-encode on write. Phase 4B.32 protects at render time, so the
  // API must store text exactly as submitted (encoding on write would
  // double-encode in the UI).
  test.each([
    ['title', { title: '<img src=x onerror="alert(1)"> Test', content: 'This is a test notice for XSS prevention' }],
    ['content', { title: 'XSS Test Notice', content: '<script>alert("XSS")</script> Content here' }],
  ])('stores hostile %s exactly as submitted — no encoding on write; protection is at render time [legacy L315, L331, L527, L544]', async (_field, body) => {
    stubInsertWithExpiryEcho();

    const res = await api('superAdmin').post('/api/admin/notices').send({ ...body, category: 'business', priority: 'normal', wardId: WARD });

    expect(res.status).toBe(200);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].params[0]).toBe(body.title);
    expect(db.calls[0].params[1]).toBe(body.content);
    expect(res.body.notice.title).toBe(body.title);
    expect(res.body.notice.content).toBe(body.content);
    expect(db.calls[0].sql).not.toMatch(/onerror|<script|<img/);
  });

  // Phase 4B.36: the raw error text is logged, not returned.
  test('a failing INSERT returns 500 { success:false, error } without the raw error text', async () => {
    db.on(SQL.insertWithExpiry, () => {
      throw new Error('insert failed');
    });

    const res = await api('superAdmin').post('/api/admin/notices').send(VALID_ADMIN_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(errSpy).toHaveBeenCalledWith('POST /api/admin/notices error:', 'insert failed');
    errSpy.mockClear();
  });

  // The five G5 todos that used to sit here (legacy L224, L235, L251, L265,
  // L279) are covered by the Phase 4B.36 describe blocks at the end of this
  // file. L279 ("rejects a past expiry") is SUPERSEDED: Decision 3A permits
  // past expiry timestamps, and those blocks assert that they are accepted.
});

// ============================================================================
// PUT /api/admin/notices/:id
// ============================================================================

describe('PUT /api/admin/notices/:id', () => {
  // legacy L374
  test('without a session answers 403 and performs no database access [legacy L374]', async () => {
    const res = await api('none').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.calls).toEqual([]);
  });

  // legacy L383 — rewritten: the notice is looked up first (ward + category in
  // ONE statement since Phase 4B.36), then a parameterised UPDATE.
  test('updates a notice in the caller\'s ward → 200 { success, notice } [legacy L383]', async () => {
    stubNoticeScopes({ 5: { ward_id: WARD, category: 'public' } });
    stubUpdateEcho();

    const res = await api('wardAdmin1').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.notice.title).toBe('Updated Notice Title');
    expect(res.body).not.toHaveProperty('data');
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].sql).toMatch(SQL.noticeScope);
    expect(db.calls[0].params).toEqual(['5']);
    expect(db.calls[1].sql).toMatch(SQL.update);
    expect(db.calls[1].params).toEqual([
      'Updated Notice Title',
      'Updated content for the notice.',
      'public',
      'high',
      VALID_UPDATE_BODY.expiresAt,
      '5',
      true,
      'health',
    ]);
  });

  // legacy L397 — the 404 contract still holds, for an INTEGER id.
  test('an id that does not exist → 404 { success:false, error } and no UPDATE runs [legacy L397]', async () => {
    stubNoticeScopes({});

    const res = await api('superAdmin').put('/api/admin/notices/999').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Notice not found' });
    expect(db.writes()).toEqual([]);
  });

  test('a notice that vanishes between the ward lookup and the UPDATE → 404', async () => {
    stubNoticeScopes({ 5: { ward_id: WARD, category: 'public' } });
    db.on(SQL.update, rows());

    const res = await api('superAdmin').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Notice not found' });
  });

  // O2 — EMULATED pg integer cast: legacy tests used a UUID id; ids are SERIAL.
  // (The owner has since confirmed the live column is UUID; this emulation is
  // outdated and is left as is -- it is outside Phase 4B.36.)
  test('a non-integer (UUID) id is rejected by the DB layer and surfaces as 500 — EMULATED pg 22P02 (observation O2) [legacy L397]', async () => {
    stubNoticeScopes({});

    const res = await api('superAdmin')
      .put('/api/admin/notices/00000000-0000-0000-0000-000000000000')
      .send(VALID_UPDATE_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(db.writes()).toEqual([]);
    expect(errSpy).toHaveBeenCalledTimes(1);
    // The diagnostic stays in the server log.
    expect(String(errSpy.mock.calls[0][1])).toMatch(/invalid input syntax for type integer/);
    errSpy.mockClear();
  });

  test('requires title and content → 400 before any database access', async () => {
    const res = await api('superAdmin').put('/api/admin/notices/5').send({ title: 'Only a title' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'title and content are required' });
    expect(db.calls).toEqual([]);
  });

  test('a WARD_ADMIN of a different ward is refused and no UPDATE runs', async () => {
    stubNoticeScopes({ 5: { ward_id: WARD, category: 'public' } });

    const res = await api('wardAdmin2').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.writes()).toEqual([]);
  });

  test('a failing UPDATE returns 500 { success:false, error } without the raw error text', async () => {
    stubNoticeScopes({ 5: { ward_id: WARD, category: 'public' } });
    db.on(SQL.update, () => {
      throw new Error('update failed');
    });

    const res = await api('superAdmin').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(errSpy).toHaveBeenCalledWith('PUT /api/admin/notices error:', 'update failed');
    errSpy.mockClear();
  });
});

// ============================================================================
// DELETE /api/admin/notices/:id
// ============================================================================

describe('DELETE /api/admin/notices/:id', () => {
  // legacy L434
  test('without a session answers 403 and performs no database access [legacy L434]', async () => {
    const res = await api('none').delete('/api/admin/notices/5');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.calls).toEqual([]);
  });

  // legacy L442
  test('deletes an existing notice in the caller\'s ward → 200 { success:true } [legacy L442]', async () => {
    stubNoticeWards({ 5: WARD });
    db.on(SQL.del, rows());

    const res = await api('wardAdmin1').delete('/api/admin/notices/5');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.calls.map((c) => c.sql)).toEqual([
      'SELECT ward_id FROM notices WHERE id = $1',
      'DELETE FROM notices WHERE id = $1',
    ]);
    expect(db.calls[1].params).toEqual(['5']);
  });

  // legacy L451 — outdated. By documented design (comment above the route) a
  // missing id is a no-op that still answers success; it is not a 404.
  test('a missing id is a successful no-op, not a 404 [legacy L451]', async () => {
    stubNoticeWards({});
    db.on(SQL.del, rows());

    const res = await api('superAdmin').delete('/api/admin/notices/999');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.calls[1].sql).toMatch(SQL.del);
    expect(db.calls[1].params).toEqual(['999']);
  });

  // legacy L460 (intent: soft delete) — G6 characterization: it is a hard delete.
  test('performs a hard DELETE; no archive UPDATE is issued (gap G6) [legacy L460]', async () => {
    stubNoticeWards({ 5: WARD });
    db.on(SQL.del, rows());

    await api('superAdmin').delete('/api/admin/notices/5');

    expect(db.calls.some((c) => /^DELETE FROM notices/.test(c.sql))).toBe(true);
    expect(db.calls.some((c) => /^UPDATE|is_archived/.test(c.sql))).toBe(false);
  });

  test('a WARD_ADMIN of a different ward is refused and nothing is deleted', async () => {
    stubNoticeWards({ 5: WARD });

    const res = await api('wardAdmin2').delete('/api/admin/notices/5');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.writes()).toEqual([]);
  });

  test('a non-integer (UUID) id surfaces as 500 — EMULATED pg 22P02 (observation O2) [legacy L451]', async () => {
    stubNoticeWards({});

    const res = await api('superAdmin').delete('/api/admin/notices/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(db.writes()).toEqual([]);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockClear();
  });

  test('a failing DELETE returns 500 { success:false, error } without the raw error text', async () => {
    stubNoticeWards({ 5: WARD });
    db.on(SQL.del, () => {
      throw new Error('delete failed');
    });

    const res = await api('superAdmin').delete('/api/admin/notices/5');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(errSpy).toHaveBeenCalledWith('DELETE /api/admin/notices error:', 'delete failed');
    errSpy.mockClear();
  });

  test.todo('[G6] soft-deletes (archives) instead of hard-deleting (legacy L460 intent)');
});

// ============================================================================
// Additional notice routes (not covered by the legacy file)
// ============================================================================

describe('POST /api/notices (day-count variant)', () => {
  test('a WARD_ADMIN of the target ward creates a notice with a day-based expiry → 200 { success, notice }', async () => {
    stubInsertWithDaysEcho();

    const res = await api('wardAdmin1')
      .post('/api/notices')
      .send({ title: 'Clinic day', content: 'Free check-ups.', category: 'public', priority: 'high', days: 7, wardId: WARD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.notice).toMatchObject({ id: 102, title: 'Clinic day', ward_id: WARD });
    expect(db.calls[0].params).toEqual(['Clinic day', 'Free check-ups.', 'public', 'high', '7', WARD]);
  });

  // Phase 4B.36: the sample title/content were 1 character long; they now have
  // to satisfy the 5 / 10 character minimums.
  test('defaults to 30 days, general and normal', async () => {
    stubInsertWithDaysEcho();

    await api('superAdmin').post('/api/notices').send({ title: 'Valid title', content: 'Valid content text' });

    expect(db.calls[0].params).toEqual(['Valid title', 'Valid content text', 'general', 'normal', '30', WARD]);
  });

  test('requires title and content → 400 and writes nothing', async () => {
    const res = await api('superAdmin').post('/api/notices').send({ title: 'T' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'title and content are required' });
    expect(db.calls).toEqual([]);
  });

  test('a WARD_ADMIN of a different ward is refused', async () => {
    const res = await api('wardAdmin2')
      .post('/api/notices')
      .send({ title: 'Valid title', content: 'Valid content text', wardId: WARD });

    expect(res.status).toBe(403);
    expect(db.calls).toEqual([]);
  });
});

describe('DELETE /api/notices/:id (twin of the admin route)', () => {
  test('deletes an existing notice in the caller\'s ward → 200 { success:true }', async () => {
    stubNoticeWards({ 5: WARD });
    db.on(SQL.del, rows());

    const res = await api('wardAdmin1').delete('/api/notices/5');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.calls[1].params).toEqual(['5']);
  });

  test('a WARD_ADMIN of a different ward is refused and nothing is deleted', async () => {
    stubNoticeWards({ 5: WARD });

    const res = await api('wardAdmin2').delete('/api/notices/5');

    expect(res.status).toBe(403);
    expect(db.writes()).toEqual([]);
  });
});

describe('GET /api/admin/notices', () => {
  test('a SUPER_ADMIN reads every ward: no WHERE clause, no parameters', async () => {
    db.on(SQL.adminList, rows({ id: 1, title: 'A', ward_id: WARD }, { id: 2, title: 'B', ward_id: OTHER_WARD }));

    const res = await api('superAdmin').get('/api/admin/notices');

    expect(res.status).toBe(200);
    expect(res.body.data.notices).toHaveLength(2);
    expect(db.calls[0].sql).not.toMatch(/\bWHERE\b/);
    expect(db.calls[0].params).toEqual([]);
  });

  test('a MODERATOR has a global read scope', async () => {
    db.on(SQL.adminList, rows());

    const res = await api('moderator').get('/api/admin/notices');

    expect(res.status).toBe(200);
    expect(db.calls[0].sql).not.toMatch(/\bWHERE\b/);
  });

  test('a WARD_ADMIN is restricted to their own ward through a bound parameter', async () => {
    db.on(SQL.adminList, rows({ id: 1, title: 'A', ward_id: WARD }));

    const res = await api('wardAdmin1').get('/api/admin/notices');

    expect(res.status).toBe(200);
    expect(db.calls[0].sql).toContain('WHERE n.ward_id = $1');
    expect(db.calls[0].params).toEqual([WARD]);
  });

  // O3 — characterization of an inconsistent response shape.
  test('answers { success, data: { notices } }, unlike the flat public feed (observation O3)', async () => {
    db.on(SQL.adminList, rows({ id: 1, title: 'A', ward_id: WARD }));

    const res = await api('superAdmin').get('/api/admin/notices');

    expect(res.body).toEqual({ success: true, data: { notices: [{ id: 1, title: 'A', ward_id: WARD }] } });
  });

  test('a failing query returns 500 { success:false, error }', async () => {
    db.on(SQL.adminList, () => {
      throw new Error('list failed');
    });

    const res = await api('superAdmin').get('/api/admin/notices');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'list failed' });
    expect(errSpy).toHaveBeenCalledWith('GET /api/admin/notices error:', 'list failed');
    errSpy.mockClear();
  });
});

// ============================================================================
// Security
// ============================================================================

describe('Security', () => {
  const PROTECTED_ROUTES = [
    ['GET', '/api/admin/notices', undefined],
    ['POST', '/api/notices', { title: 'T', content: 'C' }],
    ['DELETE', '/api/notices/5', undefined],
    ['POST', '/api/admin/notices', { title: 'T', content: 'C' }],
    ['PUT', '/api/admin/notices/5', { title: 'T', content: 'C' }],
    ['DELETE', '/api/admin/notices/5', undefined],
  ];
  const DENIED_PERSONAS = ['none', 'voter', 'unknownRole'];
  const DENIED_CASES = PROTECTED_ROUTES.flatMap(([method, url, body]) =>
    DENIED_PERSONAS.map((persona) => [method, url, persona, body]));

  // legacy L560 — rewritten: 403 (not 401), success:false, and — new — no DB access.
  test.each(DENIED_CASES)('%s %s as %s → 403 Forbidden with zero database queries [legacy L560]', async (method, url, persona, body) => {
    let req = api(persona)[method.toLowerCase()](url);
    if (body) req = req.send(body);

    const res = await req;

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.calls).toEqual([]);
  });

  // Defence in depth (new — no legacy equivalent). When the target ward id is
  // null the ward-scope check is skipped, so ONLY the MODERATOR+ role gate
  // stops a signed-in VOTER. Without these cases a missing gate on the POST
  // routes would be invisible, because the scope check returns the same 403.
  describe('the role gate holds on its own when no ward scope applies', () => {
    test('POST /api/admin/notices as VOTER with no ward id → 403, zero queries', async () => {
      wardCache.setFoundingWardId(null);

      const res = await api('voter').post('/api/admin/notices').send({ title: 'T', content: 'C' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Forbidden' });
      expect(db.calls).toEqual([]);
    });

    test('POST /api/notices as VOTER with no ward id → 403, zero queries', async () => {
      wardCache.setFoundingWardId(null);

      const res = await api('voter').post('/api/notices').send({ title: 'T', content: 'C' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Forbidden' });
      expect(db.calls).toEqual([]);
    });

    test.each([
      ['PUT', '/api/admin/notices/5', { title: 'T', content: 'C' }],
      ['DELETE', '/api/admin/notices/5', undefined],
      ['DELETE', '/api/notices/5', undefined],
    ])('%s %s as VOTER on a notice that has no ward → 403, zero queries', async (method, url, body) => {
      stubNoticeWards({ 5: null });
      let req = api('voter')[method.toLowerCase()](url);
      if (body) req = req.send(body);

      const res = await req;

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Forbidden' });
      expect(db.calls).toEqual([]);
    });
  });
});


// ============================================================================
// Phase 4B.36 — validation and ward-security hardening
// ============================================================================
// Everything below drives the REAL routes through the same fake database as
// the rest of this file. Where a case says "no database access" the assertion
// is `db.calls` toEqual([]) — not even the lookup ran.
//
// Expected messages are written out literally on purpose, so a reworded
// message is a visible test change rather than a silent one.
// (lib/notice-validation.js is unit-tested separately in
// __tests__/notice-validation.test.js.)

const MSG = {
  required: 'title and content are required',
  text: 'title and content must be text',
  title: 'title must be between 5 and 200 characters',
  content: 'content must be between 10 and 5000 characters',
  category: 'category must be one of: general, public, service, payment, event, business, jobs',
  healthRequired: 'category must be supplied for this notice: send "health" to keep it, or one of: general, public, service, payment, event, business, jobs',
  priority: 'priority must be one of: normal, high, low',
  expiresAt: 'expiresAt must be an ISO-8601 timestamp (for example 2030-01-31T18:00:00Z) or null',
  days: 'days must be a whole number between 1 and 365',
  wardId: 'wardId must be a positive whole number',
  unknownWard: 'wardId does not match an existing ward',
  foundingWard: 'The default ward is not available right now. Please try again later.',
  server: 'Internal server error',
};

const APPROVED_CATEGORIES = ['general', 'public', 'service', 'payment', 'event', 'business', 'jobs'];
const APPROVED_PRIORITIES = ['normal', 'high', 'low'];
const ADMIN_PERSONAS = ['superAdmin', 'wardAdmin1', 'wardAdmin2', 'moderator', 'countyAdmin', 'constituencyAdmin'];
const BASE_TEXT = { title: 'A valid notice title', content: 'A valid notice body text.' };
const LOOKUP_SQL = 'SELECT ward_id, category FROM notices WHERE id = $1';

// The three routes that take a notice body. `prepare()` registers the fakes a
// SUCCESSFUL call needs. For POST routes the persisted statement is the
// INSERT; for PUT it is the UPDATE issued after the lookup.
const BODY_ROUTES = [
  {
    label: 'POST /api/admin/notices',
    send: (body, persona = 'superAdmin') => api(persona).post('/api/admin/notices').send(body),
    prepare: () => stubInsertWithExpiryEcho(),
  },
  {
    label: 'POST /api/notices',
    send: (body, persona = 'superAdmin') => api(persona).post('/api/notices').send(body),
    prepare: () => stubInsertWithDaysEcho(),
  },
  {
    label: 'PUT /api/admin/notices/:id',
    send: (body, persona = 'superAdmin') => api(persona).put('/api/admin/notices/5').send(body),
    prepare: () => {
      stubNoticeScopes({ 5: { ward_id: WARD, category: 'public' } });
      stubUpdateEcho();
    },
  },
];
const CREATE_ROUTES = BODY_ROUTES.slice(0, 2);

const writtenParams = () => db.writes()[0].params;
const lastParam = () => writtenParams()[writtenParams().length - 1];

function expectBadRequest(res, message) {
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ success: false, error: message });
  expect(db.calls).toEqual([]);
}

// ───────────────────────── title / content ──────────────────────────────────

describe('Phase 4B.36 — title and content validation', () => {
  for (const route of BODY_ROUTES) {
    describe(route.label, () => {
      for (const field of ['title', 'content']) {
        for (const [label, value] of [
          ['missing', undefined],
          ['null', null],
          ['an empty string', ''],
          ['whitespace only', ' \t\n  '],
        ]) {
          test(`${field} ${label} → 400 "required", no database access`, async () => {
            route.prepare();
            expectBadRequest(await route.send({ ...BASE_TEXT, [field]: value }), MSG.required);
          });
        }

        for (const [label, value] of [
          ['a number', 12345],
          ['zero', 0],
          ['an object', { a: 1 }],
          ['an array', ['a valid looking title']],
          ['true', true],
          ['false', false],
        ]) {
          test(`${field} as ${label} → 400 "must be text", no database access`, async () => {
            route.prepare();
            expectBadRequest(await route.send({ ...BASE_TEXT, [field]: value }), MSG.text);
          });
        }
      }

      for (const [field, index, message, cases] of [
        ['title', 0, MSG.title, [[4, false], [5, true], [200, true], [201, false]]],
        ['content', 1, MSG.content, [[9, false], [10, true], [5000, true], [5001, false]]],
      ]) {
        for (const [length, accepted] of cases) {
          test(`${field} of ${length} characters is ${accepted ? 'accepted' : 'rejected with 400'}`, async () => {
            route.prepare();
            const value = 'x'.repeat(length);

            const res = await route.send({ ...BASE_TEXT, [field]: value });

            if (accepted) {
              expect(res.status).toBe(200);
              expect(writtenParams()[index]).toBe(value);
            } else {
              expectBadRequest(res, message);
            }
          });
        }
      }

      test('title and content are trimmed before they are stored', async () => {
        route.prepare();

        const res = await route.send({ title: '   Padded title   ', content: '\n  Padded content text \t' });

        expect(res.status).toBe(200);
        expect(writtenParams()[0]).toBe('Padded title');
        expect(writtenParams()[1]).toBe('Padded content text');
      });

      test('the minimums apply AFTER trimming (4 + padding → 400, 5 + padding → ok)', async () => {
        route.prepare();
        expectBadRequest(await route.send({ ...BASE_TEXT, title: '  abcd  ' }), MSG.title);

        db.reset();
        route.prepare();
        const ok = await route.send({ ...BASE_TEXT, title: '  abcde  ' });
        expect(ok.status).toBe(200);
        expect(writtenParams()[0]).toBe('abcde');
      });

      test('the content minimum applies AFTER trimming (9 + padding → 400, 10 + padding → ok)', async () => {
        route.prepare();
        expectBadRequest(await route.send({ ...BASE_TEXT, content: '   123456789   ' }), MSG.content);

        db.reset();
        route.prepare();
        const ok = await route.send({ ...BASE_TEXT, content: '   1234567890   ' });
        expect(ok.status).toBe(200);
        expect(writtenParams()[1]).toBe('1234567890');
      });

      test('the maximum applies AFTER trimming (200 characters + padding is accepted)', async () => {
        route.prepare();

        const res = await route.send({ ...BASE_TEXT, title: ` ${'x'.repeat(200)} ` });

        expect(res.status).toBe(200);
        expect(writtenParams()[0]).toBe('x'.repeat(200));
      });

      // UTF-16 .length, the same unit as the UI's maxlength: an emoji is TWO
      // code units, so 100 of them hit the 200 limit exactly while 101 do not
      // fit even though 101 < 200 "characters".
      test('UTF-16 length: 100 emoji (200 code units) are accepted as a title', async () => {
        route.prepare();
        const title = '😀'.repeat(100);

        const res = await route.send({ ...BASE_TEXT, title });

        expect(res.status).toBe(200);
        expect(title.length).toBe(200);
        expect(writtenParams()[0]).toBe(title);
      });

      test('UTF-16 length: 101 emoji (202 code units) are rejected as a title', async () => {
        route.prepare();
        const title = '😀'.repeat(101);
        expect(title.length).toBe(202);

        expectBadRequest(await route.send({ ...BASE_TEXT, title }), MSG.title);
      });

      test('UTF-16 length: 2500 emoji (5000 code units) are accepted as content, 2501 are not', async () => {
        route.prepare();
        const ok = await route.send({ ...BASE_TEXT, content: '😀'.repeat(2500) });
        expect(ok.status).toBe(200);

        db.reset();
        route.prepare();
        expectBadRequest(await route.send({ ...BASE_TEXT, content: '😀'.repeat(2501) }), MSG.content);
      });
    });
  }
});

// ───────────────────────── category / priority ──────────────────────────────

describe('Phase 4B.36 — category and priority validation', () => {
  for (const route of BODY_ROUTES) {
    describe(route.label, () => {
      for (const category of APPROVED_CATEGORIES) {
        test(`category "${category}" is accepted and bound`, async () => {
          route.prepare();

          const res = await route.send({ ...BASE_TEXT, category });

          expect(res.status).toBe(200);
          expect(writtenParams()[2]).toBe(category);
        });
      }

      for (const priority of APPROVED_PRIORITIES) {
        test(`priority "${priority}" is accepted and bound`, async () => {
          route.prepare();

          const res = await route.send({ ...BASE_TEXT, priority });

          expect(res.status).toBe(200);
          expect(writtenParams()[3]).toBe(priority);
        });
      }

      for (const [label, value] of [
        ['an unknown value', 'unknown'],
        ['the wrong case', 'Public'],
        ['upper case', 'PUBLIC'],
        ['a leading space', ' public'],
        ['a trailing space', 'public '],
        ['an empty string', ''],
        ['a trailing newline', 'general\n'],
        ['a number', 1],
        ['null', null],
        ['an array', ['public']],
        ['an object', { a: 1 }],
        ['true', true],
      ]) {
        test(`category as ${label} → 400, no database access`, async () => {
          route.prepare();
          expectBadRequest(await route.send({ ...BASE_TEXT, category: value }), MSG.category);
        });
      }

      for (const [label, value] of [
        ['an unknown value', 'urgent'],
        ['the wrong case', 'High'],
        ['upper case', 'HIGH'],
        ['a leading space', ' high'],
        ['a trailing space', 'normal '],
        ['an empty string', ''],
        ['a number', 1],
        ['null', null],
        ['an array', ['high']],
        ['an object', { a: 1 }],
        ['false', false],
      ]) {
        test(`priority as ${label} → 400, no database access`, async () => {
          route.prepare();
          expectBadRequest(await route.send({ ...BASE_TEXT, priority: value }), MSG.priority);
        });
      }

      test('omitted category and priority keep the existing defaults: general and normal', async () => {
        route.prepare();

        const res = await route.send(BASE_TEXT);

        expect(res.status).toBe(200);
        expect(writtenParams()[2]).toBe('general');
        expect(writtenParams()[3]).toBe('normal');
      });
    });
  }
});

// ───────────────────────── legacy `health` category ─────────────────────────

describe('Phase 4B.36 — legacy "health" category', () => {
  const HEALTH_NOTICE = { 5: { ward_id: WARD, category: 'health' } };

  for (const route of CREATE_ROUTES) {
    test(`${route.label}: a NEW notice may not use "health" → 400, no database access`, async () => {
      route.prepare();
      expectBadRequest(await route.send({ ...BASE_TEXT, category: 'health' }), MSG.category);
    });
  }

  test('PUT: an existing health notice can be updated while keeping "health"', async () => {
    stubNoticeScopes(HEALTH_NOTICE);
    stubUpdateEcho();

    const res = await api('wardAdmin1').put('/api/admin/notices/5').send({ ...VALID_UPDATE_BODY, category: 'health' });

    expect(res.status).toBe(200);
    expect(res.body.notice.category).toBe('health');
    // ONE lookup statement supplies both the ward and the category.
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].sql).toBe(LOOKUP_SQL);
    expect(db.calls[0].params).toEqual(['5']);
    expect(db.calls[1].sql).toMatch(SQL.update);
    expect(db.calls[1].params[2]).toBe('health');
    expect(db.calls[1].params[7]).toBe('health');
  });

  test('PUT: the UPDATE itself refuses "health" on a row that does not store it (no check-then-write gap)', async () => {
    stubNoticeScopes(HEALTH_NOTICE);
    stubUpdateEcho();

    await api('superAdmin').put('/api/admin/notices/5').send({ ...VALID_UPDATE_BODY, category: 'health' });

    expect(db.calls[1].sql).toContain('AND ($3 <> $8 OR category = $8)');
  });

  test('PUT: a health notice can be moved to an approved category', async () => {
    stubNoticeScopes(HEALTH_NOTICE);
    stubUpdateEcho();

    const res = await api('superAdmin').put('/api/admin/notices/5').send({ ...VALID_UPDATE_BODY, category: 'event' });

    expect(res.status).toBe(200);
    expect(db.calls[1].params[2]).toBe('event');
  });

  test('PUT: a health notice cannot be changed to an unapproved category → 400, no database access', async () => {
    stubNoticeScopes(HEALTH_NOTICE);

    expectBadRequest(
      await api('superAdmin').put('/api/admin/notices/5').send({ ...VALID_UPDATE_BODY, category: 'unknown' }),
      MSG.category,
    );
  });

  test('PUT: omitting category on a health notice is rejected — it is never silently rewritten to "general"', async () => {
    stubNoticeScopes(HEALTH_NOTICE);
    stubUpdateEcho();
    const { category: _omitted, ...withoutCategory } = VALID_UPDATE_BODY;

    const res = await api('superAdmin').put('/api/admin/notices/5').send(withoutCategory);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: MSG.healthRequired });
    expect(db.calls.map((c) => c.sql)).toEqual([LOOKUP_SQL]);
    expect(db.writes()).toEqual([]);
  });

  test('PUT: "health" cannot be put on a notice that does not already store it → 400, no UPDATE', async () => {
    stubNoticeScopes({ 5: { ward_id: WARD, category: 'public' } });
    stubUpdateEcho();

    const res = await api('superAdmin').put('/api/admin/notices/5').send({ ...VALID_UPDATE_BODY, category: 'health' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: MSG.category });
    expect(db.writes()).toEqual([]);
  });

  test('PUT: "health" cannot be put on a notice whose stored category is NULL → 400, no UPDATE', async () => {
    stubNoticeScopes({ 5: { ward_id: WARD, category: null } });
    stubUpdateEcho();

    const res = await api('superAdmin').put('/api/admin/notices/5').send({ ...VALID_UPDATE_BODY, category: 'health' });

    expect(res.status).toBe(400);
    expect(db.writes()).toEqual([]);
  });

  test('PUT: a caller who may not touch the notice gets 403 whatever the stored category (nothing is revealed)', async () => {
    const outcomes = [];
    for (const [stored, category] of [['health', 'health'], ['health', undefined], ['public', 'health']]) {
      db.reset();
      stubNoticeScopes({ 5: { ward_id: WARD, category: stored } });
      const body = { ...VALID_UPDATE_BODY, category };
      const res = await api('wardAdmin2').put('/api/admin/notices/5').send(body);
      outcomes.push([res.status, res.body]);
      expect(db.writes()).toEqual([]);
    }

    for (const outcome of outcomes) {
      expect(outcome).toEqual([403, { success: false, error: 'Forbidden' }]);
    }
  });

  test('PUT: if the stored category changes between the lookup and the UPDATE the guard matches no row → 404', async () => {
    stubNoticeScopes(HEALTH_NOTICE);
    db.on(SQL.update, rows());

    const res = await api('superAdmin').put('/api/admin/notices/5').send({ ...VALID_UPDATE_BODY, category: 'health' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Notice not found' });
    expect(db.calls[1].params[2]).toBe('health');
  });
});

// ───────────────────────── expiry ───────────────────────────────────────────

const MALFORMED_EXPIRY = [
  ['a number', 12345],
  ['zero', 0],
  ['an object', { a: 1 }],
  ['an array', []],
  ['true', true],
  ['an empty string', ''],
  ['an invalid string', 'garbage'],
  ['a word', 'tomorrow'],
  ['leading whitespace', ' 2030-01-31T18:00:00Z'],
  ['trailing whitespace', '2030-01-31T18:00:00Z '],
  ['a date only', '2030-01-31'],
  ['a space instead of T', '2030-01-31 18:00:00'],
  ['lowercase t and z', '2030-01-31t18:00:00z'],
  ['an impossible day', '2030-02-30T10:00:00Z'],
  ['a non-leap 29 February', '2023-02-29T10:00:00Z'],
  ['month 13', '2030-13-01T10:00:00Z'],
  ['hour 25', '2030-01-31T25:00:00Z'],
  ['hour 24', '2030-01-31T24:00:00Z'],
  ['second 60', '2030-01-31T10:00:60Z'],
  ['year 0000', '0000-01-01T00:00:00Z'],
  ['an offset of +25:00', '2030-01-31T10:00:00+25:00'],
];

const ACCEPTED_EXPIRY = [
  ['the shape the admin UI sends', '2030-01-31T18:00:00.000Z'],
  ['seconds and Z', '2030-01-31T18:00:00Z'],
  ['a positive offset', '2030-01-31T18:00:00+03:00'],
  ['a negative offset', '2030-01-31T18:00:00-05:30'],
  ['no zone designator', '2030-01-31T18:00:00'],
  ['no seconds', '2030-01-31T18:00'],
  ['a leap day', '2024-02-29T00:00:00Z'],
  ['a PAST timestamp', '2020-01-01T00:00:00.000Z'],
];

describe('Phase 4B.36 — expiry validation and semantics', () => {
  describe('POST /api/admin/notices', () => {
    test('a valid future timestamp is stored exactly as given', async () => {
      stubInsertWithExpiryEcho();

      const res = await api('superAdmin').post('/api/admin/notices').send({ ...BASE_TEXT, expiresAt: '2031-06-30T12:00:00.000Z' });

      expect(res.status).toBe(200);
      expect(writtenParams()[4]).toBe('2031-06-30T12:00:00.000Z');
    });

    for (const [label, value] of ACCEPTED_EXPIRY) {
      test(`${label} is accepted and bound unchanged`, async () => {
        stubInsertWithExpiryEcho();

        const res = await api('superAdmin').post('/api/admin/notices').send({ ...BASE_TEXT, expiresAt: value });

        expect(res.status).toBe(200);
        expect(writtenParams()[4]).toBe(value);
      });
    }

    test('a past expiry is permitted on creation (Decision 3A); the feed rule still hides the notice', async () => {
      stubInsertWithExpiryEcho();

      const created = await api('superAdmin').post('/api/admin/notices').send({ ...BASE_TEXT, expiresAt: '2020-01-01T00:00:00.000Z' });
      expect(created.status).toBe(200);
      expect(writtenParams()[4]).toBe('2020-01-01T00:00:00.000Z');

      stubFeed();
      await api('none').get('/api/notices');
      const feed = db.calls.find((c) => SQL.listNotices.test(c.sql));
      expect(feed.sql).toContain('(expires_at IS NULL OR expires_at > NOW())');
      expect(feed.sql).toContain('COALESCE(is_archived, false) = false');
    });

    test('null and an omitted expiresAt both mean "no expiry" on creation (unchanged)', async () => {
      stubInsertWithExpiryEcho();
      await api('superAdmin').post('/api/admin/notices').send({ ...BASE_TEXT, expiresAt: null });
      const explicitNull = writtenParams()[4];

      db.reset();
      stubInsertWithExpiryEcho();
      await api('superAdmin').post('/api/admin/notices').send(BASE_TEXT);

      expect(explicitNull).toBe(null);
      expect(writtenParams()[4]).toBe(null);
    });
  });

  for (const route of [BODY_ROUTES[0], BODY_ROUTES[2]]) {
    for (const [label, value] of MALFORMED_EXPIRY) {
      test(`${route.label}: expiresAt as ${label} → 400, no database access`, async () => {
        route.prepare();
        expectBadRequest(await route.send({ ...BASE_TEXT, expiresAt: value }), MSG.expiresAt);
      });
    }
  }

  test('POST /api/notices has no expiresAt input (it uses days): the property is ignored, as before', async () => {
    stubInsertWithDaysEcho();

    const res = await api('superAdmin').post('/api/notices').send({ ...BASE_TEXT, expiresAt: 'garbage' });

    expect(res.status).toBe(200);
    expect(writtenParams()[4]).toBe('30');
  });

  describe('PUT /api/admin/notices/:id — omitted vs null vs a new value (Decision 2A)', () => {
    const { expiresAt: _dropped, ...WITHOUT_EXPIRY } = VALID_UPDATE_BODY;

    function prepareUpdate() {
      stubNoticeScopes({ 5: { ward_id: WARD, category: 'public' } });
      stubUpdateEcho();
    }

    test('expiresAt OMITTED preserves the stored expiry (the UPDATE is told not to touch expires_at)', async () => {
      prepareUpdate();

      const res = await api('superAdmin').put('/api/admin/notices/5').send(WITHOUT_EXPIRY);

      expect(res.status).toBe(200);
      expect(db.calls[1].params[4]).toBe(null);
      expect(db.calls[1].params[6]).toBe(false);
      expect(db.calls[1].sql).toContain('expires_at = CASE WHEN $7::boolean THEN $5::timestamp ELSE expires_at END');
      expect(res.body.notice).not.toHaveProperty('expires_at');
    });

    test('expiresAt: null CLEARS the expiry', async () => {
      prepareUpdate();

      const res = await api('superAdmin').put('/api/admin/notices/5').send({ ...WITHOUT_EXPIRY, expiresAt: null });

      expect(res.status).toBe(200);
      expect(db.calls[1].params[4]).toBe(null);
      expect(db.calls[1].params[6]).toBe(true);
      expect(res.body.notice.expires_at).toBe(null);
    });

    test('a valid expiresAt REPLACES the expiry', async () => {
      prepareUpdate();

      const res = await api('superAdmin').put('/api/admin/notices/5').send({ ...WITHOUT_EXPIRY, expiresAt: '2032-02-02T02:02:02.000Z' });

      expect(res.status).toBe(200);
      expect(db.calls[1].params[4]).toBe('2032-02-02T02:02:02.000Z');
      expect(db.calls[1].params[6]).toBe(true);
    });

    test('an omitted property and an explicit null are told apart (different setExpiry flag)', async () => {
      prepareUpdate();
      await api('superAdmin').put('/api/admin/notices/5').send(WITHOUT_EXPIRY);
      const omittedFlag = db.calls[1].params[6];

      db.reset();
      prepareUpdate();
      await api('superAdmin').put('/api/admin/notices/5').send({ ...WITHOUT_EXPIRY, expiresAt: null });

      expect(omittedFlag).toBe(false);
      expect(db.calls[1].params[6]).toBe(true);
    });

    for (const [label, value] of ACCEPTED_EXPIRY) {
      test(`${label} is accepted on update and bound unchanged`, async () => {
        prepareUpdate();

        const res = await api('superAdmin').put('/api/admin/notices/5').send({ ...WITHOUT_EXPIRY, expiresAt: value });

        expect(res.status).toBe(200);
        expect(db.calls[1].params[4]).toBe(value);
        expect(db.calls[1].params[6]).toBe(true);
      });
    }

    test('a past expiry is permitted on update (Decision 3A)', async () => {
      prepareUpdate();

      const res = await api('superAdmin').put('/api/admin/notices/5').send({ ...WITHOUT_EXPIRY, expiresAt: '2019-05-05T05:05:05.000Z' });

      expect(res.status).toBe(200);
      expect(db.calls[1].params[4]).toBe('2019-05-05T05:05:05.000Z');
    });

    test('a notice whose expiry has already passed can still be updated (there is no expired-state check)', async () => {
      // The lookup does not even read expires_at: an expired notice is just a
      // notice. Editing it with expiresAt omitted leaves its expiry alone.
      prepareUpdate();

      const res = await api('wardAdmin1').put('/api/admin/notices/5').send(WITHOUT_EXPIRY);

      expect(res.status).toBe(200);
      expect(db.calls[0].sql).not.toContain('expires_at');
      expect(db.calls[1].params[6]).toBe(false);
    });
  });

  describe('POST /api/notices — days', () => {
    const sendDays = (days, persona = 'superAdmin') => {
      const body = { ...BASE_TEXT };
      if (days !== undefined) body.days = days;
      return api(persona).post('/api/notices').send(body);
    };

    for (const [label, value] of [['omitted', undefined], ['null', null], ['zero', 0], ['the string "0"', '0']]) {
      test(`days ${label} keeps the 30-day default`, async () => {
        stubInsertWithDaysEcho();

        const res = await sendDays(value);

        expect(res.status).toBe(200);
        expect(writtenParams()[4]).toBe('30');
      });
    }

    for (const [value, bound] of [[1, '1'], [7, '7'], ['7', '7'], [30, '30'], [365, '365'], ['365', '365']]) {
      test(`days ${JSON.stringify(value)} is accepted and bound as "${bound}"`, async () => {
        stubInsertWithDaysEcho();

        const res = await sendDays(value);

        expect(res.status).toBe(200);
        expect(writtenParams()[4]).toBe(bound);
      });
    }

    for (const [label, value] of [
      ['true', true],
      ['false', false],
      ['an empty array', []],
      ['an array holding a number', [3]],
      ['an object', { a: 1 }],
      ['a non-numeric string', 'abc'],
      ['an empty string', ''],
      ['a string with a leading space', ' 7'],
      ['a string with a trailing space', '7 '],
      ['a fractional string', '3.5'],
      ['a fractional number', 3.5],
      ['a negative number', -1],
      ['a negative string', '-1'],
      ['an exponent string', '1e2'],
      ['a zero-padded string', '007'],
      ['a plus-signed string', '+7'],
      ['one above the upper bound (366)', 366],
      ['one above the upper bound as a string', '366'],
      ['an unreasonably large number', 1e12],
    ]) {
      test(`days as ${label} → 400, no database access`, async () => {
        stubInsertWithDaysEcho();
        expectBadRequest(await sendDays(value), MSG.days);
      });
    }
  });
});

// ───────────────────────── wardId (SG3) ─────────────────────────────────────

describe('Phase 4B.36 — strict wardId (SG3)', () => {
  const INVALID_WARD_IDS = [
    ['the string "abc"', 'abc'],
    ['the string "0"', '0'],
    ['the string "-3"', '-3'],
    ['the string "2.9"', '2.9'],
    ['the string "7abc"', '7abc'],
    ['the number 1e21', 1e21],
    ['an empty array', []],
    ['an empty object', {}],
    ['true', true],
    ['false', false],
    // Phase 4B.36A: an EXPLICITLY supplied empty or blank ward id is invalid.
    // It is not "not supplied", so it must never reach the founding-ward fallback.
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a single space', ' '],
    ['a tab', '\t'],
    ['a newline', '\n'],
    ['mixed whitespace only', ' \t\r\n '],
    ['the number 0', 0],
    ['the number -3', -3],
    ['the number 2.9', 2.9],
    ['a zero-padded string', '05'],
    ['a plus-signed string', '+5'],
    ['a string with a leading space', ' 5'],
    ['an exponent string', '1e3'],
    ['a value above the 32-bit integer range (string)', '2147483648'],
    ['a value above the 32-bit integer range (number)', 2147483648],
  ];

  for (const route of CREATE_ROUTES) {
    describe(route.label, () => {
      for (const [label, value] of INVALID_WARD_IDS) {
        test(`wardId as ${label} → 400 and NEVER falls back to the founding ward`, async () => {
          expect(wardCache.getFoundingWardId()).toBe(WARD); // a fallback target exists
          route.prepare();

          expectBadRequest(await route.send({ ...BASE_TEXT, wardId: value }), MSG.wardId);
        });
      }

      for (const [label, value, expected] of [
        ['the number 2', 2, 2],
        ['the string "2"', '2', 2],
        ['the largest 32-bit integer', 2147483647, 2147483647],
        ['the largest 32-bit integer as a string', '2147483647', 2147483647],
      ]) {
        test(`wardId as ${label} is accepted and bound as the number ${expected}`, async () => {
          route.prepare();

          const res = await route.send({ ...BASE_TEXT, wardId: value });

          expect(res.status).toBe(200);
          expect(lastParam()).toBe(expected);
        });
      }

      // Phase 4B.36A: only an omitted property and an explicit null mean "not
      // supplied". The empty string moved to INVALID_WARD_IDS above.
      for (const [label, value] of [['omitted', undefined], ['null', null]]) {
        test(`wardId ${label} means "not supplied": the founding ward is used`, async () => {
          route.prepare();
          const body = { ...BASE_TEXT };
          if (value !== undefined) body.wardId = value;

          const res = await route.send(body);

          expect(res.status).toBe(200);
          expect(lastParam()).toBe(WARD);
        });
      }

      // Phase 4B.36A: an explicit empty / blank wardId is refused for EVERY
      // administrator role, with zero database access (so no INSERT, and no
      // founding-ward fallback). Here the founding ward IS resolved; the next
      // test covers the unresolved case.
      for (const [label, value] of [['an empty string', ''], ['a whitespace-only string', '  \t '], ['a newline', '\n']]) {
        for (const persona of ADMIN_PERSONAS) {
          test(`wardId as ${label}, ${persona}: 400, no founding-ward fallback, nothing written`, async () => {
            expect(wardCache.getFoundingWardId()).toBe(WARD); // a fallback target exists
            route.prepare();

            const res = await route.send({ ...BASE_TEXT, wardId: value }, persona);

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: MSG.wardId });
            expect(db.calls).toEqual([]);
            expect(db.writes()).toEqual([]);
          });
        }
      }

      test('an empty wardId is a 400 (not a 503) even when the founding ward is unresolved', async () => {
        wardCache.setFoundingWardId(null);
        route.prepare();

        expectBadRequest(await route.send({ ...BASE_TEXT, wardId: '' }), MSG.wardId);
      });

      test('omitting wardId uses the founding ward, but sending wardId: "" is refused (the two are not alike)', async () => {
        route.prepare();

        // The same body without the property is the legitimate "use the founding ward" request...
        const omitted = await route.send({ ...BASE_TEXT });
        expect(omitted.status).toBe(200);
        expect(lastParam()).toBe(WARD);

        // ...and adding wardId: "" must NOT behave the same way.
        db.reset();
        route.prepare();
        const empty = await route.send({ ...BASE_TEXT, wardId: '' });
        expect(empty.status).toBe(400);
        expect(db.writes()).toEqual([]);
      });

      test('a WARD_ADMIN may use their own ward as an integer string; another ward is still refused', async () => {
        route.prepare();
        const own = await route.send({ ...BASE_TEXT, wardId: '1' }, 'wardAdmin1');
        expect(own.status).toBe(200);
        expect(lastParam()).toBe(WARD);

        db.reset();
        route.prepare();
        const other = await route.send({ ...BASE_TEXT, wardId: '2' }, 'wardAdmin1');
        expect(other.status).toBe(403);
        expect(db.writes()).toEqual([]);
      });
    });
  }
});

// ───────────────────────── founding ward unresolved (SG2) ───────────────────

describe('Phase 4B.36 — founding ward unresolved (SG2)', () => {
  for (const route of CREATE_ROUTES) {
    describe(route.label, () => {
      for (const persona of ADMIN_PERSONAS) {
        test(`${persona}: no wardId and the founding-ward cache is null → 503, nothing inserted`, async () => {
          wardCache.setFoundingWardId(null);
          route.prepare();

          const res = await route.send(BASE_TEXT, persona);

          expect(res.status).toBe(503);
          expect(res.body).toEqual({ success: false, error: MSG.foundingWard });
          expect(db.calls).toEqual([]);
        });
      }

      // Phase 4B.36A: only null (like an omitted property) reaches the
      // founding-ward check. An empty string is rejected earlier, as a 400 --
      // see the SG3 block.
      test('wardId null with the cache null → 503, nothing inserted', async () => {
        wardCache.setFoundingWardId(null);
        route.prepare();

        const res = await route.send({ ...BASE_TEXT, wardId: null });

        expect(res.status).toBe(503);
        expect(db.calls).toEqual([]);
      });

      test('a notice is never written with a NULL ward: no INSERT carries ward null', async () => {
        wardCache.setFoundingWardId(null);
        route.prepare();

        for (const persona of ADMIN_PERSONAS) await route.send(BASE_TEXT, persona);

        expect(db.writes()).toEqual([]);
      });

      test('an invalid body is still a 400 (validation runs before the founding-ward check)', async () => {
        wardCache.setFoundingWardId(null);
        route.prepare();

        expectBadRequest(await route.send({ ...BASE_TEXT, title: 'abc' }), MSG.title);
      });

      // An explicit, valid ward still works with the cache null — but only
      // where the existing role / ward rules allow it.
      for (const [persona, ward, status] of [
        ['superAdmin', OTHER_WARD, 200],
        ['wardAdmin1', WARD, 200],
        ['wardAdmin1', OTHER_WARD, 403],
        ['wardAdmin2', WARD, 403],
        ['moderator', WARD, 403],
        ['countyAdmin', WARD, 403],
        ['constituencyAdmin', WARD, 403],
      ]) {
        test(`explicit ward ${ward} as ${persona} with the cache null → ${status}`, async () => {
          wardCache.setFoundingWardId(null);
          route.prepare();

          const res = await route.send({ ...BASE_TEXT, wardId: ward }, persona);

          expect(res.status).toBe(status);
          if (status === 200) {
            expect(lastParam()).toBe(ward);
          } else {
            expect(res.body).toEqual({ success: false, error: 'Forbidden' });
            expect(db.writes()).toEqual([]);
          }
        });
      }
    });
  }

  test('a VOTER is still refused at the role gate when the founding ward is unresolved (403, not 503)', async () => {
    wardCache.setFoundingWardId(null);

    const res = await api('voter').post('/api/admin/notices').send(BASE_TEXT);

    expect(res.status).toBe(403);
    expect(db.calls).toEqual([]);
  });
});

// ───────────────────────── NULL-ward notices (SG1) + permission matrix ──────

const EXISTING_NOTICE_ROUTES = [
  {
    label: 'PUT /api/admin/notices/5',
    prepare: (ward) => {
      stubNoticeScopes({ 5: { ward_id: ward, category: 'public' } });
      stubUpdateEcho();
    },
    prepareMissing: () => stubNoticeScopes({}),
    send: (persona) => api(persona).put('/api/admin/notices/5').send(VALID_UPDATE_BODY),
    write: /^UPDATE notices/,
    missing: 404,
  },
  {
    label: 'DELETE /api/admin/notices/5',
    prepare: (ward) => {
      stubNoticeWards({ 5: ward });
      db.on(SQL.del, rows());
    },
    prepareMissing: () => {
      stubNoticeWards({});
      db.on(SQL.del, rows());
    },
    send: (persona) => api(persona).delete('/api/admin/notices/5'),
    write: /^DELETE FROM notices/,
    missing: 200,
  },
  {
    label: 'DELETE /api/notices/5',
    prepare: (ward) => {
      stubNoticeWards({ 5: ward });
      db.on(SQL.del, rows());
    },
    prepareMissing: () => {
      stubNoticeWards({});
      db.on(SQL.del, rows());
    },
    send: (persona) => api(persona).delete('/api/notices/5'),
    write: /^DELETE FROM notices/,
    missing: 200,
  },
];

describe('Phase 4B.36 — a notice with NO ward (SG1)', () => {
  for (const route of EXISTING_NOTICE_ROUTES) {
    describe(route.label, () => {
      for (const persona of ['wardAdmin1', 'wardAdmin2', 'moderator', 'countyAdmin', 'constituencyAdmin']) {
        test(`${persona} → 403 Forbidden and no ${route.label.split(' ')[0] === 'PUT' ? 'UPDATE' : 'DELETE'} runs`, async () => {
          route.prepare(null);

          const res = await route.send(persona);

          expect(res.status).toBe(403);
          expect(res.body).toEqual({ success: false, error: 'Forbidden' });
          expect(db.writes()).toEqual([]);
        });
      }

      test('superAdmin → the existing permitted behaviour is preserved (200, the write runs)', async () => {
        route.prepare(null);

        const res = await route.send('superAdmin');

        expect(res.status).toBe(200);
        expect(db.writes()).toHaveLength(1);
        expect(db.writes()[0].sql).toMatch(route.write);
      });

      test('a VOTER is still refused at the role gate with zero queries', async () => {
        route.prepare(null);

        const res = await route.send('voter');

        expect(res.status).toBe(403);
        expect(db.calls).toEqual([]);
      });
    });
  }

  // Fail closed: a stored row that comes back WITHOUT a ward_id value at all
  // (not even null) must be treated like a notice with no ward, never as one
  // that any administrator may edit. The live schema always returns the column,
  // so this is defence in depth rather than a reachable case today.
  describe('PUT: a row that comes back with no ward_id value at all', () => {
    const stubRowWithoutWard = () => {
      db.on(SQL.noticeScope, () => rows({ category: 'public' }));
      stubUpdateEcho();
    };

    test.each(['wardAdmin1', 'moderator', 'countyAdmin', 'constituencyAdmin'])('%s → 403 and no UPDATE runs', async (persona) => {
      stubRowWithoutWard();

      const res = await api(persona).put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Forbidden' });
      expect(db.writes()).toEqual([]);
    });

    test('superAdmin is treated exactly as for a ward-less notice (200, the UPDATE runs)', async () => {
      stubRowWithoutWard();

      const res = await api('superAdmin').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

      expect(res.status).toBe(200);
      expect(db.writes()).toHaveLength(1);
    });
  });
});

describe('Phase 4B.36 — the ward-1 / ward-2 permission matrix is unchanged', () => {
  const MATRIX = [
    ['superAdmin', WARD, 200], ['superAdmin', OTHER_WARD, 200],
    ['wardAdmin1', WARD, 200], ['wardAdmin1', OTHER_WARD, 403],
    ['wardAdmin2', WARD, 403], ['wardAdmin2', OTHER_WARD, 200],
    ['moderator', WARD, 403], ['moderator', OTHER_WARD, 403],
    ['countyAdmin', WARD, 403], ['countyAdmin', OTHER_WARD, 403],
    ['constituencyAdmin', WARD, 403], ['constituencyAdmin', OTHER_WARD, 403],
  ];

  for (const route of EXISTING_NOTICE_ROUTES) {
    for (const [persona, ward, status] of MATRIX) {
      test(`${route.label}: ${persona} on a ward-${ward} notice → ${status}`, async () => {
        route.prepare(ward);

        const res = await route.send(persona);

        expect(res.status).toBe(status);
        if (status === 200) {
          expect(db.writes()).toHaveLength(1);
          expect(db.writes()[0].sql).toMatch(route.write);
        } else {
          expect(res.body).toEqual({ success: false, error: 'Forbidden' });
          expect(db.writes()).toEqual([]);
        }
      });
    }
  }

  for (const route of CREATE_ROUTES) {
    for (const [persona, ward, status] of MATRIX) {
      test(`${route.label}: ${persona} creating in ward ${ward} → ${status}`, async () => {
        route.prepare();

        const res = await route.send({ ...BASE_TEXT, wardId: ward }, persona);

        expect(res.status).toBe(status);
        if (status === 200) {
          expect(lastParam()).toBe(ward);
        } else {
          expect(db.writes()).toEqual([]);
        }
      });
    }
  }
});

describe('Phase 4B.36 — the missing-id contract is unchanged', () => {
  for (const route of EXISTING_NOTICE_ROUTES) {
    for (const persona of ADMIN_PERSONAS) {
      test(`${route.label} as ${persona}: a missing notice → ${route.missing}`, async () => {
        route.prepareMissing();

        const res = await route.send(persona);

        expect(res.status).toBe(route.missing);
        if (route.missing === 404) {
          expect(res.body).toEqual({ success: false, error: 'Notice not found' });
          expect(db.writes()).toEqual([]);
        } else {
          expect(res.body).toEqual({ success: true });
          expect(db.writes()).toHaveLength(1); // the same no-op DELETE as before
        }
      });
    }
  }
});

// ───────────────────────── nonexistent ward (SG4) + 500 hygiene ─────────────

describe('Phase 4B.36 — nonexistent ward and error responses (SG4)', () => {
  const FK_MESSAGE = 'insert or update on table "notices" violates foreign key constraint "notices_ward_id_fk"';
  const fkError = () => pgError(FK_MESSAGE, '23503', 'notices_ward_id_fk');

  const INSERT_RULE = { 'POST /api/admin/notices': SQL.insertWithExpiry, 'POST /api/notices': SQL.insertWithDays };

  for (const route of CREATE_ROUTES) {
    describe(route.label, () => {
      test('a well-formed wardId that names no ward → 400, with no SQL, constraint name or driver text', async () => {
        db.on(INSERT_RULE[route.label], () => {
          throw fkError();
        });

        const res = await route.send({ ...BASE_TEXT, wardId: 999 });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ success: false, error: MSG.unknownWard });
        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain('notices_ward_id_fk');
        expect(raw).not.toContain('violates');
        expect(raw).not.toContain('INSERT');
        // The diagnostic detail stays in the server log.
        expect(errSpy).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(errSpy.mock.calls[0].map(String))).toContain('notices_ward_id_fk');
        errSpy.mockClear();
      });

      test('the same failure for a ward the caller did NOT supply (a stale founding ward) stays a generic 500', async () => {
        db.on(INSERT_RULE[route.label], () => {
          throw fkError();
        });

        const res = await route.send(BASE_TEXT);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ success: false, error: MSG.server });
        errSpy.mockClear();
      });

      for (const [label, makeError] of [
        ['a foreign-key failure on a different constraint', () => pgError('violates other_fk', '23503', 'some_other_fk')],
        ['a foreign-key failure with no constraint name', () => pgError('violates fk', '23503')],
        ['a different SQLSTATE on the ward constraint', () => pgError('duplicate', '23505', 'notices_ward_id_fk')],
        ['an error with no SQLSTATE', () => new Error('boom')],
      ]) {
        test(`${label} is NOT mapped to "unknown ward": generic 500`, async () => {
          db.on(INSERT_RULE[route.label], () => {
            throw makeError();
          });

          const res = await route.send({ ...BASE_TEXT, wardId: 999 });

          expect(res.status).toBe(500);
          expect(res.body).toEqual({ success: false, error: MSG.server });
          errSpy.mockClear();
        });
      }

      test('an INSERT failure returns the fixed message and logs the detail', async () => {
        db.on(INSERT_RULE[route.label], () => {
          throw new Error('SECRET connection string postgres://user:pass@host/db');
        });

        const res = await route.send(BASE_TEXT);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ success: false, error: MSG.server });
        expect(JSON.stringify(res.body)).not.toContain('SECRET');
        expect(errSpy).toHaveBeenCalledTimes(1);
        errSpy.mockClear();
      });
    });
  }

  test('PUT: a failing lookup returns the fixed message and logs the detail', async () => {
    db.on(SQL.noticeScope, () => {
      throw new Error('lookup exploded: relation "notices" does not exist');
    });

    const res = await api('superAdmin').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: MSG.server });
    expect(errSpy).toHaveBeenCalledWith('PUT /api/admin/notices error:', 'lookup exploded: relation "notices" does not exist');
    errSpy.mockClear();
  });

  for (const [label, url] of [['DELETE /api/admin/notices/:id', '/api/admin/notices/5'], ['DELETE /api/notices/:id', '/api/notices/5']]) {
    test(`${label}: a failing lookup returns the fixed message and logs the detail`, async () => {
      db.on(SQL.wardOf, () => {
        throw new Error('lookup exploded');
      });

      const res = await api('superAdmin').delete(url);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: MSG.server });
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0][1])).toContain('lookup exploded');
      errSpy.mockClear();
    });
  }

  test('DELETE /api/notices/:id: a failing DELETE returns the fixed message and logs the detail', async () => {
    stubNoticeWards({ 5: WARD });
    db.on(SQL.del, () => {
      throw new Error('delete exploded');
    });

    const res = await api('superAdmin').delete('/api/notices/5');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: MSG.server });
    expect(String(errSpy.mock.calls[0][1])).toContain('delete exploded');
    errSpy.mockClear();
  });

  test('every refusal keeps the { success:false, error } shape and nothing else', async () => {
    wardCache.setFoundingWardId(null);
    const attempts = [
      api('superAdmin').post('/api/admin/notices').send({ title: 'abc', content: 'def' }), // 400
      api('superAdmin').post('/api/admin/notices').send(BASE_TEXT), // 503
      api('voter').post('/api/admin/notices').send(BASE_TEXT), // 403
    ];

    for (const attempt of attempts) {
      const res = await attempt;
      expect(Object.keys(res.body).sort()).toEqual(['error', 'success']);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.error).toBe('string');
    }
  });
});
