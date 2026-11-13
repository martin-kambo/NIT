'use strict';

// ============================================================================
// Notice-scope migration readiness — Phase 4B.44
// ============================================================================
// Covers bootstrap/notice-scope-readiness.js, the atomic installer in
// bootstrap/migrations.js (ensureNoticeScopeColumns) and the start-up wiring in
// bootstrap/startup.js, against an in-memory model of the PostgreSQL catalog.
//
//   A  classification            NOT_INSTALLED / INSTALLED / PARTIAL / INVALID
//   B  pre-backfill gate         the Phase 2 backfill is never called for PARTIAL / INVALID
//   C  atomic installer          one transaction, rollback, client released, original error rethrown
//   D  post-install verifier     only a complete, valid schema passes
//   F  start-up integration      gate placement, no listen after a failed check, DB-down unchanged
//
// WHAT THIS FILE CANNOT PROVE
//   The catalog is a MODEL: it returns the rows PostgreSQL would return for each state, and it
//   answers the CHECK / WHEN probes from a behaviour label. Whether PostgreSQL really rejects and
//   accepts the right rows, whether the installed trigger really stops the Phase 2 backfill, and
//   whether two installers really serialise are proved against a disposable PostgreSQL by
//   __tests__/notice-scope-readiness.pg.test.js (group E).
//
// Nothing here touches a real database, the network or the production schema.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const R = require('../bootstrap/notice-scope-readiness');

const ROOT = path.join(__dirname, '..');
const squash = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const clone = (o) => JSON.parse(JSON.stringify(o));

// ───────────────────────── Catalog model ──────────────────────────────────
// Real PostgreSQL 16 output for the Phase 4B.42 objects (captured from a disposable database).
const CHECK_EXPR_PG16 =
  "COALESCE((((scope_level IS NULL) AND (county_id IS NULL) AND (constituency_id IS NULL)) OR (((scope_level)::text = 'PLATFORM'::text) AND (county_id IS NULL) AND (constituency_id IS NULL) AND (ward_id IS NULL)) OR (((scope_level)::text = 'COUNTY'::text) AND (county_id IS NOT NULL) AND (constituency_id IS NULL) AND (ward_id IS NULL)) OR (((scope_level)::text = 'CONSTITUENCY'::text) AND (county_id IS NULL) AND (constituency_id IS NOT NULL) AND (ward_id IS NULL)) OR (((scope_level)::text = 'WARD'::text) AND (county_id IS NULL) AND (constituency_id IS NULL) AND (ward_id IS NOT NULL))), false)";
const TRIGGER_DEF_PG16 =
  'CREATE TRIGGER notices_keep_scoped_ward_null BEFORE UPDATE OF ward_id ON public.notices FOR EACH ROW WHEN (((old.ward_id IS NULL) AND (new.ward_id IS NOT NULL))) EXECUTE FUNCTION notices_keep_scoped_ward_null()';
const FN = 'notices_keep_scoped_ward_null';

const COL = (type) => ({ type, not_null: false, has_default: false });
const FK = (col, ref) => ({
  type: 'f', validated: true, enforced: true, deferrable: false, match_type: 's', on_update: 'a', on_delete: 'a',
  ref_table: ref, columns: [col], ref_columns: ['id'], check_expression: null,
});
const IDX = (col) => ({
  valid: true, ready: true, live: true, is_unique: false, is_primary: false, is_exclusion: false, method: 'btree',
  is_partial: false, has_expressions: false, key_count: 1, columns: [col], on_notices: true,
});
const GOOD_FN = () => ({
  name: FN, schema: 'public', language: 'plpgsql', returns: 'trigger', args: 0, security_definer: false,
  body: R.TRIGGER_FUNCTION_BODY,
});
const GOOD_TRIGGER = () => ({
  name: FN, enabled: 'O', type_bits: 19, update_columns: ['ward_id'], definition: TRIGGER_DEF_PG16,
  fn_schema: 'public', fn_name: FN,
});

function goodModel() {
  return {
    notices: true,
    columns: { ward_id: COL('integer'), scope_level: COL('character varying(20)'), county_id: COL('integer'), constituency_id: COL('integer') },
    constraints: {
      notices_county_id_fk: FK('county_id', 'public.counties'),
      notices_constituency_id_fk: FK('constituency_id', 'public.constituencies'),
      notices_scope_check: {
        type: 'c', validated: true, enforced: true, deferrable: false, match_type: ' ', on_update: ' ', on_delete: ' ',
        ref_table: null, columns: [], ref_columns: null, check_expression: CHECK_EXPR_PG16,
      },
    },
    fn: [GOOD_FN()],
    trigger: GOOD_TRIGGER(),
    indexes: { idx_notices_scope_level: IDX('scope_level'), idx_notices_county_id: IDX('county_id'), idx_notices_constituency_id: IDX('constituency_id') },
    checkBehaviour: 'good',
    whenBehaviour: 'good',
    diag: { scoped_wardless_rows: 0, scoped_rows_with_ward: 0 },
  };
}

// The production-shaped state verified read-only before this phase: notices.ward_id exists, nothing else.
function emptyModel() {
  return {
    notices: true, columns: { ward_id: COL('integer') }, constraints: {}, fn: [], trigger: null, indexes: {},
    checkBehaviour: 'good', whenBehaviour: 'good', diag: { scoped_wardless_rows: 0, scoped_rows_with_ward: 0 },
  };
}

// What a CHECK of each flavour answers for a probe row (null = PostgreSQL treats it as passing).
function checkResult(kind, probe) {
  switch (kind) {
    case 'always-true': return true;
    case 'unwrapped': return probe.scope === null && (probe.county !== null || probe.constituency !== null) ? null : probe.accept;
    case 'platform-may-carry-ward': return /PLATFORM notice carrying a ward/.test(probe.label) ? true : probe.accept;
    case 'rejects-ward-notices': return probe.scope === 'WARD' && probe.accept ? false : probe.accept;
    default: return probe.accept;
  }
}
function whenResult(kind) {
  if (kind === 'never') return false;
  if (kind === 'null') return null;
  return true;
}

// A db with query() only. Every statement must be a tagged, read-only SELECT.
function catalogDb(model, opts) {
  const o = opts || {};
  const calls = [];
  async function query(sql) {
    const text = String(sql);
    calls.push(text);
    const m = /^\/\* nsr:([a-z-]+) \*\/ SELECT /.exec(text);
    if (!m) throw new Error('UNEXPECTED statement (not a tagged inspector SELECT): ' + text.slice(0, 100));
    if (o.failOn === m[1]) throw new Error(o.failMessage || 'catalog query failed');
    switch (m[1]) {
      case 'tables': return { rows: [{ notices: model.notices, counties: true, constituencies: true }] };
      case 'columns': return { rows: Object.keys(model.columns).map((name) => Object.assign({ name }, model.columns[name])) };
      case 'constraints': return { rows: Object.keys(model.constraints).map((name) => Object.assign({ name }, model.constraints[name])) };
      case 'trigger': return { rows: model.trigger ? [model.trigger] : [] };
      case 'function': return { rows: model.fn };
      case 'indexes': return { rows: Object.keys(model.indexes).map((name) => Object.assign({ name }, model.indexes[name])) };
      case 'check-probe': return { rows: R.CHECK_PROBES.map((p, i) => ({ id: i, result: checkResult(model.checkBehaviour, p) })) };
      case 'when-probe': return { rows: R.WHEN_PROBES.map((p, i) => ({ id: i, result: whenResult(model.whenBehaviour) })) };
      case 'diagnostics': return { rows: [model.diag] };
      default: throw new Error('unknown inspector query ' + m[1]);
    }
  }
  return { query, calls };
}

// ───────────────────────── The state table (used by A, B, D and F) ────────────
// [label, mutate(model), expected state, object that must be named]
const PARTIAL_FAULTS = [
  ['column scope_level missing', (m) => { delete m.columns.scope_level; }, 'column:scope_level'],
  ['column county_id missing', (m) => { delete m.columns.county_id; }, 'column:county_id'],
  ['column constituency_id missing', (m) => { delete m.columns.constituency_id; }, 'column:constituency_id'],
  ['county foreign key missing', (m) => { delete m.constraints.notices_county_id_fk; }, 'foreign-key:notices_county_id_fk'],
  ['constituency foreign key missing', (m) => { delete m.constraints.notices_constituency_id_fk; }, 'foreign-key:notices_constituency_id_fk'],
  ['CHECK constraint missing', (m) => { delete m.constraints.notices_scope_check; }, 'check:notices_scope_check'],
  ['trigger function missing', (m) => { m.fn = []; }, 'trigger-function:' + FN],
  ['trigger missing (function present)', (m) => { m.trigger = null; }, 'trigger:' + FN],
  ['index on scope_level missing', (m) => { delete m.indexes.idx_notices_scope_level; }, 'index:idx_notices_scope_level'],
  ['index on county_id missing', (m) => { delete m.indexes.idx_notices_county_id; }, 'index:idx_notices_county_id'],
  ['index on constituency_id missing', (m) => { delete m.indexes.idx_notices_constituency_id; }, 'index:idx_notices_constituency_id'],
  ['columns only: constraints, function, trigger and indexes all missing (the dangerous shape)', (m) => {
    m.constraints = {}; m.fn = []; m.trigger = null; m.indexes = {};
  }, 'trigger:' + FN],
  ['everything installed except the indexes', (m) => { m.indexes = {}; }, 'index:idx_notices_scope_level'],
];

const withIndex = (name, patch) => (m) => { Object.assign(m.indexes[name], patch); };
const withFk = (name, patch) => (m) => { Object.assign(m.constraints[name], patch); };
const withCol = (name, patch) => (m) => { Object.assign(m.columns[name], patch); };
const withCheck = (patch) => (m) => { Object.assign(m.constraints.notices_scope_check, patch); };
const withTrigger = (patch) => (m) => { Object.assign(m.trigger, patch); };
const withFn = (patch) => (m) => { Object.assign(m.fn[0], patch); };

const INVALID_FAULTS = [
  // trigger
  ['trigger DISABLED', withTrigger({ enabled: 'D' }), 'trigger:' + FN],
  ['trigger enabled for replicas only (does not fire for ordinary sessions)', withTrigger({ enabled: 'R' }), 'trigger:' + FN],
  ['trigger is AFTER, not BEFORE', withTrigger({ type_bits: 17 }), 'trigger:' + FN],
  ['trigger is FOR EACH STATEMENT', withTrigger({ type_bits: 18 }), 'trigger:' + FN],
  ['trigger also fires on INSERT', withTrigger({ type_bits: 23 }), 'trigger:' + FN],
  ['trigger fires only on updates of another column', withTrigger({ update_columns: ['title'] }), 'trigger:' + FN],
  ['trigger WHEN never fires', (m) => { m.whenBehaviour = 'never'; }, 'trigger:' + FN],
  ['trigger WHEN evaluates to NULL for the backfill', (m) => { m.whenBehaviour = 'null'; }, 'trigger:' + FN],
  ['trigger WHEN calls a function', withTrigger({
    definition: 'CREATE TRIGGER notices_keep_scoped_ward_null BEFORE UPDATE OF ward_id ON public.notices FOR EACH ROW WHEN (((pg_sleep((1)::double precision) IS NULL) OR true)) EXECUTE FUNCTION notices_keep_scoped_ward_null()',
  }), 'trigger:' + FN],
  ['trigger calls a different function', withTrigger({ fn_name: 'some_other_function' }), 'trigger:' + FN],
  // function
  ['trigger function is a no-op (returns NEW)', withFn({ body: 'BEGIN RETURN NEW; END' }), 'trigger-function:' + FN],
  ['trigger function protects only PLATFORM', withFn({ body: "BEGIN IF OLD.scope_level IN ('PLATFORM') THEN RETURN NULL; END IF; RETURN NEW; END" }), 'trigger-function:' + FN],
  ['trigger function is SECURITY DEFINER', withFn({ security_definer: true }), 'trigger-function:' + FN],
  ['trigger function is not plpgsql', withFn({ language: 'sql' }), 'trigger-function:' + FN],
  ['trigger function does not return trigger', withFn({ returns: 'text' }), 'trigger-function:' + FN],
  ['trigger function takes an argument', withFn({ args: 1 }), 'trigger-function:' + FN],
  ['trigger function has an overload', (m) => { m.fn.push(Object.assign(GOOD_FN(), { args: 1 })); }, 'trigger-function:' + FN],
  // CHECK
  ['CHECK accepts every row (CHECK (true))', (m) => { m.checkBehaviour = 'always-true'; }, 'check:notices_scope_check'],
  ['CHECK lets a NULL scope_level carry a county or constituency (unwrapped, no COALESCE)', (m) => { m.checkBehaviour = 'unwrapped'; }, 'check:notices_scope_check'],
  ['CHECK lets a PLATFORM notice carry a ward', (m) => { m.checkBehaviour = 'platform-may-carry-ward'; }, 'check:notices_scope_check'],
  ['CHECK rejects WARD notices', (m) => { m.checkBehaviour = 'rejects-ward-notices'; }, 'check:notices_scope_check'],
  ['CHECK is NOT VALID', withCheck({ validated: false }), 'check:notices_scope_check'],
  ['CHECK is NOT ENFORCED (PostgreSQL 18)', withCheck({ enforced: false }), 'check:notices_scope_check'],
  ['CHECK name is used by another kind of constraint', withCheck({ type: 'u' }), 'check:notices_scope_check'],
  ['CHECK reads an unrelated column', withCheck({ check_expression: '(title IS NOT NULL)' }), 'check:notices_scope_check'],
  ['CHECK calls a function', withCheck({ check_expression: '(length((scope_level)::text) > 0)' }), 'check:notices_scope_check'],
  ['CHECK expression smuggles a second statement', withCheck({ check_expression: '(true); DROP TABLE notices' }), 'check:notices_scope_check'],
  ['CHECK expression is empty', withCheck({ check_expression: null }), 'check:notices_scope_check'],
  // foreign keys
  ['county foreign key is NOT VALID', withFk('notices_county_id_fk', { validated: false }), 'foreign-key:notices_county_id_fk'],
  ['county foreign key is NOT ENFORCED (PostgreSQL 18)', withFk('notices_county_id_fk', { enforced: false }), 'foreign-key:notices_county_id_fk'],
  ['county foreign key references the wrong table', withFk('notices_county_id_fk', { ref_table: 'public.wards' }), 'foreign-key:notices_county_id_fk'],
  ['constituency foreign key is on the wrong column', withFk('notices_constituency_id_fk', { columns: ['county_id'] }), 'foreign-key:notices_constituency_id_fk'],
  ['county foreign key references a different column', withFk('notices_county_id_fk', { ref_columns: ['name'] }), 'foreign-key:notices_county_id_fk'],
  ['county foreign key is ON DELETE CASCADE', withFk('notices_county_id_fk', { on_delete: 'c' }), 'foreign-key:notices_county_id_fk'],
  ['county foreign key is DEFERRABLE', withFk('notices_county_id_fk', { deferrable: true }), 'foreign-key:notices_county_id_fk'],
  ['county foreign key name is used by a CHECK', withFk('notices_county_id_fk', { type: 'c' }), 'foreign-key:notices_county_id_fk'],
  // columns
  ['scope_level is TEXT', withCol('scope_level', { type: 'text' }), 'column:scope_level'],
  ['scope_level is VARCHAR(50)', withCol('scope_level', { type: 'character varying(50)' }), 'column:scope_level'],
  ['county_id is BIGINT', withCol('county_id', { type: 'bigint' }), 'column:county_id'],
  ['scope_level is NOT NULL (no LEGACY state possible)', withCol('scope_level', { not_null: true }), 'column:scope_level'],
  ['scope_level has a DEFAULT (would scope every legacy insert)', withCol('scope_level', { has_default: true }), 'column:scope_level'],
  ['ward_id (the prerequisite) is BIGINT', withCol('ward_id', { type: 'bigint' }), 'column:ward_id'],
  // indexes
  ['index on scope_level is on the wrong column', withIndex('idx_notices_scope_level', { columns: ['title'] }), 'index:idx_notices_scope_level'],
  ['index is partial', withIndex('idx_notices_scope_level', { is_partial: true }), 'index:idx_notices_scope_level'],
  ['index is UNIQUE', withIndex('idx_notices_county_id', { is_unique: true }), 'index:idx_notices_county_id'],
  ['index is a hash index', withIndex('idx_notices_county_id', { method: 'hash' }), 'index:idx_notices_county_id'],
  ['index is on an expression', withIndex('idx_notices_county_id', { has_expressions: true, columns: null }), 'index:idx_notices_county_id'],
  ['index has two columns', withIndex('idx_notices_county_id', { columns: ['county_id', 'title'], key_count: 2 }), 'index:idx_notices_county_id'],
  ['index is INVALID (an interrupted CREATE INDEX)', withIndex('idx_notices_constituency_id', { valid: false }), 'index:idx_notices_constituency_id'],
  ['index is not READY', withIndex('idx_notices_constituency_id', { ready: false }), 'index:idx_notices_constituency_id'],
  ['index is on another table', withIndex('idx_notices_scope_level', { on_notices: false }), 'index:idx_notices_scope_level'],
];

// Variants PostgreSQL versions / DBAs may legitimately produce: judged by behaviour, not by text.
const ACCEPTED_VARIANTS = [
  ['trigger ENABLE ALWAYS', withTrigger({ enabled: 'A' })],
  ['trigger without a WHEN clause (the function alone decides)', withTrigger({
    definition: 'CREATE TRIGGER notices_keep_scoped_ward_null BEFORE UPDATE OF ward_id ON public.notices FOR EACH ROW EXECUTE FUNCTION notices_keep_scoped_ward_null()',
  })],
  ['trigger without an OF column list (fires on every update)', withTrigger({ update_columns: [] })],
  ['trigger definition using EXECUTE PROCEDURE (older deparse)', withTrigger({
    definition: TRIGGER_DEF_PG16.replace('EXECUTE FUNCTION', 'EXECUTE PROCEDURE'),
  })],
  ['function body re-indented', withFn({ body: R.TRIGGER_FUNCTION_BODY })],
  ['CHECK deparsed with varchar casts instead of text casts (another server version)', withCheck({
    check_expression: CHECK_EXPR_PG16.replace(/::text/g, '::character varying'),
  })],
  ['CHECK deparsed without the redundant inner casts', withCheck({
    check_expression: CHECK_EXPR_PG16.replace(/\(\(scope_level\)::text = '(\w+)'::text\)/g, "(scope_level = '$1')"),
  })],
];

const make = (mutate) => { const m = goodModel(); if (mutate) mutate(m); return m; };
const inspect = (model, opts) => { const db = catalogDb(model, opts); return R.inspectNoticeScopeSchema(db).then((r) => ({ r, db })); };
const attempt = async (fn) => { try { return { value: await fn() }; } catch (error) { return { error }; } };

// ============================================================================
// A. Classification
// ============================================================================
describe('A. classification of the notice-scope schema', () => {
  test('the model fixtures are consistent: 11 expected objects', () => {
    expect(R.SCOPE_OBJECTS).toHaveLength(11);
    expect(R.SCOPE_OBJECTS.filter((o) => o.kind === 'column')).toHaveLength(3);
    expect(R.SCOPE_OBJECTS.filter((o) => o.kind === 'foreign key')).toHaveLength(2);
    expect(R.SCOPE_OBJECTS.filter((o) => o.kind === 'CHECK constraint')).toHaveLength(1);
    expect(R.SCOPE_OBJECTS.filter((o) => o.kind === 'trigger function')).toHaveLength(1);
    expect(R.SCOPE_OBJECTS.filter((o) => o.kind === 'trigger')).toHaveLength(1);
    expect(R.SCOPE_OBJECTS.filter((o) => o.kind === 'index')).toHaveLength(3);
  });

  test('the notices table does not exist (fresh database) => NOT_INSTALLED, and nothing else is queried', async () => {
    const { r, db } = await inspect(Object.assign(emptyModel(), { notices: false }));
    expect(r.state).toBe('NOT_INSTALLED');
    expect(r.tableExists).toBe(false);
    expect(db.calls).toHaveLength(1);
  });

  test('production shape (notices.ward_id only, no scope object) => NOT_INSTALLED', async () => {
    const { r } = await inspect(emptyModel());
    expect(r.state).toBe('NOT_INSTALLED');
    expect(r.tableExists).toBe(true);
    expect(r.present).toEqual([]);
    expect(r.missing).toHaveLength(11);
    expect(r.invalid).toEqual([]);
  });

  test('all 11 objects present and valid => INSTALLED', async () => {
    const { r } = await inspect(goodModel());
    expect(r.state).toBe('INSTALLED');
    expect(r.present).toHaveLength(11);
    expect(r.missing).toEqual([]);
    expect(r.invalid).toEqual([]);
  });

  test.each(PARTIAL_FAULTS)('PARTIAL: %s', async (label, mutate, object) => {
    const { r } = await inspect(make(mutate));
    expect(r.state).toBe('PARTIAL');
    expect(r.missing).toContain(object);
  });

  test.each(INVALID_FAULTS)('INVALID: %s', async (label, mutate, object) => {
    const { r } = await inspect(make(mutate));
    expect(r.state).toBe('INVALID');
    expect(r.invalid.map((p) => p.object)).toContain(object);
    expect(r.missing).toEqual([]);
    r.invalid.forEach((p) => {
      expect(typeof p.requirement).toBe('string');
      expect(typeof p.reason).toBe('string');
    });
  });

  test.each(ACCEPTED_VARIANTS)('INSTALLED (judged by behaviour, not by text): %s', async (label, mutate) => {
    const { r } = await inspect(make(mutate));
    expect(r.invalid).toEqual([]);
    expect(r.state).toBe('INSTALLED');
  });

  test('a missing object is PARTIAL while a present-but-wrong object is INVALID (the documented rule)', async () => {
    const missing = (await inspect(make((m) => { delete m.indexes.idx_notices_county_id; }))).r;
    const wrong = (await inspect(make((m) => { m.indexes.idx_notices_county_id.method = 'hash'; }))).r;
    expect(missing.state).toBe('PARTIAL');
    expect(wrong.state).toBe('INVALID');
  });

  test('a PARTIAL schema reports how many ward-less scoped notices the backfill would have touched (read-only count)', async () => {
    const m = make((x) => { x.trigger = null; x.diag = { scoped_wardless_rows: 3, scoped_rows_with_ward: 1 }; });
    const { r, db } = await inspect(m);
    expect(r.diagnostics).toEqual({ scopedWardlessRows: 3, scopedRowsWithWard: 1 });
    expect(db.calls.some((c) => /nsr:diagnostics/.test(c))).toBe(true);
  });

  test('diagnostics are skipped when the columns they read do not exist (so they can never abort a transaction)', async () => {
    const m = make((x) => { delete x.columns.scope_level; });
    const { r, db } = await inspect(m);
    expect(r.state).toBe('PARTIAL');
    expect(r.diagnostics).toBe(null);
    expect(db.calls.some((c) => /nsr:diagnostics/.test(c))).toBe(false);
  });

  test('every statement the inspector sends is a tagged, read-only SELECT', async () => {
    const models = [emptyModel(), goodModel()].concat(PARTIAL_FAULTS.map((f) => make(f[1]))).concat(INVALID_FAULTS.map((f) => make(f[1])));
    for (const m of models) {
      const { db } = await inspect(m);
      db.calls.forEach((c) => {
        expect(c).toMatch(/^\/\* nsr:[a-z-]+ \*\/ SELECT /);
        expect(c).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|VACUUM|REINDEX)\b/i);
        expect(c).not.toContain(';');
      });
    }
  });

  test('an expression that is not a plain boolean expression over the scope columns is never sent to the server', async () => {
    const bad = make(withCheck({ check_expression: '(true); DROP TABLE notices' }));
    const { r, db } = await inspect(bad);
    expect(r.state).toBe('INVALID');
    expect(db.calls.some((c) => /nsr:check-probe/.test(c))).toBe(false);
    const sleepy = make(withTrigger({
      definition: 'CREATE TRIGGER notices_keep_scoped_ward_null BEFORE UPDATE OF ward_id ON public.notices FOR EACH ROW WHEN (pg_sleep(10) IS NULL) EXECUTE FUNCTION notices_keep_scoped_ward_null()',
    }));
    const second = await inspect(sleepy);
    expect(second.r.state).toBe('INVALID');
    expect(second.db.calls.some((c) => /nsr:when-probe/.test(c))).toBe(false);
  });

  test('the CHECK probes encode the scope model: every contradictory row is a reject probe', () => {
    const accepts = R.CHECK_PROBES.filter((p) => p.accept);
    const rejects = R.CHECK_PROBES.filter((p) => !p.accept);
    expect(accepts.length).toBeGreaterThanOrEqual(8);
    expect(rejects.length).toBeGreaterThanOrEqual(20);
    // what the Phase 2 backfill would produce on each protected level is a reject probe
    ['PLATFORM', 'COUNTY', 'CONSTITUENCY'].forEach((level) => {
      expect(rejects.some((p) => p.scope === level && p.ward !== null)).toBe(true);
    });
    // legacy rows (NULL level) with or without a ward are accepted
    expect(accepts.some((p) => p.scope === null && p.ward === null)).toBe(true);
    expect(accepts.some((p) => p.scope === null && p.ward === 1)).toBe(true);
    expect(accepts.some((p) => p.scope === 'WARD' && p.ward === 10)).toBe(true);
  });

  test('a failure to read the catalog is not "safe": it fails closed', async () => {
    const r = await attempt(() => R.verifyNoticeScopeBeforeBackfill(catalogDb(goodModel(), { failOn: 'indexes', failMessage: 'canceling statement due to statement timeout' })));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('UNVERIFIABLE');
    expect(r.error.message).toContain('statement timeout');
  });
});

// ============================================================================
// B. Pre-backfill gate
// ============================================================================
describe('B. verifyNoticeScopeBeforeBackfill (the gate in front of ensurePhase2Migrations)', () => {
  test('passes for NOT_INSTALLED (a fresh install, or the production shape)', async () => {
    const r = await R.verifyNoticeScopeBeforeBackfill(catalogDb(emptyModel()));
    expect(r.state).toBe('NOT_INSTALLED');
    const fresh = await R.verifyNoticeScopeBeforeBackfill(catalogDb(Object.assign(emptyModel(), { notices: false })));
    expect(fresh.state).toBe('NOT_INSTALLED');
  });

  test('passes for a complete, valid INSTALLED schema', async () => {
    const r = await R.verifyNoticeScopeBeforeBackfill(catalogDb(goodModel()));
    expect(r.state).toBe('INSTALLED');
  });

  test.each(PARTIAL_FAULTS)('stops for PARTIAL: %s', async (label, mutate, object) => {
    const r = await attempt(() => R.verifyNoticeScopeBeforeBackfill(catalogDb(make(mutate))));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('PARTIAL');
    expect(r.error.message).toContain(object);
  });

  test.each(INVALID_FAULTS)('stops for INVALID: %s', async (label, mutate, object) => {
    const r = await attempt(() => R.verifyNoticeScopeBeforeBackfill(catalogDb(make(mutate))));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('INVALID');
    expect(r.error.message).toContain(object);
  });

  test('the error says nothing was repaired and no row was changed', async () => {
    const r = await attempt(() => R.verifyNoticeScopeBeforeBackfill(catalogDb(make((m) => { m.trigger = null; }))));
    expect(r.error.reason).toMatch(/Nothing was repaired and no row was changed/);
    expect(r.error.message).toMatch(/Startup stopped/);
  });

  test('it only ever reads: no statement other than tagged SELECTs is sent', async () => {
    const db = catalogDb(emptyModel());
    await R.verifyNoticeScopeBeforeBackfill(db);
    expect(db.calls.length).toBeGreaterThan(0);
    db.calls.forEach((c) => expect(c).toMatch(/^\/\* nsr:[a-z-]+ \*\/ SELECT /));
  });
});

// ============================================================================
// D. Post-install verifier
// ============================================================================
describe('D. verifyNoticeScopeReady (verification after installation)', () => {
  test('passes only for INSTALLED', async () => {
    const r = await R.verifyNoticeScopeReady(catalogDb(goodModel()));
    expect(r.state).toBe('INSTALLED');
  });

  test('NOT_INSTALLED is a failure here (the installer did not run to completion), unlike at the gate', async () => {
    const r = await attempt(() => R.verifyNoticeScopeReady(catalogDb(emptyModel())));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('NOT_INSTALLED');
    expect(r.error.phase).toMatch(/after notice-scope installation/);
    expect(r.error.message).toMatch(/installer did not complete/);
  });

  test.each(PARTIAL_FAULTS)('rejects PARTIAL: %s', async (label, mutate, object) => {
    const r = await attempt(() => R.verifyNoticeScopeReady(catalogDb(make(mutate))));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('PARTIAL');
    expect(r.error.problems.map((p) => p.object)).toContain(object);
  });

  test.each(INVALID_FAULTS)('rejects INVALID: %s', async (label, mutate, object) => {
    const r = await attempt(() => R.verifyNoticeScopeReady(catalogDb(make(mutate))));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('INVALID');
    expect(r.error.problems.map((p) => p.object)).toContain(object);
  });

  test('missing columns, foreign keys, CHECK, function, trigger and indexes are each named in the error', async () => {
    const m = make((x) => {
      delete x.columns.county_id; delete x.constraints.notices_constituency_id_fk; delete x.constraints.notices_scope_check;
      x.fn = []; x.trigger = null; x.indexes = {};
    });
    const r = await attempt(() => R.verifyNoticeScopeReady(catalogDb(m)));
    ['column:county_id', 'foreign-key:notices_constituency_id_fk', 'check:notices_scope_check', 'trigger-function:' + FN,
      'trigger:' + FN, 'index:idx_notices_scope_level', 'index:idx_notices_county_id', 'index:idx_notices_constituency_id']
      .forEach((o) => expect(r.error.message).toContain(o));
  });
});

// ============================================================================
// The structured error
// ============================================================================
describe('NoticeScopeNotReadyError', () => {
  test('identifies the schema state, the failed requirement, the object and why startup must stop', async () => {
    const r = await attempt(() => R.verifyNoticeScopeBeforeBackfill(catalogDb(make(withTrigger({ enabled: 'D' })))));
    const e = r.error;
    expect(e instanceof Error).toBe(true);
    expect(e.name).toBe('NoticeScopeNotReadyError');
    expect(e.code).toBe('NOTICE_SCOPE_NOT_READY');
    expect(e.state).toBe('INVALID');
    expect(e.phase).toBe('before the Phase 2 ward backfill');
    expect(e.problems).toEqual([{ object: 'trigger:' + FN, requirement: 'must be enabled', reason: 'it is DISABLED' }]);
    expect(e.reason).toMatch(/Phase 2 backfill/);
    expect(e.message).toContain('INVALID');
    expect(e.message).toContain('trigger:' + FN);
    expect(e.message).toContain('must be enabled');
  });

  test('carries no secret: connection strings and credentials in a driver error are redacted', async () => {
    const leaky = 'connect failed for postgres://nit_user:hunter2@db.internal:5432/nit password=hunter2 token: abc123';
    const r = await attempt(() => R.verifyNoticeScopeReady(catalogDb(goodModel(), { failOn: 'tables', failMessage: leaky })));
    expect(r.error.state).toBe('UNVERIFIABLE');
    const shown = r.error.message + JSON.stringify(r.error.problems);
    expect(shown).not.toContain('hunter2');
    expect(shown).not.toContain('abc123');
    expect(shown).not.toContain('postgres://');
    expect(shown).toContain('[redacted');
  });

  test('exports the stable constants the rest of the code relies on', () => {
    expect(R.ERROR_CODE).toBe('NOTICE_SCOPE_NOT_READY');
    expect(R.STATES).toEqual({ NOT_INSTALLED: 'NOT_INSTALLED', INSTALLED: 'INSTALLED', PARTIAL: 'PARTIAL', INVALID: 'INVALID' });
    expect(R.NOTICE_SCOPE_INSTALL_LOCK).toEqual({ key1: 4244, key2: 42 });
  });
});

// ============================================================================
// The expression allowlist
// ============================================================================
describe('sanitizeExpression (the only catalog text that is ever executed)', () => {
  test('accepts the PostgreSQL 16 deparse of the Phase 4B.42 CHECK', () => {
    const r = R.sanitizeExpression(CHECK_EXPR_PG16, {});
    expect(r.ok).toBe(true);
    expect(r.sql).toContain('coalesce');
    expect(r.sql).toContain("'PLATFORM'");
  });

  test('accepts the trigger WHEN condition and renames old/new to the probe aliases', () => {
    const when = R.extractWhenClause(TRIGGER_DEF_PG16);
    expect(when).toBe('((old.ward_id IS NULL) AND (new.ward_id IS NOT NULL))');
    const r = R.sanitizeExpression(when, { old: 'o__', new: 'n__' });
    expect(r.ok).toBe(true);
    expect(r.sql).toContain('o__ . ward_id');
    expect(r.sql).toContain('n__ . ward_id');
    expect(r.sql).not.toMatch(/\b(old|new)\b/);
  });

  test.each([
    ['a second statement', '(true); DROP TABLE notices'],
    ['a line comment', '(true) -- tail'],
    ['a block comment', '(true) /* x */'],
    ['a backslash', "(scope_level = 'a\\')"],
    ['a function call', 'pg_sleep(10)'],
    ['a sub-select', '(scope_level IN (SELECT scope_level FROM notices))'],
    ['an unrelated column', '(title IS NULL)'],
    ['a qualified name', '(notices.scope_level IS NULL)'],
    ['a quoted identifier', '("scope_level" IS NULL)'],
    ['an E-string', "(scope_level = E'x')"],
    ['dollar quoting', '($$x$$ IS NULL)'],
    ['a cast to an unknown type', '(scope_level::regclass IS NULL)'],
    ['arithmetic', '(county_id + 1 > 0)'],
  ])('rejects %s', (label, text) => {
    expect(R.sanitizeExpression(text, {}).ok).toBe(false);
  });

  test('rejects an empty or oversized expression, and old/new used without a column', () => {
    expect(R.sanitizeExpression('', {}).ok).toBe(false);
    expect(R.sanitizeExpression(null, {}).ok).toBe(false);
    expect(R.sanitizeExpression('(' + 'true AND '.repeat(2000) + 'true)', {}).ok).toBe(false);
    expect(R.sanitizeExpression('(old IS NULL)', { old: 'o__', new: 'n__' }).ok).toBe(false);
    expect(R.sanitizeExpression('(old.title IS NULL)', { old: 'o__', new: 'n__' }).ok).toBe(false);
  });

  test('extractWhenClause: no WHEN => null; unreadable WHEN => undefined', () => {
    expect(R.extractWhenClause('CREATE TRIGGER t BEFORE UPDATE ON public.notices FOR EACH ROW EXECUTE FUNCTION f()')).toBe(null);
    expect(R.extractWhenClause('CREATE TRIGGER t BEFORE UPDATE ON public.notices FOR EACH ROW WHEN (true)')).toBe(undefined);
  });
});

// ============================================================================
// C. Atomic installer  (bootstrap/migrations.js ensureNoticeScopeColumns)
// ============================================================================
// A transactional model of one database connection: BEGIN snapshots the catalog model, DDL changes it
// (each statement creates the object it names, taking its definition FROM THE STATEMENT TEXT where it can),
// ROLLBACK restores the snapshot, COMMIT keeps it. Anything the installer does outside a transaction is
// therefore visible as a half-installed state after a failure.
function installerHarness(opts) {
  const o = opts || {};
  const h = { model: o.model || emptyModel(), snapshot: null, log: [], released: [], poolQueries: [], connects: 0, commits: 0, rollbacks: 0 };

  function applyDdl(text) {
    const m = h.model;
    let mm;
    if (/^ALTER TABLE notices ADD COLUMN IF NOT EXISTS ward_id INT$/.test(text)) { m.columns.ward_id = m.columns.ward_id || COL('integer'); return; }
    if ((mm = /^ALTER TABLE notices ADD COLUMN IF NOT EXISTS (scope_level VARCHAR\(20\)|county_id INT|constituency_id INT)$/.exec(text))) {
      const name = mm[1].split(' ')[0];
      m.columns[name] = COL(name === 'scope_level' ? 'character varying(20)' : 'integer');
      return;
    }
    if ((mm = /ADD CONSTRAINT (notices_county_id_fk|notices_constituency_id_fk) FOREIGN KEY \((\w+)\) REFERENCES (\w+)\(id\)/.exec(text))) {
      m.constraints[mm[1]] = FK(mm[2], 'public.' + mm[3]);
      return;
    }
    if (/ADD CONSTRAINT notices_scope_check CHECK \(COALESCE\(/.test(text)) {
      m.constraints.notices_scope_check = goodModel().constraints.notices_scope_check;
      return;
    }
    if ((mm = /^CREATE OR REPLACE FUNCTION (\w+)\(\) RETURNS trigger AS \$fn\$ (.*) \$fn\$ LANGUAGE plpgsql$/.exec(text))) {
      m.fn = [Object.assign(GOOD_FN(), { name: mm[1], body: mm[2] })];
      return;
    }
    if (/CREATE TRIGGER notices_keep_scoped_ward_null BEFORE UPDATE OF ward_id ON notices FOR EACH ROW WHEN \((.*)\) EXECUTE PROCEDURE notices_keep_scoped_ward_null\(\)/.test(text)) {
      m.trigger = GOOD_TRIGGER();
      return;
    }
    if ((mm = /^CREATE INDEX IF NOT EXISTS (idx_notices_\w+) ON notices\((\w+)\)$/.exec(text))) {
      m.indexes[mm[1]] = IDX(mm[2]);
      return;
    }
    throw new Error('UNEXPECTED DDL in the installer (no model for it): ' + text.slice(0, 120));
  }

  async function query(sql, params) {
    // SQL comments are not part of the statement: a commented-out CREATE must not count as one
    const text = squash(String(sql).replace(/--[^\n]*/g, ''));
    h.log.push({ sql: text, params: params === undefined ? [] : params });
    if (/^\/\* nsr:/.test(text)) return catalogDb(h.model).query(sql);
    if (text === 'BEGIN') {
      if (o.failBegin) throw o.failBegin;
      h.snapshot = clone(h.model);
      return { rows: [] };
    }
    if (text === 'COMMIT') { h.commits++; h.snapshot = null; return { rows: [] }; }
    if (text === 'ROLLBACK') {
      h.rollbacks++;
      if (o.failRollback) throw new Error('connection terminated unexpectedly');
      if (h.snapshot) h.model = h.snapshot;
      h.snapshot = null;
      return { rows: [] };
    }
    if (/^SELECT pg_advisory_xact_lock/.test(text)) return { rows: [{ pg_advisory_xact_lock: '' }] };
    if (o.failAt && o.failAt.test(text)) throw o.error;
    applyDdl(text);
    if (o.afterDdl && /CREATE INDEX IF NOT EXISTS idx_notices_constituency_id/.test(text)) o.afterDdl(h.model);
    return { rows: [] };
  }
  const client = { query, release: (arg) => { h.released.push(arg === true ? 'destroyed' : 'released'); } };
  h.pool = {
    query: async (sql) => {
      h.poolQueries.push(squash(sql));
      if (o.poolQueryOk) return { rows: [], rowCount: 0 };
      throw new Error('UNEXPECTED pool.query: ' + squash(sql).slice(0, 100));
    },
    connect: async () => {
      h.connects++;
      if (o.failConnect) throw o.failConnect;
      return client;
    },
  };
  h.statements = () => h.log.map((l) => l.sql);
  h.ddl = () => h.statements().filter((s) => !/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory_xact_lock|\/\* nsr:)/.test(s));
  h.state = async () => (await R.inspectNoticeScopeSchema(catalogDb(h.model))).state;
  return h;
}

describe('C. atomic installer: ensureNoticeScopeColumns()', () => {
  let migrations;
  let current;
  let logSpy;
  let errSpy;
  let warnSpy;

  beforeAll(() => {
    // bootstrap/migrations.js is loaded with its database replaced by the transactional model above;
    // its two unrelated imports (the voting router and the period engine) are stubbed.
    jest.doMock('../bootstrap/database', () => ({
      pool: {
        query: (...a) => current.pool.query(...a),
        connect: (...a) => current.pool.connect(...a),
      },
      testDBConnection: async () => true,
    }));
    jest.doMock('../lib/period-engine', () => ({ transitionPeriod: async () => {} }));
    jest.doMock('../routes/voting', () => ({ broadcastVoteUpdate: () => {} }));
    migrations = require('../bootstrap/migrations');
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore(); });

  const run = async (h) => { current = h; return attempt(() => migrations.ensureNoticeScopeColumns()); };

  test('NOT_INSTALLED: BEGIN, advisory lock, inspect, 12 DDL statements, inspect again, COMMIT; installed and verified', async () => {
    const h = installerHarness();
    const r = await run(h);
    expect(r.error).toBe(undefined);
    const s = h.statements();
    expect(s[0]).toBe('BEGIN');
    expect(s[1]).toBe('SELECT pg_advisory_xact_lock($1, $2)');
    expect(h.log[1].params).toEqual([4244, 42]);
    expect(s[s.length - 1]).toBe('COMMIT');
    expect(h.ddl()).toHaveLength(12);
    // the lock comes before the first inspection, which comes before the first DDL, and a second inspection follows the last DDL
    const firstInspect = s.findIndex((x) => /^\/\* nsr:/.test(x));
    const firstDdl = s.findIndex((x) => /^ALTER TABLE/.test(x));
    const lastDdl = s.length - 1 - s.slice().reverse().findIndex((x) => /^CREATE INDEX/.test(x));
    const lastInspect = s.length - 1 - s.slice().reverse().findIndex((x) => /^\/\* nsr:/.test(x));
    expect(firstInspect).toBeGreaterThan(1);
    expect(firstDdl).toBeGreaterThan(firstInspect);
    expect(lastInspect).toBeGreaterThan(lastDdl);
    expect(h.commits).toBe(1);
    expect(h.rollbacks).toBe(0);
    expect(await h.state()).toBe('INSTALLED');
    expect(logSpy.mock.calls.some((c) => /notices geographic scope columns ready/.test(String(c[0])))).toBe(true);
  });

  test('uses exactly one client from the existing pool, releases it, and sends nothing through pool.query', async () => {
    const h = installerHarness();
    await run(h);
    expect(h.connects).toBe(1);
    expect(h.released).toEqual(['released']);
    expect(h.poolQueries).toEqual([]);
  });

  test('every DDL statement runs INSIDE the transaction (between BEGIN and COMMIT), on the client', async () => {
    const h = installerHarness();
    await run(h);
    const s = h.statements();
    const begin = s.indexOf('BEGIN');
    const commit = s.indexOf('COMMIT');
    h.ddl().forEach((d) => {
      const at = s.indexOf(d);
      expect(at).toBeGreaterThan(begin);
      expect(at).toBeLessThan(commit);
    });
  });

  test('already INSTALLED: no DDL at all, COMMIT, ready line, client released', async () => {
    const h = installerHarness({ model: goodModel() });
    const r = await run(h);
    expect(r.error).toBe(undefined);
    expect(h.ddl()).toEqual([]);
    expect(h.commits).toBe(1);
    expect(h.rollbacks).toBe(0);
    expect(h.released).toEqual(['released']);
    expect(logSpy.mock.calls.some((c) => /notices geographic scope columns ready/.test(String(c[0])))).toBe(true);
  });

  test.each(PARTIAL_FAULTS)('PARTIAL is NOT repaired: %s', async (label, mutate, object) => {
    const h = installerHarness({ model: make(mutate) });
    const before = clone(h.model);
    const r = await run(h);
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('PARTIAL');
    expect(r.error.message).toContain(object);
    expect(h.ddl()).toEqual([]);                 // not one ALTER / CREATE
    expect(h.statements()).toContain('ROLLBACK');
    expect(h.statements()).not.toContain('COMMIT');
    expect(h.released).toEqual(['released']);
    expect(h.model).toEqual(before);             // the schema is exactly as it was found
  });

  test.each(INVALID_FAULTS)('INVALID is NOT repaired: %s', async (label, mutate, object) => {
    const h = installerHarness({ model: make(mutate) });
    const before = clone(h.model);
    const r = await run(h);
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('INVALID');
    expect(h.ddl()).toEqual([]);
    expect(h.statements()).toContain('ROLLBACK');
    expect(h.statements()).not.toContain('COMMIT');
    expect(h.released).toEqual(['released']);
    expect(h.model).toEqual(before);
  });

  test.each([
    ['the first column', /ADD COLUMN IF NOT EXISTS scope_level/],
    ['a foreign key', /notices_constituency_id_fk/],
    ['the CHECK', /notices_scope_check/],
    ['the trigger function', /^CREATE OR REPLACE FUNCTION/],
    ['the trigger', /CREATE TRIGGER/],
    ['the LAST index', /idx_notices_constituency_id/],
  ])('a DDL failure at %s rolls everything back, releases the client and rethrows the ORIGINAL error', async (label, failAt) => {
    const boom = Object.assign(new Error('permission denied for table notices'), { code: '42501' });
    const h = installerHarness({ failAt, error: boom });
    const r = await run(h);
    expect(r.error).toBe(boom);                         // the very same object, not a wrapper
    expect(r.error.code).toBe('42501');
    expect(h.rollbacks).toBe(1);
    expect(h.commits).toBe(0);
    expect(h.released).toEqual(['released']);
    expect(await h.state()).toBe('NOT_INSTALLED');      // nothing half-installed survives
    expect(h.model).toEqual(emptyModel());
  });

  test('post-install verification failure inside the transaction => rollback, NoticeScopeNotReadyError, nothing committed', async () => {
    // simulate a catalog that ends up wrong after the DDL (for example a pre-existing differently defined object that
    // the guarded DDL silently kept): the trigger ends up disabled
    const h = installerHarness({ afterDdl: (m) => { m.trigger.enabled = 'D'; } });
    const r = await run(h);
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('INVALID');
    expect(r.error.phase).toMatch(/inside the install transaction/);
    expect(r.error.message).toContain('trigger:' + FN);
    expect(h.rollbacks).toBe(1);
    expect(h.commits).toBe(0);
    expect(h.released).toEqual(['released']);
    expect(h.model).toEqual(emptyModel());
  });

  test('if ROLLBACK itself fails the connection is destroyed (not returned to the pool) and the original error still wins', async () => {
    const boom = new Error('statement timeout');
    const h = installerHarness({ failAt: /CREATE TRIGGER/, error: boom, failRollback: true });
    const r = await run(h);
    expect(r.error).toBe(boom);
    expect(h.released).toEqual(['destroyed']);
  });

  test('BEGIN failing: original error rethrown, client released', async () => {
    const boom = new Error('connection reset');
    const h = installerHarness({ failBegin: boom });
    const r = await run(h);
    expect(r.error).toBe(boom);
    expect(h.released).toEqual(['released']);
    expect(h.ddl()).toEqual([]);
  });

  test('pool.connect() failing: the original error propagates and there is no client to release', async () => {
    const boom = new Error('connect ECONNREFUSED');
    const h = installerHarness({ failConnect: boom });
    const r = await run(h);
    expect(r.error).toBe(boom);
    expect(h.released).toEqual([]);
    expect(h.statements()).toEqual([]);
  });

  test('a client is never leaked: released exactly once on every outcome', async () => {
    const outcomes = [
      installerHarness(),
      installerHarness({ model: goodModel() }),
      installerHarness({ model: make((m) => { m.trigger = null; }) }),
      installerHarness({ model: make(withTrigger({ enabled: 'D' })) }),
      installerHarness({ failAt: /CREATE INDEX/, error: new Error('x') }),
      installerHarness({ failAt: /CREATE INDEX/, error: new Error('x'), failRollback: true }),
      installerHarness({ failBegin: new Error('x') }),
    ];
    for (const h of outcomes) {
      await run(h);
      expect(h.released).toHaveLength(1);
    }
  });

  test('the DDL is the Phase 4B.42 DDL: object names and the trigger-function body match what the verifier expects', async () => {
    const h = installerHarness();
    await run(h);
    const all = h.ddl().join('\n');
    R.SCOPE_OBJECTS.filter((o) => o.kind !== 'column').forEach((o) => expect(all).toContain(o.name));
    ['scope_level', 'county_id', 'constituency_id'].forEach((c) => expect(all).toContain('ADD COLUMN IF NOT EXISTS ' + c));
    const fn = h.ddl().find((s) => /^CREATE OR REPLACE FUNCTION/.test(s));
    const body = /\$fn\$ (.*) \$fn\$/.exec(fn)[1];
    expect(body).toBe(R.TRIGGER_FUNCTION_BODY);
    // the installer's own result verifies under the real inspector (the model derived the objects from the statements)
    expect(await h.state()).toBe('INSTALLED');
  });

  test('running it twice: the second run finds INSTALLED and issues no DDL', async () => {
    const h = installerHarness();
    await run(h);
    const second = installerHarness({ model: h.model });
    const r = await run(second);
    expect(r.error).toBe(undefined);
    expect(second.ddl()).toEqual([]);
  });

  // ── ensureNoticesTable(): what it does with the installer's outcome ──────────────────────────
  test('ensureNoticesTable rethrows a NoticeScopeNotReadyError (it is not swallowed by its catch-all)', async () => {
    const h = installerHarness({ model: make((m) => { m.trigger = null; }), poolQueryOk: true });
    current = h;
    const r = await attempt(() => migrations.ensureNoticesTable());
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.code).toBe('NOTICE_SCOPE_NOT_READY');
    expect(r.error.state).toBe('PARTIAL');
  });

  test('ensureNoticesTable logs, rolls back and carries on when the installer fails for another reason; the post-verifier then stops start-up', async () => {
    const boom = new Error('permission denied for table notices');
    const h = installerHarness({ failAt: /CREATE TRIGGER/, error: boom, poolQueryOk: true });
    current = h;
    const r = await attempt(() => migrations.ensureNoticesTable());
    expect(r.error).toBe(undefined); // it does not throw...
    expect(errSpy.mock.calls.some((c) => /ensureNoticeScopeColumns error/.test(String(c[0])) && String(c[0]).includes('rolled back'))).toBe(true);
    expect(h.rollbacks).toBe(1);
    // ...but the schema is still NOT_INSTALLED, so the verification that follows it in startServer() refuses to continue
    const after = await attempt(() => R.verifyNoticeScopeReady(catalogDb(h.model)));
    expect(after.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(after.error.state).toBe('NOT_INSTALLED');
  });
});

// ============================================================================
// F. Start-up integration  (bootstrap/startup.js)
// ============================================================================
describe('F. startServer(): gate, post-verification, listen, database-down', () => {
  let startup;
  let order;
  let listenPorts;
  let intervalSpy;
  let warnSpy;
  let logSpy;
  let errSpy;
  let sigtermBefore;

  beforeAll(() => {
    jest.doMock('../routes/community-reports', () => ({
      ensureCommunityReportsTables: async () => { order.push('ensureCommunityReportsTables'); },
    }));
    startup = require('../bootstrap/startup');
  });

  beforeEach(() => {
    order = [];
    listenPorts = [];
    sigtermBefore = process.listeners('SIGTERM').slice();
    intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => ({ unref() {} }));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    intervalSpy.mockRestore(); warnSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore();
    process.removeAllListeners('SIGTERM');
    sigtermBefore.forEach((l) => process.on('SIGTERM', l));
  });

  const step = (name) => async () => { order.push(name); };

  // deps for startServer(); `model` is the catalog the REAL verifiers read through `pool`.
  // installs: what ensureNoticesTable() leaves behind in the model (the real installer is tested in group C and in the PG file).
  function deps(model, extra) {
    const x = extra || {};
    const d = {
      app: { listen: (port) => { order.push('listen'); listenPorts.push(port); return { close() {} }; } },
      PORT: 4321,
      pool: x.pool || { query: catalogDb(model).query },
      testDBConnection: async () => { order.push('testDBConnection'); return x.connected !== false; },
      transitionPeriod: async () => {},
      broadcastVoteUpdate: () => {},
      initDB: step('initDB'),
      ensureVotingPeriodsTable: step('ensureVotingPeriodsTable'),
      ensureActivePeriod: step('ensureActivePeriod'),
      ensureCandidatesTable: step('ensureCandidatesTable'),
      ensureGeographyTables: step('ensureGeographyTables'),
      seedKiambuHierarchy: step('seedKiambuHierarchy'),
      ensurePhase2Migrations: step('ensurePhase2Migrations'),
      ensureRBACFoundation: step('ensureRBACFoundation'),
      ensureSuperAdminBootstrap: step('ensureSuperAdminBootstrap'),
      ensureNoticesTable: async () => {
        order.push('ensureNoticesTable');
        if (x.noticesTable) await x.noticesTable(model);
        else Object.assign(model, goodModel()); // a successful installer leaves the complete schema behind
      },
    };
    // record when the REAL verifiers run, without replacing them
    d.verifyNoticeScopeBeforeBackfill = async (p) => { order.push('gate'); return R.verifyNoticeScopeBeforeBackfill(p); };
    d.verifyNoticeScopeReady = async (p) => { order.push('postVerify'); return R.verifyNoticeScopeReady(p); };
    return Object.assign(d, x.override || {});
  }

  const HAPPY_ORDER = [
    'testDBConnection', 'initDB', 'ensureVotingPeriodsTable', 'ensureActivePeriod', 'ensureCandidatesTable',
    'ensureGeographyTables', 'seedKiambuHierarchy', 'gate', 'ensurePhase2Migrations', 'ensureRBACFoundation',
    'ensureSuperAdminBootstrap', 'ensureCommunityReportsTables', 'ensureNoticesTable', 'postVerify', 'listen',
  ];

  test('production shape (NOT_INSTALLED): the sequence is unchanged apart from the two checks, gate IMMEDIATELY before Phase 2', async () => {
    const r = await attempt(() => startup.startServer(deps(emptyModel())));
    expect(r.error).toBe(undefined);
    expect(order).toEqual(HAPPY_ORDER);
    expect(order.indexOf('gate')).toBe(order.indexOf('seedKiambuHierarchy') + 1);
    expect(order.indexOf('ensurePhase2Migrations')).toBe(order.indexOf('gate') + 1);
    expect(order.indexOf('postVerify')).toBe(order.indexOf('ensureNoticesTable') + 1);
    expect(order.indexOf('listen')).toBe(order.indexOf('postVerify') + 1);
    expect(listenPorts).toEqual([4321]);
  });

  test('an already INSTALLED schema starts normally', async () => {
    const r = await attempt(() => startup.startServer(deps(goodModel(), { noticesTable: async () => {} })));
    expect(r.error).toBe(undefined);
    expect(order).toEqual(HAPPY_ORDER);
  });

  test('a brand-new database (no notices table at all) starts: the gate allows it', async () => {
    const m = Object.assign(emptyModel(), { notices: false });
    const r = await attempt(() => startup.startServer(deps(m)));
    expect(r.error).toBe(undefined);
    expect(order).toEqual(HAPPY_ORDER);
  });

  test.each(PARTIAL_FAULTS)('PARTIAL stops start-up BEFORE the Phase 2 backfill, and the server never listens: %s', async (label, mutate, object) => {
    const m = make(mutate);
    const r = await attempt(() => startup.startServer(deps(m)));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('PARTIAL');
    expect(order).toEqual(['testDBConnection', 'initDB', 'ensureVotingPeriodsTable', 'ensureActivePeriod', 'ensureCandidatesTable',
      'ensureGeographyTables', 'seedKiambuHierarchy', 'gate']);
    expect(order).not.toContain('ensurePhase2Migrations');
    expect(order).not.toContain('listen');
    expect(intervalSpy.mock.calls.length).toBe(0);
  });

  test.each(INVALID_FAULTS)('INVALID stops start-up BEFORE the Phase 2 backfill, and the server never listens: %s', async (label, mutate, object) => {
    const m = make(mutate);
    const r = await attempt(() => startup.startServer(deps(m)));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('INVALID');
    expect(order[order.length - 1]).toBe('gate');
    expect(order).not.toContain('ensurePhase2Migrations');
    expect(order).not.toContain('ensureRBACFoundation');
    expect(order).not.toContain('ensureNoticesTable');
    expect(order).not.toContain('listen');
  });

  test('the default wiring uses the REAL verifiers (server.js does not have to pass them)', async () => {
    const m = make((x) => { x.trigger = null; });
    const d = deps(m);
    delete d.verifyNoticeScopeBeforeBackfill;
    delete d.verifyNoticeScopeReady;
    const r = await attempt(() => startup.startServer(d));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.code).toBe('NOTICE_SCOPE_NOT_READY');
    expect(order).not.toContain('ensurePhase2Migrations');
    expect(order).not.toContain('listen');
  });

  test('the gate receives the pool, and an unreadable catalog stops start-up before the backfill (fails closed)', async () => {
    const m = emptyModel();
    const d = deps(m, { pool: { query: catalogDb(m, { failOn: 'tables', failMessage: 'canceling statement due to statement timeout' }).query } });
    const r = await attempt(() => startup.startServer(d));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.state).toBe('UNVERIFIABLE');
    expect(order).not.toContain('ensurePhase2Migrations');
    expect(order).not.toContain('listen');
  });

  test.each([
    ['the installer silently did nothing (NOT_INSTALLED)', async () => {}],
    ['the installer left a PARTIAL schema', async (m) => { Object.assign(m, goodModel()); m.trigger = null; }],
    ['the installer left an INVALID schema', async (m) => { Object.assign(m, goodModel()); m.trigger.enabled = 'D'; }],
    ['the installer left a weak CHECK', async (m) => { Object.assign(m, goodModel()); m.checkBehaviour = 'always-true'; }],
  ])('post-install verification: %s => the server never listens', async (label, noticesTable) => {
    const m = emptyModel();
    const r = await attempt(() => startup.startServer(deps(m, { noticesTable })));
    expect(r.error instanceof R.NoticeScopeNotReadyError).toBe(true);
    expect(r.error.phase).toMatch(/after notice-scope installation/);
    expect(order).toContain('ensureNoticesTable');
    expect(order[order.length - 1]).toBe('postVerify');
    expect(order).not.toContain('listen');
    expect(intervalSpy.mock.calls.length).toBe(0);
  });

  test('a NoticeScopeNotReadyError thrown by ensureNoticesTable itself propagates: the server never listens', async () => {
    const m = emptyModel();
    const boom = new R.NoticeScopeNotReadyError({ phase: 'before notice-scope installation', state: 'PARTIAL', problems: [], reason: 'test' });
    const r = await attempt(() => startup.startServer(deps(m, { noticesTable: async () => { throw boom; } })));
    expect(r.error).toBe(boom);
    expect(order).not.toContain('postVerify');
    expect(order).not.toContain('listen');
  });

  test('database unavailable: no migration and no readiness check runs, the server still listens (unchanged), and the warning says readiness was NOT verified', async () => {
    const touched = [];
    const pool = { query: async (sql) => { touched.push(String(sql)); throw new Error('the pool must not be used when the database is down'); } };
    const r = await attempt(() => startup.startServer(deps(emptyModel(), { connected: false, pool })));
    expect(r.error).toBe(undefined);
    expect(order).toEqual(['testDBConnection', 'listen']);
    expect(touched).toEqual([]);
    const warned = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => /Continuing without database/.test(w))).toBe(true);
    expect(warned.some((w) => /readiness was NOT verified/.test(w) && /database unavailable/.test(w))).toBe(true);
  });

  test('database available: no "NOT verified" warning is printed', async () => {
    await startup.startServer(deps(emptyModel()));
    expect(warnSpy.mock.calls.map((c) => String(c[0])).some((w) => /NOT verified/.test(w))).toBe(false);
  });

  // ── startServerOrExit ─────────────────────────────────────────────────────────────────────────
  test('startServerOrExit: success => returns the server, never calls exit', async () => {
    const exits = [];
    const server = await startup.startServerOrExit(deps(emptyModel()), { exit: (c) => exits.push(c), logger: { error() {} } });
    expect(typeof server.close).toBe('function');
    expect(exits).toEqual([]);
  });

  test('startServerOrExit: a failed gate is logged clearly, the server does not listen, the exit code is 1, and it never rejects', async () => {
    const exits = [];
    const logged = [];
    const m = make((x) => { x.trigger = null; });
    const r = await attempt(() => startup.startServerOrExit(deps(m), { exit: (c) => exits.push(c), logger: { error: (...a) => logged.push(a.join(' ')) } }));
    expect(r.error).toBe(undefined);
    expect(exits).toEqual([1]);
    expect(order).not.toContain('listen');
    expect(order).not.toContain('ensurePhase2Migrations');
    const text = logged.join('\n');
    expect(text).toMatch(/Startup aborted/);
    expect(text).toMatch(/will NOT listen/);
    expect(text).toContain('PARTIAL');
    expect(text).toContain('trigger:' + FN);
  });

  test('startServerOrExit: any other start-up failure also exits 1 (no unhandled rejection) and logs the stack', async () => {
    const exits = [];
    const logged = [];
    const d = deps(emptyModel(), { override: { ensureRBACFoundation: async () => { throw new Error('rbac boom'); } } });
    const r = await attempt(() => startup.startServerOrExit(d, { exit: (c) => exits.push(c), logger: { error: (...a) => logged.push(a.join(' ')) } }));
    expect(r.error).toBe(undefined);
    expect(exits).toEqual([1]);
    expect(logged.join('\n')).toContain('rbac boom');
    expect(order).not.toContain('listen');
  });

  test('server.js starts through startServerOrExit (and no longer calls a bare startServer without a rejection handler)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(src).toMatch(/startServerOrExit\(\{/);
    expect(src).not.toMatch(/(^|[^A-Za-z])startServer\(\{/m);
    expect(src).toMatch(/require\('\.\/bootstrap\/startup'\)/);
  });
});

// ============================================================================
// ensurePhase2Migrations() must stay exactly as it was
// ============================================================================
describe('ensurePhase2Migrations is unchanged by Phase 4B.44', () => {
  // sha256 of the function text recorded before Phase 4B.42 and re-verified before and after Phase 4B.44.
  // (Line endings are normalised so a CRLF checkout hashes the same.)
  const RECORDED_SHA256 = 'eca9119c92bb6c8a1658e3aee535cf9393b8bf36ed5f25ab95e4fb2b994c6617';

  function phase2Source() {
    const src = fs.readFileSync(path.join(ROOT, 'bootstrap', 'migrations.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('async function ensurePhase2Migrations()');
    expect(start).toBeGreaterThan(-1);
    const next = /^(async function|function|module\.exports|const |let |\/\/ ═)/m.exec(src.slice(start + 10));
    return src.slice(start, start + 10 + next.index).replace(/\n+$/, '') + '\n';
  }

  test('its text hashes to the recorded value', () => {
    const body = phase2Source();
    expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(RECORDED_SHA256);
  });

  test('it still backfills the same five tables in the same order with the same statement, and never mentions the notice-scope objects', () => {
    const body = phase2Source();
    const tables = [];
    body.replace(/\{ table: '(\w+)',\s+fkName/g, (all, t) => { tables.push(t); return all; });
    expect(tables).toEqual(['users', 'votes', 'notices', 'forum_posts', 'candidates']);
    expect(body).toContain('`UPDATE ${table} SET ward_id = $1 WHERE ward_id IS NULL`');
    // (its founding-ward JOIN legitimately uses counties/constituencies; it must know nothing of the scope columns, trigger or checks)
    expect(body).not.toMatch(/scope_level|notices_scope_check|notices_keep_scoped_ward_null|notice-scope|readiness/);
  });
});
