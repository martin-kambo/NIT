'use strict';

// ============================================
// PHASE 4B.42: ADMIN NOTICE FORM - SCOPE SELECTORS - FRONTEND CONTRACT TESTS
// Same technique as __tests__/admin-notices-contract.test.js: the inline script of
// public/admin-notices.html is loaded into a node:vm context with a tiny fake DOM and a
// recording fetch(), then driven through the real page code. No jsdom, no extra packages.
// The fake <select> parses the <option> markup the page writes into innerHTML, so the
// options a person would see can be asserted.
//
// WHAT THIS PROVES (mocked DOM, NOT a browser):
//   * the form offers only the scope levels GET /api/admin/notice-scope-options returned
//   * county > constituency > ward cascade from the public geography endpoints; changing a
//     parent discards the children; no invalid combination can be submitted from the form
//   * a ward / constituency / county administrator's own area is the only choice, locked
//   * a MODERATOR (no levels), a failed options load and a still-loading page cannot submit
//   * a create request carries scopeLevel and only that level's id; an edit carries no scope
//   * every notice card says where the notice is published; names are escaped
// WHAT IT DOES NOT PROVE: real browser rendering (see the Playwright run in the evidence
// folder), real API behaviour, or authorization (the server is authoritative; see
// __tests__/notice-scope.test.js).
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

const unescapeHtml = t => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

class FakeNode {
    constructor(id) {
        this.id = id;
        this.value = '';
        this.style = {};
        this.disabled = false;
        this.listeners = {};
        this.options = [];
        this._text = '';
        this._html = '';
        const classes = new Set();
        this.classList = {
            add: c => classes.add(c), remove: c => classes.delete(c),
            toggle: (c, f) => ((f === undefined ? !classes.has(c) : f) ? classes.add(c) : classes.delete(c)),
            contains: c => classes.has(c)
        };
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = v == null ? '' : String(v); }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
        this._html = String(v);
        // what a <select> would hold after the markup is parsed
        this.options = [...this._html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)]
            .map(m => ({ value: unescapeHtml(m[1]), label: unescapeHtml(m[2]) }));
        this.value = this.options.length ? this.options[0].value : '';
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    scrollIntoView() {}
    focus() {}
}

const FORM_DEFAULTS = { title: '', content: '', category: 'general', priority: 'normal', expiresAt: '' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 8; i++) await flush(); };
const clone = v => JSON.parse(JSON.stringify(v));

// Public geography the fake server serves (county 5 Kiambu > Thika Town 7 > ward 10 Ngoliba ...).
const GEO = {
    counties: [{ id: 5, name: 'Kiambu' }, { id: 6, name: 'Nairobi' }],
    constituencies: [
        { id: 7, county_id: 5, name: 'Thika Town' }, { id: 8, county_id: 5, name: 'Juja' }, { id: 9, county_id: 6, name: 'Westlands' }
    ],
    wards: [
        { id: 10, constituency_id: 7, name: 'Ngoliba' }, { id: 11, constituency_id: 7, name: 'Biashara' },
        { id: 1, constituency_id: 8, name: 'Ngoliba' }, { id: 13, constituency_id: 9, name: 'Parklands' }
    ]
};

const SUPER = { role: 'SUPER_ADMIN', levels: ['PLATFORM', 'COUNTY', 'CONSTITUENCY', 'WARD'], assignment: { county: null, constituency: null, ward: null } };
const WARD_ADMIN = {
    role: 'WARD_ADMIN', levels: ['WARD'],
    assignment: { county: { id: 5, name: 'Kiambu' }, constituency: { id: 7, name: 'Thika Town' }, ward: { id: 10, name: 'Ngoliba' } }
};
const CONSTITUENCY_ADMIN = {
    role: 'CONSTITUENCY_ADMIN', levels: ['CONSTITUENCY'],
    assignment: { county: { id: 5, name: 'Kiambu' }, constituency: { id: 7, name: 'Thika Town' }, ward: null }
};
const COUNTY_ADMIN = { role: 'COUNTY_ADMIN', levels: ['COUNTY'], assignment: { county: { id: 5, name: 'Kiambu' }, constituency: null, ward: null } };
const MODERATOR = { role: 'MODERATOR', levels: [], assignment: { county: null, constituency: null, ward: null } };

// options: what GET /api/admin/notice-scope-options answers ({ data } | { fail: true } | { hang: true }),
// hook: (url) => promise | undefined, lets a test hold a geography response back.
function loadAdminPage({ options = SUPER, notices = [], hook } = {}) {
    const nodes = {};
    const node = id => {
        if (!nodes[id]) {
            nodes[id] = new FakeNode(id);
            if (Object.prototype.hasOwnProperty.call(FORM_DEFAULTS, id)) nodes[id].value = FORM_DEFAULTS[id];
        }
        return nodes[id];
    };
    node('noticeForm').reset = () => {
        Object.keys(FORM_DEFAULTS).forEach(k => { node(k).value = FORM_DEFAULTS[k]; });
        // a browser puts every <select> back on its first <option>
        Object.keys(nodes).forEach(id => { if (nodes[id].options.length) nodes[id].value = nodes[id].options[0].value; });
    };

    const requests = [];
    const respond = payload => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(payload) });
    const fetchStub = (url, opts = {}) => {
        const method = opts.method || 'GET';
        requests.push({ method, url, credentials: opts.credentials, body: opts.body ? JSON.parse(opts.body) : undefined });
        const held = hook && hook(url);
        const serve = () => {
            if (method !== 'GET') return respond({ success: true });
            if (url === '/api/admin/notices') return respond({ success: true, data: { notices: clone(notices) } });
            if (url === '/api/admin/notice-scope-options') {
                if (options.hang) return new Promise(() => {});
                if (options.fail) return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({ success: false, error: 'Internal server error' }) });
                return respond({ success: true, data: clone(options) });
            }
            if (url === '/api/counties') return respond({ success: true, counties: clone(GEO.counties) });
            let m = /^\/api\/constituencies\?county_id=(\d+)$/.exec(url);
            if (m) return respond({ success: true, constituencies: clone(GEO.constituencies.filter(c => c.county_id === Number(m[1]))) });
            m = /^\/api\/wards\?constituency_id=(\d+)$/.exec(url);
            if (m) return respond({ success: true, wards: clone(GEO.wards.filter(w => w.constituency_id === Number(m[1]))) });
            return respond({ success: true });
        };
        return held ? held.then(serve) : serve();
    };

    const sandbox = {
        console, URLSearchParams, Number, String, Object, JSON, Math, Date,
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
    const geoUrls = () => requests.map(r => r.url).filter(u => /^\/api\/(counties|constituencies|wards)/.test(u));
    const alertText = () => node('adminAlert').textContent;

    const signIn = async () => { run('loadScopeOptions()'); await settle(); };
    const choose = async (id, value, handler) => { node(id).value = value; await run(handler + '()'); await settle(); };
    const values = id => node(id).options.map(o => o.value);
    const labels = id => node(id).options.map(o => o.label);

    const type = fields => Object.keys(fields || {}).forEach(k => { node(k).value = fields[k]; });
    const submit = async fields => {
        type(Object.assign({ title: 'Community clean-up day', content: 'Join us on Saturday at the market.' }, fields));
        const before = writes().length;
        await run('handleSubmit({ preventDefault() {} })');
        await settle();
        return writes().slice(before)[0];
    };

    return { sandbox, node, run, requests, writes, geoUrls, alertText, signIn, choose, values, labels, submit, state: () => run('state') };
}

const mkNotice = over => Object.assign({
    id: 'a1', title: 'Borehole maintenance', content: 'The borehole will be serviced on Saturday morning.',
    category: 'service', priority: 'high', created_by: 'admin', created_at: '2026-10-15T08:00:00.000Z',
    expires_at: null, is_archived: false, ward_id: 10, scope_level: 'WARD',
    ward_name: 'Ngoliba', constituency_name: 'Thika Town', county_name: 'Kiambu'
}, over || {});

// ============================================
// Page structure
// ============================================
describe('admin-notices.html - scope section is in the form', () => {
    test('the scope selectors exist and the existing fields and buttons are all still there', () => {
        const html = pageHtml();
        ['scopeLevel', 'scopeCounty', 'scopeConstituency', 'scopeWard', 'scopeControls', 'scopeNote',
            'title', 'content', 'category', 'priority', 'expiresAt', 'submitBtn', 'cancelBtn', 'noticeForm', 'noticesContainer']
            .forEach(id => expect({ id, found: html.includes('id="' + id + '"') }).toEqual({ id, found: true }));
    });

    test('the sections keep their order: Basic Information, Classification, scope, Expiration', () => {
        const html = pageHtml();
        const at = t => html.indexOf('<h3>' + t + '</h3>');
        expect(at('Basic Information') > 0).toBe(true);
        expect(at('Classification') > at('Basic Information')).toBe(true);
        expect(at('Who should see this notice') > at('Classification')).toBe(true);
        expect(at('Expiration') > at('Who should see this notice')).toBe(true);
    });

    test('the selectors call the cascade handlers; the form is still submitted by handleSubmit', () => {
        const html = pageHtml();
        expect(html).toContain('id="scopeLevel" onchange="onScopeLevelChange()"');
        expect(html).toContain('id="scopeCounty" onchange="onScopeCountyChange()"');
        expect(html).toContain('id="scopeConstituency" onchange="onScopeConstituencyChange()"');
        expect(html).toContain('<form id="noticeForm" onsubmit="handleSubmit(event)">');
    });

    test('the page only reads the public geography endpoints and the scope-options endpoint (no new write endpoint)', () => {
        const script = inlineScript();
        const urls = [...script.matchAll(/(?:fetch|fetchGeographyList)\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
        expect(urls).toContain('/api/admin/notice-scope-options');
        expect(urls).toContain('/api/counties');
        expect(urls.some(u => u.startsWith('/api/constituencies?county_id='))).toBe(true);
        expect(urls.some(u => u.startsWith('/api/wards?constituency_id='))).toBe(true);
        expect(urls.filter(u => /archive/i.test(u))).toEqual([]);
    });
});

// ============================================
// SUPER_ADMIN: all four levels, free cascade
// ============================================
describe('SUPER_ADMIN', () => {
    test('is offered every level, with a prompt first, and no geography is fetched yet', async () => {
        const page = loadAdminPage();
        await page.signIn();
        expect(page.state().scope.status).toBe('ready');
        expect(page.values('scopeLevel')).toEqual(['', 'PLATFORM', 'COUNTY', 'CONSTITUENCY', 'WARD']);
        expect(page.labels('scopeLevel')[0]).toBe('Select who should see this notice');
        ['scopeCountyGroup', 'scopeConstituencyGroup', 'scopeWardGroup'].forEach(id => expect(page.node(id).style.display).toBe('none'));
        expect(page.geoUrls()).toEqual([]);
        expect(page.node('scopeNote').textContent).toBe('');
        expect(page.requests[0]).toEqual({ method: 'GET', url: '/api/admin/notice-scope-options', credentials: 'include', body: undefined });
    });

    test('PLATFORM: no geography selector, request carries only scopeLevel', async () => {
        const page = loadAdminPage();
        await page.signIn();
        await page.choose('scopeLevel', 'PLATFORM', 'onScopeLevelChange');
        ['scopeCountyGroup', 'scopeConstituencyGroup', 'scopeWardGroup'].forEach(id => expect(page.node(id).style.display).toBe('none'));
        const req = await page.submit();
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/api/admin/notices');
        expect(req.body.scopeLevel).toBe('PLATFORM');
        ['countyId', 'constituencyId', 'wardId'].forEach(k => expect(k in req.body).toBe(false));
        // the existing fields are still sent
        expect(req.body.title).toBe('Community clean-up day');
        expect(req.body.category).toBe('general');
        expect(req.body.priority).toBe('normal');
        expect('expiresAt' in req.body).toBe(true);
    });

    test('COUNTY: only the county selector, filled from /api/counties; the request carries countyId as a number', async () => {
        const page = loadAdminPage();
        await page.signIn();
        await page.choose('scopeLevel', 'COUNTY', 'onScopeLevelChange');
        expect(page.node('scopeCountyGroup').style.display).toBe('block');
        expect(page.node('scopeConstituencyGroup').style.display).toBe('none');
        expect(page.node('scopeWardGroup').style.display).toBe('none');
        expect(page.geoUrls()).toEqual(['/api/counties']);
        expect(page.values('scopeCounty')).toEqual(['', '5', '6']);
        expect(page.labels('scopeCounty')).toEqual(['Select a county', 'Kiambu', 'Nairobi']);

        const blank = await page.submit();
        expect(blank).toBe(undefined);
        expect(page.alertText()).toBe('Choose a county');

        page.node('scopeCounty').value = '6';
        const req = await page.submit();
        expect(req.body.scopeLevel).toBe('COUNTY');
        expect(req.body.countyId).toBe(6);
        expect('constituencyId' in req.body || 'wardId' in req.body).toBe(false);
    });

    test('CONSTITUENCY: county then constituency; the request carries only constituencyId', async () => {
        const page = loadAdminPage();
        await page.signIn();
        await page.choose('scopeLevel', 'CONSTITUENCY', 'onScopeLevelChange');
        expect(page.node('scopeWardGroup').style.display).toBe('none');
        expect(page.values('scopeConstituency')).toEqual(['']);
        expect(page.labels('scopeConstituency')).toEqual(['Select a county first']);

        await page.choose('scopeCounty', '5', 'onScopeCountyChange');
        expect(page.geoUrls()).toEqual(['/api/counties', '/api/constituencies?county_id=5']);
        expect(page.values('scopeConstituency')).toEqual(['', '7', '8']);
        expect(page.labels('scopeConstituency')).toEqual(['Select a constituency', 'Thika Town', 'Juja']);
        page.node('scopeConstituency').value = '7';
        const req = await page.submit();
        expect(req.body.scopeLevel).toBe('CONSTITUENCY');
        expect(req.body.constituencyId).toBe(7);
        expect('countyId' in req.body || 'wardId' in req.body).toBe(false);
    });

    test('WARD: the full cascade; the two wards named Ngoliba are separate choices under separate constituencies', async () => {
        const page = loadAdminPage();
        await page.signIn();
        await page.choose('scopeLevel', 'WARD', 'onScopeLevelChange');
        ['scopeCountyGroup', 'scopeConstituencyGroup', 'scopeWardGroup'].forEach(id => expect(page.node(id).style.display).toBe('block'));
        expect(page.labels('scopeWard')).toEqual(['Select a constituency first']);

        await page.choose('scopeCounty', '5', 'onScopeCountyChange');
        await page.choose('scopeConstituency', '7', 'onScopeConstituencyChange');
        expect(page.geoUrls()).toEqual(['/api/counties', '/api/constituencies?county_id=5', '/api/wards?constituency_id=7']);
        expect(page.values('scopeWard')).toEqual(['', '10', '11']);

        page.node('scopeWard').value = '10';
        const req = await page.submit();
        expect(req.body.scopeLevel).toBe('WARD');
        expect(req.body.wardId).toBe(10);
        expect('countyId' in req.body || 'constituencyId' in req.body).toBe(false);

        // the same name under Juja is ward 1, reached only through Juja
        await page.choose('scopeLevel', 'WARD', 'onScopeLevelChange');
        await page.choose('scopeCounty', '5', 'onScopeCountyChange');
        await page.choose('scopeConstituency', '8', 'onScopeConstituencyChange');
        expect(page.values('scopeWard')).toEqual(['', '1']);
    });

    test('changing a parent discards the children: no ward from the old constituency can be submitted', async () => {
        const page = loadAdminPage();
        await page.signIn();
        await page.choose('scopeLevel', 'WARD', 'onScopeLevelChange');
        await page.choose('scopeCounty', '5', 'onScopeCountyChange');
        await page.choose('scopeConstituency', '7', 'onScopeConstituencyChange');
        page.node('scopeWard').value = '10';

        await page.choose('scopeCounty', '6', 'onScopeCountyChange');
        expect(page.values('scopeConstituency')).toEqual(['', '9']);
        expect(page.labels('scopeWard')).toEqual(['Select a constituency first']);
        expect(page.node('scopeWard').value).toBe('');

        const req = await page.submit();
        expect(req).toBe(undefined);
        expect(page.alertText()).toBe('Choose a ward');
        expect(page.writes()).toEqual([]);
    });

    test('no level chosen: the form refuses to submit and says why', async () => {
        const page = loadAdminPage();
        await page.signIn();
        const req = await page.submit();
        expect(req).toBe(undefined);
        expect(page.alertText()).toBe('Choose who should see this notice');
        expect(page.writes()).toEqual([]);
    });

    test('the existing title and content validation still comes first', async () => {
        const page = loadAdminPage();
        await page.signIn();
        const req = await page.submit({ title: 'abc' });
        expect(req).toBe(undefined);
        expect(page.alertText()).toBe('Title must be at least 5 characters');
    });

    test('a late answer for an old county is ignored (the newest choice wins)', async () => {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const page = loadAdminPage({ hook: url => (url === '/api/constituencies?county_id=5' ? held : undefined) });
        await page.signIn();
        await page.choose('scopeLevel', 'CONSTITUENCY', 'onScopeLevelChange');

        page.node('scopeCounty').value = '5';
        const slow = page.run('onScopeCountyChange()');      // county 5: held back
        await settle();
        page.node('scopeCounty').value = '6';
        await page.run('onScopeCountyChange()');             // county 6: answers at once
        await settle();
        expect(page.values('scopeConstituency')).toEqual(['', '9']);

        release();
        await slow;
        await settle();
        expect(page.values('scopeConstituency')).toEqual(['', '9']);   // not overwritten by county 5's list
    });

    test('a geography request that fails shows an error and leaves nothing selectable', async () => {
        const page = loadAdminPage({ hook: null });
        await page.signIn();
        // make the counties endpoint fail
        page.sandbox.fetch = () => Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({ success: false }) });
        await page.choose('scopeLevel', 'COUNTY', 'onScopeLevelChange');
        expect(page.labels('scopeCounty')).toEqual(['Could not load']);
        expect(page.alertText()).toBe('Could not load the list of counties');
        const req = await page.submit();
        expect(req).toBe(undefined);
        expect(page.writes()).toEqual([]);
    });
});

// ============================================
// Scoped administrators: only their own area
// ============================================
describe('scoped administrators', () => {
    test('WARD_ADMIN: only the ward level (preselected); county, constituency and ward are locked to their own', async () => {
        const page = loadAdminPage({ options: WARD_ADMIN });
        await page.signIn();
        expect(page.values('scopeLevel')).toEqual(['WARD']);
        expect(page.node('scopeLevel').value).toBe('WARD');
        ['scopeCountyGroup', 'scopeConstituencyGroup', 'scopeWardGroup'].forEach(id => expect(page.node(id).style.display).toBe('block'));
        expect(page.labels('scopeCounty')).toEqual(['Kiambu']);
        expect(page.labels('scopeConstituency')).toEqual(['Thika Town']);
        expect(page.labels('scopeWard')).toEqual(['Ngoliba']);
        ['scopeCounty', 'scopeConstituency', 'scopeWard'].forEach(id => expect(page.node(id).disabled).toBe(true));
        expect(page.geoUrls()).toEqual([]);
        expect(page.node('scopeNote').textContent).toBe('You can publish only within the area you administer.');

        const req = await page.submit();
        expect(req.body.scopeLevel).toBe('WARD');
        expect(req.body.wardId).toBe(10);
        expect('countyId' in req.body || 'constituencyId' in req.body).toBe(false);
    });

    test('CONSTITUENCY_ADMIN: only their constituency, locked', async () => {
        const page = loadAdminPage({ options: CONSTITUENCY_ADMIN });
        await page.signIn();
        expect(page.values('scopeLevel')).toEqual(['CONSTITUENCY']);
        expect(page.node('scopeWardGroup').style.display).toBe('none');
        expect(page.labels('scopeCounty')).toEqual(['Kiambu']);
        expect(page.labels('scopeConstituency')).toEqual(['Thika Town']);
        expect(page.node('scopeConstituency').disabled).toBe(true);
        expect(page.geoUrls()).toEqual([]);
        const req = await page.submit();
        expect(req.body.scopeLevel).toBe('CONSTITUENCY');
        expect(req.body.constituencyId).toBe(7);
    });

    test('COUNTY_ADMIN: only their county, locked', async () => {
        const page = loadAdminPage({ options: COUNTY_ADMIN });
        await page.signIn();
        expect(page.values('scopeLevel')).toEqual(['COUNTY']);
        expect(page.node('scopeConstituencyGroup').style.display).toBe('none');
        expect(page.labels('scopeCounty')).toEqual(['Kiambu']);
        expect(page.node('scopeCounty').disabled).toBe(true);
        expect(page.geoUrls()).toEqual([]);
        const req = await page.submit();
        expect(req.body.scopeLevel).toBe('COUNTY');
        expect(req.body.countyId).toBe(5);
    });

    test('a level the server did not offer cannot be sent, even if the select is tampered with', async () => {
        const page = loadAdminPage({ options: WARD_ADMIN });
        await page.signIn();
        page.node('scopeLevel').value = 'PLATFORM';
        const req = await page.submit();
        expect(req).toBe(undefined);
        expect(page.alertText()).toBe('Choose who should see this notice');
        expect(page.writes()).toEqual([]);
    });

    test('levels outside the four known ones are dropped from the offer', async () => {
        const page = loadAdminPage({ options: Object.assign({}, WARD_ADMIN, { levels: ['WARD', 'GLOBAL', '__proto__', 'constructor'] }) });
        await page.signIn();
        expect(page.values('scopeLevel')).toEqual(['WARD']);
    });

    test('MODERATOR (no levels): nothing to choose, an explanation, and no request can be made', async () => {
        const page = loadAdminPage({ options: MODERATOR });
        await page.signIn();
        expect(page.labels('scopeLevel')).toEqual(['No scope available']);
        expect(page.node('scopeNote').textContent).toBe('Your account is not allowed to publish notices.');
        const req = await page.submit();
        expect(req).toBe(undefined);
        expect(page.alertText()).toBe('Your account is not allowed to publish notices.');
        expect(page.writes()).toEqual([]);
    });
});

// ============================================
// Loading and failure states
// ============================================
describe('options loading', () => {
    test('while the options are still loading the form cannot submit', async () => {
        const page = loadAdminPage({ options: { hang: true } });
        page.run('loadScopeOptions()');
        await settle();
        expect(page.state().scope.status).toBe('loading');
        expect(page.labels('scopeLevel')).toEqual(['Loading your options...']);
        const req = await page.submit();
        expect(req).toBe(undefined);
        expect(page.alertText()).toBe('Your publishing options are still loading. Try again in a moment.');
    });

    test('when the options cannot be loaded the form cannot submit and says so', async () => {
        const page = loadAdminPage({ options: { fail: true } });
        await page.signIn();
        expect(page.state().scope.status).toBe('error');
        expect(page.labels('scopeLevel')).toEqual(['Unavailable']);
        expect(page.node('scopeNote').textContent).toBe('Your publishing options could not be loaded. Reload the page and sign in again.');
        const req = await page.submit();
        expect(req).toBe(undefined);
        expect(page.writes()).toEqual([]);
    });

    test('a malformed answer is treated as a failure, not as "everything allowed"', async () => {
        const page = loadAdminPage({ options: { role: 'SUPER_ADMIN' } });   // no levels array
        await page.signIn();
        expect(page.state().scope.status).toBe('error');
        expect((await page.submit())).toBe(undefined);
    });

    test('before sign-in (options never requested) the request is the legacy one: no scope fields are added', async () => {
        const page = loadAdminPage();
        const req = await page.submit();
        expect(req.method).toBe('POST');
        ['scopeLevel', 'countyId', 'constituencyId', 'wardId'].forEach(k => expect(k in req.body).toBe(false));
    });

    test('signing out forgets the previous administrator\'s options', async () => {
        const page = loadAdminPage({ options: SUPER });
        await page.signIn();
        expect(page.state().scope.levels.length).toBe(4);
        await page.run('handleLogout()');
        await settle();
        expect(page.state().scope.status).toBe('idle');
        expect(page.state().scope.levels).toEqual([]);
        expect(page.state().scope.assignment).toBe(null);
    });
});

// ============================================
// Editing: the scope is shown, never changed
// ============================================
describe('editing a notice', () => {
    test('the scope selectors are hidden, the scope is stated, and the PUT carries no scope fields', async () => {
        const page = loadAdminPage({ options: SUPER, notices: [mkNotice()] });
        await page.signIn();
        page.run('editNotice("a1")');
        expect(page.node('scopeControls').style.display).toBe('none');
        expect(page.node('scopeNote').textContent).toBe('Scope: Ward: Ngoliba (Thika Town). The scope of a published notice cannot be changed here.');

        const req = await page.submit({ title: 'Borehole maintenance (rescheduled)' });
        expect(req.method).toBe('PUT');
        expect(req.url).toBe('/api/admin/notices/a1');
        ['scopeLevel', 'countyId', 'constituencyId', 'wardId', 'ward_id', 'scope_level'].forEach(k => expect(k in req.body).toBe(false));
    });

    test('Cancel / reset brings the selectors back, empty, and clears the scope text', async () => {
        const page = loadAdminPage({ options: SUPER, notices: [mkNotice()] });
        await page.signIn();
        await page.choose('scopeLevel', 'COUNTY', 'onScopeLevelChange');
        page.run('editNotice("a1")');
        page.run('resetForm()');
        await settle();
        expect(page.node('scopeControls').style.display).toBe('block');
        expect(page.node('scopeNote').textContent).toBe('');
        expect(page.node('scopeLevel').value).toBe('');
        expect(page.state().editingId).toBe(null);
        ['scopeCountyGroup', 'scopeConstituencyGroup', 'scopeWardGroup'].forEach(id => expect(page.node(id).style.display).toBe('none'));
    });

    test('after a successful create the form is back to an empty scope choice', async () => {
        const page = loadAdminPage({ options: SUPER });
        await page.signIn();
        await page.choose('scopeLevel', 'PLATFORM', 'onScopeLevelChange');
        const req = await page.submit();
        expect(req.body.scopeLevel).toBe('PLATFORM');
        expect(page.node('scopeLevel').value).toBe('');
    });

    test('a WARD_ADMIN\'s locked selectors survive a reset (re-rendered from the same options)', async () => {
        const page = loadAdminPage({ options: WARD_ADMIN });
        await page.signIn();
        page.run('resetForm()');
        await settle();
        expect(page.node('scopeLevel').value).toBe('WARD');
        expect(page.node('scopeWard').disabled).toBe(true);
        expect(page.labels('scopeWard')).toEqual(['Ngoliba']);
    });
});

// ============================================
// Notice cards: where is it published?
// ============================================
describe('notice cards show the scope', () => {
    const text = n => loadAdminPage().run('noticeScopeText(' + JSON.stringify(n) + ')');

    test('each scope level has its own label', () => {
        expect(text({ scope_level: 'PLATFORM' })).toBe('Platform-wide');
        expect(text({ scope_level: 'COUNTY', county_name: 'Kiambu' })).toBe('County: Kiambu');
        expect(text({ scope_level: 'CONSTITUENCY', constituency_name: 'Thika Town', county_name: 'Kiambu' })).toBe('Constituency: Thika Town (Kiambu)');
        expect(text({ scope_level: 'WARD', ward_name: 'Ngoliba', constituency_name: 'Thika Town' })).toBe('Ward: Ngoliba (Thika Town)');
    });

    test('a legacy notice (scope_level null or absent) is labelled legacy with the ward it belongs to', () => {
        expect(text({ scope_level: null, ward_id: 1, ward_name: 'Ngoliba', constituency_name: 'Juja' })).toBe('Legacy notice for ward Ngoliba (Juja)');
        expect(text({ ward_id: 1 })).toBe('Legacy notice');
    });

    test('the same ward name under two constituencies is distinguishable on the card', () => {
        expect(text({ scope_level: 'WARD', ward_name: 'Ngoliba', constituency_name: 'Thika Town' }))
            .not.toBe(text({ scope_level: null, ward_name: 'Ngoliba', constituency_name: 'Juja' }));
    });

    test('the list renders one scope line per card inside the notice info, between the badges and the expiry', async () => {
        const notices = [
            mkNotice({ id: 'a1', scope_level: 'PLATFORM', ward_name: null }),
            mkNotice({ id: 'a2', scope_level: null, ward_id: 1, ward_name: 'Ngoliba', constituency_name: 'Juja' })
        ];
        const page = loadAdminPage({ notices });
        page.run('renderNotices()');
        const html = page.node('noticesContainer').innerHTML;
        expect((html.match(/class="notice-scope"/g) || []).length).toBe(2);
        expect(html).toContain('<div class="notice-scope">Platform-wide</div>');
        expect(html).toContain('<div class="notice-scope">Legacy notice for ward Ngoliba (Juja)</div>');
        expect(html.indexOf('notice-badges') < html.indexOf('notice-scope')).toBe(true);
    });

    test('geography names are escaped (cards and selects)', async () => {
        const hostile = '<img src=x onerror=alert(1)>';
        const notices = [mkNotice({ scope_level: 'WARD', ward_name: hostile, constituency_name: '"><script>x</script>' })];
        const page = loadAdminPage({ notices, options: Object.assign({}, WARD_ADMIN, {
            assignment: { county: { id: 5, name: hostile }, constituency: { id: 7, name: hostile }, ward: { id: 10, name: hostile } }
        }) });
        page.run('renderNotices()');
        const html = page.node('noticesContainer').innerHTML;
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script>x');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');

        await page.signIn();
        expect(page.node('scopeWard').innerHTML).not.toContain('<img');
        expect(page.labels('scopeWard')).toEqual([hostile]);   // the markup round-trips as TEXT, never as an element
    });

    test('the existing card content is untouched: title, badges, archived badge, expiry line, buttons', () => {
        const page = loadAdminPage({ notices: [mkNotice({ is_archived: true, expires_at: '2026-10-16T13:10:45.123Z' })] });
        page.run('renderNotices()');
        const html = page.node('noticesContainer').innerHTML;
        expect(html).toContain('<h3>Borehole maintenance</h3>');
        expect(html).toContain('<span class="badge">service</span>');
        expect(html).toContain('<span class="badge">high</span>');
        expect(html).toContain('Archived</span>');
        expect(html).toContain('class="notice-expiry"');
        expect(html).toContain('data-notice-action="edit"');
        expect(html).toContain('data-notice-action="delete"');
    });
});
