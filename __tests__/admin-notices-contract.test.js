// ============================================
// PHASE 4B.37B: ADMIN NOTICE EDITING RELIABILITY - FRONTEND CONTRACT TESTS
// Jest (same runner as __tests__/notices.test.js and notice-xss.test.js). No jsdom, no extra
// packages: the inline script of public/admin-notices.html is loaded into a node:vm context
// together with a tiny fake DOM and a recording fetch(), then driven through the real page code
// (editNotice, handleSubmit, openDeleteModal, the delegated Edit / Delete click handler).
//
// WHAT THIS PROVES (mocked-DOM tests, NOT a browser):
//   S1  editing a notice keeps its expiry: the field is pre-filled in LOCAL time, an unrelated
//       edit leaves expiresAt out of the request (the server then keeps the stored value),
//       emptying the field sends null, a new value is sent as the right instant
//   S2  Edit / Delete find the notice whether its id is a number (SERIAL) or a string (UUID),
//       and an unknown id is ignored instead of throwing
// WHAT IT DOES NOT PROVE: real browser behaviour, the real API, or the production id type.
//
// TIME ZONES: the zone-dependent tests run the page with a Date whose LOCAL getters and local
// parsing simulate a fixed offset (UTC, Africa/Nairobi +03:00, America/Los_Angeles -08:00,
// Asia/Kathmandu +05:45, Pacific/Kiritimati +14:00). They do not depend on the TZ of the machine,
// so they behave the same on Windows, macOS and Linux. One extra test uses the machine's own
// Date, so the whole file can also be run as
//     TZ=Africa/Nairobi npx jest __tests__/admin-notices-contract.test.js        (bash)
//     $env:TZ='Africa/Nairobi'; npx jest __tests__/admin-notices-contract.test.js (PowerShell)
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
// Simulated time zones
// ─────────────────────────────────────────
const LOCAL_FIELD = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;   // what a datetime-local field holds

// offsetMin = minutes EAST of UTC. A string like "2026-10-16T16:10" (no zone) is LOCAL wall-clock
// time in that zone, exactly as the browser reads a datetime-local value; ISO strings with a Z
// are parsed as usual; the local getters read the wall clock of the simulated zone.
function makeZonedDate(offsetMin) {
    const Real = Date;
    const shifted = d => new Real(d.getTime() + offsetMin * 60000);
    return class ZonedDate extends Real {
        constructor(...args) {
            if (args.length === 1 && typeof args[0] === 'string' && LOCAL_FIELD.test(args[0])) {
                super(Real.parse(args[0] + ':00.000Z') - offsetMin * 60000);
            } else {
                super(...args);
            }
        }
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
const NAIROBI = ZONES[1];

// Independent of the page code: the wall-clock text of an instant in a zone, and the instant of a wall-clock text.
const wallClock = (iso, min) => new Date(Date.parse(iso) + min * 60000).toISOString().slice(0, 16);
const instantOf = (local, min) => new Date(Date.parse(local + ':00.000Z') - min * 60000).toISOString();

// ─────────────────────────────────────────
// Fake DOM + recording fetch
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

const FORM_DEFAULTS = { title: '', content: '', category: 'general', priority: 'normal', expiresAt: '' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = v => JSON.parse(JSON.stringify(v));

// notices: what GET /api/admin/notices will return (and what the page already lists).
function loadAdminPage({ zone, notices = [] } = {}) {
    const nodes = {};
    const node = id => {
        if (!nodes[id]) {
            nodes[id] = new FakeNode(id);
            if (Object.prototype.hasOwnProperty.call(FORM_DEFAULTS, id)) nodes[id].value = FORM_DEFAULTS[id];
        }
        return nodes[id];
    };
    node('noticeForm').reset = () => Object.keys(FORM_DEFAULTS).forEach(k => { node(k).value = FORM_DEFAULTS[k]; });

    const requests = [];
    const serverNotices = clone(notices);
    const fetchStub = (url, opts = {}) => {
        const method = opts.method || 'GET';
        requests.push({ method, url, raw: opts.body, body: opts.body ? JSON.parse(opts.body) : undefined });
        const payload = method === 'GET' && url === '/api/admin/notices'
            ? { success: true, data: { notices: serverNotices } }
            : { success: true };
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(payload) });
    };

    const sandbox = {
        console, URLSearchParams, Number, String, Object, JSON, Math,
        Date: zone ? makeZonedDate(zone.min) : Date,
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
    sandbox.__seed = clone(notices);
    vm.runInContext('state.notices = __seed;', sandbox);

    const run = code => vm.runInContext(code, sandbox);
    const writes = () => requests.filter(r => r.method !== 'GET');

    // The delegated click handler of the real page, fed a button whose data-notice-id is a STRING,
    // exactly as getAttribute() returns it in a browser.
    const clickRowButton = (action, id) => {
        const listener = node('noticesContainer').listeners.click[0];
        const attrs = { 'data-notice-action': action, 'data-notice-id': String(id) };
        const btn = { getAttribute: k => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null) };
        listener({ target: { closest: sel => (sel === 'button[data-notice-action]' ? btn : null) } });
    };

    // Type into the form (only the given fields), submit it, return the write request that was made.
    const submit = async fields => {
        Object.keys(fields || {}).forEach(k => { node(k).value = fields[k]; });
        const before = writes().length;
        await run('handleSubmit({ preventDefault() {} })');
        await flush();
        const made = writes().slice(before);
        return made[made.length - 1];
    };

    return { sandbox, node, run, requests, writes, clickRowButton, submit, state: () => run('state') };
}

// ─────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────
const UUID_A = '3f2b8c1e-9d4a-4e0b-8a57-6c1d2e9f0a11';
const UUID_B = '9c1d7a52-0e4b-4f3a-b6d8-2a5e8f4c7b90';
const STORED = '2026-10-16T13:10:45.123Z';   // seconds and milliseconds on purpose: the field only has minutes

const mkNotice = over => Object.assign({
    id: UUID_A, title: 'Borehole maintenance', content: 'The borehole will be serviced on Saturday morning.',
    category: 'service', priority: 'high', created_by: 'admin', created_at: '2026-10-15T08:00:00.000Z',
    updated_at: '2026-10-15T08:00:00.000Z', expires_at: STORED, is_archived: false, ward_id: 1
}, over || {});

// ============================================
// S1 - an edit must not clear (or move) the expiry
// ============================================
describe('S1 - expiry when editing a notice', () => {

    ZONES.forEach(zone => {
        describe(zone.name, () => {

            test('Edit pre-fills the expiry in LOCAL time (not the UTC clock text)', () => {
                const page = loadAdminPage({ zone, notices: [mkNotice()] });
                page.clickRowButton('edit', UUID_A);
                expect(page.node('expiresAt').value).toBe(wallClock(STORED, zone.min));
                expect(page.node('expiresAt').value).toMatch(LOCAL_FIELD);
                if (zone.min !== 0) expect(page.node('expiresAt').value).not.toBe('2026-10-16T13:10');
                expect(page.node('title').value).toBe('Borehole maintenance');
                expect(page.node('submitBtn').textContent).toBe('Update Notice');
            });

            test('an unrelated edit leaves expiresAt OUT of the request (server preserves it)', async () => {
                const page = loadAdminPage({ zone, notices: [mkNotice()] });
                page.clickRowButton('edit', UUID_A);
                const req = await page.submit({ title: 'Borehole maintenance (rescheduled)' });
                expect(req.method).toBe('PUT');
                expect(req.url).toBe('/api/admin/notices/' + UUID_A);
                expect('expiresAt' in req.body).toBe(false);
                expect(req.raw).not.toContain('expiresAt');
                expect(req.body.title).toBe('Borehole maintenance (rescheduled)');
                expect(req.body.content).toBe('The borehole will be serviced on Saturday morning.');
                expect(req.body.category).toBe('service');
                expect(req.body.priority).toBe('high');
            });

            test('saving the pre-filled expiry untouched cannot drift it by the zone offset', async () => {
                const page = loadAdminPage({ zone, notices: [mkNotice()] });
                page.clickRowButton('edit', UUID_A);
                const field = page.node('expiresAt').value;
                // field -> instant is the inverse of instant -> field (to the minute), in every zone
                expect(instantOf(field, zone.min)).toBe(STORED.slice(0, 16) + ':00.000Z');
                expect(page.run('new Date(' + JSON.stringify(field) + ').toISOString()')).toBe(STORED.slice(0, 16) + ':00.000Z');
                const req = await page.submit({});
                expect('expiresAt' in req.body).toBe(false);   // nothing is sent, so nothing can move
            });

            test('emptying the field sends expiresAt: null (intentional clear)', async () => {
                const page = loadAdminPage({ zone, notices: [mkNotice()] });
                page.clickRowButton('edit', UUID_A);
                const req = await page.submit({ expiresAt: '' });
                expect(req.method).toBe('PUT');
                expect('expiresAt' in req.body).toBe(true);
                expect(req.body.expiresAt).toBe(null);
            });

            test('a new expiry is sent as the correct instant', async () => {
                const page = loadAdminPage({ zone, notices: [mkNotice()] });
                page.clickRowButton('edit', UUID_A);
                const req = await page.submit({ expiresAt: '2026-11-01T09:30' });
                expect(req.body.expiresAt).toBe(instantOf('2026-11-01T09:30', zone.min));
            });

            test('a notice without an expiry: untouched save omits the key; entering one sends it', async () => {
                const page = loadAdminPage({ zone, notices: [mkNotice({ expires_at: null })] });
                page.clickRowButton('edit', UUID_A);
                expect(page.node('expiresAt').value).toBe('');
                const untouched = await page.submit({ title: 'Borehole maintenance v2' });
                expect('expiresAt' in untouched.body).toBe(false);

                page.clickRowButton('edit', UUID_A);
                const added = await page.submit({ expiresAt: '2026-12-24T18:00' });
                expect(added.body.expiresAt).toBe(instantOf('2026-12-24T18:00', zone.min));
            });

            test('creating a notice: empty expiry still sends null, a chosen expiry is sent as an instant', async () => {
                const page = loadAdminPage({ zone, notices: [] });
                const none = await page.submit({ title: 'Clinic outreach day', content: 'Free screening at the chief camp on Monday.' });
                expect(none.method).toBe('POST');
                expect(none.url).toBe('/api/admin/notices');
                expect('expiresAt' in none.body).toBe(true);
                expect(none.body.expiresAt).toBe(null);

                const some = await page.submit({ title: 'Clinic outreach day', content: 'Free screening at the chief camp on Monday.', expiresAt: '2026-11-01T09:30' });
                expect(some.method).toBe('POST');
                expect(some.body.expiresAt).toBe(instantOf('2026-11-01T09:30', zone.min));
            });
        });
    });

    test('Edit on one notice then another: the first expiry does not carry over', async () => {
        const page = loadAdminPage({ zone: NAIROBI, notices: [mkNotice({ id: 'a' }), mkNotice({ id: 'b', title: 'Clinic outreach day', expires_at: null })] });
        page.clickRowButton('edit', 'a');
        expect(page.node('expiresAt').value).toBe(wallClock(STORED, NAIROBI.min));
        page.clickRowButton('edit', 'b');
        expect(page.node('expiresAt').value).toBe('');
        expect(page.node('title').value).toBe('Clinic outreach day');
        const req = await page.submit({ title: 'Clinic outreach day (moved)' });
        expect(req.url).toBe('/api/admin/notices/b');
        expect('expiresAt' in req.body).toBe(false);   // not 'a' expiry, not a clear
    });

    test('Cancel after Edit, then create: back to the create behaviour (expiresAt: null)', async () => {
        const page = loadAdminPage({ zone: NAIROBI, notices: [mkNotice()] });
        page.clickRowButton('edit', UUID_A);
        page.run('resetForm()');
        expect(page.state().editingId).toBe(null);
        expect(page.node('expiresAt').value).toBe('');
        const req = await page.submit({ title: 'Brand new notice', content: 'Created right after cancelling an edit.' });
        expect(req.method).toBe('POST');
        expect(req.body.expiresAt).toBe(null);
    });

    test('a stored expiry that is not a valid date leaves the field empty and is preserved on save', async () => {
        const page = loadAdminPage({ zone: NAIROBI, notices: [mkNotice({ expires_at: 'not a date' })] });
        page.clickRowButton('edit', UUID_A);
        expect(page.node('expiresAt').value).toBe('');
        const req = await page.submit({ title: 'Borehole maintenance v2' });
        expect('expiresAt' in req.body).toBe(false);
    });

    test('the machine\'s own Date (run with TZ=Africa/Nairobi to see it): prefill and a deliberate change round-trip', async () => {
        const page = loadAdminPage({ notices: [mkNotice()] });
        page.clickRowButton('edit', UUID_A);
        const field = page.node('expiresAt').value;
        expect(field).toMatch(LOCAL_FIELD);
        // the field text, read back as local time, is the stored instant to the minute
        expect(page.run('new Date(' + JSON.stringify(field) + ').toISOString()')).toBe(STORED.slice(0, 16) + ':00.000Z');
        const untouched = await page.submit({});
        expect('expiresAt' in untouched.body).toBe(false);
        page.clickRowButton('edit', UUID_A);
        const changed = await page.submit({ expiresAt: field.slice(0, 15) + (field.endsWith('0') ? '5' : '0') });
        expect(typeof changed.body.expiresAt).toBe('string');
    });
});

// ============================================
// S2 - Edit / Delete find the notice for numeric and string ids
// ============================================
describe('S2 - notice id lookup', () => {

    const NUMERIC = [mkNotice({ id: 1, title: 'First notice here' }), mkNotice({ id: 11, title: 'Eleventh notice' }), mkNotice({ id: 12, title: 'Twelfth notice' })];
    const UUIDS = [mkNotice({ id: UUID_A, title: 'Notice with uuid A' }), mkNotice({ id: UUID_B, title: 'Notice with uuid B' })];

    test('numeric database id + string attribute id: Edit selects exactly that notice', async () => {
        const page = loadAdminPage({ zone: NAIROBI, notices: NUMERIC });
        page.clickRowButton('edit', 12);
        expect(page.node('title').value).toBe('Twelfth notice');
        expect(page.state().editingId).toBe('12');
        const req = await page.submit({ title: 'Twelfth notice (edited)' });
        expect(req.method).toBe('PUT');
        expect(req.url).toBe('/api/admin/notices/12');
    });

    test('numeric ids that share digits are not confused (1, 11, 12)', () => {
        const page = loadAdminPage({ notices: NUMERIC });
        page.clickRowButton('edit', 1);
        expect(page.node('title').value).toBe('First notice here');
        page.clickRowButton('edit', 11);
        expect(page.node('title').value).toBe('Eleventh notice');
    });

    test('numeric database id: Delete opens the confirmation for that notice and sends that id', async () => {
        const page = loadAdminPage({ notices: NUMERIC });
        page.clickRowButton('delete', 11);
        expect(page.node('deleteNoticeTitle').textContent).toBe('Eleventh notice');
        expect(page.node('deleteModal').classList.contains('show')).toBe(true);
        expect(page.state().deleteId).toBe('11');
        page.run('confirmDelete()');
        await flush();
        const del = page.writes()[0];
        expect(del.method).toBe('DELETE');
        expect(del.url).toBe('/api/admin/notices/11');
    });

    test('UUID database id + string attribute id: Edit and Delete still work', async () => {
        const page = loadAdminPage({ notices: UUIDS });
        page.clickRowButton('edit', UUID_B);
        expect(page.node('title').value).toBe('Notice with uuid B');
        expect(page.state().editingId).toBe(UUID_B);
        const put = await page.submit({ title: 'Notice with uuid B (edited)' });
        expect(put.url).toBe('/api/admin/notices/' + UUID_B);

        page.clickRowButton('delete', UUID_A);
        expect(page.node('deleteNoticeTitle').textContent).toBe('Notice with uuid A');
        page.run('confirmDelete()');
        await flush();
        const del = page.writes().filter(r => r.method === 'DELETE')[0];
        expect(del.url).toBe('/api/admin/notices/' + UUID_A);
    });

    test('an id that matches no notice: Edit does nothing and does not throw', () => {
        const page = loadAdminPage({ notices: NUMERIC });
        page.node('title').value = 'untouched';
        let error = null;
        try { page.clickRowButton('edit', 999); } catch (e) { error = e; }
        expect(error).toBe(null);
        expect(page.state().editingId).toBe(null);
        expect(page.node('title').value).toBe('untouched');
        expect(page.node('submitBtn').textContent).toBe('');
    });

    test('an id that matches no notice: Delete does not throw and opens nothing', () => {
        const page = loadAdminPage({ notices: UUIDS });
        let error = null;
        try { page.clickRowButton('delete', 'no-such-id'); } catch (e) { error = e; }
        expect(error).toBe(null);
        expect(page.node('deleteModal').classList.contains('show')).toBe(false);
        expect(page.state().deleteId).toBe(null);
        expect(page.writes().length).toBe(0);
    });

    test('an empty notice list: Edit and Delete are ignored', () => {
        const page = loadAdminPage({ notices: [] });
        page.clickRowButton('edit', 1);
        page.clickRowButton('delete', 1);
        expect(page.state().editingId).toBe(null);
        expect(page.state().deleteId).toBe(null);
    });
});

// ============================================
// Static guards: the two defects must not come back in their original form
// ============================================
describe('Static source guards (admin-notices.html)', () => {
    test('no strict n.id === id lookup against a string attribute id', () => {
        expect(/n\.id\s*===\s*id/.test(pageHtml())).toBe(false);
    });

    test('the UTC clock text is never copied into the local datetime-local field', () => {
        expect(/toISOString\(\)\s*\.slice\(\s*0\s*,\s*16\s*\)/.test(pageHtml())).toBe(false);
    });
});
