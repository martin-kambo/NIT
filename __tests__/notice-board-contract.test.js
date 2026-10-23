// ============================================
// PHASE 4B.37C: PUBLIC NOTICE BOARD (public/notice-board.html) - CONTRACT TESTS
// Jest, same conventions as __tests__/notice-xss.test.js: no jsdom and no extra packages. The
// page script is loaded into a node:vm context together with a small recording fake DOM and a
// fake `fetch`, then driven through the page's own functions (applyFilters, clearFilters,
// fetchNotices, renderNotices).
//
// WHAT THIS PROVES (mocked-DOM tests, not a browser):
//   S3  the category filter is sent as the query parameter the backend actually reads (`cat`);
//       `service` and `payment` are selectable and work; priority and search narrow the
//       returned notices client-side; all three combine; no-match shows an empty-results state
//       and no stale cards; an older, slower response cannot overwrite a newer one.
//   S4  an ad (is_ad) gets an "Ad" badge and a neutral label; business name and phone are
//       shown only when present and valid; the only link is tel:+?digits; hostile business
//       names / phone values stay inert; ordinary notices are untouched.
// WHAT IT DOES NOT PROVE: behaviour in a real browser, or against the real database.
// The fake server below filters on `cat` and ignores every other parameter, exactly like
// GET /api/notices does; a test reads routes/notices.js (read-only) to confirm that is still true.
//
// NIT_PUBLIC_DIR may point at another copy of public/ (used to confirm these tests FAIL on the
// pre-fix page). routes/ and lib/ are always read from this checkout.
// ============================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = process.env.NIT_PUBLIC_DIR || path.join(ROOT, 'public');
const readPublic = rel => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
const { NOTICE_CATEGORIES, LEGACY_CATEGORY } = require('../lib/notice-validation');

// ─────────────────────────────────────────
// Recording fake DOM
// ─────────────────────────────────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.className = '';
        this.style = {};
        this.value = '';
        this._text = '';
        this._html = '';
        this._classes = new Set();
        const set = this._classes;
        this.classList = {
            add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
            toggle: (c, f) => ((f === undefined ? !set.has(c) : f) ? set.add(c) : set.delete(c))
        };
    }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this.children = []; }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener() {}
    setAttribute() {}
}

const unescapeHtml = s => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeOnce = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const settle = () => new Promise(resolve => setImmediate(resolve));

// Every '<' must open a whitelisted tag with whitelisted attributes; href may only be tel:+?digits.
function inspectHtml(html, allowedTags, allowedAttrs) {
    const problems = [];
    const tokens = html.match(/<[^<>]*>/g) || [];
    if ((html.match(/</g) || []).length !== tokens.length) problems.push('stray "<" outside a well-formed tag');
    tokens.forEach(tok => {
        const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)([\s\S]*?)\/?>$/.exec(tok);
        if (!m) { problems.push('malformed tag ' + tok.slice(0, 60)); return; }
        if (!allowedTags.includes(m[1].toLowerCase())) problems.push('unexpected tag <' + m[1] + '>');
        const attrRe = /([^\s=\/"'<>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        let a;
        while ((a = attrRe.exec(m[2])) !== null) {
            const name = a[1].toLowerCase();
            const val = a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : (a[5] || ''));
            if (!allowedAttrs.includes(name)) problems.push('unexpected attribute "' + name + '" on <' + m[1] + '>');
            if (name === 'href' && !/^tel:\+?[0-9]{7,15}$/.test(val)) problems.push('href is not a plain tel: URL: ' + val.slice(0, 60));
            if (name === 'class' && !/^[A-Za-z0-9_\- ]*$/.test(val)) problems.push('unsafe class value ' + val.slice(0, 40));
        }
    });
    return problems;
}
const CARD_TAGS = ['div', 'h3', 'span', 'p', 'a'];
const CARD_ATTRS = ['class', 'href'];

// ─────────────────────────────────────────
// Fixtures - the shape GET /api/notices returns (snake_case rows, ads merged in, is_ad boolean)
// ─────────────────────────────────────────
const POSTED = '2026-10-16T08:00:00.000Z';
const notice = (id, o) => Object.assign({
    id, title: 'Notice ' + id, content: 'Body ' + id, category: 'general', priority: 'normal',
    created_at: POSTED, expires_at: null, contact_phone: null, business_name: null, is_ad: false
}, o);
const ad = (id, o) => Object.assign({
    id, title: 'Mama Wanjiru Groceries', content: 'Fresh vegetables delivered daily', category: 'business',
    priority: 'normal', created_at: POSTED, expires_at: null,
    contact_phone: '0712 345 678', business_name: 'Mama Wanjiru Groceries', is_ad: true
}, o);

const ROWS = [
    notice(1, { title: 'Borehole maintenance', content: 'Water supply is interrupted on Tuesday', category: 'service', priority: 'high' }),
    notice(2, { title: 'Land rates reminder', content: 'Pay your rates before month end', category: 'payment', priority: 'normal' }),
    notice(3, { title: 'Community clean-up day', content: 'Bring gloves and bags', category: 'event', priority: 'normal' }),
    notice(4, { title: 'Water points timetable', content: 'Collection hours for each water point', category: 'service', priority: 'normal' }),
    notice(5, { title: 'Road works', content: 'Road closed for pipe repairs', category: 'public', priority: 'high' }),
    notice(6, { title: 'Casual labourers needed', content: 'Apply at the ward office', category: 'jobs', priority: 'low' }),
    notice(7, { title: 'Fundi Water Tanks', content: 'Tank installation and repair', category: 'business', priority: 'normal',
        is_ad: true, business_name: 'Fundi Tanks Ltd', contact_phone: '+254 722 111 222' }),
    ad(8)
];

// Same behaviour as GET /api/notices for the query string: `cat` filters on category (exact match,
// 'all' = none); page, limit, priority, search and category are ignored.
function fakeServer(rows, log) {
    return url => {
        log.push(url);
        const cat = new URLSearchParams(String(url).split('?')[1] || '').get('cat');
        const filterCat = cat && cat !== 'all' ? cat : null;
        const out = rows.filter(r => !filterCat || r.category === filterCat);
        return Promise.resolve({ json: () => Promise.resolve({ success: true, notices: out }) });
    };
}

// ─────────────────────────────────────────
// Page loader
// ─────────────────────────────────────────
function inlineScript(file) {
    const html = readPublic(file);
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    if (!blocks.length) throw new Error('no inline script in ' + file);
    return blocks[blocks.length - 1];
}

function loadBoard(fetchImpl, opts = {}) {
    const nodes = {};
    const node = id => (nodes[id] = nodes[id] || new FakeNode('div'));
    node('category').value = 'all';
    node('priority').value = 'all';
    node('search').value = '';
    const requests = [];
    const sandbox = {
        console: opts.quiet ? { log() {}, warn() {}, error() {} } : console,
        URLSearchParams, Date, Number, String, Object, JSON, Math, Promise,
        setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {},
        fetch: fetchImpl ? (url => { requests.push(url); return fetchImpl(url); })
                         : (() => Promise.reject(new Error('network disabled in unit test'))),
        confirm: () => false, alert: () => {},
        document: {
            getElementById: node,
            createElement: t => new FakeNode(t),
            addEventListener: () => {},
            querySelectorAll: () => [],
            querySelector: () => node('__qs')
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(inlineScript('notice-board.html'), sandbox);
    const ctx = {
        sandbox, node, requests,
        run: code => vm.runInContext(code, sandbox),
        titles: () => [...node('noticesContainer').innerHTML.matchAll(/<h3 class="notice-title">([\s\S]*?)<\/h3>/g)].map(m => unescapeHtml(m[1])),
        html: () => node('noticesContainer').innerHTML,
        emptyShown: () => !node('emptyState').classList.contains('hidden'),
        async filter(f) {
            node('category').value = f.category || 'all';
            node('priority').value = f.priority || 'all';
            node('search').value = f.search || '';
            ctx.run('applyFilters()');
            await settle();
        },
        params: i => new URLSearchParams(String(requests[i == null ? requests.length - 1 : i]).split('?')[1] || '')
    };
    return ctx;
}

function boardWithServer(rows) {
    const log = [];
    const ctx = loadBoard(fakeServer(rows || ROWS, log));
    ctx.log = log;
    return ctx;
}

// Direct render of a list (no network), for the card-presentation tests.
function renderRows(rows) {
    const ctx = loadBoard();
    ctx.sandbox.__rows = rows;
    ctx.run('state.notices = __rows; renderNotices();');
    return ctx;
}

// Independent oracle for "what should be on screen" (written without reference to the page code).
function expectedTitles(rows, f) {
    const q = (f.search || '').trim().toLowerCase();
    return rows.filter(r =>
        (!f.category || f.category === 'all' || r.category === f.category) &&
        (!f.priority || f.priority === 'all' || r.priority === f.priority) &&
        (!q || [r.title, r.content, r.is_ad ? r.business_name : ''].join('\n').toLowerCase().includes(q))
    ).map(r => r.title);
}

// ============================================
// S3 - request contract
// ============================================
describe('S3: category request uses the parameter the backend reads', () => {
    test('GET /api/notices reads `cat` (routes/notices.js, read-only check)', () => {
        const src = fs.readFileSync(path.join(ROOT, 'routes', 'notices.js'), 'utf8');
        const start = src.indexOf("router.get('/api/notices'");
        expect(start > -1).toBe(true);
        const end = src.indexOf('router.', start + 10);
        const handler = src.slice(start, end);
        const m = /const\s*\{\s*(\w+)\s*\}\s*=\s*req\.query/.exec(handler);
        expect(m ? m[1] : null).toBe('cat');
        expect(handler).not.toMatch(/req\.query\.(priority|search|category)/);
    });

    test('a category filter is sent as cat=..., not category=...; priority and search are not sent', async () => {
        const ctx = boardWithServer();
        await ctx.filter({ category: 'event', priority: 'high', search: 'zzz' });
        const p = ctx.params();
        expect(p.get('cat')).toBe('event');
        expect(p.has('category')).toBe(false);
        expect(p.has('priority')).toBe(false);
        expect(p.has('search')).toBe(false);
    });

    test('"All Categories" sends no cat parameter', async () => {
        const ctx = boardWithServer();
        await ctx.filter({ category: 'event' });
        await ctx.filter({ category: 'all' });
        expect(ctx.params().has('cat')).toBe(false);
        expect(ctx.titles()).toEqual(ROWS.map(r => r.title));
    });
});

// ============================================
// S3 - category selector
// ============================================
describe('S3: category selector', () => {
    const select = () => {
        const html = readPublic('notice-board.html');
        const s = html.indexOf('<select id="category">');
        return html.slice(s, html.indexOf('</select>', s));
    };
    const values = () => [...select().matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);

    test('every category an admin can create is offered, plus All; the legacy one is not', () => {
        const offered = values();
        expect(offered[0]).toBe('all');
        NOTICE_CATEGORIES.forEach(c => expect(offered).toContain(c));
        expect(offered).not.toContain(LEGACY_CATEGORY);
        expect(offered.length).toBe(NOTICE_CATEGORIES.length + 1);
    });

    test('service: selectable and shows only service notices', async () => {
        expect(values()).toContain('service');
        const ctx = boardWithServer();
        await ctx.filter({ category: 'service' });
        expect(ctx.params().get('cat')).toBe('service');
        expect(ctx.titles()).toEqual(['Borehole maintenance', 'Water points timetable']);
    });

    test('payment: selectable and shows only payment notices', async () => {
        expect(values()).toContain('payment');
        const ctx = boardWithServer();
        await ctx.filter({ category: 'payment' });
        expect(ctx.params().get('cat')).toBe('payment');
        expect(ctx.titles()).toEqual(['Land rates reminder']);
    });
});

// ============================================
// S3 - priority and search
// ============================================
describe('S3: priority filter', () => {
    test('each priority shows only that priority and excludes the rest', async () => {
        const ctx = boardWithServer();
        await ctx.filter({ priority: 'high' });
        expect(ctx.titles()).toEqual(['Borehole maintenance', 'Road works']);
        await ctx.filter({ priority: 'low' });
        expect(ctx.titles()).toEqual(['Casual labourers needed']);
        await ctx.filter({ priority: 'normal' });
        expect(ctx.titles()).toEqual(expectedTitles(ROWS, { priority: 'normal' }));
        expect(ctx.titles()).not.toContain('Road works');
        await ctx.filter({ priority: 'all' });
        expect(ctx.titles()).toEqual(ROWS.map(r => r.title));
    });
});

describe('S3: search filter', () => {
    test('matches title and content, ignoring case and surrounding spaces; excludes the rest', async () => {
        const ctx = boardWithServer();
        await ctx.filter({ search: '  WATER ' });
        expect(ctx.titles()).toEqual(['Borehole maintenance', 'Water points timetable', 'Fundi Water Tanks']);
        await ctx.filter({ search: 'gloves' });                       // content only
        expect(ctx.titles()).toEqual(['Community clean-up day']);
        await ctx.filter({ search: 'no such text anywhere' });
        expect(ctx.titles()).toEqual([]);
    });

    test('an ad is found by its business name; a non-ad is not searched on a stray business_name', async () => {
        const rows = [
            ad(1, { title: 'Weekend offer', business_name: 'Kamau Hardware' }),
            notice(2, { title: 'Meeting', content: 'Ward meeting', business_name: 'Kamau Hardware' })
        ];
        const ctx = boardWithServer(rows);
        await ctx.filter({ search: 'kamau' });
        expect(ctx.titles()).toEqual(['Weekend offer']);
    });

    test('the search term is data: regex characters are literal and HTML is never written back', async () => {
        const ctx = boardWithServer();
        for (const term of ['.*', '(', '[a-z]+', '\\', '<img src=x onerror=alert(1)>', '"><script>alert(1)</script>']) {
            await ctx.filter({ search: term });
            expect(ctx.titles()).toEqual([]);
            expect(ctx.html()).toBe('');
            expect(ctx.node('emptyTitle').textContent).not.toMatch(/[<>]/);
            expect(ctx.node('emptyHint').textContent).not.toMatch(/[<>]/);
            expect(ctx.node('statusMessage').textContent).not.toContain(term);
        }
    });
});

// ============================================
// S3 - combined filtering
// ============================================
describe('S3: category, priority and search together', () => {
    test('narrowing and relaxing one filter keeps the other two in force', async () => {
        const ctx = boardWithServer();
        await ctx.filter({ category: 'service', priority: 'high', search: 'borehole' });
        expect(ctx.titles()).toEqual(['Borehole maintenance']);

        await ctx.filter({ category: 'service', priority: 'high', search: '' });        // relax search
        expect(ctx.titles()).toEqual(['Borehole maintenance']);
        expect(ctx.params().get('cat')).toBe('service');

        await ctx.filter({ category: 'service', priority: 'all', search: 'water' });    // relax priority
        expect(ctx.titles()).toEqual(['Borehole maintenance', 'Water points timetable']);
        expect(ctx.titles()).not.toContain('Fundi Water Tanks');                          // other category
        expect(ctx.titles()).not.toContain('Road works');

        await ctx.filter({ category: 'all', priority: 'high', search: 'water' });       // relax category
        expect(ctx.titles()).toEqual(['Borehole maintenance']);
        expect(ctx.run('state.filters.search')).toBe('water');
        expect(ctx.run('state.filters.priority')).toBe('high');
        expect(ctx.run('state.filters.category')).toBe('all');
    });

    test('for every combination, what is shown satisfies ALL active filters (independent oracle)', async () => {
        const ctx = boardWithServer();
        for (const category of ['all', 'general', 'public', 'service', 'payment', 'event', 'business', 'jobs']) {
            for (const priority of ['all', 'high', 'normal', 'low']) {
                for (const search of ['', 'water', 'ROAD', 'zzz']) {
                    await ctx.filter({ category, priority, search });
                    expect(ctx.titles()).toEqual(expectedTitles(ROWS, { category, priority, search }));
                }
            }
        }
    });
});

// ============================================
// S3 - empty results and stale cards
// ============================================
describe('S3: empty results and stale cards', () => {
    test('no match shows the empty-results state, with a message about the filters', async () => {
        const ctx = boardWithServer();
        await ctx.filter({ category: 'jobs', priority: 'high' });
        expect(ctx.titles()).toEqual([]);
        expect(ctx.html()).toBe('');
        expect(ctx.emptyShown()).toBe(true);
        expect(ctx.node('emptyTitle').textContent).toBe('No Notices Match Your Filters');
        expect(ctx.node('emptyHint').textContent).toMatch(/changing or clearing/);
    });

    test('with no filter on and nothing to show, the original wording is kept', async () => {
        const ctx = boardWithServer([]);
        await ctx.filter({});
        expect(ctx.emptyShown()).toBe(true);
        expect(ctx.node('emptyTitle').textContent).toBe('No Notices Found');
        expect(ctx.node('emptyHint').textContent).toBe('Try adjusting your filters or check back later for updates');
    });

    test('cards -> no match -> cards again: nothing stale in between, empty state toggles correctly', async () => {
        const ctx = boardWithServer();
        await ctx.filter({ search: 'borehole' });
        expect(ctx.titles()).toEqual(['Borehole maintenance']);
        expect(ctx.emptyShown()).toBe(false);

        await ctx.filter({ search: 'zzz' });
        expect(ctx.html()).toBe('');
        expect(ctx.emptyShown()).toBe(true);

        await ctx.filter({ search: 'rates' });
        expect(ctx.titles()).toEqual(['Land rates reminder']);
        expect(ctx.emptyShown()).toBe(false);
    });

    test('Clear All resets the controls and brings every notice back', async () => {
        const ctx = boardWithServer();
        await ctx.filter({ category: 'service', priority: 'high', search: 'bore' });
        ctx.run('clearFilters()');
        await settle();
        expect(ctx.node('category').value).toBe('all');
        expect(ctx.node('priority').value).toBe('all');
        expect(ctx.node('search').value).toBe('');
        expect(ctx.params().has('cat')).toBe(false);
        expect(ctx.titles()).toEqual(ROWS.map(r => r.title));
    });

    test('an older, slower response cannot overwrite the newer filtered result', async () => {
        // The category is the one filter the server applies, so it is the one a stale response can get wrong.
        const waiting = [];
        const ctx = loadBoard(url => new Promise(resolve => waiting.push({ url, resolve })));
        const answer = (entry, rows) => entry.resolve({ json: () => Promise.resolve({ success: true, notices: rows }) });
        const serviceRows = ROWS.filter(r => r.category === 'service');

        ctx.run('fetchNotices(1)');                     // e.g. the 30 s refresh, no category chosen
        ctx.node('category').value = 'service';
        ctx.run('applyFilters()');                      // the user then picks Service
        expect(waiting.length).toBe(2);
        expect(new URLSearchParams(waiting[0].url.split('?')[1]).has('cat')).toBe(false);
        expect(new URLSearchParams(waiting[1].url.split('?')[1]).get('cat')).toBe('service');

        answer(waiting[1], serviceRows);                // the newer request answers first ...
        await settle();
        expect(ctx.titles()).toEqual(['Borehole maintenance', 'Water points timetable']);

        answer(waiting[0], ROWS);                       // ... the older, unfiltered one answers last
        await settle();
        expect(ctx.titles()).toEqual(['Borehole maintenance', 'Water points timetable']);   // not the full list again
        expect(ctx.emptyShown()).toBe(false);
    });

    test('a failed request clears the cards instead of leaving old ones (existing behaviour)', async () => {
        let fail = false;
        const log = [];
        const ok = fakeServer(ROWS, log);
        const ctx = loadBoard(url => (fail ? Promise.reject(new Error('boom')) : ok(url)), { quiet: true });
        await ctx.filter({});
        expect(ctx.titles().length).toBe(ROWS.length);
        fail = true;
        await ctx.filter({ search: 'x' });
        expect(ctx.html()).toBe('');
        expect(ctx.emptyShown()).toBe(true);
    });

    test('the empty-state panel can actually be hidden: the page has a CSS rule for it (the script only toggles a class)', () => {
        // Without this rule the panel stays on screen under the notices, whatever the script does.
        const css = (/<style>([\s\S]*?)<\/style>/.exec(readPublic('notice-board.html')) || [, ''])[1];
        expect(css).toMatch(/\.empty-state\.hidden\s*\{[^}]*display:\s*none/);
    });

    test('no pagination controls appear (the backend does not paginate)', async () => {
        const ctx = boardWithServer();
        await ctx.filter({ category: 'service' });
        expect(ctx.node('paginationContainer').classList.contains('hidden')).toBe(true);
        expect(ctx.node('paginationContainer').innerHTML).toBe('');
    });
});

// ============================================
// S4 - advertisement identification
// ============================================
describe('S4: the Ad badge', () => {
    test('an ad gets exactly one visible "Ad" badge and the ad card class', () => {
        const ctx = renderRows([ad(1)]);
        expect((ctx.html().match(/<span class="badge badge-ad">Ad<\/span>/g) || []).length).toBe(1);
        expect(ctx.html()).toContain('notice-card-ad');
    });

    test('the badge follows the is_ad value: true (and serialized forms) yes, anything else no', () => {
        [true, 'true', 't', 'TRUE', 1].forEach(v => {
            expect(renderRows([ad(1, { is_ad: v })]).html()).toContain('badge-ad');
        });
        [false, 'false', 'f', '0', 0, null, undefined, '', 'yes', {}, []].forEach(v => {
            expect(renderRows([notice(1, { is_ad: v })]).html()).not.toContain('badge-ad');
        });
    });

    test('in a mixed list only the ads carry the badge, and the order is kept', () => {
        const ctx = renderRows(ROWS);
        expect((ctx.html().match(/badge-ad/g) || []).length).toBe(2);
        expect(ctx.titles()).toEqual(ROWS.map(r => r.title));
    });
});

describe('S4: neutral label', () => {
    test('an ad says it is an advertisement and not an official notice, even under an official category', () => {
        ['business', 'public', 'service', 'payment'].forEach(category => {
            const html = renderRows([ad(1, { category })]).html();
            expect(html).toContain('<div class="ad-label">Advertisement');
            expect(html).toContain('not an official notice');
        });
    });

    test('the label claims no endorsement, verification or government status', () => {
        const html = renderRows([ad(1)]).html();
        const label = /<div class="ad-label">([\s\S]*?)<\/div>/.exec(html)[1];
        expect(label).not.toMatch(/verified|endorsed|approved by|government|county|ward office|official notice(?!$)/i);
        expect(label).toMatch(/not an official notice$/);
    });
});

describe('S4: business details and phone link', () => {
    test('business name is shown, escaped', () => {
        const html = renderRows([ad(1, { business_name: 'Tom & Jerry <b>Foods</b>' })]).html();
        expect(html).toContain('<span class="ad-business">🏪 Tom &amp; Jerry &lt;b&gt;Foods&lt;/b&gt;</span>');
        expect(html).not.toContain('<b>');
    });

    test('a valid phone is shown as written and linked as a plain tel: URL', () => {
        const cases = [
            ['0712 345 678', 'tel:0712345678'],
            ['+254 722-111-222', 'tel:+254722111222'],
            ['(020) 123-4567', 'tel:0201234567']
        ];
        cases.forEach(([raw, href]) => {
            const html = renderRows([ad(1, { contact_phone: raw })]).html();
            expect(html).toContain('<a class="ad-phone" href="' + href + '">📞 ' + raw + '</a>');
            expect(inspectHtml(html, CARD_TAGS, CARD_ATTRS)).toEqual([]);
        });
    });

    test('hostile or malformed phone values never produce a link or any phone text', () => {
        const hostile = [
            'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'tel:0712345678', 'data:text/html,<script>alert(1)</script>',
            '0712" onmouseover="window.__xss=1" x="', '"><img src=x onerror=alert(1)>', '<script>alert(1)</script>',
            '0712345678"><a href="javascript:alert(1)">x</a>', '123456', '1234567890123456', '+', '--------',
            '12 34 56', '(1) (2) (3) (4) (5) (6)', '1234 5678 9012 3456', '+1234 5678 9012 3456',   // wrong digit count, enough characters
            '', '   ', 'null', 'undefined', null, undefined, {}, ['javascript:alert(1)'], true
        ];
        hostile.forEach(phone => {
            const html = renderRows([ad(1, { contact_phone: phone })]).html();
            expect(html).not.toContain('<a ');
            expect(html).not.toContain('href=');
            expect(html).not.toContain('ad-phone');
            expect(html).not.toMatch(/javascript:|onerror|onmouseover/i);
            expect(inspectHtml(html, CARD_TAGS, CARD_ATTRS)).toEqual([]);
        });
    });

    test('hostile business names (also as title) stay literal text: no tag, attribute or handler is created', () => {
        const hostile = [
            '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><img src=x onerror=alert(1)>',
            'javascript:alert(1)', 'It\'s a "mix" of \'single\' and "double" quotes',
            'Tom & Jerry <b>bold</b> &amp; &lt;i&gt; 5 < 6 > 4', 'x" onmouseover="window.__xss=1" x="', "x'); window.__xss=1;//"
        ];
        hostile.forEach(name => {
            const html = renderRows([ad(1, { title: name, business_name: name, content: name })]).html();
            expect(inspectHtml(html, CARD_TAGS, CARD_ATTRS)).toEqual([]);
            expect(html).toContain(escapeOnce(name));
            expect(html).not.toMatch(/<img|<script|<b>/);
        });
    });

    test('this page and community.js apply the same phone rule (parity over a corpus)', () => {
        const src = readPublic('js/community.js');
        const sandbox = { console };
        vm.createContext(sandbox);
        vm.runInContext(src.slice(0, src.indexOf('// AD REQUESTS')), sandbox);
        const reference = vm.runInContext('safeTelHref', sandbox);
        const page = loadBoard().sandbox.safeTelHref;
        const corpus = [
            '0712 345 678', '+254 722-111-222', '(020) 123-4567', '0712345678', '+254712345678', '254712345678',
            '1234567', '123456', '123456789012345', '1234567890123456', '+', '+123456', ' 0712345678 ',
            'tel:0712345678', 'javascript:alert(1)', '0712" x="', '07 12 34 56 78 90 12 34 56 78', '12 34 56', '(1) (2) (3) (4) (5) (6)',
            '1234 5678 9012 3456', '+1234 5678 9012 3456', '', null, undefined, 712345678
        ];
        corpus.forEach(v => expect(page(v)).toBe(reference(v)));
    });
});

describe('S4: ordinary notices stay ordinary', () => {
    test('no badge, label, business block or link, even if the row carries advertiser-looking fields', () => {
        const rows = [
            notice(1, { title: 'Water notice' }),
            notice(2, { title: 'Stray fields', business_name: 'Some Shop', contact_phone: '0712 345 678', is_ad: false }),
            notice(3, { title: 'Serialized false', business_name: 'Some Shop', contact_phone: '0712 345 678', is_ad: 'false' })
        ];
        const html = renderRows(rows).html();
        expect(html).not.toMatch(/badge-ad|ad-label|ad-details|ad-business|ad-phone|notice-card-ad/);
        expect(html).not.toContain('<a ');
        expect(html).not.toContain('tel:');
        expect(html).not.toContain('Some Shop');
    });

    test('an ordinary card keeps its existing structure (category and priority badges, footer)', () => {
        const html = renderRows([notice(1, { title: 'Plain', category: 'event', priority: 'high', created_by: 'admin' })]).html();
        expect(html).toContain('<span class="badge badge-category">event</span>');
        expect(html).toContain('badge-priority-high');
        expect(html).toContain('notice-footer');
        expect(html).toContain('admin');
    });
});

describe('S4: missing advertisement fields', () => {
    test('no undefined/null text, empty labels or broken links when business or phone are missing', () => {
        const missing = [null, undefined, '', '   ', 'null', 'undefined', 'NULL'];
        missing.forEach(v => {
            const html = renderRows([ad(1, { business_name: v, contact_phone: v })]).html();
            expect(html).toContain('badge-ad');                       // still identified as an ad
            expect(html).toContain('not an official notice');
            expect(html).not.toMatch(/undefined|null/i);
            expect(html).not.toMatch(/ad-business|ad-phone|ad-details/);
            expect(html).not.toContain('<a ');
            expect(html).not.toContain('href=');
        });
    });

    test('only the detail that exists is shown', () => {
        const onlyName = renderRows([ad(1, { contact_phone: null })]).html();
        expect(onlyName).toContain('ad-business');
        expect(onlyName).not.toContain('ad-phone');
        const onlyPhone = renderRows([ad(1, { business_name: null })]).html();
        expect(onlyPhone).toContain('ad-phone');
        expect(onlyPhone).not.toContain('ad-business');
    });
});
