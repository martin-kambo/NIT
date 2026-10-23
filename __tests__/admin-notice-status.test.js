// ============================================
// PHASE 4B.38B: ADMIN NOTICE LIST - ARCHIVED BADGE AND EXPIRY LINE
// Jest (same runner as __tests__/notices.test.js, notice-xss.test.js and admin-notices-contract.test.js).
// No jsdom, no extra packages: the inline script of public/admin-notices.html is loaded into a node:vm
// context with a tiny fake DOM and a stub fetch(), then driven through the real page code
// (loadNotices -> renderNotices). The rows are BACKEND-SHAPED: GET /api/admin/notices is
// `SELECT n.* FROM notices n ...` (routes/notices.js), so a row has `is_archived` (boolean, nullable)
// and `expires_at` (ISO string or null) and never `isArchived`.
//
// WHAT THIS PROVES (mocked-DOM tests, NOT a browser):
//   - a notice shows "Archived" only when is_archived === true (false, null, missing and any
//     non-boolean value show nothing; the frontend-shaped isArchived is ignored)
//   - a notice with a valid expires_at shows one "Expires YYYY-MM-DD HH:mm" line in LOCAL time;
//     null, missing, empty, invalid and non-string values show no line
//   - the two combine independently, and hostile database text stays inert
// WHAT IT DOES NOT PROVE: any "expired" or "approaching expiry" status (deliberately NOT implemented in
// this phase: the production PostgreSQL and Node time zones are unverified), the real API, a real
// browser, or the production time zone. The line only displays the stored value.
//
// TIME ZONES: zone-dependent tests run the page with a Date whose LOCAL getters simulate a fixed offset,
// so they behave the same on Windows, macOS and Linux whatever the machine's TZ. One test uses the
// machine's own Date; the whole file can also be run as
//     TZ=Africa/Nairobi npx jest __tests__/admin-notice-status.test.js         (bash)
//     $env:TZ='Africa/Nairobi'; npx jest __tests__/admin-notice-status.test.js  (PowerShell)
//
// NIT_PUBLIC_DIR may point at another copy of public/ (used to confirm these tests FAIL on the
// pre-fix page).
// ============================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = process.env.NIT_PUBLIC_DIR || path.join(__dirname, '..', 'public');
const pageHtml = () => fs.readFileSync(path.join(PUBLIC, 'admin-notices.html'), 'utf8');

function inlineScript() {
    const blocks = [...pageHtml().matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    if (!blocks.length) throw new Error('no inline script in admin-notices.html');
    return blocks[blocks.length - 1];
}

// ─────────────────────────────────────────
// Simulated time zones (and an optional fixed "now")
// ─────────────────────────────────────────
const LOCAL_FIELD = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;

// offsetMin = minutes EAST of UTC. The local getters read the wall clock of the simulated zone; a string
// without a zone such as "2026-10-16T16:10" is LOCAL time in that zone; strings with a Z or an offset
// parse as usual. fixedNow (optional) pins Date.now() and new Date().
function makeZonedDate(offsetMin, fixedNow) {
    const Real = Date;
    const shifted = d => new Real(d.getTime() + offsetMin * 60000);
    return class ZonedDate extends Real {
        constructor(...args) {
            if (args.length === 0 && fixedNow !== undefined) {
                super(fixedNow);
            } else if (args.length === 1 && typeof args[0] === 'string' && LOCAL_FIELD.test(args[0])) {
                super(Real.parse(args[0] + ':00.000Z') - offsetMin * 60000);
            } else {
                super(...args);
            }
        }
        static now() { return fixedNow !== undefined ? fixedNow : Real.now(); }
        getFullYear() { return shifted(this).getUTCFullYear(); }
        getMonth() { return shifted(this).getUTCMonth(); }
        getDate() { return shifted(this).getUTCDate(); }
        getHours() { return shifted(this).getUTCHours(); }
        getMinutes() { return shifted(this).getUTCMinutes(); }
        getTimezoneOffset() { return -offsetMin; }
    };
}

const ZONES = [
    { name: 'UTC', min: 0 },
    { name: 'Africa/Nairobi (UTC+03:00)', min: 180 },
    { name: 'America/Los_Angeles (UTC-08:00)', min: -480 },
    { name: 'Asia/Kathmandu (UTC+05:45)', min: 345 },
    { name: 'Pacific/Kiritimati (UTC+14:00)', min: 840 }
];
const UTC = ZONES[0];
const NAIROBI = ZONES[1];

// Independent of the page code: the wall-clock text ("YYYY-MM-DD HH:mm") of an instant in a zone.
const wallClock = (iso, min) => new Date(Date.parse(iso) + min * 60000).toISOString().slice(0, 16).replace('T', ' ');

// ─────────────────────────────────────────
// Fake DOM + stub fetch
// ─────────────────────────────────────────
class FakeNode {
    constructor(id) {
        this.id = id;
        this.value = '';
        this.style = {};
        this.listeners = {};
        this._text = '';
        this.innerHTML = '';
        const classes = new Set();
        this.classList = {
            add: c => classes.add(c), remove: c => classes.delete(c),
            toggle: (c, f) => ((f === undefined ? !classes.has(c) : f) ? classes.add(c) : classes.delete(c)),
            contains: c => classes.has(c)
        };
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = v == null ? '' : String(v); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    scrollIntoView() {}
    focus() {}
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = v => JSON.parse(JSON.stringify(v));

// notices: what GET /api/admin/notices returns, in the route's real wrapper { success, data: { notices } }.
function loadAdminPage({ zone, now, notices = [] } = {}) {
    const nodes = {};
    const node = id => (nodes[id] || (nodes[id] = new FakeNode(id)));
    const served = clone(notices);                       // goes through JSON, like a real response body
    const fetchStub = url => {
        const payload = url === '/api/admin/notices'
            ? { success: true, data: { notices: served } }
            : { success: true };
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(payload) });
    };
    const sandbox = {
        console, URLSearchParams, Number, String, Object, JSON, Math,
        Date: zone ? makeZonedDate(zone.min, now) : (now !== undefined ? makeZonedDate(0, now) : Date),
        setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {},
        fetch: fetchStub, confirm: () => false, alert: () => {},
        document: {
            getElementById: node,
            createElement: () => new FakeNode('created'),
            addEventListener: () => {},
            querySelectorAll: () => [],
            querySelector: () => node('__form-panel')
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(inlineScript(), sandbox);
    return { node, run: code => vm.runInContext(code, sandbox) };
}

// Load the notices through the page's own loadNotices() and return the list markup it rendered.
async function renderList(notices, opts) {
    const page = loadAdminPage(Object.assign({ notices }, opts || {}));
    await page.run('loadNotices()');
    await flush();
    return page.node('noticesContainer').innerHTML;
}

// ─────────────────────────────────────────
// Reading the rendered markup
// ─────────────────────────────────────────
const cards = html => html.split('<div class="notice-item">').slice(1);
const badgeTexts = card => [...card.matchAll(/<span class="badge"[^>]*>([^<]*)<\/span>/g)].map(m => m[1]);
const expiryLines = card => [...card.matchAll(/<div class="notice-expiry">([^<]*)<\/div>/g)].map(m => m[1]);
const archivedCount = card => badgeTexts(card).filter(t => t === 'Archived').length;

// ─────────────────────────────────────────
// Fixtures: backend-shaped rows (snake_case, as SELECT n.* returns them)
// ─────────────────────────────────────────
const mkNotice = over => Object.assign({
    id: 1, title: 'Borehole maintenance', content: 'The borehole will be serviced on Saturday morning.',
    category: 'service', priority: 'high', created_by: 'admin', created_at: '2026-10-15T08:00:00.000Z',
    updated_at: '2026-10-15T08:00:00.000Z', expires_at: null, is_archived: false, ward_id: 1
}, over || {});
const without = (row, key) => { const copy = Object.assign({}, row); delete copy[key]; return copy; };

// ============================================
// Archived badge
// ============================================
describe('Archived badge reads the backend property is_archived', () => {

    test('is_archived: true shows exactly one Archived badge', async () => {
        const html = await renderList([mkNotice({ is_archived: true })]);
        expect(cards(html)).toHaveLength(1);
        expect(archivedCount(cards(html)[0])).toBe(1);
    });

    test('is_archived: false shows no Archived badge', async () => {
        const html = await renderList([mkNotice({ is_archived: false })]);
        expect(archivedCount(cards(html)[0])).toBe(0);
        expect(html).not.toContain('Archived');
    });

    test('is_archived: null shows no Archived badge (as COALESCE(is_archived,false) in the public feed)', async () => {
        const html = await renderList([mkNotice({ is_archived: null })]);
        expect(archivedCount(cards(html)[0])).toBe(0);
        expect(html).not.toContain('Archived');
    });

    test('a missing is_archived property shows no Archived badge', async () => {
        const html = await renderList([without(mkNotice(), 'is_archived')]);
        expect(archivedCount(cards(html)[0])).toBe(0);
        expect(html).not.toContain('Archived');
    });

    test('unexpected non-boolean values never show Archived', async () => {
        const values = ['true', 't', 'TRUE', '1', 'yes', 'false', '', 'Archived', 0, 1, 2, -1, {}, [], [true]];
        const html = await renderList(values.map((v, i) => mkNotice({ id: i + 1, is_archived: v })));
        const list = cards(html);
        expect(list).toHaveLength(values.length);
        list.forEach((card, i) => {
            expect(`${JSON.stringify(values[i])} -> ${archivedCount(card)}`).toBe(`${JSON.stringify(values[i])} -> 0`);
        });
    });

    test('the frontend-shaped isArchived (a property the API never sends) is ignored', async () => {
        const html = await renderList([
            mkNotice({ id: 1, isArchived: true, is_archived: false }),
            mkNotice({ id: 2, isArchived: true }),
            without(mkNotice({ id: 3, isArchived: true }), 'is_archived')
        ]);
        cards(html).forEach(card => expect(archivedCount(card)).toBe(0));
    });

    test('in a mixed list only the archived notice carries the badge', async () => {
        const html = await renderList([
            mkNotice({ id: 1, title: 'First', is_archived: false }),
            mkNotice({ id: 2, title: 'Second', is_archived: true }),
            mkNotice({ id: 3, title: 'Third', is_archived: null })
        ]);
        const list = cards(html);
        expect(list).toHaveLength(3);
        expect(list.map(archivedCount)).toEqual([0, 1, 0]);
        expect(list[1]).toContain('Second');
    });

    test('category and priority badges and the Edit / Delete buttons are unchanged', async () => {
        const html = await renderList([
            mkNotice({ id: 7, is_archived: true }),
            mkNotice({ id: 8, is_archived: false, category: 'public', priority: 'low' })
        ]);
        const [a, b] = cards(html);
        expect(badgeTexts(a)).toEqual(['service', 'high', 'Archived']);
        expect(badgeTexts(b)).toEqual(['public', 'low']);
        expect(a).toContain('data-notice-action="edit" data-notice-id="7"');
        expect(a).toContain('data-notice-action="delete" data-notice-id="7"');
        expect(b).toContain('data-notice-action="edit" data-notice-id="8"');
        expect(a).toContain('<h3>Borehole maintenance</h3>');
    });

    test('the page code no longer reads the property isArchived (comments may still name it)', () => {
        expect(pageHtml()).not.toMatch(/\.\s*isArchived\b|\[\s*['"]isArchived['"]\s*\]/);
    });
});

// ============================================
// Expiry line
// ============================================
describe('expiry line for notices with a valid expires_at', () => {

    const INSTANTS = [
        '2026-10-16T13:10:45.123Z',   // seconds and milliseconds are dropped, not rounded
        '2026-10-16T22:30:00.000Z',   // crosses midnight in the zones east of UTC
        '2026-12-31T23:30:00.000Z',   // crosses the year boundary in the zones east of UTC
        '2026-03-01T00:00:00.000Z',
        '2099-12-31T20:59:00.000Z'
    ];

    ZONES.forEach(zone => {
        test(`${zone.name}: the line shows the stored instant as local "Expires YYYY-MM-DD HH:mm"`, async () => {
            const html = await renderList(INSTANTS.map((iso, i) => mkNotice({ id: i + 1, expires_at: iso })), { zone });
            const list = cards(html);
            expect(list).toHaveLength(INSTANTS.length);
            list.forEach((card, i) => {
                expect(expiryLines(card)).toEqual(['Expires ' + wallClock(INSTANTS[i], zone.min)]);
            });
        });
    });

    test('the documented example: 12:00Z is "Expires 2026-10-17 15:00" in Nairobi and 12:00 in UTC', async () => {
        const row = mkNotice({ expires_at: '2026-10-17T12:00:00.000Z' });
        expect(expiryLines(cards(await renderList([row], { zone: NAIROBI }))[0])).toEqual(['Expires 2026-10-17 15:00']);
        expect(expiryLines(cards(await renderList([row], { zone: UTC }))[0])).toEqual(['Expires 2026-10-17 12:00']);
    });

    test('an ISO string with an explicit offset is converted to the local clock', async () => {
        const row = mkNotice({ expires_at: '2026-10-17T15:00:00+03:00' });
        expect(expiryLines(cards(await renderList([row], { zone: UTC }))[0])).toEqual(['Expires 2026-10-17 12:00']);
        expect(expiryLines(cards(await renderList([row], { zone: NAIROBI }))[0])).toEqual(['Expires 2026-10-17 15:00']);
    });

    test('seconds are truncated, never rounded up to the next minute', async () => {
        const row = mkNotice({ expires_at: '2026-10-16T13:10:59.999Z' });
        expect(expiryLines(cards(await renderList([row], { zone: UTC }))[0])).toEqual(['Expires 2026-10-16 13:10']);
    });

    test('a far-future and a past expiry are displayed in exactly the same way (nothing is compared with now)', async () => {
        const html = await renderList([
            mkNotice({ id: 1, expires_at: '2099-12-31T20:59:00.000Z' }),
            mkNotice({ id: 2, expires_at: '2001-01-31T18:00:00.000Z' })
        ], { zone: UTC });
        expect(cards(html).map(c => expiryLines(c))).toEqual([['Expires 2099-12-31 20:59'], ['Expires 2001-01-31 18:00']]);
    });

    test('the markup does not depend on the current time', async () => {
        const rows = [
            mkNotice({ id: 1, expires_at: '2026-10-17T12:00:00.000Z' }),
            mkNotice({ id: 2, expires_at: '2026-10-17T12:00:00.000Z', is_archived: true }),
            mkNotice({ id: 3, expires_at: null })
        ];
        const early = await renderList(rows, { zone: NAIROBI, now: Date.parse('2000-01-01T00:00:00Z') });
        const atExpiry = await renderList(rows, { zone: NAIROBI, now: Date.parse('2026-10-17T12:00:00Z') });
        const late = await renderList(rows, { zone: NAIROBI, now: Date.parse('2090-01-01T00:00:00Z') });
        expect(atExpiry).toBe(early);
        expect(late).toBe(early);
    });

    test('each card shows its own expiry, and the same input always gives the same markup', async () => {
        const rows = [
            mkNotice({ id: 1, title: 'Alpha', expires_at: '2026-11-01T06:00:00.000Z' }),
            mkNotice({ id: 2, title: 'Beta', expires_at: null }),
            mkNotice({ id: 3, title: 'Gamma', expires_at: '2026-11-03T18:15:00.000Z' })
        ];
        const first = await renderList(rows, { zone: NAIROBI });
        const second = await renderList(rows, { zone: NAIROBI });
        expect(second).toBe(first);
        const list = cards(first);
        expect(list.map(c => expiryLines(c))).toEqual([['Expires 2026-11-01 09:00'], [], ['Expires 2026-11-03 21:15']]);
        expect(list[0]).toContain('Alpha');
        expect(list[2]).toContain('Gamma');
    });

    test('the line sits under the badges inside the notice info, once, and not in the actions', async () => {
        const html = await renderList([mkNotice({ expires_at: '2026-10-17T12:00:00.000Z' })], { zone: UTC });
        const card = cards(html)[0];
        expect(expiryLines(card)).toHaveLength(1);
        const at = s => card.indexOf(s);
        expect(at('<h3>')).toBeGreaterThan(-1);
        expect(at('notice-badges')).toBeGreaterThan(at('<h3>'));
        expect(at('notice-expiry')).toBeGreaterThan(at('notice-badges'));
        expect(at('notice-actions')).toBeGreaterThan(at('notice-expiry'));
    });

    test('with the machine time zone the line is the local time of the stored instant (round trip)', async () => {
        const instants = ['2026-01-15T09:30:00.000Z', '2026-07-15T21:45:00.000Z'];
        const html = await renderList(instants.map((iso, i) => mkNotice({ id: i + 1, expires_at: iso })));
        cards(html).forEach((card, i) => {
            const m = (expiryLines(card)[0] || '').match(/^Expires (\d{4}-\d\d-\d\d) (\d\d:\d\d)$/);
            expect(m).toBeTruthy();
            // "YYYY-MM-DDTHH:mm" without a zone is parsed as LOCAL time, so this reads the line back as the instant it names.
            expect(new Date(m[1] + 'T' + m[2]).getTime()).toBe(Math.floor(Date.parse(instants[i]) / 60000) * 60000);
        });
    });
});

describe('no expiry line when there is no valid expiry', () => {

    test('a missing expires_at and a null expires_at show no line', async () => {
        const html = await renderList([without(mkNotice(), 'expires_at'), mkNotice({ id: 2, expires_at: null })]);
        cards(html).forEach(card => expect(expiryLines(card)).toEqual([]));
        expect(html).not.toContain('Expires');
        expect(html).not.toContain('notice-expiry');
    });

    test('empty, blank, invalid and non-string values show no line and do not break rendering', async () => {
        const values = [
            '', '   ', 'not-a-date', 'NaN', 'null', 'undefined', '0000-00-00', '2026-13-45T99:99:99Z',
            0, 1760000000000, true, false, {}, [], ['2026-10-17T12:00:00.000Z']
        ];
        const html = await renderList(values.map((v, i) => mkNotice({ id: i + 1, expires_at: v })), { zone: NAIROBI });
        const list = cards(html);
        expect(list).toHaveLength(values.length);       // every notice still rendered
        list.forEach((card, i) => {
            expect(`${JSON.stringify(values[i])} -> ${expiryLines(card).length}`).toBe(`${JSON.stringify(values[i])} -> 0`);
        });
        expect(html).not.toContain('Invalid Date');
        expect(html).not.toContain('NaN');
        expect(html).not.toContain('1970');
    });

    test('the other card content is still rendered when the expiry is bad', async () => {
        const html = await renderList([mkNotice({ expires_at: 'not-a-date', is_archived: true })]);
        const card = cards(html)[0];
        expect(card).toContain('<h3>Borehole maintenance</h3>');
        expect(badgeTexts(card)).toEqual(['service', 'high', 'Archived']);
    });
});

// ============================================
// Combined states
// ============================================
describe('archive status and expiry line are independent', () => {

    test('an archived notice with a valid expiry shows both Archived and the expiry line', async () => {
        const html = await renderList([mkNotice({ is_archived: true, expires_at: '2026-10-17T12:00:00.000Z' })], { zone: NAIROBI });
        const card = cards(html)[0];
        expect(archivedCount(card)).toBe(1);
        expect(expiryLines(card)).toEqual(['Expires 2026-10-17 15:00']);
    });

    test('a non-archived notice with a valid expiry shows the line without Archived', async () => {
        const html = await renderList([mkNotice({ is_archived: false, expires_at: '2026-10-17T12:00:00.000Z' })], { zone: NAIROBI });
        const card = cards(html)[0];
        expect(archivedCount(card)).toBe(0);
        expect(expiryLines(card)).toEqual(['Expires 2026-10-17 15:00']);
    });

    test('an archived notice without an expiry shows Archived and no line', async () => {
        const html = await renderList([mkNotice({ is_archived: true, expires_at: null })]);
        const card = cards(html)[0];
        expect(archivedCount(card)).toBe(1);
        expect(expiryLines(card)).toEqual([]);
    });
});

// ============================================
// Security: database text is untrusted
// ============================================
describe('hostile database text stays inert', () => {

    const HOSTILE = [
        '<img src=x onerror=alert(1)>',
        '"><script>alert(1)</script>',
        '\' onmouseover=\'alert(1)',
        'javascript:alert(1)',
        '</div><div class="notice-expiry">Expires 1999-01-01 00:00</div>',
        '<span class="badge" style="background:red">Archived</span>'
    ];
    const ALLOWED_TAGS = ['div', 'h3', 'p', 'span', 'button'];

    // Every opening tag may carry only quoted attributes: an injected attribute would leave a bare "name=" behind.
    function assertOnlyKnownMarkup(html) {
        const names = [...html.matchAll(/<\s*([a-zA-Z][\w-]*)/g)].map(m => m[1].toLowerCase());
        names.forEach(n => expect(ALLOWED_TAGS).toContain(n));
        [...html.matchAll(/<[a-zA-Z][^>]*>/g)].forEach(m => {
            const bare = m[0].replace(/\s[a-zA-Z-]+="[^"]*"/g, '');
            expect(bare).toMatch(/^<[a-z0-9]+\s*>$/);
        });
    }

    test('hostile title, content, category, priority and id are escaped on cards with a badge and an expiry line', async () => {
        const rows = HOSTILE.map((h, i) => mkNotice({
            id: i === 0 ? h : i + 1, title: h, content: h + ' padding to be long enough', category: h, priority: h,
            is_archived: i % 2 === 0, expires_at: '2026-10-17T12:00:00.000Z'
        }));
        const html = await renderList(rows, { zone: NAIROBI });
        const list = cards(html);
        expect(list).toHaveLength(HOSTILE.length);
        assertOnlyKnownMarkup(html);
        // A forged expiry line or badge inside the text must not become a real element: the counts of real
        // elements stay exactly the true ones (the forged text itself is shown, escaped, as plain text).
        list.forEach((card, i) => {
            expect(expiryLines(card)).toEqual(['Expires 2026-10-17 15:00']);
            expect(archivedCount(card)).toBe(i % 2 === 0 ? 1 : 0);
        });
        expect(list[4]).toContain('&lt;/div&gt;&lt;div class=&quot;notice-expiry&quot;&gt;Expires 1999-01-01 00:00&lt;/div&gt;');
    });

    test('a hostile expires_at is never echoed: it gives no line or a line of digits only', async () => {
        const values = [
            '<img src=x onerror=alert(1)>',
            '"><script>alert(1)</script>',
            '2026-10-17 12:00 (<script>alert(1)</script>)',
            '2026-10-17T12:00:00.000Z<script>alert(1)</script>'
        ];
        const html = await renderList(values.map((v, i) => mkNotice({ id: i + 1, expires_at: v })), { zone: UTC });
        assertOnlyKnownMarkup(html);
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        cards(html).forEach(card => {
            expiryLines(card).forEach(line => expect(line).toMatch(/^Expires \d{4}-\d\d-\d\d \d\d:\d\d$/));
        });
    });

    test('a hostile non-boolean is_archived shows no badge', async () => {
        const html = await renderList(HOSTILE.map((h, i) => mkNotice({ id: i + 1, is_archived: h })));
        assertOnlyKnownMarkup(html);
        cards(html).forEach(card => expect(archivedCount(card)).toBe(0));
    });
});
