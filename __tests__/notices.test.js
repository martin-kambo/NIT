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
  insertWithExpiry: /^INSERT INTO notices \(title,content,category,priority,expires_at,created_by,ward_id\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7\) RETURNING \*$/,
  insertWithDays: /^INSERT INTO notices \(title, content, category, priority, expires_at, created_by, ward_id\) VALUES \(\$1, \$2, \$3, \$4, NOW\(\) \+ \(\$5 \|\| ' days'\)::INTERVAL, 'admin', \$6\) RETURNING \*$/,
  update: /^UPDATE notices SET title=\$1,content=\$2,category=\$3,priority=\$4,expires_at=\$5,updated_at=NOW\(\) WHERE id=\$6 RETURNING \*$/,
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

function stubUpdateEcho() {
  db.on(SQL.update, (_sql, p) =>
    rows({ id: Number(p[5]), title: p[0], content: p[1], category: p[2], priority: p[3], expires_at: p[4], ward_id: WARD }));
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

  test('a failing INSERT returns 500 { success:false, error }', async () => {
    db.on(SQL.insertWithExpiry, () => {
      throw new Error('insert failed');
    });

    const res = await api('superAdmin').post('/api/admin/notices').send(VALID_ADMIN_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'insert failed' });
    expect(errSpy).toHaveBeenCalledWith('POST /api/admin/notices error:', 'insert failed');
    errSpy.mockClear();
  });

  // Deferred: no such validation exists (G5).
  test.todo('[G5] rejects a title that is too short with 400 (legacy L224)');
  test.todo('[G5] rejects content that is too short with 400 (legacy L235)');
  test.todo('[G5] rejects an invalid category with 400 (legacy L251)');
  test.todo('[G5] rejects an invalid priority with 400 (legacy L265)');
  test.todo('[G5] rejects an expiry date in the past with 400 (legacy L279)');
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

  // legacy L383 — rewritten: ward is looked up first, then a parameterised UPDATE.
  test('updates a notice in the caller\'s ward → 200 { success, notice } [legacy L383]', async () => {
    stubNoticeWards({ 5: WARD });
    stubUpdateEcho();

    const res = await api('wardAdmin1').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.notice.title).toBe('Updated Notice Title');
    expect(res.body).not.toHaveProperty('data');
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].sql).toMatch(SQL.wardOf);
    expect(db.calls[0].params).toEqual(['5']);
    expect(db.calls[1].sql).toMatch(SQL.update);
    expect(db.calls[1].params).toEqual([
      'Updated Notice Title',
      'Updated content for the notice.',
      'public',
      'high',
      VALID_UPDATE_BODY.expiresAt,
      '5',
    ]);
  });

  // legacy L397 — the 404 contract still holds, for an INTEGER id.
  test('an id that does not exist → 404 { success:false, error } and no UPDATE runs [legacy L397]', async () => {
    stubNoticeWards({});

    const res = await api('superAdmin').put('/api/admin/notices/999').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Notice not found' });
    expect(db.writes()).toEqual([]);
  });

  test('a notice that vanishes between the ward lookup and the UPDATE → 404', async () => {
    stubNoticeWards({ 5: WARD });
    db.on(SQL.update, rows());

    const res = await api('superAdmin').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Notice not found' });
  });

  // O2 — EMULATED pg integer cast: legacy tests used a UUID id; ids are SERIAL.
  test('a non-integer (UUID) id is rejected by the DB layer and surfaces as 500 — EMULATED pg 22P02 (observation O2) [legacy L397]', async () => {
    stubNoticeWards({});

    const res = await api('superAdmin')
      .put('/api/admin/notices/00000000-0000-0000-0000-000000000000')
      .send(VALID_UPDATE_BODY);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/invalid input syntax for type integer/);
    expect(db.writes()).toEqual([]);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockClear();
  });

  test('requires title and content → 400 before any database access', async () => {
    const res = await api('superAdmin').put('/api/admin/notices/5').send({ title: 'Only a title' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'title and content are required' });
    expect(db.calls).toEqual([]);
  });

  test('a WARD_ADMIN of a different ward is refused and no UPDATE runs', async () => {
    stubNoticeWards({ 5: WARD });

    const res = await api('wardAdmin2').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden' });
    expect(db.writes()).toEqual([]);
  });

  test('a failing UPDATE returns 500 { success:false, error }', async () => {
    stubNoticeWards({ 5: WARD });
    db.on(SQL.update, () => {
      throw new Error('update failed');
    });

    const res = await api('superAdmin').put('/api/admin/notices/5').send(VALID_UPDATE_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'update failed' });
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

  test('a failing DELETE returns 500 { success:false, error }', async () => {
    stubNoticeWards({ 5: WARD });
    db.on(SQL.del, () => {
      throw new Error('delete failed');
    });

    const res = await api('superAdmin').delete('/api/admin/notices/5');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'delete failed' });
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

  test('defaults to 30 days, general and normal', async () => {
    stubInsertWithDaysEcho();

    await api('superAdmin').post('/api/notices').send({ title: 'T', content: 'C' });

    expect(db.calls[0].params).toEqual(['T', 'C', 'general', 'normal', '30', WARD]);
  });

  test('requires title and content → 400 and writes nothing', async () => {
    const res = await api('superAdmin').post('/api/notices').send({ title: 'T' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'title and content are required' });
    expect(db.calls).toEqual([]);
  });

  test('a WARD_ADMIN of a different ward is refused', async () => {
    const res = await api('wardAdmin2').post('/api/notices').send({ title: 'T', content: 'C', wardId: WARD });

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
