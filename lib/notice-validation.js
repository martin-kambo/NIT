// lib/notice-validation.js
// Phase 4B.36: input validation and normalisation for the notice WRITE routes
// (POST /api/admin/notices, POST /api/notices, PUT /api/admin/notices/:id).
//
// PURE module: no Express, no database, no I/O, no environment access. Every
// function is deterministic, so it is unit-tested directly
// (__tests__/notice-validation.test.js) and shared by all three routes instead
// of being copied into each handler.
//
// Every validator returns either
//     { ok: true,  ...normalised values }
//  or { ok: false, error: '<client-safe message>' }
// and never throws for bad input.
//
// Where the rules come from (approved in Phase 4B.36):
//   * title 5-200 and content 10-5000 characters AFTER trimming, counted with
//     JavaScript UTF-16 `.length` - the same unit as the `maxlength` attribute
//     and the `.trim()` / `< 5` / `< 10` checks in public/admin-notices.html.
//   * the seven categories and three priorities offered by that page.
//   * `health` is a LEGACY category that exists in stored rows but is not an
//     official category: it is never accepted for a new notice and is accepted
//     on update only when the notice already stores `health` (see
//     resolveUpdateCategory()).
//   * expiry accepts ISO-8601 timestamps, including past ones; `null` clears;
//     an omitted property is reported as "not provided" so callers can tell
//     the difference.
//   * `days` (POST /api/notices only) keeps its default of 30 for an omitted,
//     null or zero value; anything else must be a whole number in 1..MAX_DAYS.

const NOTICE_CATEGORIES = Object.freeze([
  'general', 'public', 'service', 'payment', 'event', 'business', 'jobs',
]);
const NOTICE_PRIORITIES = Object.freeze(['normal', 'high', 'low']);
const LEGACY_CATEGORY = 'health';

const DEFAULT_CATEGORY = 'general';
const DEFAULT_PRIORITY = 'normal';

const TITLE_MIN = 5;
const TITLE_MAX = 200;
const CONTENT_MIN = 10;
const CONTENT_MAX = 5000;

const DEFAULT_DAYS = 30;
// Upper bound for `days`. Repository evidence: the longest notice lifetime
// anywhere in the repo is 120 days (the migration seeds), the in-repo default
// is 30, nothing in public/ calls POST /api/notices, and no route contract or
// test documents a maximum. 365 is the smallest whole-year bound that covers
// every observed use with headroom. PostgreSQL itself only fails far above
// this (a timestamp overflows near 10^9 days).
const MAX_DAYS = 365;

// wards.id / notices.ward_id are 32-bit integers.
const MAX_WARD_ID = 2147483647;

const MESSAGES = Object.freeze({
  required: 'title and content are required',
  text: 'title and content must be text',
  title: `title must be between ${TITLE_MIN} and ${TITLE_MAX} characters`,
  content: `content must be between ${CONTENT_MIN} and ${CONTENT_MAX} characters`,
  category: `category must be one of: ${NOTICE_CATEGORIES.join(', ')}`,
  categoryRequiredForLegacy:
    `category must be supplied for this notice: send "${LEGACY_CATEGORY}" to keep it, or one of: ${NOTICE_CATEGORIES.join(', ')}`,
  priority: `priority must be one of: ${NOTICE_PRIORITIES.join(', ')}`,
  expiresAt: 'expiresAt must be an ISO-8601 timestamp (for example 2030-01-31T18:00:00Z) or null',
  days: `days must be a whole number between 1 and ${MAX_DAYS}`,
  wardId: 'wardId must be a positive whole number',
});

const fail = (error) => ({ ok: false, error });

// ── title / content ─────────────────────────────────────────────────────────

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function validateText(body) {
  const { title, content } = body;
  if (isBlank(title) || isBlank(content)) return fail(MESSAGES.required);
  if (typeof title !== 'string' || typeof content !== 'string') return fail(MESSAGES.text);

  const trimmedTitle = title.trim();
  const trimmedContent = content.trim();
  if (trimmedTitle.length < TITLE_MIN || trimmedTitle.length > TITLE_MAX) return fail(MESSAGES.title);
  if (trimmedContent.length < CONTENT_MIN || trimmedContent.length > CONTENT_MAX) return fail(MESSAGES.content);
  return { ok: true, title: trimmedTitle, content: trimmedContent };
}

// ── category / priority ─────────────────────────────────────────────────────

// Shape check shared by create and update. `allowLegacy` lets the legacy
// category through to the update-time rule in resolveUpdateCategory().
function checkCategoryValue(value, allowLegacy) {
  if (typeof value !== 'string') return false;
  if (NOTICE_CATEGORIES.includes(value)) return true;
  return allowLegacy && value === LEGACY_CATEGORY;
}

function validateCreateCategory(value) {
  if (value === undefined) return { ok: true, category: DEFAULT_CATEGORY };
  if (!checkCategoryValue(value, false)) return fail(MESSAGES.category);
  return { ok: true, category: value };
}

function validatePriority(value) {
  if (value === undefined) return { ok: true, priority: DEFAULT_PRIORITY };
  if (typeof value !== 'string' || !NOTICE_PRIORITIES.includes(value)) return fail(MESSAGES.priority);
  return { ok: true, priority: value };
}

// Update-time category rule, applied AFTER the route has loaded the notice and
// passed the permission check, so the stored category never influences the
// response of a caller who is not allowed to touch the notice.
//   category omitted  -> the existing default ('general'), EXCEPT that a notice
//                        stored as `health` is never silently rewritten: the
//                        caller must say what category it should have.
//   approved category -> accepted.
//   `health`          -> accepted only when the stored category is `health`.
function resolveUpdateCategory(categoryInput, existingCategory) {
  if (categoryInput === undefined) {
    if (existingCategory === LEGACY_CATEGORY) return fail(MESSAGES.categoryRequiredForLegacy);
    return { ok: true, category: DEFAULT_CATEGORY };
  }
  if (categoryInput === LEGACY_CATEGORY && existingCategory !== LEGACY_CATEGORY) {
    return fail(MESSAGES.category);
  }
  return { ok: true, category: categoryInput };
}

// ── expiry ──────────────────────────────────────────────────────────────────

// Extended-format ISO-8601 date-time: YYYY-MM-DDTHH:mm[:ss[.f{1,9}]] followed
// by an optional zone designator (Z, +HH, +HHMM or +HH:MM; also -).
// Deliberately NOT accepted (PostgreSQL would parse some of these, so this is
// an intentional tightening): date-only values, a space instead of "T",
// lowercase "t"/"z", the compact basic format, a 24:00 hour, a :60 second.
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/;

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return false;
  const m = ISO_TIMESTAMP.exec(value);
  if (!m) return false;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);

  // Year 0000 is rejected because PostgreSQL rejects it (SQLSTATE 22008).
  if (year < 1 || month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  // Real-world UTC offsets stop at +14:00; PostgreSQL rejects beyond +15:59.
  if (m[7] !== undefined) {
    if (Number(m[7]) > 14) return false;
    if (m[8] !== undefined && Number(m[8]) > 59) return false;
  }
  return true;
}

// -> { ok:true, provided:false }                      property omitted
//    { ok:true, provided:true, value:null }           explicit null  (clear)
//    { ok:true, provided:true, value:'<iso string>' } valid timestamp (set)
// The original string is passed through unchanged: the column is
// `timestamp without time zone`, so what the database stores for a given
// string is unchanged by this phase.
function validateExpiresAt(value) {
  if (value === undefined) return { ok: true, provided: false, value: undefined };
  if (value === null) return { ok: true, provided: true, value: null };
  if (!isValidIsoTimestamp(value)) return fail(MESSAGES.expiresAt);
  return { ok: true, provided: true, value };
}

// ── days (POST /api/notices only) ───────────────────────────────────────────

function validateDays(value) {
  if (value === undefined || value === null) return { ok: true, days: DEFAULT_DAYS };

  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^(0|[1-9]\d{0,9})$/.test(value)) {
    n = Number(value);
  } else {
    return fail(MESSAGES.days);
  }

  if (!Number.isSafeInteger(n)) return fail(MESSAGES.days);
  if (n === 0) return { ok: true, days: DEFAULT_DAYS };
  if (n < 1 || n > MAX_DAYS) return fail(MESSAGES.days);
  return { ok: true, days: n };
}

// ── wardId ──────────────────────────────────────────────────────────────────

// -> { ok:true, supplied:false }                 omitted or null (the caller
//                                                 did not name a ward)
//    { ok:true, supplied:true, wardId:<int> }    canonical positive integer
//    { ok:false, error }                         anything else
// Accepted: a number or a canonical decimal string (no sign, no leading zero,
// no whitespace) from 1 to 2147483647. A supplied-but-invalid value is never
// treated as "not supplied": that includes the empty string and a
// whitespace-only string (Phase 4B.36A) -- a caller that sends `wardId: ""` has
// named a ward, badly, and gets a 400 instead of the founding-ward fallback.
function parseWardId(value) {
  if (value === undefined || value === null) return { ok: true, supplied: false };

  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)) {
    n = Number(value);
  } else {
    return fail(MESSAGES.wardId);
  }

  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_WARD_ID) return fail(MESSAGES.wardId);
  return { ok: true, supplied: true, wardId: n };
}

// ── composites used by the routes ───────────────────────────────────────────

function asObject(body) {
  return body !== null && typeof body === 'object' ? body : {};
}

// expiry: 'expiresAt' (POST /api/admin/notices) or 'days' (POST /api/notices).
// Order of checks: title/content, category, priority, expiry. The first failure
// is reported.
function validateNoticeCreate(body, { expiry }) {
  const src = asObject(body);

  const text = validateText(src);
  if (!text.ok) return text;
  const category = validateCreateCategory(src.category);
  if (!category.ok) return category;
  const priority = validatePriority(src.priority);
  if (!priority.ok) return priority;

  const value = {
    title: text.title,
    content: text.content,
    category: category.category,
    priority: priority.priority,
  };

  if (expiry === 'days') {
    const days = validateDays(src.days);
    if (!days.ok) return days;
    value.days = days.days;
  } else {
    const expiresAt = validateExpiresAt(src.expiresAt);
    if (!expiresAt.ok) return expiresAt;
    // Create route: omitted and null both mean "no expiry" (unchanged).
    value.expiresAt = expiresAt.value === undefined ? null : expiresAt.value;
  }
  return { ok: true, value };
}

// Everything that can be checked WITHOUT the stored notice. The category is
// only shape-checked here (`health` is let through); the stored-category rule
// is resolveUpdateCategory(), called after the lookup and permission check.
// value.expiresAt is undefined (keep the stored expiry), null (clear it) or a
// timestamp string (replace it).
function validateNoticeUpdate(body) {
  const src = asObject(body);

  const text = validateText(src);
  if (!text.ok) return text;
  if (src.category !== undefined && !checkCategoryValue(src.category, true)) return fail(MESSAGES.category);
  const priority = validatePriority(src.priority);
  if (!priority.ok) return priority;
  const expiresAt = validateExpiresAt(src.expiresAt);
  if (!expiresAt.ok) return expiresAt;

  return {
    ok: true,
    value: {
      title: text.title,
      content: text.content,
      categoryInput: src.category,
      priority: priority.priority,
      expiresAt: expiresAt.value,
    },
  };
}

module.exports = {
  NOTICE_CATEGORIES,
  NOTICE_PRIORITIES,
  LEGACY_CATEGORY,
  DEFAULT_CATEGORY,
  DEFAULT_PRIORITY,
  TITLE_MIN,
  TITLE_MAX,
  CONTENT_MIN,
  CONTENT_MAX,
  DEFAULT_DAYS,
  MAX_DAYS,
  MAX_WARD_ID,
  MESSAGES,
  isValidIsoTimestamp,
  validateExpiresAt,
  validateDays,
  parseWardId,
  resolveUpdateCategory,
  validateNoticeCreate,
  validateNoticeUpdate,
};
