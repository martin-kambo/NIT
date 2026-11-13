'use strict';

// ============================================================================
// Notice-scope readiness against a REAL PostgreSQL — Phase 4B.44 (group E + integration)
// ============================================================================
// OPT-IN. This file does nothing unless NOTICE_SCOPE_TEST_DATABASE_URL names a DISPOSABLE database, e.g.
//
//     NOTICE_SCOPE_TEST_DATABASE_URL=postgres://postgres:<password>@localhost:5432/nit_test_readiness  npx jest --runInBand notice-scope-readiness.pg
//
// SAFETY (the file refuses to run, and changes nothing, unless all of these hold)
//   * the database name matches ^nit_test_[a-z0-9_]+$   (never a project or production database)
//   * the host is not a Render / cloud hostname
//   * the public schema is empty, or contains only what a previous run of THIS file created
//     (marked by the table nit_scope_readiness_test_marker)
// Between tests the file drops and recreates the public schema of that database. Production data is never used:
// every fixture below is synthetic (ids 1 and 10 mirror the production shape described in 4B.41: ward 1 'Ngoliba'
// under Juja, ward 10 'Ngoliba' under Thika Town, Kiambu).
//
// WHAT IT PROVES, on a real server
//   E  the installed trigger stops the REAL ensurePhase2Migrations() from assigning the founding ward to
//      PLATFORM / COUNTY / CONSTITUENCY notices (the whole reason for Phase 4B.44), while legacy and WARD
//      behaviour stay as Phase 4B.42 defined it
//   *  the gate really stops a PARTIAL / INVALID schema BEFORE the backfill, leaving every row untouched
//   *  the installer is atomic (a failure part-way leaves NOTHING behind) and serialised (advisory lock)
//   *  the catalog inspector classifies real catalog rows correctly for ~55 injected faults
// It also records, as tests, what the UNGUARDED Phase 2 backfill does to a partial schema (the hazard the gate prevents).
//
// WHAT IT CANNOT PROVE
//   Whichever server version it runs on is the only version it proves anything about. Run it against PostgreSQL 18 before
//   relying on the inspector there: PostgreSQL 18 formats catalog expressions differently (the inspector judges behaviour,
//   not text, precisely for that reason) and adds NOT ENFORCED constraints (handled).
// ============================================================================

const URL_ENV = process.env.NOTICE_SCOPE_TEST_DATABASE_URL;
const suite = URL_ENV ? describe : describe.skip;
if (typeof jest !== 'undefined' && typeof jest.setTimeout === 'function') jest.setTimeout(60000);

const R = require('../bootstrap/notice-scope-readiness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = async (fn) => { try { return { value: await fn() }; } catch (error) { return { error }; } };

suite('notice-scope readiness on a real PostgreSQL (disposable database only)', () => {
  let pool;
  let migrations;
  let startup;
  let wardCache;
  let spies;
  let isSuper = false;
  let serverVersion = '';
  let armed = false; // true only after EVERY safety check passed; nothing below may change the database before that

  const q = (sql, params) => pool.query(sql, params);
  const one = async (sql, params) => (await q(sql, params)).rows[0];
  const state = async () => (await R.inspectNoticeScopeSchema(pool)).state;

  // ── safety + schema fixtures ────────────────────────────────────────────────────────────────
  function assertDisposable(urlText) {
    const u = new URL(urlText);
    const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!/^nit_test_[a-z0-9_]+$/.test(db)) throw new Error(`REFUSING to run: database "${db}" is not named nit_test_*`);
    if (/render\.com|amazonaws\.com|azure|googleusercontent|neon\.tech|supabase/i.test(u.hostname)) {
      throw new Error('REFUSING to run: the host looks like a hosted (possibly production) database');
    }
  }

  async function assertSchemaIsOursOrEmpty() {
    const tables = (await q("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','f','p')")).rows[0].n;
    const marker = (await q("SELECT to_regclass('public.nit_scope_readiness_test_marker') IS NOT NULL AS present")).rows[0].present;
    if (tables > 0 && !marker) throw new Error('REFUSING to run: the public schema of this database is not empty and was not created by this test file');
  }

  async function resetSchema() {
    if (!armed) throw new Error('REFUSING to change the database: the safety checks have not passed');
    await q('DROP SCHEMA public CASCADE');
    await q('CREATE SCHEMA public');
    await q('CREATE TABLE nit_scope_readiness_test_marker (id INT)');
    await q(`
      CREATE TABLE counties (id SERIAL PRIMARY KEY, name VARCHAR(100));
      CREATE TABLE constituencies (id SERIAL PRIMARY KEY, county_id INT REFERENCES counties(id), name VARCHAR(100));
      CREATE TABLE wards (id SERIAL PRIMARY KEY, constituency_id INT REFERENCES constituencies(id), name VARCHAR(100));
      INSERT INTO counties (id, name) VALUES (5, 'Kiambu'), (6, 'Nairobi');
      INSERT INTO constituencies (id, county_id, name) VALUES (7, 5, 'Thika Town'), (8, 5, 'Juja'), (9, 6, 'Westlands');
      INSERT INTO wards (id, constituency_id, name) VALUES (1, 8, 'Ngoliba'), (10, 7, 'Ngoliba'), (11, 7, 'Biashara'), (13, 9, 'Parklands');
      CREATE TABLE users (id SERIAL PRIMARY KEY, phone TEXT);
      CREATE TABLE votes (id SERIAL PRIMARY KEY, choice TEXT);
      CREATE TABLE forum_posts (id SERIAL PRIMARY KEY, body TEXT);
      CREATE TABLE candidates (id SERIAL PRIMARY KEY, name TEXT);
      CREATE TABLE notices (
        id SERIAL PRIMARY KEY, title VARCHAR(200) NOT NULL, content TEXT NOT NULL, category VARCHAR(20) DEFAULT 'general',
        priority VARCHAR(10) DEFAULT 'normal', created_by VARCHAR(100), created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(), expires_at TIMESTAMP, is_archived BOOLEAN DEFAULT false
      );
    `);
  }

  // The state verified read-only in production before this phase: notices.ward_id exists and NOTHING else of the
  // scope schema does. Four legacy notices carry the legacy ward 1.
  async function productionShape() {
    await resetSchema();
    for (const t of ['users', 'votes', 'notices', 'forum_posts', 'candidates']) {
      await q(`ALTER TABLE ${t} ADD COLUMN ward_id INT`);
      await q(`ALTER TABLE ${t} ADD CONSTRAINT ${t}_ward_id_fk FOREIGN KEY (ward_id) REFERENCES wards(id)`);
    }
    await q("INSERT INTO notices (title, content, ward_id) VALUES ('legacy A','a',1), ('legacy B','b',1), ('legacy C','c',1), ('legacy D','d',1)");
  }

  // Rows the Phase 2 backfill would act on, in every table
  async function addUnassignedRows() {
    await q("INSERT INTO users (phone) VALUES ('0700000001')");
    await q("INSERT INTO votes (choice) VALUES ('x')");
    await q("INSERT INTO forum_posts (body) VALUES ('post')");
    await q("INSERT INTO candidates (name) VALUES ('cand')");
  }

  // Scoped notices exactly as routes/notices.js stores them (ward_id NULL on the three ward-less levels)
  async function addScopedNotices() {
    await q(`INSERT INTO notices (title, content, scope_level, county_id, constituency_id, ward_id) VALUES
      ('platform', 'p', 'PLATFORM', NULL, NULL, NULL),
      ('county', 'c', 'COUNTY', 5, NULL, NULL),
      ('constituency', 'k', 'CONSTITUENCY', NULL, 7, NULL),
      ('ward-scoped', 'w', 'WARD', NULL, NULL, 10)`);
  }

  const noticeByTitle = async (title) => one('SELECT title, scope_level, county_id, constituency_id, ward_id FROM notices WHERE title = $1', [title]);

  beforeAll(async () => {
    assertDisposable(URL_ENV);
    // the real pg driver, a real pool; bootstrap/database.js (which would read DATABASE_URL) is replaced by it
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: URL_ENV, max: 8 });
    await assertSchemaIsOursOrEmpty();
    armed = true;
    const v = await one("SELECT current_setting('server_version') AS v, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su");
    serverVersion = v.v; isSuper = !!v.su;
    jest.doMock('../bootstrap/database', () => ({ pool, testDBConnection: async () => true }));
    jest.doMock('../lib/period-engine', () => ({ transitionPeriod: async () => {} }));
    jest.doMock('../routes/voting', () => ({ broadcastVoteUpdate: () => {} }));
    jest.doMock('../routes/community-reports', () => ({ ensureCommunityReportsTables: async () => {} }));
    wardCache = require('../lib/ward-cache');
    migrations = require('../bootstrap/migrations');
    startup = require('../bootstrap/startup');
  });

  afterAll(async () => {
    if (pool) {
      // clean up ONLY if the safety checks passed; a refused run must leave the database exactly as it found it
      if (armed) {
        try { await q('DROP SCHEMA public CASCADE'); await q('CREATE SCHEMA public'); } catch (_) { /* best effort */ }
      }
      await pool.end();
    }
    if (wardCache) wardCache.setFoundingWardId(null);
  });

  beforeEach(() => {
    spies = {
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });
  afterEach(() => { spies.log.mockRestore(); spies.warn.mockRestore(); spies.error.mockRestore(); });

  const logged = (spy) => spy.mock.calls.map((c) => String(c[0]));

  test('the target is a disposable database (version recorded in the test output)', async () => {
    expect(typeof serverVersion).toBe('string');
    expect(/^\d+/.test(serverVersion)).toBe(true);
    process.stdout.write(`      [real PostgreSQL ${serverVersion}; superuser=${isSuper}]\n`);
  });

  // ==========================================================================
  // E. The critical proof: the installed trigger protects the Phase 2 backfill
  // ==========================================================================
  describe('E. the installed trigger vs the REAL ensurePhase2Migrations()', () => {
    test('production shape -> real installer -> INSTALLED, and no existing row was touched', async () => {
      await productionShape();
      expect(await state()).toBe('NOT_INSTALLED');
      const before = (await q('SELECT * FROM notices ORDER BY id')).rows;
      await migrations.ensureNoticeScopeColumns();
      expect(await state()).toBe('INSTALLED');
      const after = (await q('SELECT id, title, content, ward_id FROM notices ORDER BY id')).rows;
      expect(after).toEqual(before.map((r) => ({ id: r.id, title: r.title, content: r.content, ward_id: r.ward_id })));
      const scoped = (await q('SELECT scope_level, county_id, constituency_id FROM notices')).rows;
      scoped.forEach((r) => expect(r).toEqual({ scope_level: null, county_id: null, constituency_id: null })); // all four stay LEGACY
    });

    test('CRITICAL: Phase 2 never assigns the founding ward to PLATFORM, COUNTY or CONSTITUENCY notices; legacy / WARD behaviour is as 4B.42 defined', async () => {
      await productionShape();
      await migrations.ensureNoticeScopeColumns();
      await addScopedNotices();
      await q("INSERT INTO notices (title, content) VALUES ('legacy without a ward', 'x')"); // scope_level NULL, ward_id NULL
      await addUnassignedRows();

      await migrations.ensurePhase2Migrations(); // the REAL, unchanged function

      expect(logged(spies.error).filter((l) => /ensurePhase2Migrations error/.test(l))).toEqual([]);
      expect(await noticeByTitle('platform')).toEqual({ title: 'platform', scope_level: 'PLATFORM', county_id: null, constituency_id: null, ward_id: null });
      expect(await noticeByTitle('county')).toEqual({ title: 'county', scope_level: 'COUNTY', county_id: 5, constituency_id: null, ward_id: null });
      expect(await noticeByTitle('constituency')).toEqual({ title: 'constituency', scope_level: 'CONSTITUENCY', county_id: null, constituency_id: 7, ward_id: null });
      // WARD notice keeps its ward
      expect((await noticeByTitle('ward-scoped')).ward_id).toBe(10);
      // a LEGACY notice with no ward is still stamped with the founding ward (10): existing behaviour
      expect(await noticeByTitle('legacy without a ward')).toEqual({ title: 'legacy without a ward', scope_level: null, county_id: null, constituency_id: null, ward_id: 10 });
      // the four legacy notices (ward 1) are untouched and still LEGACY
      const legacy = (await q("SELECT ward_id, scope_level FROM notices WHERE title LIKE 'legacy _' ORDER BY title")).rows;
      expect(legacy).toEqual([1, 1, 1, 1].map((w) => ({ ward_id: w, scope_level: null })));
      // Phase 2 ran to completion: the later tables were backfilled too (it was not aborted)
      for (const t of ['users', 'votes', 'forum_posts', 'candidates']) {
        expect((await one(`SELECT ward_id FROM ${t}`)).ward_id).toBe(10);
      }
      // and its log says exactly one notice (the legacy one) was backfilled, not four
      expect(logged(spies.log).some((l) => /backfilled 1 notices row\(s\)/.test(l))).toBe(true);
      expect(logged(spies.log).some((l) => /Phase 2 complete/.test(l))).toBe(true);
    });

    test('CRITICAL, on every start-up: scoped notices written after the first start survive the backfill of the next one', async () => {
      await productionShape();
      await migrations.ensureNoticeScopeColumns();
      await migrations.ensurePhase2Migrations();
      await addScopedNotices();
      for (let restart = 0; restart < 3; restart++) {
        await migrations.ensureNoticeScopeColumns();
        await migrations.ensurePhase2Migrations();
      }
      expect((await noticeByTitle('platform')).ward_id).toBe(null);
      expect((await noticeByTitle('county')).ward_id).toBe(null);
      expect((await noticeByTitle('constituency')).ward_id).toBe(null);
      expect(await state()).toBe('INSTALLED');
    });

    test('the trigger also holds for any other UPDATE that tries to give a ward-less scoped notice a ward; direct contradictory inserts are rejected by the CHECK', async () => {
      await productionShape();
      await migrations.ensureNoticeScopeColumns();
      await addScopedNotices();
      const res = await q("UPDATE notices SET ward_id = 11 WHERE title IN ('platform', 'county', 'constituency')");
      expect(res.rowCount).toBe(0); // BEFORE trigger returned NULL for each row: skipped, not counted
      expect((await noticeByTitle('platform')).ward_id).toBe(null);
      const bad = await attempt(() => q("INSERT INTO notices (title, content, scope_level, ward_id) VALUES ('bad', 'b', 'PLATFORM', 10)"));
      expect(bad.error.code).toBe('23514'); // check_violation
      const bad2 = await attempt(() => q("INSERT INTO notices (title, content, county_id) VALUES ('bad2', 'b', 5)")); // a county without a scope level
      expect(bad2.error.code).toBe('23514');
    });

    test('HAZARD (what the gate prevents): the unguarded Phase 2 on a columns-only schema stamps the founding ward onto scoped notices', async () => {
      await productionShape();
      await q('ALTER TABLE notices ADD COLUMN scope_level VARCHAR(20), ADD COLUMN county_id INT, ADD COLUMN constituency_id INT');
      await q("INSERT INTO notices (title, content, scope_level) VALUES ('platform', 'p', 'PLATFORM')");
      expect(await state()).toBe('PARTIAL');
      await migrations.ensurePhase2Migrations(); // run directly, bypassing the gate
      expect((await noticeByTitle('platform')).ward_id).toBe(10); // silently corrupted: a PLATFORM notice now belongs to a ward
    });

    test('HAZARD (what the gate prevents): with the CHECK but no trigger the backfill fails part-way and skips forum_posts and candidates', async () => {
      await productionShape();
      await q('ALTER TABLE notices ADD COLUMN scope_level VARCHAR(20), ADD COLUMN county_id INT, ADD COLUMN constituency_id INT');
      await q(`ALTER TABLE notices ADD CONSTRAINT notices_scope_check CHECK (COALESCE(
        (scope_level IS NULL AND county_id IS NULL AND constituency_id IS NULL)
        OR (scope_level = 'PLATFORM' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NULL)
        OR (scope_level = 'WARD' AND ward_id IS NOT NULL), false))`);
      await q("INSERT INTO notices (title, content, scope_level) VALUES ('platform', 'p', 'PLATFORM')");
      await addUnassignedRows();
      await migrations.ensurePhase2Migrations();
      expect(logged(spies.error).some((l) => /ensurePhase2Migrations error/.test(l))).toBe(true);
      expect((await one('SELECT ward_id FROM users')).ward_id).toBe(10);        // done before the failing table
      expect((await one('SELECT ward_id FROM forum_posts')).ward_id).toBe(null); // never reached
      expect((await one('SELECT ward_id FROM candidates')).ward_id).toBe(null);  // never reached
    });
  });

  // ==========================================================================
  // The gate through the real startServer(): PARTIAL / INVALID never reach the backfill
  // ==========================================================================
  describe('start-up: the gate with the real verifiers, the real installer and the real Phase 2', () => {
    let order;
    let listened;
    let intervalSpy;
    let sigterm;

    beforeEach(() => {
      order = [];
      listened = 0;
      sigterm = process.listeners('SIGTERM').slice();
      intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => ({ unref() {} }));
    });
    afterEach(() => {
      intervalSpy.mockRestore();
      process.removeAllListeners('SIGTERM');
      sigterm.forEach((l) => process.on('SIGTERM', l));
    });

    const note = (name) => async () => { order.push(name); };
    const startDeps = () => ({
      app: { listen: () => { listened++; order.push('listen'); return { close() {} }; } },
      PORT: 0,
      pool,
      testDBConnection: async () => true,
      transitionPeriod: async () => {},
      broadcastVoteUpdate: () => {},
      initDB: note('initDB'),
      ensureVotingPeriodsTable: note('ensureVotingPeriodsTable'),
      ensureActivePeriod: note('ensureActivePeriod'),
      ensureCandidatesTable: note('ensureCandidatesTable'),
      ensureGeographyTables: note('ensureGeographyTables'),
      seedKiambuHierarchy: note('seedKiambuHierarchy'),
      ensurePhase2Migrations: async () => { order.push('ensurePhase2Migrations'); return migrations.ensurePhase2Migrations(); }, // REAL
      ensureRBACFoundation: note('ensureRBACFoundation'),
      ensureSuperAdminBootstrap: note('ensureSuperAdminBootstrap'),
      ensureNoticesTable: async () => { order.push('ensureNoticesTable'); return migrations.ensureNoticesTable(); },               // REAL
      // verifyNoticeScopeBeforeBackfill / verifyNoticeScopeReady: the defaults, i.e. the real ones
    });

    test('production shape: starts, installs the scope schema, and the Phase 2 backfill that ran in that start spared nothing it should not touch', async () => {
      await productionShape();
      await addUnassignedRows();
      await startup.startServer(startDeps());
      expect(listened).toBe(1);
      expect(await state()).toBe('INSTALLED');
      expect((await one('SELECT ward_id FROM users')).ward_id).toBe(10);
      const legacy = (await q("SELECT ward_id, scope_level FROM notices WHERE title LIKE 'legacy _'")).rows;
      expect(legacy).toHaveLength(4);
      legacy.forEach((r) => expect(r).toEqual({ ward_id: 1, scope_level: null }));
      // a second start (a restart) with scoped notices present keeps them ward-less
      await addScopedNotices();
      order = [];
      await startup.startServer(startDeps());
      expect(listened).toBe(2);
      expect((await noticeByTitle('platform')).ward_id).toBe(null);
      expect((await noticeByTitle('county')).ward_id).toBe(null);
      expect((await noticeByTitle('constituency')).ward_id).toBe(null);
    });

    test('a brand-new database (notices table absent) passes the gate', async () => {
      await resetSchema();
      await q('DROP TABLE notices');
      const g = await R.verifyNoticeScopeBeforeBackfill(pool);
      expect(g.state).toBe('NOT_INSTALLED');
      expect(g.tableExists).toBe(false);
    });

    const PARTIAL_SHAPES = [
      ['columns only', async () => {
        await q('ALTER TABLE notices ADD COLUMN scope_level VARCHAR(20), ADD COLUMN county_id INT, ADD COLUMN constituency_id INT');
      }],
      ['columns + foreign keys + CHECK, no trigger or indexes', async () => {
        await q('ALTER TABLE notices ADD COLUMN scope_level VARCHAR(20), ADD COLUMN county_id INT, ADD COLUMN constituency_id INT');
        await q('ALTER TABLE notices ADD CONSTRAINT notices_county_id_fk FOREIGN KEY (county_id) REFERENCES counties(id)');
        await q('ALTER TABLE notices ADD CONSTRAINT notices_constituency_id_fk FOREIGN KEY (constituency_id) REFERENCES constituencies(id)');
      }],
      ['fully installed except the trigger', async () => {
        await migrations.ensureNoticeScopeColumns();
        await q('DROP TRIGGER notices_keep_scoped_ward_null ON notices');
      }],
    ];

    test.each(PARTIAL_SHAPES)('PARTIAL (%s): start-up stops before the backfill, nothing is written, the server never listens', async (label, build) => {
      await productionShape();
      await build();
      await addUnassignedRows();
      await q("INSERT INTO notices (title, content, scope_level) VALUES ('platform', 'p', 'PLATFORM')");
      const snapshot = JSON.stringify([(await q('SELECT * FROM notices ORDER BY id')).rows, (await q('SELECT * FROM users ORDER BY id')).rows]);
      const r = await attempt(() => startup.startServer(startDeps()));
      expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
      expect(r.error.state).toBe('PARTIAL');
      expect(order).not.toContain('ensurePhase2Migrations');
      expect(order).not.toContain('listen');
      expect(listened).toBe(0);
      // not one row changed, and the schema was not repaired
      expect(JSON.stringify([(await q('SELECT * FROM notices ORDER BY id')).rows, (await q('SELECT * FROM users ORDER BY id')).rows])).toBe(snapshot);
      expect(await state()).toBe('PARTIAL');
      expect((await noticeByTitle('platform')).ward_id).toBe(null);
      expect((await one('SELECT ward_id FROM users')).ward_id).toBe(null);
    });

    test('INVALID (trigger disabled): start-up stops before the backfill and the platform notice keeps no ward', async () => {
      await productionShape();
      await migrations.ensureNoticeScopeColumns();
      await q("INSERT INTO notices (title, content, scope_level) VALUES ('platform', 'p', 'PLATFORM')");
      await q('ALTER TABLE notices DISABLE TRIGGER notices_keep_scoped_ward_null');
      await addUnassignedRows();
      const r = await attempt(() => startup.startServer(startDeps()));
      expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
      expect(r.error.state).toBe('INVALID');
      expect(order).not.toContain('ensurePhase2Migrations');
      expect(listened).toBe(0);
      expect((await noticeByTitle('platform')).ward_id).toBe(null);
      expect((await one('SELECT ward_id FROM users')).ward_id).toBe(null);
      expect(await state()).toBe('INVALID'); // still disabled: nothing repaired it
    });

    test('INVALID (CHECK that lets a NULL level carry a county): stops; the error names the CHECK', async () => {
      await productionShape();
      await migrations.ensureNoticeScopeColumns();
      await q('ALTER TABLE notices DROP CONSTRAINT notices_scope_check');
      await q(`ALTER TABLE notices ADD CONSTRAINT notices_scope_check CHECK (
        (scope_level IS NULL AND county_id IS NULL AND constituency_id IS NULL)
        OR (scope_level = 'PLATFORM' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NULL)
        OR (scope_level = 'COUNTY' AND county_id IS NOT NULL AND constituency_id IS NULL AND ward_id IS NULL)
        OR (scope_level = 'CONSTITUENCY' AND county_id IS NULL AND constituency_id IS NOT NULL AND ward_id IS NULL)
        OR (scope_level = 'WARD' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NOT NULL))`);
      const r = await attempt(() => startup.startServer(startDeps()));
      expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
      expect(r.error.message).toContain('check:notices_scope_check');
      expect(listened).toBe(0);
    });

    test('startServerOrExit on a PARTIAL database: logs, exits 1, does not listen', async () => {
      await productionShape();
      await q('ALTER TABLE notices ADD COLUMN scope_level VARCHAR(20), ADD COLUMN county_id INT, ADD COLUMN constituency_id INT');
      const exits = [];
      const lines = [];
      const r = await attempt(() => startup.startServerOrExit(startDeps(), { exit: (c) => exits.push(c), logger: { error: (...a) => lines.push(a.join(' ')) } }));
      expect(r.error).toBe(undefined);
      expect(exits).toEqual([1]);
      expect(listened).toBe(0);
      expect(lines.join('\n')).toMatch(/Startup aborted/);
      expect(lines.join('\n')).toContain('PARTIAL');
    });
  });

  // ==========================================================================
  // ensureNoticesTable() with the real installer
  // ==========================================================================
  describe('ensureNoticesTable() on a real database', () => {
    test('PARTIAL schema: rejects with NOTICE_SCOPE_NOT_READY (not swallowed) and repairs nothing', async () => {
      await productionShape();
      await q('ALTER TABLE notices ADD COLUMN scope_level VARCHAR(20), ADD COLUMN county_id INT, ADD COLUMN constituency_id INT');
      const r = await attempt(() => migrations.ensureNoticesTable());
      expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
      expect(r.error.code).toBe('NOTICE_SCOPE_NOT_READY');
      expect(await state()).toBe('PARTIAL');
    });

    test('production shape: installs and verifies the scope schema', async () => {
      await productionShape();
      const r = await attempt(() => migrations.ensureNoticesTable());
      expect(r.error).toBe(undefined);
      const v = await R.verifyNoticeScopeReady(pool);
      expect(v.state).toBe('INSTALLED');
    });
  });

  // ==========================================================================
  // C on a real server: atomic and serialised
  // ==========================================================================
  describe('C. the installer on a real server', () => {
    test('atomic: a failure part-way (the geography table is missing) leaves NOTHING behind, rethrows the original error, and leaks no client', async () => {
      await productionShape();
      await q('DROP TABLE wards, constituencies CASCADE'); // the FK on constituencies(id) cannot be created
      const r = await attempt(() => migrations.ensureNoticeScopeColumns());
      expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(false);
      expect(r.error.code).toBe('42P01'); // undefined_table: the ORIGINAL pg error, unwrapped
      expect(String(r.error.message)).toMatch(/constituencies/);
      // the three ADD COLUMNs that ran BEFORE the failing statement were rolled back with it
      const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'notices' AND column_name IN ('scope_level', 'county_id', 'constituency_id')")).rows;
      expect(cols).toEqual([]);
      expect(await one("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'notices_keep_scoped_ward_null'")).toEqual({ n: 0 });
      expect(await state()).toBe('NOT_INSTALLED');
      expect(pool.idleCount).toBe(pool.totalCount); // every client is back in the pool
    });

    test('atomic: after the failure is fixed, the next start installs cleanly', async () => {
      await productionShape();
      await q('ALTER TABLE constituencies RENAME TO constituencies_gone');
      const first = await attempt(() => migrations.ensureNoticeScopeColumns());
      expect(first.error.code).toBe('42P01');
      await q('ALTER TABLE constituencies_gone RENAME TO constituencies');
      const second = await attempt(() => migrations.ensureNoticeScopeColumns());
      expect(second.error).toBe(undefined);
      expect(await state()).toBe('INSTALLED');
    });

    test('PARTIAL / INVALID are never repaired by the installer (schema byte-for-byte as found)', async () => {
      await productionShape();
      await q('ALTER TABLE notices ADD COLUMN scope_level VARCHAR(20)');
      const dump = async () => JSON.stringify((await q("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'notices' ORDER BY column_name")).rows);
      const before = await dump();
      const r = await attempt(() => migrations.ensureNoticeScopeColumns());
      expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
      expect(r.error.state).toBe('PARTIAL');
      expect(await dump()).toBe(before);
    });

    test('serialised: while another session holds the install advisory lock the installer waits, then installs once the lock is released', async () => {
      await productionShape();
      const holder = await pool.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [R.NOTICE_SCOPE_INSTALL_LOCK.key1, R.NOTICE_SCOPE_INSTALL_LOCK.key2]);
      let finished = false;
      const p = migrations.ensureNoticeScopeColumns().then(() => { finished = true; }, (e) => { finished = e; });
      await sleep(500);
      expect(finished).toBe(false);                 // waiting on the lock
      expect(await state()).toBe('NOT_INSTALLED');  // and has changed nothing yet
      await holder.query('COMMIT');
      holder.release();
      await p;
      expect(finished).toBe(true);
      expect(await state()).toBe('INSTALLED');
    });

    test('two instances starting together: both succeed, the schema is installed once and verifies', async () => {
      await productionShape();
      const results = await Promise.all([0, 1, 2].map(() => attempt(() => migrations.ensureNoticeScopeColumns())));
      results.forEach((r) => expect(r.error).toBe(undefined));
      expect(await state()).toBe('INSTALLED');
      expect(await one("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'notices_keep_scoped_ward_null' AND NOT tgisinternal")).toEqual({ n: 1 });
      expect(pool.idleCount).toBe(pool.totalCount);
    });
  });

  // ==========================================================================
  // A / D against the real catalog: ~55 injected faults
  // ==========================================================================
  describe('A/D. the inspector against real catalog rows', () => {
    const GOOD_CHECK = `CHECK (COALESCE(
 (scope_level IS NULL AND county_id IS NULL AND constituency_id IS NULL)
 OR (scope_level = 'PLATFORM' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NULL)
 OR (scope_level = 'COUNTY' AND county_id IS NOT NULL AND constituency_id IS NULL AND ward_id IS NULL)
 OR (scope_level = 'CONSTITUENCY' AND county_id IS NULL AND constituency_id IS NOT NULL AND ward_id IS NULL)
 OR (scope_level = 'WARD' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NOT NULL), false))`;
    const swapCheck = (expr) => `ALTER TABLE notices DROP CONSTRAINT notices_scope_check; ALTER TABLE notices ADD CONSTRAINT notices_scope_check ${expr}`;
    const dropTrg = 'DROP TRIGGER notices_keep_scoped_ward_null ON notices;';
    const newTrg = (when, extra) => `${dropTrg} CREATE TRIGGER notices_keep_scoped_ward_null BEFORE ${extra || 'UPDATE OF ward_id'} ON notices FOR EACH ROW ${when} EXECUTE PROCEDURE notices_keep_scoped_ward_null()`;
    const GOOD_WHEN = 'WHEN (OLD.ward_id IS NULL AND NEW.ward_id IS NOT NULL)';
    const replaceFn = (body) => `CREATE OR REPLACE FUNCTION notices_keep_scoped_ward_null() RETURNS trigger AS $f$ ${body} $f$ LANGUAGE plpgsql`;

    // [label, sql, expected state, needs superuser]
    const FAULTS = [
      ['control (no fault)', 'SELECT 1', 'INSTALLED'],
      ['column scope_level dropped (cascades the CHECK and its index)', 'ALTER TABLE notices DROP COLUMN scope_level CASCADE', 'PARTIAL'],
      ['column county_id dropped', 'ALTER TABLE notices DROP COLUMN county_id CASCADE', 'PARTIAL'],
      ['column constituency_id dropped', 'ALTER TABLE notices DROP COLUMN constituency_id CASCADE', 'PARTIAL'],
      ['county FK dropped', 'ALTER TABLE notices DROP CONSTRAINT notices_county_id_fk', 'PARTIAL'],
      ['constituency FK dropped', 'ALTER TABLE notices DROP CONSTRAINT notices_constituency_id_fk', 'PARTIAL'],
      ['CHECK dropped', 'ALTER TABLE notices DROP CONSTRAINT notices_scope_check', 'PARTIAL'],
      ['trigger dropped', dropTrg.replace(';', ''), 'PARTIAL'],
      ['function dropped (cascades the trigger)', 'DROP FUNCTION notices_keep_scoped_ward_null() CASCADE', 'PARTIAL'],
      ['index scope_level dropped', 'DROP INDEX idx_notices_scope_level', 'PARTIAL'],
      ['index county_id dropped', 'DROP INDEX idx_notices_county_id', 'PARTIAL'],
      ['index constituency_id dropped', 'DROP INDEX idx_notices_constituency_id', 'PARTIAL'],
      ['columns only', 'DROP INDEX idx_notices_scope_level; DROP INDEX idx_notices_county_id; DROP INDEX idx_notices_constituency_id; DROP FUNCTION notices_keep_scoped_ward_null() CASCADE; ALTER TABLE notices DROP CONSTRAINT notices_scope_check; ALTER TABLE notices DROP CONSTRAINT notices_county_id_fk; ALTER TABLE notices DROP CONSTRAINT notices_constituency_id_fk', 'PARTIAL'],
      ['every scope object dropped', 'ALTER TABLE notices DROP COLUMN scope_level CASCADE; ALTER TABLE notices DROP COLUMN county_id CASCADE; ALTER TABLE notices DROP COLUMN constituency_id CASCADE; DROP FUNCTION notices_keep_scoped_ward_null() CASCADE', 'NOT_INSTALLED'],
      ['trigger DISABLED', 'ALTER TABLE notices DISABLE TRIGGER notices_keep_scoped_ward_null', 'INVALID'],
      ['trigger ENABLE REPLICA', 'ALTER TABLE notices ENABLE REPLICA TRIGGER notices_keep_scoped_ward_null', 'INVALID'],
      ['trigger ENABLE ALWAYS (acceptable)', 'ALTER TABLE notices ENABLE ALWAYS TRIGGER notices_keep_scoped_ward_null', 'INSTALLED'],
      ['trigger AFTER', newTrg(GOOD_WHEN).replace('BEFORE', 'AFTER'), 'INVALID'],
      ['trigger FOR EACH STATEMENT', `${dropTrg} CREATE TRIGGER notices_keep_scoped_ward_null BEFORE UPDATE OF ward_id ON notices FOR EACH STATEMENT EXECUTE PROCEDURE notices_keep_scoped_ward_null()`, 'INVALID'],
      ['trigger INSERT OR UPDATE', `${dropTrg} CREATE TRIGGER notices_keep_scoped_ward_null BEFORE INSERT OR UPDATE OF ward_id ON notices FOR EACH ROW EXECUTE PROCEDURE notices_keep_scoped_ward_null()`, 'INVALID'],
      ['trigger on another column', newTrg(GOOD_WHEN, 'UPDATE OF title'), 'INVALID'],
      ['trigger WHEN (false)', newTrg('WHEN (false)'), 'INVALID'],
      ['trigger WHEN only for WARD notices', newTrg("WHEN (OLD.scope_level = 'WARD')"), 'INVALID'],
      ['trigger WHEN with a function call', newTrg('WHEN (pg_sleep(0) IS NULL OR true)'), 'INVALID'],
      ['trigger without WHEN (acceptable)', newTrg(''), 'INSTALLED'],
      ['trigger without OF column list (acceptable)', newTrg(GOOD_WHEN, 'UPDATE'), 'INSTALLED'],
      ['function body no-op', replaceFn('BEGIN RETURN NEW; END'), 'INVALID'],
      ['function protects only PLATFORM', replaceFn("BEGIN IF OLD.scope_level IN ('PLATFORM') THEN RETURN NULL; END IF; RETURN NEW; END"), 'INVALID'],
      ['function SECURITY DEFINER', 'ALTER FUNCTION notices_keep_scoped_ward_null() SECURITY DEFINER', 'INVALID'],
      ['function body re-indented (acceptable)', replaceFn("\n  BEGIN\n    IF OLD.scope_level IN ('PLATFORM',   'COUNTY', 'CONSTITUENCY') THEN\n      RETURN NULL;\n    END IF;\n    RETURN NEW;\n  END\n"), 'INSTALLED'],
      ['CHECK unwrapped (no COALESCE)', swapCheck(`CHECK (
 (scope_level IS NULL AND county_id IS NULL AND constituency_id IS NULL)
 OR (scope_level = 'PLATFORM' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NULL)
 OR (scope_level = 'COUNTY' AND county_id IS NOT NULL AND constituency_id IS NULL AND ward_id IS NULL)
 OR (scope_level = 'CONSTITUENCY' AND county_id IS NULL AND constituency_id IS NOT NULL AND ward_id IS NULL)
 OR (scope_level = 'WARD' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NOT NULL))`), 'INVALID'],
      ['CHECK (true)', swapCheck('CHECK (true)'), 'INVALID'],
      ['CHECK without the WARD branch', swapCheck(`CHECK (COALESCE(
 (scope_level IS NULL AND county_id IS NULL AND constituency_id IS NULL)
 OR (scope_level = 'PLATFORM' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NULL)
 OR (scope_level = 'COUNTY' AND county_id IS NOT NULL AND constituency_id IS NULL AND ward_id IS NULL)
 OR (scope_level = 'CONSTITUENCY' AND county_id IS NULL AND constituency_id IS NOT NULL AND ward_id IS NULL), false))`), 'INVALID'],
      ['CHECK lets PLATFORM carry a ward', swapCheck(`CHECK (COALESCE(
 (scope_level IS NULL AND county_id IS NULL AND constituency_id IS NULL)
 OR (scope_level = 'PLATFORM' AND county_id IS NULL AND constituency_id IS NULL)
 OR (scope_level = 'COUNTY' AND county_id IS NOT NULL AND constituency_id IS NULL AND ward_id IS NULL)
 OR (scope_level = 'CONSTITUENCY' AND county_id IS NULL AND constituency_id IS NOT NULL AND ward_id IS NULL)
 OR (scope_level = 'WARD' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NOT NULL), false))`), 'INVALID'],
      ['CHECK reads another column', swapCheck('CHECK (title IS NOT NULL OR scope_level IS NULL)'), 'INVALID'],
      ['CHECK calls a function', swapCheck("CHECK (length(coalesce(scope_level, 'x')) > 0)"), 'INVALID'],
      ['CHECK NOT VALID', `ALTER TABLE notices DROP CONSTRAINT notices_scope_check; ALTER TABLE notices ADD CONSTRAINT notices_scope_check ${GOOD_CHECK} NOT VALID`, 'INVALID'],
      ['CHECK, CASE form without the outer COALESCE (still has the NULL hole)', swapCheck(`CHECK (COALESCE(
 CASE WHEN scope_level IS NULL THEN county_id IS NULL AND constituency_id IS NULL ELSE false END, false)
 OR (scope_level = 'PLATFORM' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NULL)
 OR (scope_level = 'COUNTY' AND county_id IS NOT NULL AND constituency_id IS NULL AND ward_id IS NULL)
 OR (scope_level = 'CONSTITUENCY' AND county_id IS NULL AND constituency_id IS NOT NULL AND ward_id IS NULL)
 OR (scope_level = 'WARD' AND county_id IS NULL AND constituency_id IS NULL AND ward_id IS NOT NULL))`), 'INVALID'],
      ['CHECK reordered / CASE-based but equivalent (acceptable)', swapCheck(`CHECK (COALESCE(
 CASE scope_level WHEN 'WARD' THEN county_id IS NULL AND constituency_id IS NULL AND ward_id IS NOT NULL
   WHEN 'COUNTY' THEN county_id IS NOT NULL AND constituency_id IS NULL AND ward_id IS NULL
   WHEN 'CONSTITUENCY' THEN county_id IS NULL AND constituency_id IS NOT NULL AND ward_id IS NULL
   WHEN 'PLATFORM' THEN county_id IS NULL AND constituency_id IS NULL AND ward_id IS NULL
   ELSE false END
 OR (scope_level IS NULL AND county_id IS NULL AND constituency_id IS NULL), false))`), 'INSTALLED'],
      ['county FK NOT VALID', 'ALTER TABLE notices DROP CONSTRAINT notices_county_id_fk; ALTER TABLE notices ADD CONSTRAINT notices_county_id_fk FOREIGN KEY (county_id) REFERENCES counties(id) NOT VALID', 'INVALID'],
      ['county FK references the wrong table', 'ALTER TABLE notices DROP CONSTRAINT notices_county_id_fk; ALTER TABLE notices ADD CONSTRAINT notices_county_id_fk FOREIGN KEY (county_id) REFERENCES wards(id)', 'INVALID'],
      ['constituency FK on the wrong column', 'ALTER TABLE notices DROP CONSTRAINT notices_constituency_id_fk; ALTER TABLE notices ADD CONSTRAINT notices_constituency_id_fk FOREIGN KEY (county_id) REFERENCES constituencies(id)', 'INVALID'],
      ['county FK ON DELETE CASCADE', 'ALTER TABLE notices DROP CONSTRAINT notices_county_id_fk; ALTER TABLE notices ADD CONSTRAINT notices_county_id_fk FOREIGN KEY (county_id) REFERENCES counties(id) ON DELETE CASCADE', 'INVALID'],
      ['county FK DEFERRABLE', 'ALTER TABLE notices DROP CONSTRAINT notices_county_id_fk; ALTER TABLE notices ADD CONSTRAINT notices_county_id_fk FOREIGN KEY (county_id) REFERENCES counties(id) DEFERRABLE', 'INVALID'],
      ['county FK name taken by a CHECK', 'ALTER TABLE notices DROP CONSTRAINT notices_county_id_fk; ALTER TABLE notices ADD CONSTRAINT notices_county_id_fk CHECK (true)', 'INVALID'],
      ['scope_level is TEXT', `ALTER TABLE notices DROP COLUMN scope_level CASCADE; ALTER TABLE notices ADD COLUMN scope_level TEXT; CREATE INDEX idx_notices_scope_level ON notices(scope_level); ALTER TABLE notices ADD CONSTRAINT notices_scope_check ${GOOD_CHECK}`, 'INVALID'],
      ['scope_level is VARCHAR(50)', 'ALTER TABLE notices ALTER COLUMN scope_level TYPE VARCHAR(50)', 'INVALID'],
      ['county_id is BIGINT', 'ALTER TABLE notices DROP CONSTRAINT notices_county_id_fk; ALTER TABLE notices ALTER COLUMN county_id TYPE BIGINT; ALTER TABLE notices ADD CONSTRAINT notices_county_id_fk FOREIGN KEY (county_id) REFERENCES counties(id)', 'INVALID'],
      ['scope_level NOT NULL', 'ALTER TABLE notices ALTER COLUMN scope_level SET NOT NULL', 'INVALID'],
      ["scope_level DEFAULT 'PLATFORM'", "ALTER TABLE notices ALTER COLUMN scope_level SET DEFAULT 'PLATFORM'", 'INVALID'],
      ['ward_id is BIGINT', `${dropTrg} ALTER TABLE notices DROP CONSTRAINT notices_scope_check; ALTER TABLE notices ALTER COLUMN ward_id TYPE BIGINT; ALTER TABLE notices ADD CONSTRAINT notices_scope_check ${GOOD_CHECK}; CREATE TRIGGER notices_keep_scoped_ward_null BEFORE UPDATE OF ward_id ON notices FOR EACH ROW ${GOOD_WHEN} EXECUTE PROCEDURE notices_keep_scoped_ward_null()`, 'INVALID'],
      ['index on the wrong column', 'DROP INDEX idx_notices_county_id; CREATE INDEX idx_notices_county_id ON notices(title)', 'INVALID'],
      ['index partial', 'DROP INDEX idx_notices_scope_level; CREATE INDEX idx_notices_scope_level ON notices(scope_level) WHERE scope_level IS NOT NULL', 'INVALID'],
      ['index UNIQUE', 'DROP INDEX idx_notices_scope_level; CREATE UNIQUE INDEX idx_notices_scope_level ON notices(scope_level)', 'INVALID'],
      ['index hash', 'DROP INDEX idx_notices_county_id; CREATE INDEX idx_notices_county_id ON notices USING hash (county_id)', 'INVALID'],
      ['index on an expression', 'DROP INDEX idx_notices_county_id; CREATE INDEX idx_notices_county_id ON notices((county_id + 0))', 'INVALID'],
      ['index with two columns', 'DROP INDEX idx_notices_county_id; CREATE INDEX idx_notices_county_id ON notices(county_id, title)', 'INVALID'],
      ['index on another table', 'DROP INDEX idx_notices_scope_level; CREATE TABLE other_t (scope_level VARCHAR(20)); CREATE INDEX idx_notices_scope_level ON other_t(scope_level)', 'INVALID'],
      ['index marked invalid (superuser)', "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_notices_scope_level'::regclass", 'INVALID', true],
      ['index not ready (superuser)', "UPDATE pg_index SET indisready = false WHERE indexrelid = 'idx_notices_scope_level'::regclass", 'INVALID', true],
    ];

    let templateReady = false;
    async function withFault(sql, fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(sql);
        return await fn(c);
      } finally {
        try { await c.query('ROLLBACK'); } catch (_) { /* connection gone */ }
        c.release();
      }
    }

    beforeAll(async () => {
      await productionShape();
      await migrations.ensureNoticeScopeColumns();
      await q('DELETE FROM notices'); // an empty table, so faults such as SET NOT NULL are not refused by existing rows
      templateReady = true;
    });

    test('the schema built by the real installer is INSTALLED (the installer and the inspector agree on a real server)', async () => {
      expect(templateReady).toBe(true);
      const r = await R.inspectNoticeScopeSchema(pool);
      expect(r.invalid).toEqual([]);
      expect(r.state).toBe('INSTALLED');
    });

    test('injected faults are classified as expected (each runs in a transaction that is rolled back)', async () => {
      const wrong = [];
      for (const f of FAULTS) {
        const [label, sql, want, needsSuper] = f;
        if (needsSuper && !isSuper) continue;
        let got;
        try {
          got = await withFault(sql, async (c) => (await R.inspectNoticeScopeSchema(c)).state);
        } catch (e) {
          got = 'ERROR ' + String(e.message).slice(0, 120); // the fault itself could not be built: a defect in this test, reported by name
        }
        if (got !== want) wrong.push(`${label}: got ${got}, want ${want}`);
      }
      expect(wrong).toEqual([]);
      expect(await state()).toBe('INSTALLED'); // every fault was rolled back
    });

    test('the verifier names the failed object for a real fault, and the gate refuses it', async () => {
      const err = await withFault('ALTER TABLE notices DISABLE TRIGGER notices_keep_scoped_ward_null', async (c) => (await attempt(() => R.verifyNoticeScopeBeforeBackfill(c))).error);
      expect(err instanceof R.NoticeScopeNotReadyError).toBe(true);
      expect(err.state).toBe('INVALID');
      expect(err.message).toContain('trigger:notices_keep_scoped_ward_null');
      expect(err.message).toContain('DISABLED');
    });

    test('with ward-less scoped rows present, a real PARTIAL report carries the read-only counts', async () => {
      await addScopedNotices();
      await q("INSERT INTO notices (title, content, scope_level, ward_id) SELECT 'x', 'x', NULL, 10"); // a legacy row, not counted
      const err = await withFault('DROP TRIGGER notices_keep_scoped_ward_null ON notices', async (c) => (await attempt(() => R.verifyNoticeScopeBeforeBackfill(c))).error);
      expect(err.diagnostics).toEqual({ scopedWardlessRows: 3, scopedRowsWithWard: 0 });
      await q("DELETE FROM notices WHERE scope_level IS NOT NULL OR title = 'x'");
    });
  });
});
