// ============================================================================
// Phase 4B.36 — unit tests for lib/notice-validation.js
// ============================================================================
// The module is pure (no Express, no database), so these tests call it
// directly. The route-level behaviour — that every write route actually uses
// these rules, and that an invalid request causes no database access — is
// covered in __tests__/notices.test.js.
//
// Expected messages and limits are written out literally on purpose: changing
// a rule or a message must be a visible edit to this file.

const V = require('../lib/notice-validation');

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
};

const BODY = { title: 'A valid notice title', content: 'A valid notice body text.' };
const bad = (error) => ({ ok: false, error });

describe('constants', () => {
  test('the approved categories, priorities and limits', () => {
    expect(V.NOTICE_CATEGORIES).toEqual(['general', 'public', 'service', 'payment', 'event', 'business', 'jobs']);
    expect(V.NOTICE_PRIORITIES).toEqual(['normal', 'high', 'low']);
    expect(V.LEGACY_CATEGORY).toBe('health');
    expect(V.DEFAULT_CATEGORY).toBe('general');
    expect(V.DEFAULT_PRIORITY).toBe('normal');
    expect([V.TITLE_MIN, V.TITLE_MAX, V.CONTENT_MIN, V.CONTENT_MAX]).toEqual([5, 200, 10, 5000]);
    expect([V.DEFAULT_DAYS, V.MAX_DAYS, V.MAX_WARD_ID]).toEqual([30, 365, 2147483647]);
  });

  test('`health` is not one of the approved categories', () => {
    expect(V.NOTICE_CATEGORIES.includes('health')).toBe(false);
  });

  test('the message table matches the documented wording', () => {
    expect(V.MESSAGES).toEqual({
      required: MSG.required,
      text: MSG.text,
      title: MSG.title,
      content: MSG.content,
      category: MSG.category,
      categoryRequiredForLegacy: MSG.healthRequired,
      priority: MSG.priority,
      expiresAt: MSG.expiresAt,
      days: MSG.days,
      wardId: MSG.wardId,
    });
  });
});

describe('validateNoticeCreate — title and content', () => {
  const create = (body) => V.validateNoticeCreate(body, { expiry: 'expiresAt' });

  test.each([
    ['no body at all', undefined],
    ['null body', null],
    ['a string body', 'title'],
    ['an array body', []],
    ['an empty object', {}],
  ])('%s → "required"', (label, body) => {
    expect(create(body)).toEqual(bad(MSG.required));
  });

  test.each([
    ['title missing', { content: BODY.content }],
    ['content missing', { title: BODY.title }],
    ['title null', { ...BODY, title: null }],
    ['content null', { ...BODY, content: null }],
    ['title empty', { ...BODY, title: '' }],
    ['content empty', { ...BODY, content: '' }],
    ['title whitespace only', { ...BODY, title: '      ' }],
    ['content whitespace only', { ...BODY, content: '            ' }],
    ['title tabs and newlines only', { ...BODY, title: ' \t\n\r ' }],
  ])('%s → "required"', (label, body) => {
    expect(create(body)).toEqual(bad(MSG.required));
  });

  test.each([
    ['title is a number', { ...BODY, title: 12345 }],
    ['content is a number', { ...BODY, content: 1234567890 }],
    ['title is an object', { ...BODY, title: { a: 1 } }],
    ['content is an object', { ...BODY, content: { a: 1 } }],
    ['title is an array', { ...BODY, title: ['abcde'] }],
    ['content is an array', { ...BODY, content: ['abcdefghij'] }],
    ['title is true', { ...BODY, title: true }],
    ['title is false', { ...BODY, title: false }],
    ['content is true', { ...BODY, content: true }],
    ['content is false', { ...BODY, content: false }],
    ['title is 0', { ...BODY, title: 0 }],
  ])('%s → "must be text"', (label, body) => {
    expect(create(body)).toEqual(bad(MSG.text));
  });

  test('title boundaries: 4 rejected, 5 and 200 accepted, 201 rejected', () => {
    expect(create({ ...BODY, title: 'a'.repeat(4) })).toEqual(bad(MSG.title));
    expect(create({ ...BODY, title: 'a'.repeat(5) }).ok).toBe(true);
    expect(create({ ...BODY, title: 'a'.repeat(200) }).ok).toBe(true);
    expect(create({ ...BODY, title: 'a'.repeat(201) })).toEqual(bad(MSG.title));
  });

  test('content boundaries: 9 rejected, 10 and 5000 accepted, 5001 rejected', () => {
    expect(create({ ...BODY, content: 'b'.repeat(9) })).toEqual(bad(MSG.content));
    expect(create({ ...BODY, content: 'b'.repeat(10) }).ok).toBe(true);
    expect(create({ ...BODY, content: 'b'.repeat(5000) }).ok).toBe(true);
    expect(create({ ...BODY, content: 'b'.repeat(5001) })).toEqual(bad(MSG.content));
  });

  test('lengths are counted AFTER trimming', () => {
    // 4 real characters + padding is too short; 5 real characters is enough.
    expect(create({ ...BODY, title: '   abcd   ' })).toEqual(bad(MSG.title));
    expect(create({ ...BODY, title: '   abcde   ' }).ok).toBe(true);
    // 200 real characters + padding is still within the limit; 201 is not.
    expect(create({ ...BODY, title: `  ${'a'.repeat(200)}  ` }).ok).toBe(true);
    expect(create({ ...BODY, title: `  ${'a'.repeat(201)}  ` })).toEqual(bad(MSG.title));
    expect(create({ ...BODY, content: `   ${'b'.repeat(9)}   ` })).toEqual(bad(MSG.content));
    expect(create({ ...BODY, content: `   ${'b'.repeat(10)}   ` }).ok).toBe(true);
    expect(create({ ...BODY, content: `  ${'b'.repeat(5000)}  ` }).ok).toBe(true);
    expect(create({ ...BODY, content: `  ${'b'.repeat(5001)}  ` })).toEqual(bad(MSG.content));
  });

  test('the TRIMMED values are what is returned (for storage)', () => {
    const res = create({ title: '  Padded title \n', content: '\t Padded content body  ' });
    expect(res.ok).toBe(true);
    expect(res.value.title).toBe('Padded title');
    expect(res.value.content).toBe('Padded content body');
  });

  test('inner whitespace is preserved', () => {
    const res = create({ title: 'Two  spaces\tand a tab', content: 'Line one\n\nLine three here' });
    expect(res.value.title).toBe('Two  spaces\tand a tab');
    expect(res.value.content).toBe('Line one\n\nLine three here');
  });

  test('length is the UTF-16 length: an astral character counts as 2', () => {
    const emoji = '\u{1F600}'; // one code point, two UTF-16 code units
    expect(emoji.length).toBe(2);
    // 2 emoji = 4 units → too short; 3 emoji = 6 units → ok (a code-point count would say 3 ≥ 5? no: 3 < 5)
    expect(create({ ...BODY, title: emoji.repeat(2) })).toEqual(bad(MSG.title));
    expect(create({ ...BODY, title: emoji.repeat(3) }).ok).toBe(true);
    // 100 emoji = 200 units → ok; 101 emoji = 202 units → too long
    expect(create({ ...BODY, title: emoji.repeat(100) }).ok).toBe(true);
    expect(create({ ...BODY, title: emoji.repeat(101) })).toEqual(bad(MSG.title));
    // content: 2500 emoji = 5000 units → ok; 2501 = 5002 → too long
    expect(create({ ...BODY, content: emoji.repeat(2500) }).ok).toBe(true);
    expect(create({ ...BODY, content: emoji.repeat(2501) })).toEqual(bad(MSG.content));
  });

  test('the title is checked before the content when both are bad', () => {
    expect(create({ title: 'abc', content: 'def' })).toEqual(bad(MSG.title));
  });

  test('a bad title is reported before a bad category/priority/expiry', () => {
    expect(create({ title: 'abc', content: BODY.content, category: 'nope', priority: 'nope', expiresAt: 'nope' }))
      .toEqual(bad(MSG.title));
  });
});

describe('validateNoticeCreate — category and priority', () => {
  const create = (extra) => V.validateNoticeCreate({ ...BODY, ...extra }, { expiry: 'expiresAt' });

  test.each(['general', 'public', 'service', 'payment', 'event', 'business', 'jobs'])(
    'category %s is accepted and returned unchanged', (category) => {
      const res = create({ category });
      expect(res.ok).toBe(true);
      expect(res.value.category).toBe(category);
    }
  );

  test.each(['normal', 'high', 'low'])('priority %s is accepted and returned unchanged', (priority) => {
    const res = create({ priority });
    expect(res.ok).toBe(true);
    expect(res.value.priority).toBe(priority);
  });

  test('omitted category and priority default to general / normal', () => {
    const res = create({});
    expect(res.value.category).toBe('general');
    expect(res.value.priority).toBe('normal');
  });

  test.each([
    ['unknown', 'sports'],
    ['upper case', 'PUBLIC'],
    ['capitalised', 'Public'],
    ['padded', ' public '],
    ['empty string', ''],
    ['whitespace', '   '],
    ['plural', 'events'],
    ['a prototype key', '__proto__'],
    ['a prototype method name', 'toString'],
    ['a number', 1],
    ['null', null],
    ['true', true],
    ['false', false],
    ['an object', { a: 1 }],
    ['an array', ['public']],
    ['an array holding an approved value', ['general']],
  ])('category: %s is rejected', (label, category) => {
    expect(create({ category })).toEqual(bad(MSG.category));
  });

  test('category `health` is rejected on a NEW notice', () => {
    expect(create({ category: 'health' })).toEqual(bad(MSG.category));
    expect(create({ category: 'Health' })).toEqual(bad(MSG.category));
  });

  test.each([
    ['unknown', 'urgent'],
    ['upper case', 'HIGH'],
    ['capitalised', 'High'],
    ['padded', ' high '],
    ['empty string', ''],
    ['whitespace', '   '],
    ['a prototype key', 'constructor'],
    ['a number', 1],
    ['null', null],
    ['true', true],
    ['false', false],
    ['an object', { a: 1 }],
    ['an array', ['high']],
  ])('priority: %s is rejected', (label, priority) => {
    expect(create({ priority })).toEqual(bad(MSG.priority));
  });

  test('a bad category is reported before a bad priority', () => {
    expect(create({ category: 'nope', priority: 'nope' })).toEqual(bad(MSG.category));
  });
});

describe('validateNoticeCreate — expiry', () => {
  test("expiry:'expiresAt' — omitted and null both mean no expiry (create behaviour unchanged)", () => {
    expect(V.validateNoticeCreate(BODY, { expiry: 'expiresAt' }).value.expiresAt).toBe(null);
    expect(V.validateNoticeCreate({ ...BODY, expiresAt: null }, { expiry: 'expiresAt' }).value.expiresAt).toBe(null);
  });

  test("expiry:'expiresAt' — a valid timestamp (future OR past) is passed through unchanged", () => {
    const future = V.validateNoticeCreate({ ...BODY, expiresAt: '2099-01-31T18:00:00Z' }, { expiry: 'expiresAt' });
    expect(future.value.expiresAt).toBe('2099-01-31T18:00:00Z');
    const past = V.validateNoticeCreate({ ...BODY, expiresAt: '2001-01-31T18:00:00Z' }, { expiry: 'expiresAt' });
    expect(past.ok).toBe(true);
    expect(past.value.expiresAt).toBe('2001-01-31T18:00:00Z');
  });

  test("expiry:'expiresAt' — a malformed timestamp is rejected, never defaulted", () => {
    expect(V.validateNoticeCreate({ ...BODY, expiresAt: 'tomorrow' }, { expiry: 'expiresAt' })).toEqual(bad(MSG.expiresAt));
    expect(V.validateNoticeCreate({ ...BODY, expiresAt: 12345 }, { expiry: 'expiresAt' })).toEqual(bad(MSG.expiresAt));
  });

  test("expiry:'expiresAt' — the value contains no `days` key", () => {
    const res = V.validateNoticeCreate({ ...BODY, days: 3 }, { expiry: 'expiresAt' });
    expect(res.ok).toBe(true);
    expect(res.value).not.toHaveProperty('days');
  });

  test("expiry:'days' — omitted, null and 0 → 30", () => {
    expect(V.validateNoticeCreate(BODY, { expiry: 'days' }).value.days).toBe(30);
    expect(V.validateNoticeCreate({ ...BODY, days: null }, { expiry: 'days' }).value.days).toBe(30);
    expect(V.validateNoticeCreate({ ...BODY, days: 0 }, { expiry: 'days' }).value.days).toBe(30);
  });

  test("expiry:'days' — a valid count is returned as a number", () => {
    expect(V.validateNoticeCreate({ ...BODY, days: 7 }, { expiry: 'days' }).value.days).toBe(7);
    expect(V.validateNoticeCreate({ ...BODY, days: '7' }, { expiry: 'days' }).value.days).toBe(7);
  });

  test("expiry:'days' — an invalid count is rejected", () => {
    expect(V.validateNoticeCreate({ ...BODY, days: 'soon' }, { expiry: 'days' })).toEqual(bad(MSG.days));
    expect(V.validateNoticeCreate({ ...BODY, days: 366 }, { expiry: 'days' })).toEqual(bad(MSG.days));
  });

  test("expiry:'days' — the value contains no `expiresAt` key and ignores one in the body", () => {
    const res = V.validateNoticeCreate({ ...BODY, expiresAt: 'garbage' }, { expiry: 'days' });
    expect(res.ok).toBe(true);
    expect(res.value).not.toHaveProperty('expiresAt');
  });

  test('a fully valid body returns exactly the normalised fields', () => {
    const res = V.validateNoticeCreate(
      { title: ' Title here ', content: ' Content here! ', category: 'event', priority: 'high', expiresAt: '2099-01-01T00:00:00Z' },
      { expiry: 'expiresAt' }
    );
    expect(res).toEqual({
      ok: true,
      value: { title: 'Title here', content: 'Content here!', category: 'event', priority: 'high', expiresAt: '2099-01-01T00:00:00Z' },
    });
  });
});

describe('validateNoticeUpdate', () => {
  test('a minimal valid body: only text; category and expiry are left for the route', () => {
    expect(V.validateNoticeUpdate(BODY)).toEqual({
      ok: true,
      value: { title: BODY.title, content: BODY.content, categoryInput: undefined, priority: 'normal', expiresAt: undefined },
    });
  });

  test('the same text rules apply (required, type, boundaries, trim)', () => {
    expect(V.validateNoticeUpdate({})).toEqual(bad(MSG.required));
    expect(V.validateNoticeUpdate({ ...BODY, title: 5 })).toEqual(bad(MSG.text));
    expect(V.validateNoticeUpdate({ ...BODY, title: 'abcd' })).toEqual(bad(MSG.title));
    expect(V.validateNoticeUpdate({ ...BODY, content: 'b'.repeat(5001) })).toEqual(bad(MSG.content));
    expect(V.validateNoticeUpdate({ title: '  Trimmed  ', content: '  Trimmed too!  ' }).value.title).toBe('Trimmed');
    expect(V.validateNoticeUpdate({ title: '  Trimmed  ', content: '  Trimmed too!  ' }).value.content).toBe('Trimmed too!');
  });

  test('approved categories are passed through as categoryInput', () => {
    V.NOTICE_CATEGORIES.forEach((category) => {
      expect(V.validateNoticeUpdate({ ...BODY, category }).value.categoryInput).toBe(category);
    });
  });

  test('`health` passes the SHAPE check (the stored-category rule is resolveUpdateCategory)', () => {
    const res = V.validateNoticeUpdate({ ...BODY, category: 'health' });
    expect(res.ok).toBe(true);
    expect(res.value.categoryInput).toBe('health');
  });

  test.each([
    ['unknown', 'sports'],
    ['wrong case', 'Health'],
    ['wrong case of an approved one', 'GENERAL'],
    ['empty', ''],
    ['a number', 7],
    ['null', null],
    ['true', true],
    ['an object', {}],
    ['an array', ['health']],
  ])('category: %s is rejected', (label, category) => {
    expect(V.validateNoticeUpdate({ ...BODY, category })).toEqual(bad(MSG.category));
  });

  test('priority defaults to normal and rejects bad values', () => {
    expect(V.validateNoticeUpdate(BODY).value.priority).toBe('normal');
    expect(V.validateNoticeUpdate({ ...BODY, priority: 'low' }).value.priority).toBe('low');
    expect(V.validateNoticeUpdate({ ...BODY, priority: 'HIGH' })).toEqual(bad(MSG.priority));
    expect(V.validateNoticeUpdate({ ...BODY, priority: null })).toEqual(bad(MSG.priority));
    expect(V.validateNoticeUpdate({ ...BODY, priority: 2 })).toEqual(bad(MSG.priority));
  });

  test('expiresAt: omitted → undefined (keep), null → null (clear), valid → string (replace)', () => {
    expect(V.validateNoticeUpdate(BODY).value.expiresAt).toBe(undefined);
    expect(V.validateNoticeUpdate({ ...BODY, expiresAt: null }).value.expiresAt).toBe(null);
    expect(V.validateNoticeUpdate({ ...BODY, expiresAt: '2099-06-01T12:00:00Z' }).value.expiresAt).toBe('2099-06-01T12:00:00Z');
  });

  test('"omitted" is distinguished from "explicit undefined-like" values on the wire', () => {
    // JSON can only carry null or a value; a key that is absent is the "omitted" case.
    const omitted = V.validateNoticeUpdate(BODY).value;
    const cleared = V.validateNoticeUpdate({ ...BODY, expiresAt: null }).value;
    expect(omitted.expiresAt === undefined).toBe(true);
    expect(cleared.expiresAt === null).toBe(true);
  });

  test('a past expiry is valid on update', () => {
    const res = V.validateNoticeUpdate({ ...BODY, expiresAt: '2001-01-31T18:00:00Z' });
    expect(res.ok).toBe(true);
    expect(res.value.expiresAt).toBe('2001-01-31T18:00:00Z');
  });

  test.each([
    ['a number', 1700000000000],
    ['an object', { date: '2099-01-01T00:00:00Z' }],
    ['an array', ['2099-01-01T00:00:00Z']],
    ['true', true],
    ['false', false],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['an invalid string', 'not a date'],
  ])('expiresAt: %s is rejected', (label, expiresAt) => {
    expect(V.validateNoticeUpdate({ ...BODY, expiresAt })).toEqual(bad(MSG.expiresAt));
  });

  test('a null / non-object body is "required"', () => {
    expect(V.validateNoticeUpdate(null)).toEqual(bad(MSG.required));
    expect(V.validateNoticeUpdate(undefined)).toEqual(bad(MSG.required));
  });
});

describe('resolveUpdateCategory — the legacy `health` rule', () => {
  test('`health` is accepted only when the stored category is already `health`', () => {
    expect(V.resolveUpdateCategory('health', 'health')).toEqual({ ok: true, category: 'health' });
  });

  test.each(['general', 'public', 'service', 'payment', 'event', 'business', 'jobs', 'something-else'])(
    '`health` is rejected when the stored category is %s', (stored) => {
      expect(V.resolveUpdateCategory('health', stored)).toEqual(bad(MSG.category));
    }
  );

  test('`health` is rejected when the stored category is null or undefined', () => {
    expect(V.resolveUpdateCategory('health', null)).toEqual(bad(MSG.category));
    expect(V.resolveUpdateCategory('health', undefined)).toEqual(bad(MSG.category));
  });

  test.each(['general', 'public', 'service', 'payment', 'event', 'business', 'jobs'])(
    'a stored `health` notice may be moved to the approved category %s', (target) => {
      expect(V.resolveUpdateCategory(target, 'health')).toEqual({ ok: true, category: target });
    }
  );

  test('an approved category is accepted whatever the stored value is', () => {
    expect(V.resolveUpdateCategory('event', 'public')).toEqual({ ok: true, category: 'event' });
    expect(V.resolveUpdateCategory('event', null)).toEqual({ ok: true, category: 'event' });
    expect(V.resolveUpdateCategory('event', undefined)).toEqual({ ok: true, category: 'event' });
  });

  test('omitted category on a stored `health` notice is refused, not silently rewritten', () => {
    expect(V.resolveUpdateCategory(undefined, 'health')).toEqual(bad(MSG.healthRequired));
  });

  test('omitted category on any other notice keeps today’s default: general', () => {
    expect(V.resolveUpdateCategory(undefined, 'public')).toEqual({ ok: true, category: 'general' });
    expect(V.resolveUpdateCategory(undefined, 'general')).toEqual({ ok: true, category: 'general' });
    expect(V.resolveUpdateCategory(undefined, null)).toEqual({ ok: true, category: 'general' });
    expect(V.resolveUpdateCategory(undefined, undefined)).toEqual({ ok: true, category: 'general' });
  });

  test('the comparison is exact: "Health" and " health" are not the legacy category', () => {
    expect(V.resolveUpdateCategory('health', 'Health')).toEqual(bad(MSG.category));
    expect(V.resolveUpdateCategory('health', ' health')).toEqual(bad(MSG.category));
    expect(V.resolveUpdateCategory(undefined, 'Health')).toEqual({ ok: true, category: 'general' });
  });
});

describe('isValidIsoTimestamp / validateExpiresAt', () => {
  test.each([
    '2030-01-31T18:00:00Z',
    '2030-01-31T18:00:00.123Z',
    '2030-01-31T18:00:00.123456789Z',
    '2030-01-31T18:00Z',
    '2030-01-31T18:00',
    '2030-01-31T18:00:00',
    '2030-01-31T18:00:00.5',
    '2030-01-31T18:00:00+03:00',
    '2030-01-31T18:00:00-05:30',
    '2030-01-31T18:00:00+0300',
    '2030-01-31T18:00:00+03',
    '2030-01-31T18:00:00+14:00',
    '2030-01-31T18:00:00-14:59',
    '2030-01-31T00:00:00Z',
    '2030-01-31T23:59:59Z',
    '2030-12-31T23:59:59Z',
    '2028-02-29T12:00:00Z', // leap day
    '2000-02-29T12:00:00Z', // divisible by 400
    '2001-01-01T00:00:00Z', // past
    '1999-12-31T23:59:59Z', // past
    '0001-01-01T00:00:00Z', // year 1 is the earliest valid year
    '9999-12-31T23:59:59Z',
  ])('accepts %s', (value) => {
    expect(V.isValidIsoTimestamp(value)).toBe(true);
    expect(V.validateExpiresAt(value)).toEqual({ ok: true, provided: true, value });
  });

  test.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['free text', 'tomorrow'],
    ['"null" as text', 'null'],
    ['"undefined" as text', 'undefined'],
    ['a date only', '2030-01-31'],
    ['a space instead of T', '2030-01-31 18:00:00'],
    ['a lowercase t', '2030-01-31t18:00:00Z'],
    ['a lowercase z', '2030-01-31T18:00:00z'],
    ['the compact basic format', '20300131T180000Z'],
    ['an hour without minutes', '2030-01-31T18Z'],
    ['hour 24', '2030-01-31T24:00:00Z'],
    ['a minute 60', '2030-01-31T18:60:00Z'],
    ['a second 60', '2030-01-31T18:00:60Z'],
    ['month 0', '2030-00-15T10:00:00Z'],
    ['month 13', '2030-13-15T10:00:00Z'],
    ['day 0', '2030-01-00T10:00:00Z'],
    ['day 32', '2030-01-32T10:00:00Z'],
    ['31 April', '2030-04-31T10:00:00Z'],
    ['30 February', '2030-02-30T10:00:00Z'],
    ['29 February in a non-leap year', '2029-02-29T10:00:00Z'],
    ['29 February in a century non-leap year', '1900-02-29T10:00:00Z'],
    ['year 0000', '0000-01-01T00:00:00Z'],
    ['a 5-digit year', '10000-01-01T00:00:00Z'],
    ['a 2-digit year', '30-01-31T18:00:00Z'],
    ['an offset beyond +14', '2030-01-31T18:00:00+15:00'],
    ['an offset minute 60', '2030-01-31T18:00:00+03:60'],
    ['10 fractional digits', '2030-01-31T18:00:00.1234567890Z'],
    ['an empty fraction', '2030-01-31T18:00:00.Z'],
    ['trailing text', '2030-01-31T18:00:00Z and more'],
    ['leading whitespace', ' 2030-01-31T18:00:00Z'],
    ['trailing whitespace', '2030-01-31T18:00:00Z '],
    ['a trailing newline', '2030-01-31T18:00:00Z\n'],
    ['a SQL-ish string', "2030-01-31'; DROP TABLE notices;--"],
    ['an overlong string', `2030-01-31T18:00:00Z${' '.repeat(40)}`],
    ['a PostgreSQL keyword', 'infinity'],
    ['a PostgreSQL keyword (-)', '-infinity'],
    ['a PostgreSQL keyword (now)', 'now'],
    ['a PostgreSQL keyword (epoch)', 'epoch'],
  ])('rejects %s', (label, value) => {
    expect(V.isValidIsoTimestamp(value)).toBe(false);
    expect(V.validateExpiresAt(value)).toEqual(bad(MSG.expiresAt));
  });

  test.each([
    ['a number', 1700000000000],
    ['zero', 0],
    ['NaN', NaN],
    ['true', true],
    ['false', false],
    ['an object', {}],
    ['an array', []],
    ['a Date object', new Date('2030-01-31T18:00:00Z')],
    ['a function', () => '2030-01-31T18:00:00Z'],
  ])('rejects a non-string: %s', (label, value) => {
    expect(V.isValidIsoTimestamp(value)).toBe(false);
    expect(V.validateExpiresAt(value)).toEqual(bad(MSG.expiresAt));
  });

  test('omitted → provided:false; null → provided:true with null', () => {
    expect(V.validateExpiresAt(undefined)).toEqual({ ok: true, provided: false, value: undefined });
    expect(V.validateExpiresAt(null)).toEqual({ ok: true, provided: true, value: null });
  });

  test('a valid value is returned byte-for-byte (not re-formatted)', () => {
    expect(V.validateExpiresAt('2030-01-31T18:00:00+03:00').value).toBe('2030-01-31T18:00:00+03:00');
    expect(V.validateExpiresAt('2030-01-31T18:00').value).toBe('2030-01-31T18:00');
  });
});

describe('validateDays', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['0', 0],
    ['"0"', '0'],
  ])('%s → the default of 30', (label, value) => {
    expect(V.validateDays(value)).toEqual({ ok: true, days: 30 });
  });

  test.each([
    ['1', 1, 1],
    ['7', 7, 7],
    ['30', 30, 30],
    ['90', 90, 90],
    ['120', 120, 120],
    ['365', 365, 365],
    ['"1"', '1', 1],
    ['"14"', '14', 14],
    ['"365"', '365', 365],
    ['2 written as 2.0 in JSON', 2.0, 2],
  ])('%s is accepted', (label, value, expected) => {
    expect(V.validateDays(value)).toEqual({ ok: true, days: expected });
  });

  test.each([
    ['366', 366],
    ['"366"', '366'],
    ['1000', 1000],
    ['1e9', 1e9],
    ['2147483648', 2147483648],
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['Number.MAX_SAFE_INTEGER + 2 (unsafe)', Number.MAX_SAFE_INTEGER + 2],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
    ['-1', -1],
    ['"-1"', '-1'],
    ['-30', -30],
    ['1.5', 1.5],
    ['0.5', 0.5],
    ['"1.5"', '1.5'],
    ['"3.0"', '3.0'],
    ['"1e2"', '1e2'],
    ['"0x10"', '0x10'],
    ['"007" (leading zeros)', '007'],
    ['"+5"', '+5'],
    ['" 5" (leading space)', ' 5'],
    ['"5 " (trailing space)', '5 '],
    ['"" (empty string)', ''],
    ['"   " (whitespace)', '   '],
    ['"abc"', 'abc'],
    ['"5days"', '5days'],
    ['"Infinity"', 'Infinity'],
    ['"NaN"', 'NaN'],
    ['"99999999999" (11 digits)', '99999999999'],
    ['true', true],
    ['false', false],
    ['an empty array', []],
    ['an array [7]', [7]],
    ['an array ["7"]', ['7']],
    ['an object', {}],
    ['an object with a number', { n: 7 }],
    ['a function', () => 7],
  ])('%s is rejected', (label, value) => {
    expect(V.validateDays(value)).toEqual(bad(MSG.days));
  });

  test('negative zero is treated as zero (→ default)', () => {
    expect(V.validateDays(-0)).toEqual({ ok: true, days: 30 });
  });
});

describe('parseWardId', () => {
  // Phase 4B.36A: ONLY undefined and null mean "not supplied". The empty string
  // used to be in this list; it is now an invalid ward id (see the rejected
  // table below).
  test.each([
    ['undefined', undefined],
    ['null', null],
  ])('%s means "not supplied"', (label, value) => {
    expect(V.parseWardId(value)).toEqual({ ok: true, supplied: false });
  });

  test.each([
    ['1', 1, 1],
    ['2', 2, 2],
    ['42', 42, 42],
    ['2147483647', 2147483647, 2147483647],
    ['"1"', '1', 1],
    ['"7"', '7', 7],
    ['"42"', '42', 42],
    ['"2147483647"', '2147483647', 2147483647],
    ['2.0 written as a JSON number', 2.0, 2],
  ])('%s is a valid ward id', (label, value, expected) => {
    expect(V.parseWardId(value)).toEqual({ ok: true, supplied: true, wardId: expected });
  });

  test.each([
    ['"abc"', 'abc'],
    ['"0"', '0'],
    ['0', 0],
    ['"-3"', '-3'],
    ['-3', -3],
    ['"2.9"', '2.9'],
    ['2.9', 2.9],
    ['"7abc"', '7abc'],
    ['"abc7"', 'abc7'],
    ['1e21', 1e21],
    ['"1e21"', '1e21'],
    ['"1e2"', '1e2'],
    ['"0x1"', '0x1'],
    ['"007" (leading zeros)', '007'],
    ['"+5"', '+5'],
    ['" 5"', ' 5'],
    ['"5 "', '5 '],
    ['"5\\n"', '5\n'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a single space', ' '],
    ['a tab', '\t'],
    ['a newline', '\n'],
    ['a carriage return and newline', '\r\n'],
    ['mixed whitespace only', ' \t\n\r '],
    ['a non-breaking space only', ' '],
    ['2147483648 (one past int32)', 2147483648],
    ['"2147483648"', '2147483648'],
    ['"99999999999" (11 digits)', '99999999999'],
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
    ['an empty array', []],
    ['an array [1]', [1]],
    ['an array ["1"]', ['1']],
    ['an object', {}],
    ['an object with a number', { id: 1 }],
    ['true', true],
    ['false', false],
    ['a function', () => 1],
    ['"null" as text', 'null'],
    ['"undefined" as text', 'undefined'],
    ['"NaN" as text', 'NaN'],
  ])('%s is rejected', (label, value) => {
    expect(V.parseWardId(value)).toEqual(bad(MSG.wardId));
  });

  test('a supplied-but-invalid value is never reported as "not supplied"', () => {
    ['abc', '0', '-3', '2.9', '7abc', '', ' ', '   ', '\t', '\n', 1e21, [], {}, true, false].forEach((value) => {
      const res = V.parseWardId(value);
      expect(res.ok).toBe(false);
      expect(res).not.toHaveProperty('supplied');
    });
  });
});

describe('purity', () => {
  test('validators do not mutate their input', () => {
    const body = Object.freeze({ title: '  Frozen title ', content: ' Frozen content body ', category: 'event', priority: 'high', expiresAt: '2099-01-01T00:00:00Z', days: 3 });
    expect(V.validateNoticeCreate(body, { expiry: 'expiresAt' }).ok).toBe(true);
    expect(V.validateNoticeCreate(body, { expiry: 'days' }).ok).toBe(true);
    expect(V.validateNoticeUpdate(body).ok).toBe(true);
    expect(body.title).toBe('  Frozen title ');
  });

  test('exported lists cannot be modified', () => {
    expect(() => { 'use strict'; V.NOTICE_CATEGORIES.push('health'); }).toThrow();
    expect(() => { 'use strict'; V.NOTICE_PRIORITIES.push('urgent'); }).toThrow();
    expect(V.NOTICE_CATEGORIES.includes('health')).toBe(false);
  });

  test('the module has no side effects on require (no database or Express loaded)', () => {
    const loaded = Object.keys(require.cache).filter((f) => /[\\/](pg|express)[\\/]/.test(f));
    // Other test files in the same worker may have loaded express; this module must not
    // be the reason. Its own source must not require either.
    const src = require('fs').readFileSync(require.resolve('../lib/notice-validation'), 'utf8');
    expect(src).not.toMatch(/require\(\s*['"](express|pg)['"]\s*\)/);
    expect(src).not.toMatch(/process\.env/);
    expect(Array.isArray(loaded)).toBe(true);
  });
});
