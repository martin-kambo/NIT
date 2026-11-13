// bootstrap/notice-scope-readiness.js
// Phase 4B.44: migration-readiness safeguards for the Phase 4B.42 notice geographic scope.
//
// WHY THIS EXISTS
//   ensurePhase2Migrations() runs, on every start,
//       UPDATE notices SET ward_id = <founding ward> WHERE ward_id IS NULL
//   A PLATFORM / COUNTY / CONSTITUENCY notice has no ward by definition. The Phase 4B.42 trigger
//   (notices_keep_scoped_ward_null) makes that one statement skip such a row, but the trigger is only
//   there if the notice-scope schema is completely and correctly installed. Without it the statement
//   either stamps the founding ward onto the notice (silent corruption) or fails on the CHECK and aborts
//   the rest of Phase 2. This module lets start-up check that, BEFORE the backfill, and again after the
//   installer ran, and stop instead of continuing on a half-installed schema.
//
// WHAT IT DOES (and does not do)
//   * inspectNoticeScopeSchema(db)           read-only. SELECTs against the PostgreSQL catalog only.
//   * verifyNoticeScopeBeforeBackfill(db)    throws unless the state is NOT_INSTALLED or INSTALLED.
//   * verifyNoticeScopeReady(db)             throws unless the state is INSTALLED.
//   It never installs, repairs or rewrites anything, and it never touches a notice row.
//
// STATES (the 11 notice-scope objects are: 3 columns, 2 foreign keys, 1 CHECK, 1 trigger function,
// 1 trigger, 3 indexes; notices.ward_id is a prerequisite and is checked separately)
//   NOT_INSTALLED  none of the 11 objects exists (a fresh install, or no notices table yet)
//   INSTALLED      all 11 exist and every one passes validation
//   PARTIAL        some, but not all, of the 11 exist. A MISSING object, including a missing index, is PARTIAL.
//   INVALID        all 11 exist but at least one fails validation (wrong type, disabled trigger, a CHECK that
//                  does not enforce the scope rules, an unvalidated constraint, an invalid index, ...).
//                  An index that is present but wrong is therefore INVALID, not PARTIAL.
//
// HOW OBJECTS ARE VALIDATED (PostgreSQL 16 .. 18 safe: no comparison of deparsed definitions)
//   * columns:      name, type (format_type), nullable, no DEFAULT (a default would silently scope legacy inserts)
//   * foreign keys: source and referenced columns, referenced table, validated, enforced (PG 18 NOT ENFORCED),
//                   not deferrable, NO ACTION
//   * CHECK:        validated and enforced, and its ACTUAL RULES are evaluated by PostgreSQL: the constraint's own
//                   expression is run read-only against a fixed table of probe rows (CHECK_PROBES), and every row the
//                   scope model accepts must be accepted and every contradictory row rejected. The text is never compared.
//   * function:     language, return type, arguments, schema, not SECURITY DEFINER, and the body (stored verbatim by
//                   PostgreSQL, so it is identical on every version) equals the installer's body
//   * trigger:      BEFORE, FOR EACH ROW, UPDATE only, on notices, enabled, calls that function, fires on ward_id, and
//                   its WHEN condition (if any) is evaluated on probe rows (WHEN_PROBES): it must fire for the Phase 2
//                   backfill case of every protected level
//   * indexes:      btree, on notices, the right single column, valid, ready, live, not unique, not partial, no expression
//
// The only SQL that is built from catalog text is the CHECK/WHEN expression above. It is first tokenised and
// accepted only if it contains nothing but the four scope columns, boolean/NULL operators, COALESCE, string/number
// literals and plain casts (sanitizeExpression); anything else is reported INVALID and is never executed.

const STATES = Object.freeze({
  NOT_INSTALLED: 'NOT_INSTALLED',
  INSTALLED: 'INSTALLED',
  PARTIAL: 'PARTIAL',
  INVALID: 'INVALID',
});

const ERROR_CODE = 'NOTICE_SCOPE_NOT_READY';

// Key pair for pg_advisory_xact_lock(int, int): serialises concurrent installers (used by ensureNoticeScopeColumns).
const NOTICE_SCOPE_INSTALL_LOCK = Object.freeze({ key1: 4244, key2: 42 });

const FUNCTION_NAME = 'notices_keep_scoped_ward_null';
// The Phase 4B.42 trigger function body, whitespace-collapsed (PostgreSQL keeps the body text verbatim).
const TRIGGER_FUNCTION_BODY =
  "BEGIN IF OLD.scope_level IN ('PLATFORM', 'COUNTY', 'CONSTITUENCY') THEN RETURN NULL; END IF; RETURN NEW; END";

// The 11 scope objects. `id` is what appears in errors; `name` is the catalog name.
const SCOPE_OBJECTS = Object.freeze([
  { id: 'column:scope_level', kind: 'column', name: 'scope_level' },
  { id: 'column:county_id', kind: 'column', name: 'county_id' },
  { id: 'column:constituency_id', kind: 'column', name: 'constituency_id' },
  { id: 'foreign-key:notices_county_id_fk', kind: 'foreign key', name: 'notices_county_id_fk' },
  { id: 'foreign-key:notices_constituency_id_fk', kind: 'foreign key', name: 'notices_constituency_id_fk' },
  { id: 'check:notices_scope_check', kind: 'CHECK constraint', name: 'notices_scope_check' },
  { id: 'trigger-function:' + FUNCTION_NAME, kind: 'trigger function', name: FUNCTION_NAME },
  { id: 'trigger:' + FUNCTION_NAME, kind: 'trigger', name: FUNCTION_NAME },
  { id: 'index:idx_notices_scope_level', kind: 'index', name: 'idx_notices_scope_level' },
  { id: 'index:idx_notices_county_id', kind: 'index', name: 'idx_notices_county_id' },
  { id: 'index:idx_notices_constituency_id', kind: 'index', name: 'idx_notices_constituency_id' },
]);

const EXPECTED_COLUMNS = Object.freeze({
  ward_id: 'integer',
  scope_level: 'character varying(20)',
  county_id: 'integer',
  constituency_id: 'integer',
});

const EXPECTED_FKS = Object.freeze({
  notices_county_id_fk: { column: 'county_id', refTable: 'public.counties' },
  notices_constituency_id_fk: { column: 'constituency_id', refTable: 'public.constituencies' },
});

const EXPECTED_INDEXES = Object.freeze({
  idx_notices_scope_level: 'scope_level',
  idx_notices_county_id: 'county_id',
  idx_notices_constituency_id: 'constituency_id',
});

// ── What the scope model accepts and rejects (the CHECK is judged by these, not by its text) ──────────
// PostgreSQL accepts a row unless the CHECK expression evaluates to FALSE (NULL passes), so "accepted" below
// means "result is not false". The NULL-level rows matter: an unwrapped CHECK evaluates them to NULL and
// lets contradictory rows through (found by the 4B.42 real-database run).
const P = (label, scope, county, constituency, ward, accept) => ({ label, scope, county, constituency, ward, accept });
const CHECK_PROBES = Object.freeze([
  // accepted
  P('legacy notice without a ward', null, null, null, null, true),
  P('legacy notice in ward 1', null, null, null, 1, true),
  P('legacy notice in ward 10', null, null, null, 10, true),
  P('PLATFORM notice', 'PLATFORM', null, null, null, true),
  P('COUNTY notice (county 1)', 'COUNTY', 1, null, null, true),
  P('COUNTY notice (county 2)', 'COUNTY', 2, null, null, true),
  P('CONSTITUENCY notice', 'CONSTITUENCY', null, 2, null, true),
  P('WARD notice', 'WARD', null, null, 10, true),
  // rejected
  P('county id without a scope level', null, 1, null, null, false),
  P('constituency id without a scope level', null, null, 2, null, false),
  P('both ids without a scope level', null, 1, 2, null, false),
  P('PLATFORM notice carrying a ward (what the Phase 2 backfill would produce)', 'PLATFORM', null, null, 10, false),
  P('PLATFORM notice carrying a county', 'PLATFORM', 1, null, null, false),
  P('PLATFORM notice carrying a constituency', 'PLATFORM', null, 2, null, false),
  P('COUNTY notice without a county', 'COUNTY', null, null, null, false),
  P('COUNTY notice carrying a ward (what the Phase 2 backfill would produce)', 'COUNTY', 1, null, 10, false),
  P('COUNTY notice carrying a constituency', 'COUNTY', 1, 2, null, false),
  P('COUNTY notice with a constituency instead of a county', 'COUNTY', null, 2, null, false),
  P('CONSTITUENCY notice without a constituency', 'CONSTITUENCY', null, null, null, false),
  P('CONSTITUENCY notice carrying a ward (what the Phase 2 backfill would produce)', 'CONSTITUENCY', null, 2, 10, false),
  P('CONSTITUENCY notice carrying a county', 'CONSTITUENCY', 1, 2, null, false),
  P('CONSTITUENCY notice with a county instead of a constituency', 'CONSTITUENCY', 1, null, null, false),
  P('WARD notice without a ward', 'WARD', null, null, null, false),
  P('WARD notice carrying a county', 'WARD', 1, null, 10, false),
  P('WARD notice carrying a constituency', 'WARD', null, 2, 10, false),
  P('unknown scope level', 'BOGUS', null, null, null, false),
  P('lower-case scope level', 'platform', null, null, null, false),
  P('empty scope level', '', null, null, null, false),
  P('scope level with a trailing space', 'PLATFORM ', null, null, null, false),
]);

// Trigger WHEN condition: for the Phase 2 backfill (ward_id NULL -> a ward) on a row of each protected level the
// trigger must fire. (Firing more often is harmless: the function itself decides; firing less would disable the guard.)
const W = (label, scope, county, constituency) => ({
  label,
  old: { scope, county, constituency, ward: null },
  new: { scope, county, constituency, ward: 10 },
});
const WHEN_PROBES = Object.freeze([
  W('backfill of a PLATFORM notice', 'PLATFORM', null, null),
  W('backfill of a COUNTY notice', 'COUNTY', 1, null),
  W('backfill of a CONSTITUENCY notice', 'CONSTITUENCY', null, 2),
]);

// ── Structured error ───────────────────────────────────────────────────────────────────────────────
function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi, '[redacted-url]')
    .replace(/(password|passwd|pwd|token|secret)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 300);
}

class NoticeScopeNotReadyError extends Error {
  // problems: [{ requirement, object, reason }]
  constructor({ phase, state, problems, reason, diagnostics, cause }) {
    const list = (problems || []).map((p) => `  - ${p.object}: ${p.requirement} (${p.reason})`).join('\n');
    const diag = diagnostics
      ? `\n  Notices without a ward in a ward-less scope: ${diagnostics.scopedWardlessRows}; ` +
        `already carrying a ward: ${diagnostics.scopedRowsWithWard}.`
      : '';
    super(
      `Notice-scope schema is ${state} (${phase}). Startup stopped: ${reason}` +
        (list ? `\n${list}` : '') + diag
    );
    this.name = 'NoticeScopeNotReadyError';
    this.code = ERROR_CODE;
    this.phase = phase;
    this.state = state;
    this.problems = problems || [];
    this.reason = reason;
    this.diagnostics = diagnostics || null;
    if (cause !== undefined) this.cause = cause;
  }
}

// ── Safe expression handling ───────────────────────────────────────────────────────────────────────
const SCOPE_COLUMNS = ['scope_level', 'county_id', 'constituency_id', 'ward_id'];
const KEYWORDS = new Set([
  'and', 'or', 'not', 'is', 'null', 'true', 'false', 'coalesce', 'in', 'any', 'array', 'distinct', 'from',
  'case', 'when', 'then', 'else', 'end',
  'text', 'character', 'varying', 'varchar', 'integer', 'int', 'int4',
]);
const TOKEN_RE = /\s+|'(?:[^']|'')*'|::|<>|!=|>=|<=|[=<>(),.[\]]|\d+|[A-Za-z_][A-Za-z0-9_]*|[\s\S]/gy;
const MAX_EXPRESSION_CHARS = 8000;

// Returns { ok: true, sql } with the expression rebuilt from vetted tokens (aliases renamed), or { ok: false, reason }.
// `aliases` maps a row-reference word used in the text to the alias used when it is run (e.g. { old: 'o__', new: 'n__' }).
function sanitizeExpression(text, aliases) {
  const map = aliases || {};
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'the expression is empty' };
  if (text.length > MAX_EXPRESSION_CHARS) return { ok: false, reason: 'the expression is unusually long' };
  if (text.includes('\\')) return { ok: false, reason: 'the expression contains a backslash' };
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while (TOKEN_RE.lastIndex < text.length && (m = TOKEN_RE.exec(text)) !== null) {
    if (!/^\s+$/.test(m[0])) tokens.push(m[0]);
  }
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const low = tok.toLowerCase();
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (/^'/.test(tok) || /^\d+$/.test(tok) || /^(::|<>|!=|>=|<=|[=<>(),[\]])$/.test(tok)) {
      out.push(tok);
    } else if (tok === '.') {
      if (!(prev && Object.prototype.hasOwnProperty.call(map, prev.toLowerCase()) && next && SCOPE_COLUMNS.includes(next.toLowerCase()))) {
        return { ok: false, reason: 'an unexpected "." in the expression' };
      }
      out.push('.');
    } else if (/^[A-Za-z_]/.test(tok)) {
      if (Object.prototype.hasOwnProperty.call(map, low)) {
        if (next !== '.') return { ok: false, reason: `"${tok}" is used without a column` };
        out.push(map[low]);
      } else if (KEYWORDS.has(low) || SCOPE_COLUMNS.includes(low)) {
        out.push(low);
      } else {
        return { ok: false, reason: `unexpected identifier "${tok.slice(0, 40)}"` };
      }
    } else {
      return { ok: false, reason: `unexpected token "${tok.slice(0, 20)}"` };
    }
  }
  return { ok: true, sql: out.join(' ') };
}

function sqlLiteral(v, type) {
  if (v === null || v === undefined) return `NULL::${type}`;
  if (typeof v === 'number') return `${Math.trunc(v)}::int`;
  return `'${String(v).replace(/'/g, "''")}'::varchar`;
}

function buildCheckProbeSql(safeExpression) {
  const values = CHECK_PROBES.map((p, i) =>
    `(${i}, ${sqlLiteral(p.scope, 'varchar')}, ${sqlLiteral(p.county, 'int')}, ${sqlLiteral(p.constituency, 'int')}, ${sqlLiteral(p.ward, 'int')})`
  ).join(', ');
  return `/* nsr:check-probe */ SELECT p.id AS id, (${safeExpression}) AS result ` +
    `FROM (VALUES ${values}) AS p(id, scope_level, county_id, constituency_id, ward_id) ORDER BY p.id`;
}

function buildWhenProbeSql(safeExpression) {
  const row = (r) =>
    `SELECT ${sqlLiteral(r.scope, 'varchar')} AS scope_level, ${sqlLiteral(r.county, 'int')} AS county_id, ` +
    `${sqlLiteral(r.constituency, 'int')} AS constituency_id, ${sqlLiteral(r.ward, 'int')} AS ward_id`;
  const parts = WHEN_PROBES.map((p, i) =>
    `SELECT ${i} AS id, (${safeExpression}) AS result FROM (${row(p.old)}) AS o__, (${row(p.new)}) AS n__`
  );
  return `/* nsr:when-probe */ ${parts.join(' UNION ALL ')} ORDER BY id`;
}

// The WHEN condition of a trigger, taken from pg_get_triggerdef(). null = no WHEN clause. undefined = could not parse.
function extractWhenClause(definition) {
  const text = String(definition || '');
  const start = text.search(/\sWHEN\s*\(/i);
  if (start === -1) return /\sWHEN\s/i.test(text) ? undefined : null;
  const open = text.indexOf('(', start);
  const execAt = text.search(/\)\s+EXECUTE\s+(FUNCTION|PROCEDURE)\s/i);
  if (execAt === -1 || execAt < open) return undefined;
  return text.slice(open + 1, execAt);
}

// ── Catalog queries (all read-only; each starts with a tag comment so tests can route them) ─────────
const Q = {
  tables:
    "/* nsr:tables */ SELECT to_regclass('public.notices') IS NOT NULL AS notices, " +
    "to_regclass('public.counties') IS NOT NULL AS counties, to_regclass('public.constituencies') IS NOT NULL AS constituencies",
  columns:
    '/* nsr:columns */ SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, ' +
    'a.atthasdef AS has_default FROM pg_attribute a ' +
    "WHERE a.attrelid = to_regclass('public.notices') AND a.attnum > 0 AND NOT a.attisdropped " +
    "AND a.attname IN ('ward_id', 'scope_level', 'county_id', 'constituency_id')",
  constraints:
    '/* nsr:constraints */ SELECT con.conname::text AS name, con.contype::text AS type, con.convalidated AS validated, ' +
    "COALESCE((to_jsonb(con) ->> 'conenforced')::boolean, true) AS enforced, con.condeferrable AS deferrable, " +
    'con.confmatchtype::text AS match_type, con.confupdtype::text AS on_update, con.confdeltype::text AS on_delete, ' +
    "(SELECT n.nspname::text || '.' || c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = con.confrelid) AS ref_table, " +
    '(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ' +
    'JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns, ' +
    '(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord) ' +
    'JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns, ' +
    'pg_get_expr(con.conbin, con.conrelid) AS check_expression ' +
    "FROM pg_constraint con WHERE con.conrelid = to_regclass('public.notices') " +
    "AND con.conname IN ('notices_county_id_fk', 'notices_constituency_id_fk', 'notices_scope_check')",
  trigger:
    '/* nsr:trigger */ SELECT t.tgname::text AS name, t.tgenabled::text AS enabled, t.tgtype::int AS type_bits, ' +
    '(SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)) AS update_columns, ' +
    'pg_get_triggerdef(t.oid) AS definition, pn.nspname::text AS fn_schema, p.proname::text AS fn_name ' +
    'FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace ' +
    `WHERE t.tgrelid = to_regclass('public.notices') AND t.tgname = '${FUNCTION_NAME}' AND NOT t.tgisinternal`,
  fn:
    '/* nsr:function */ SELECT p.proname::text AS name, n.nspname::text AS schema, l.lanname::text AS language, ' +
    'p.prorettype::regtype::text AS returns, p.pronargs::int AS args, p.prosecdef AS security_definer, ' +
    "regexp_replace(p.prosrc, '\\s+', ' ', 'g') AS body " +
    'FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang ' +
    `WHERE n.nspname = 'public' AND p.proname = '${FUNCTION_NAME}'`,
  indexes:
    '/* nsr:indexes */ SELECT c.relname::text AS name, i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live, ' +
    'i.indisunique AS is_unique, i.indisprimary AS is_primary, i.indisexclusion AS is_exclusion, am.amname::text AS method, ' +
    '(i.indpred IS NOT NULL) AS is_partial, (i.indexprs IS NOT NULL) AS has_expressions, i.indnatts::int AS key_count, ' +
    '(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ' +
    'JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns, ' +
    "(i.indrelid = to_regclass('public.notices')) AS on_notices " +
    'FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_am am ON am.oid = c.relam ' +
    "WHERE n.nspname = 'public' AND c.relname IN ('idx_notices_scope_level', 'idx_notices_county_id', 'idx_notices_constituency_id')",
  diagnostics:
    '/* nsr:diagnostics */ SELECT ' +
    "(count(*) FILTER (WHERE scope_level IN ('PLATFORM', 'COUNTY', 'CONSTITUENCY') AND ward_id IS NULL))::int AS scoped_wardless_rows, " +
    "(count(*) FILTER (WHERE scope_level IN ('PLATFORM', 'COUNTY', 'CONSTITUENCY') AND ward_id IS NOT NULL))::int AS scoped_rows_with_ward " +
    'FROM public.notices',
};

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const byName = (rows) => {
  const m = {};
  (rows || []).forEach((r) => { m[r.name] = r; });
  return m;
};

// ── The inspector ───────────────────────────────────────────────────────────────────────────────────
// db: anything with query(text) -> { rows } (a pg Pool or a checked-out pg client).
async function inspectNoticeScopeSchema(db) {
  const tables = (await db.query(Q.tables)).rows[0] || {};
  const result = {
    state: STATES.NOT_INSTALLED,
    tableExists: !!tables.notices,
    present: [],
    missing: SCOPE_OBJECTS.map((o) => o.id),
    invalid: [],
    prerequisites: { ward_id: { present: false, problems: [] } },
    diagnostics: null,
  };
  if (!tables.notices) return result;

  const problems = []; // { object, requirement, reason } for every present object that fails validation
  const bad = (object, requirement, reason) => problems.push({ object, requirement, reason });
  const present = new Set();

  // columns
  const cols = byName((await db.query(Q.columns)).rows);
  const wardCol = cols.ward_id;
  result.prerequisites.ward_id.present = !!wardCol;
  if (wardCol && wardCol.type !== EXPECTED_COLUMNS.ward_id) {
    result.prerequisites.ward_id.problems.push(`type is ${wardCol.type}, expected ${EXPECTED_COLUMNS.ward_id}`);
  }
  ['scope_level', 'county_id', 'constituency_id'].forEach((name) => {
    const c = cols[name];
    if (!c) return;
    const id = `column:${name}`;
    present.add(id);
    if (c.type !== EXPECTED_COLUMNS[name]) bad(id, `type must be ${EXPECTED_COLUMNS[name]}`, `found ${c.type}`);
    if (c.not_null) bad(id, 'must be nullable (NULL scope_level is the LEGACY state)', 'it is NOT NULL');
    if (c.has_default) bad(id, 'must have no DEFAULT (a default would silently scope every legacy insert)', 'it has a default');
  });

  // constraints
  const cons = byName((await db.query(Q.constraints)).rows);
  Object.keys(EXPECTED_FKS).forEach((name) => {
    const c = cons[name];
    if (!c) return;
    const want = EXPECTED_FKS[name];
    const id = `foreign-key:${name}`;
    present.add(id);
    if (c.type !== 'f') {
      bad(id, 'must be a foreign key', `the name is used by a constraint of type "${c.type}"`);
      return;
    }
    if (!sameList(c.columns, [want.column])) bad(id, `must be on column ${want.column}`, `found ${JSON.stringify(c.columns)}`);
    if (c.ref_table !== want.refTable || !sameList(c.ref_columns, ['id'])) {
      bad(id, `must reference ${want.refTable}(id)`, `found ${c.ref_table}(${(c.ref_columns || []).join(',')})`);
    }
    if (!c.validated) bad(id, 'must be validated', 'it is NOT VALID');
    if (c.enforced === false) bad(id, 'must be enforced', 'it is NOT ENFORCED');
    if (c.deferrable) bad(id, 'must not be deferrable', 'it is deferrable');
    if (c.on_update !== 'a' || c.on_delete !== 'a') bad(id, 'must use NO ACTION on update and delete', `found update=${c.on_update} delete=${c.on_delete}`);
    if (c.match_type !== 's') bad(id, 'must use MATCH SIMPLE', `found ${c.match_type}`);
  });

  const chk = cons.notices_scope_check;
  if (chk) {
    const id = 'check:notices_scope_check';
    present.add(id);
    if (chk.type !== 'c') bad(id, 'must be a CHECK constraint', `found constraint type ${chk.type}`);
    if (!chk.validated) bad(id, 'must be validated (it must cover existing rows)', 'it is NOT VALID');
    if (chk.enforced === false) bad(id, 'must be enforced', 'it is NOT ENFORCED');
    if (chk.type === 'c') {
      const safe = sanitizeExpression(chk.check_expression, {});
      if (!safe.ok) {
        bad(id, 'its expression must use only the scope columns and plain boolean operators', safe.reason);
      } else {
        try {
          const probe = (await db.query(buildCheckProbeSql(safe.sql))).rows;
          const got = {};
          probe.forEach((r) => { got[Number(r.id)] = r.result; });
          const wrong = [];
          CHECK_PROBES.forEach((p, i) => {
            const accepted = got[i] !== false; // PostgreSQL rejects a row only when the CHECK is false
            if (accepted !== p.accept) wrong.push(`${p.accept ? 'rejects' : 'accepts'}: ${p.label}`);
          });
          if (Object.keys(got).length !== CHECK_PROBES.length) wrong.push('did not evaluate every probe row');
          if (wrong.length) bad(id, 'must enforce the scope rules', wrong.slice(0, 4).join('; ') + (wrong.length > 4 ? ` (+${wrong.length - 4} more)` : ''));
        } catch (e) {
          bad(id, 'its expression must be evaluable on the scope columns', scrub(e && e.message));
        }
      }
    }
  }

  // function + trigger
  const fnRows = (await db.query(Q.fn)).rows;
  const fn = fnRows.find((r) => r.args === 0) || fnRows[0];
  if (fn) {
    const id = 'trigger-function:' + FUNCTION_NAME;
    present.add(id);
    if (fnRows.length !== 1) bad(id, 'there must be exactly one function with this name', `found ${fnRows.length}`);
    if (fn.language !== 'plpgsql') bad(id, 'must be written in plpgsql', `found ${fn.language}`);
    if (fn.returns !== 'trigger') bad(id, 'must return trigger', `found ${fn.returns}`);
    if (fn.args !== 0) bad(id, 'must take no arguments', `found ${fn.args}`);
    if (fn.security_definer) bad(id, 'must not be SECURITY DEFINER', 'it is');
    if (String(fn.body).trim() !== TRIGGER_FUNCTION_BODY) {
      bad(id, 'must skip a ward stamp on PLATFORM, COUNTY and CONSTITUENCY rows (RETURN NULL) and otherwise return NEW', 'the body differs from the installed Phase 4B.42 body');
    }
  }

  const trg = (await db.query(Q.trigger)).rows[0];
  if (trg) {
    const id = 'trigger:' + FUNCTION_NAME;
    present.add(id);
    if (trg.enabled !== 'O' && trg.enabled !== 'A') {
      bad(id, 'must be enabled', trg.enabled === 'D' ? 'it is DISABLED' : `its enabled state is ${trg.enabled} (it does not fire for ordinary sessions)`);
    }
    // tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE, 64 INSTEAD OF
    if (trg.type_bits !== 19) bad(id, 'must be BEFORE UPDATE ... FOR EACH ROW', `tgtype is ${trg.type_bits}, expected 19`);
    if (trg.update_columns && trg.update_columns.length && !trg.update_columns.includes('ward_id')) {
      bad(id, 'must fire on updates of ward_id', `it fires only on ${JSON.stringify(trg.update_columns)}`);
    }
    if (trg.fn_schema !== 'public' || trg.fn_name !== FUNCTION_NAME) bad(id, `must call public.${FUNCTION_NAME}()`, `it calls ${trg.fn_schema}.${trg.fn_name}`);
    const when = extractWhenClause(trg.definition);
    if (when === undefined) {
      bad(id, 'its WHEN condition must be readable', 'the trigger definition could not be parsed');
    } else if (when !== null) {
      const safe = sanitizeExpression(when, { old: 'o__', new: 'n__' });
      if (!safe.ok) {
        bad(id, 'its WHEN condition must use only old/new scope columns and plain boolean operators', safe.reason);
      } else {
        try {
          const res = (await db.query(buildWhenProbeSql(safe.sql))).rows;
          const got = {};
          res.forEach((r) => { got[Number(r.id)] = r.result; });
          const silent = WHEN_PROBES.filter((p, i) => got[i] !== true).map((p) => p.label);
          if (silent.length) bad(id, 'its WHEN condition must fire for the Phase 2 ward backfill of every protected scope', `it does not fire for: ${silent.join(', ')}`);
        } catch (e) {
          bad(id, 'its WHEN condition must be evaluable', scrub(e && e.message));
        }
      }
    }
  }

  // indexes
  const idx = byName((await db.query(Q.indexes)).rows);
  Object.keys(EXPECTED_INDEXES).forEach((name) => {
    const r = idx[name];
    if (!r) return;
    const id = `index:${name}`;
    present.add(id);
    const col = EXPECTED_INDEXES[name];
    if (!r.on_notices) bad(id, 'must be an index on notices', 'it belongs to another table');
    if (r.method !== 'btree') bad(id, 'must be a btree index', `found ${r.method}`);
    if (!r.has_expressions && (!sameList(r.columns, [col]) || r.key_count !== 1)) {
      bad(id, `must index exactly (${col})`, `found ${JSON.stringify(r.columns)}`);
    }
    if (!r.valid || !r.ready || r.live === false) bad(id, 'must be valid, ready and live', 'it is not (an interrupted CREATE INDEX leaves an invalid index)');
    if (r.is_unique || r.is_primary || r.is_exclusion) bad(id, 'must be a plain, non-unique index', 'it is unique, primary or exclusion');
    if (r.is_partial || r.has_expressions) bad(id, 'must be a plain index with no predicate or expression', 'it has one');
  });

  result.present = SCOPE_OBJECTS.filter((o) => present.has(o.id)).map((o) => o.id);
  result.missing = SCOPE_OBJECTS.filter((o) => !present.has(o.id)).map((o) => o.id);
  result.invalid = problems;

  if (result.present.length === 0) {
    result.state = STATES.NOT_INSTALLED;
    return result;
  }
  if (result.missing.length > 0) {
    result.state = STATES.PARTIAL;
  } else {
    // every scope object exists: the ward_id prerequisite must hold too
    if (!result.prerequisites.ward_id.present) {
      result.invalid.push({ object: 'column:ward_id', requirement: 'must exist (Phase 2 prerequisite)', reason: 'it is missing' });
    }
    result.prerequisites.ward_id.problems.forEach((reason) => {
      result.invalid.push({ object: 'column:ward_id', requirement: `type must be ${EXPECTED_COLUMNS.ward_id}`, reason });
    });
    result.state = result.invalid.length ? STATES.INVALID : STATES.INSTALLED;
  }
  // Read-only diagnostics, only when the columns they read exist (so the query cannot fail and, inside a
  // transaction, cannot abort it).
  if ((result.state === STATES.PARTIAL || result.state === STATES.INVALID) && cols.scope_level && cols.ward_id) {
    try {
      const d = (await db.query(Q.diagnostics)).rows[0];
      if (d) result.diagnostics = { scopedWardlessRows: d.scoped_wardless_rows, scopedRowsWithWard: d.scoped_rows_with_ward };
    } catch (_) {
      result.diagnostics = null; // diagnostics only; the columns may not all exist
    }
  }
  return result;
}

function problemsOf(inspection) {
  const list = [];
  inspection.missing.forEach((id) => {
    if (inspection.present.length) list.push({ object: id, requirement: 'must exist', reason: 'it is missing' });
  });
  inspection.invalid.forEach((p) => list.push(p));
  return list;
}

async function inspectOrThrow(db, phase) {
  try {
    return await inspectNoticeScopeSchema(db);
  } catch (cause) {
    // Not being able to look is not the same as being safe: fail closed.
    throw new NoticeScopeNotReadyError({
      phase,
      state: 'UNVERIFIABLE',
      problems: [{ object: 'notice-scope schema', requirement: 'must be readable from the PostgreSQL catalog', reason: scrub(cause && cause.message) }],
      reason: 'the schema could not be inspected, so it cannot be shown to be safe.',
      cause,
    });
  }
}

// Gate for the Phase 2 ward backfill. Returns the inspection when it is safe to continue.
async function verifyNoticeScopeBeforeBackfill(db) {
  const phase = 'before the Phase 2 ward backfill';
  const r = await inspectOrThrow(db, phase);
  if (r.state === STATES.NOT_INSTALLED || r.state === STATES.INSTALLED) return r;
  throw new NoticeScopeNotReadyError({
    phase,
    state: r.state,
    problems: problemsOf(r),
    diagnostics: r.diagnostics,
    reason:
      'the schema is ' + (r.state === STATES.PARTIAL ? 'only partly installed' : 'installed but invalid') +
      ', so the Phase 2 backfill (UPDATE notices SET ward_id ... WHERE ward_id IS NULL) could assign the founding ward ' +
      'to PLATFORM, COUNTY or CONSTITUENCY notices, or fail. Nothing was repaired and no row was changed; fix the schema, then restart.',
  });
}

// Verification after the installer. Only a complete, valid schema passes.
async function verifyNoticeScopeReady(db) {
  const phase = 'after notice-scope installation';
  const r = await inspectOrThrow(db, phase);
  if (r.state === STATES.INSTALLED) return r;
  const reason =
    r.state === STATES.NOT_INSTALLED
      ? 'the notice-scope installer did not complete (see the error logged just before this one), so the notice routes ' +
        'that read the scope columns cannot work.'
      : 'the schema is ' + (r.state === STATES.PARTIAL ? 'only partly installed' : 'installed but invalid') +
        ', so notice scoping cannot be relied on. Nothing was repaired.';
  throw new NoticeScopeNotReadyError({
    phase,
    state: r.state,
    problems: r.state === STATES.NOT_INSTALLED
      ? [{ object: 'notice-scope schema', requirement: 'all 11 scope objects must exist', reason: 'none of them exists' }]
      : problemsOf(r),
    diagnostics: r.diagnostics,
    reason,
  });
}

module.exports = {
  STATES,
  ERROR_CODE,
  NoticeScopeNotReadyError,
  NOTICE_SCOPE_INSTALL_LOCK,
  SCOPE_OBJECTS,
  TRIGGER_FUNCTION_BODY,
  CHECK_PROBES,
  WHEN_PROBES,
  inspectNoticeScopeSchema,
  verifyNoticeScopeBeforeBackfill,
  verifyNoticeScopeReady,
  // exported for tests
  sanitizeExpression,
  extractWhenClause,
  buildCheckProbeSql,
  buildWhenProbeSql,
  QUERIES: Q,
};
