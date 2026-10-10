// ============================================
// PHASE 4B.32: NOTICE BOARD XSS REMEDIATION - TEST SUITE
// Jest (same runner as __tests__/notices.test.js). No jsdom and no extra packages:
// each page script is loaded into a node:vm context together with a tiny recording
// fake DOM, then hostile notice/ad data is pushed through the real render code.
//
// WHAT THIS PROVES (mocked-DOM tests, not a browser):
//   - notice values reach the DOM only through textContent / validated properties
//   - generated HTML strings contain no tag, attribute or URL that the template did not put there
//   - More / Edit / Delete / Hide / Pay handlers receive exactly their own record's id
// WHAT IT DOES NOT PROVE: that a real browser executes nothing. That is covered by the
// separate headless-Chromium run documented in the Phase 4B.32 report.
//
// NIT_PUBLIC_DIR may point at another copy of public/ (used to confirm these tests FAIL on the
// pre-fix files).
// ============================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = process.env.NIT_PUBLIC_DIR || path.join(__dirname, '..', 'public');
const read = rel => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

// ─────────────────────────────────────────
// Hostile values (test INPUTS only)
// ─────────────────────────────────────────
const P_SCRIPT = '<script>alert(1)</script>';
const P_IMG = '<img src=x onerror=alert(1)>';
const P_BREAK = '"><img src=x onerror=alert(1)>';
const P_JSURL = 'javascript:alert(1)';
const P_QUOTES = 'It\'s a "mix" of \'single\' and "double" quotes';
const P_AMP = 'Tom & Jerry <b>bold</b> &amp; &lt;i&gt; 5 < 6 > 4';
const P_ATTR = 'x" onmouseover="window.__xss=1" x="';
const P_JSBRK = "x'); window.__xss=1;//";
const P_ID = 'x\' onclick=\'window.__xss=1\' "><img src=x onerror=window.__xss=1>';
const SWAHILI = 'Mkutano wa jamii — Ngoliba ✓ 你好 Ünïcödé';
const HOSTILE = [P_SCRIPT, P_IMG, P_BREAK, P_JSURL, P_QUOTES, P_AMP, P_ATTR, P_JSBRK];

const unescapeHtml = s => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeOnce = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─────────────────────────────────────────
// Recording fake DOM
// ─────────────────────────────────────────
class FakeNode {
    constructor(tag, opts = {}) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.className = '';
        this.style = {};
        this.attrs = {};
        this.listeners = {};
        this.htmlWrites = [];
        this.value = '';
        this._text = '';
        this._classes = new Set();
        this._allowHtml = !!opts.allowHtml;
        const set = this._classes;
        this.classList = {
            add: c => set.add(c), remove: c => set.delete(c),
            toggle: (c, f) => ((f === undefined ? !set.has(c) : f) ? set.add(c) : set.delete(c)),
            contains: c => set.has(c)
        };
    }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
    get innerHTML() { return this._html || ''; }
    set innerHTML(v) {
        if (!this._allowHtml) throw new Error('innerHTML assigned on <' + this.tagName + '> that must be built with DOM APIs');
        this._html = String(v); this.htmlWrites.push(String(v)); this.children = [];
    }
    appendChild(c) {
        if (c.tagName === '#FRAGMENT') { this.children.push(...c.children); c.children = []; } else { this.children.push(c); }
        return c;
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    click() { (this.listeners.click || []).forEach(fn => fn({ target: this })); }
}
const walk = (node, fn) => { fn(node); node.children.forEach(c => walk(c, fn)); };
const findByClass = (node, cls) => { const out = []; walk(node, n => { if (n.className.split(/\s+/).includes(cls)) out.push(n); }); return out; };

const textNode = t => { const n = new FakeNode('#text'); n._text = String(t); return n; };

// Evaluates generated HTML strings structurally: every '<' must open a whitelisted tag with whitelisted attributes.
function inspectHtml(html, allowedTags, allowedAttrs) {
    const problems = [];
    const tokens = html.match(/<[^<>]*>/g) || [];
    const lt = (html.match(/</g) || []).length;
    if (lt !== tokens.length) problems.push('stray "<" outside a well-formed tag (' + lt + ' vs ' + tokens.length + ')');
    tokens.forEach(tok => {
        if (/^<!--[\s\S]*-->$/.test(tok)) return;
        const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)([\s\S]*?)\/?>$/.exec(tok);
        if (!m) { problems.push('malformed tag ' + tok.slice(0, 60)); return; }
        if (!allowedTags.includes(m[1].toLowerCase())) problems.push('unexpected tag <' + m[1] + '>');
        const attrRe = /([^\s=\/"'<>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        let a;
        while ((a = attrRe.exec(m[2])) !== null) {
            const name = a[1].toLowerCase();
            if (!allowedAttrs.includes(name) && !/^data-(notice|ar|ad)-[a-z-]+$/.test(name)) problems.push('unexpected attribute "' + name + '" on <' + m[1] + '>');
            if (/^on/.test(name)) problems.push('event-handler attribute ' + name);
            const val = a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : (a[5] || ''));
            if (/^(href|src|action|formaction)$/.test(name) && /^\s*(javascript|data|vbscript):/i.test(val)) problems.push('dangerous URL in ' + name);
            if (name === 'class' && !/^[A-Za-z0-9_\- ]*$/.test(val)) problems.push('unsafe class value ' + val.slice(0, 40));
        }
    });
    return problems;
}
const NOTICE_BOARD_TAGS = ['div', 'h3', 'span', 'p'];
const NOTICE_BOARD_ATTRS = ['class'];
const ADMIN_TAGS = ['div', 'h3', 'p', 'span', 'button', 'em', 'label', 'input', 'textarea'];
const ADMIN_ATTRS = ['class', 'id', 'style', 'title', 'type', 'min', 'step', 'value', 'rows', 'placeholder'];
const HISTORY_TAGS = ['div', 'span', 'button'];
const HISTORY_ATTRS = ['style', 'type'];

// ─────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────
function loadCommunityNoticeSection() {
    const src = read('js/community.js');
    const end = src.indexOf('// AD REQUESTS');
    if (end < 0) throw new Error('AD REQUESTS marker not found in community.js');
    const grid = new FakeNode('div', { allowHtml: true });
    const empty = new FakeNode('div');
    const toasts = [];
    const sandbox = {
        console,
        document: {
            createElement: t => new FakeNode(t),
            createTextNode: textNode,
            createDocumentFragment: () => new FakeNode('#fragment'),
            getElementById: id => (id === 'noticesGrid' ? grid : id === 'noticeEmpty' ? empty : null),
            querySelectorAll: () => []
        },
        showToast: (m, t) => toasts.push([m, t]),
        initScrollReveal: () => {}
    };
    vm.createContext(sandbox);
    vm.runInContext(src.slice(0, end), sandbox);
    const api = vm.runInContext('({ buildNoticeCard, buildNotices, escHtml, safeTelHref, setFilter: v => { activeNoticeFilter = v; } })', sandbox);
    return { api, grid, empty, toasts, src: src.slice(0, end) };
}

function loadAdHistoryRenderer() {
    const src = read('js/community.js');
    const start = src.indexOf('function renderAdHistory');
    const end = src.indexOf('// Opens the pay pane from history tab');
    if (start < 0 || end < 0) throw new Error('renderAdHistory markers not found in community.js');
    const sandbox = { console, openPayFromHistory: () => {} };
    vm.createContext(sandbox);
    vm.runInContext(read('js/community.js').slice(0, src.indexOf('// AD REQUESTS')).match(/function escHtml[\s\S]*?\n}\n/)[0], sandbox);
    vm.runInContext(src.slice(start, end), sandbox);
    return vm.runInContext('renderAdHistory', sandbox);
}

function inlineScript(file) {
    const html = read(file);
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    if (!blocks.length) throw new Error('no inline script in ' + file);
    return blocks[blocks.length - 1];
}

function loadPage(file, extra = {}) {
    const registry = {};
    const getNode = id => (registry[id] = registry[id] || new FakeNode('div', { allowHtml: true }));
    const sandbox = Object.assign({
        console, URLSearchParams, Date, Number, String, Object, JSON, Math,
        setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {},
        fetch: () => Promise.reject(new Error('network disabled in unit test')),
        confirm: () => false, alert: () => {},
        document: {
            getElementById: getNode,
            createElement: t => new FakeNode(t),
            addEventListener: () => {},
            querySelectorAll: () => [],
            querySelector: () => getNode('__qs')
        }
    }, extra);
    vm.createContext(sandbox);
    vm.runInContext(inlineScript(file), sandbox);
    return { sandbox, getNode, run: code => vm.runInContext(code, sandbox) };
}

// ============================================
// community.js — helpers
// ============================================
describe('community.js safe-output helpers', () => {
    let api;
    beforeAll(() => { api = loadCommunityNoticeSection().api; });

    test('escHtml encodes & < > " \' exactly once and tolerates null/undefined', () => {
        expect(api.escHtml(P_QUOTES)).toBe('It&#39;s a &quot;mix&quot; of &#39;single&#39; and &quot;double&quot; quotes');
        expect(api.escHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
        expect(api.escHtml(null)).toBe('');
        expect(api.escHtml(undefined)).toBe('');
        expect(api.escHtml(42)).toBe('42');
        HOSTILE.forEach(p => {
            const out = api.escHtml(p);
            expect(out).not.toMatch(/[<>"']/);
            expect(unescapeHtml(out)).toBe(p);
        });
    });

    test('safeTelHref only ever returns tel:+?digits (7-15 digits) or an empty string', () => {
        expect(api.safeTelHref('0712 345 678')).toBe('tel:0712345678');
        expect(api.safeTelHref('+254 712-345-678')).toBe('tel:+254712345678');
        expect(api.safeTelHref('(020) 123-4567')).toBe('tel:0201234567');
        [P_JSURL, P_BREAK, P_IMG, P_SCRIPT, '0712" onmouseover="x" x="', 'tel:0712345678', '123', '', null, undefined,
            '1234567890123456789', '+1234567890123456', '0712 345 678 <b>', '0712;javascript:alert(1)'].forEach(v => {
            expect(api.safeTelHref(v)).toBe('');
        });
    });
});

// ============================================
// community.js — Notice Board cards (DOM-built)
// ============================================
describe('Notice Board card rendering (community.js)', () => {

    const mk = (o = {}) => Object.assign({ id: 1, title: 'T', content: 'C', category: 'general', priority: 'normal', created_at: '2026-10-07T09:00:00.000Z', is_ad: false, contact_phone: null }, o);

    test('hostile title / content / author / category are placed as literal text, never as markup', () => {
        const { api } = loadCommunityNoticeSection();
        HOSTILE.forEach(p => {
            const card = api.buildNoticeCard(mk({ title: p, content: p, author: p, category: p }));
            expect(findByClass(card, 'notice-card-title')[0].textContent).toBe(p);
            expect(findByClass(card, 'notice-card-desc')[0].textContent).toBe(p);
            expect(findByClass(card, 'notice-meta')[0].children[0].textContent).toBe(p);   // <strong>author</strong>
            expect(findByClass(card, 'notice-cat-badge')[0].textContent).toBe(p);          // free-text category label
            walk(card, n => {
                expect(['DIV', 'SPAN', 'STRONG', 'BUTTON', 'A', '#TEXT']).toContain(n.tagName);
                expect(n.innerHTML).toBe('');                                                // innerHTML was never written
                Object.keys(n.attrs).forEach(k => expect(k).not.toMatch(/^on/i));
                expect(n.className).toMatch(/^[A-Za-z0-9_\- ]*$/);                          // class tokens come from the fixed taxonomy only
            });
        });
    });

    test('ads: Call link only for a valid phone, always a plain tel: URL; otherwise the More button', () => {
        const { api } = loadCommunityNoticeSection();
        const good = api.buildNoticeCard(mk({ is_ad: true, contact_phone: '0712 345 678' }));
        const anchors = findByClass(good, 'notice-cta-btn');
        expect(anchors).toHaveLength(1);
        expect(anchors[0].tagName).toBe('A');
        expect(anchors[0].href).toBe('tel:0712345678');
        [P_JSURL, P_BREAK, P_IMG, '0712" onmouseover="x" x="', null, ''].forEach(ph => {
            const card = api.buildNoticeCard(mk({ is_ad: true, contact_phone: ph }));
            const cta = findByClass(card, 'notice-cta-btn')[0];
            expect(cta.tagName).toBe('BUTTON');
            expect(cta.href).toBeUndefined();
        });
        walk(good, n => { if (n.href !== undefined) expect(n.href).toMatch(/^tel:\+?[0-9]{7,15}$/); });
    });

    test('More button: handler is attached with addEventListener, shows THIS notice title (escaped for the toast sink)', () => {
        const { api, toasts } = loadCommunityNoticeSection();
        HOSTILE.concat([SWAHILI, 'Tom & Jerry\'s "Sale"']).forEach((title, i) => {
            const card = api.buildNoticeCard(mk({ id: i, title }));
            const btn = findByClass(card, 'notice-cta-btn')[0];
            expect(btn.tagName).toBe('BUTTON');
            expect(btn.attrs.onclick).toBeUndefined();
            expect(btn.listeners.click).toHaveLength(1);
            toasts.length = 0;
            btn.click();
            expect(toasts).toHaveLength(1);
            expect(toasts[0][0]).toBe('📌 ' + escapeOnce(title));
            expect(toasts[0][0]).not.toMatch(/[<>"']/);                // safe for an innerHTML-rendering toast
            expect(unescapeHtml(toasts[0][0])).toBe('📌 ' + title);    // ...and not double-escaped
        });
    });

    test('each More button belongs to its own notice (button <-> notice association preserved)', () => {
        const { api, grid, toasts } = loadCommunityNoticeSection();
        const list = [mk({ id: 1, title: 'First' }), mk({ id: 2, title: P_IMG }), mk({ id: 3, title: 'Third' })];
        api.buildNotices(list);
        const cards = grid.children;
        expect(cards).toHaveLength(3);
        cards.forEach((card, i) => {
            toasts.length = 0;
            findByClass(card, 'notice-cta-btn')[0].click();
            expect(toasts[0][0]).toBe('📌 ' + escapeOnce(list[i].title));
        });
        expect(grid.htmlWrites).toHaveLength(0);   // list built from DOM nodes, no innerHTML
    });

    test('legitimate notices, non-English text, apostrophes/ampersands (no double escaping) and null fields', () => {
        const { api } = loadCommunityNoticeSection();
        const t = 'Tom & Jerry\'s "Sale" — 5 > 3 < 9';
        const card = api.buildNoticeCard(mk({ title: t, content: SWAHILI, category: 'event', priority: 'high' }));
        expect(findByClass(card, 'notice-card-title')[0].textContent).toBe(t);
        expect(findByClass(card, 'notice-card-desc')[0].textContent).toBe(SWAHILI);
        expect(findByClass(card, 'notice-cat-badge')[0].textContent).toBe('Community Event');
        const urgent = api.buildNoticeCard(mk({ category: 'service', priority: 'high' }));
        expect(urgent.textContent).toContain('⚠ Urgent');
        const empty = api.buildNoticeCard({ title: null, content: null, category: null, priority: null, created_at: null, is_ad: false });
        expect(findByClass(empty, 'notice-card-title')[0].textContent).toBe('');
        expect(findByClass(empty, 'notice-card-desc')[0].textContent).toBe('');
        expect(findByClass(empty, 'notice-cat-badge')[0].textContent).toBe('General');
        const ad = api.buildNoticeCard(mk({ is_ad: true }));
        expect(ad.className).toContain('notice-card--ad');
        expect(ad.textContent).toContain('Ad');
    });

    test('category filtering and the empty state still work', () => {
        const { api, grid, empty } = loadCommunityNoticeSection();
        const list = [mk({ id: 1, title: 'Fix', category: 'service', priority: 'high' }), mk({ id: 2, title: 'Fair', category: 'event' }), mk({ id: 3, title: 'Shop', category: 'business', is_ad: true })];
        api.setFilter('alerts'); api.buildNotices(list);
        expect(grid.children.map(c => findByClass(c, 'notice-card-title')[0].textContent)).toEqual(['Fix']);
        api.setFilter('event'); api.buildNotices(list);
        expect(grid.children.map(c => findByClass(c, 'notice-card-title')[0].textContent)).toEqual(['Fair']);
        api.setFilter('payment'); api.buildNotices(list);
        expect(grid.htmlWrites[grid.htmlWrites.length - 1]).toBe('');
        expect(empty.classList.contains('hidden')).toBe(false);
        api.setFilter('all'); api.buildNotices(list);
        expect(grid.children).toHaveLength(3);
        expect(empty.classList.contains('hidden')).toBe(true);
    });
});

// ============================================
// community.js — ad-request history (HTML template, every dynamic value encoded)
// ============================================
describe('Ad-request history (community.js renderAdHistory)', () => {
    let renderAdHistory;
    beforeAll(() => { renderAdHistory = loadAdHistoryRenderer(); });
    const container = () => { const c = new FakeNode('div', { allowHtml: true }); c.querySelectorAll = () => []; return c; };

    test('hostile business name / content / duration / notes / status produce only the template markup', () => {
        const c = container();
        const reqs = HOSTILE.map((p, i) => ({ id: '0000-' + i, business_name: p, ad_content: p, duration: p, notes: p, status: i % 2 ? 'payment_pending' : p, fee: i % 2 ? 1500 : null, submitted_at: '2026-10-07T09:00:00.000Z' }));
        renderAdHistory(reqs, c);
        const html = c.htmlWrites[0];
        expect(inspectHtml(html, HISTORY_TAGS, HISTORY_ATTRS)).toEqual([]);
        HOSTILE.forEach(p => expect(html).toContain(escapeOnce(p)));
        expect(html).not.toContain('onclick="');
    });

    test('Pay button carries an index, never record data; prototype keys are not treated as statuses', () => {
        const c = container();
        renderAdHistory([{ id: P_ID, business_name: 'Shop', ad_content: 'x', duration: P_JSBRK, notes: null, status: 'payment_pending', fee: 900, submitted_at: '2026-10-07T09:00:00.000Z' },
            { id: 'b', business_name: 'Proto', ad_content: 'x', duration: '7 days', notes: null, status: 'constructor', fee: null, submitted_at: '2026-10-07T09:00:00.000Z' }], c);
        const html = c.htmlWrites[0];
        expect(html).toContain('data-ad-pay="0"');
        expect(html).not.toContain(P_ID);
        expect(html).not.toContain('native code');
        expect(html).toContain('KES 900');
    });

    test('empty history message', () => {
        const c = container();
        renderAdHistory([], c);
        expect(c.htmlWrites[0]).toContain('You have no ad requests yet.');
    });
});

// ============================================
// notice-board.html (standalone page)
// ============================================
describe('notice-board.html (standalone page)', () => {
    const page = () => loadPage('notice-board.html');

    test('escapeHTML is safe for text AND quoted attributes; cssToken yields a single class token', () => {
        const { sandbox } = page();
        HOSTILE.forEach(p => {
            expect(sandbox.escapeHTML(p)).not.toMatch(/[<>"']/);
            expect(unescapeHtml(sandbox.escapeHTML(p))).toBe(p);
            expect(sandbox.cssToken(p)).toMatch(/^[A-Za-z0-9_-]*$/);
        });
        expect(sandbox.escapeHTML(null)).toBe('');
        expect(sandbox.escapeHTML('Tom & Jerry')).toBe('Tom &amp; Jerry');
        expect(sandbox.cssToken('event')).toBe('event');
        expect(sandbox.cssToken(null)).toBe('');
    });

    test('renderNotices: hostile title/content/category/priority/created_by never create markup or attributes', () => {
        const list = HOSTILE.map((p, i) => ({ id: i, title: p, content: p, category: p, priority: p, created_by: p, created_at: '2026-10-07T09:00:00.000Z', expires_at: i % 2 ? '2099-01-01T00:00:00.000Z' : null }));
        list.push({ id: 99, title: 'Legit', content: SWAHILI, category: 'event', priority: 'high', created_by: 'admin', created_at: '2026-10-07T09:00:00.000Z', expires_at: null });
        list.push({ id: 100, title: 'Null priority', content: 'x', category: null, priority: null, created_by: null, created_at: '2026-10-07T09:00:00.000Z', expires_at: null });
        const ctx = page();
        ctx.sandbox.__list = list;
        ctx.run('state.notices = __list; renderNotices();');
        const html = ctx.getNode('noticesContainer').htmlWrites.slice(-1)[0];
        expect(inspectHtml(html, NOTICE_BOARD_TAGS, NOTICE_BOARD_ATTRS)).toEqual([]);
        HOSTILE.forEach(p => expect(html).toContain(escapeOnce(p)));
        expect(html).toContain('badge-priority-high');
        expect(html).toContain(escapeOnce(SWAHILI));
        expect((html.match(/class="notice-card /g) || []).length).toBe(list.length);   // null priority no longer aborts the whole list
    });

    test('showStatus writes the message as text, never as HTML', () => {
        const ctx = page();
        ctx.sandbox.showStatus(P_IMG, 'error');
        const el = ctx.getNode('statusMessage');
        expect(el.htmlWrites).toHaveLength(0);
        expect(el.textContent).toBe(P_IMG);
        expect(el.children[0].tagName).toBe('SPAN');
    });

    test('pagination handlers only interpolate numbers', () => {
        const ctx = page();
        ctx.run('state.page = 2; state.totalPages = 5; renderPagination();');
        const html = ctx.getNode('paginationContainer').htmlWrites.slice(-1)[0];
        const calls = [...html.matchAll(/onclick="fetchNotices\(([^)]*)\)"/g)].map(m => m[1]);
        expect(calls.length).toBeGreaterThan(0);
        calls.forEach(a => expect(a).toMatch(/^[0-9]+$/));
    });
});

// ============================================
// admin-notices.html (admin console)
// ============================================
describe('admin-notices.html (admin console)', () => {
    const page = () => loadPage('admin-notices.html');

    const hostileRequests = () => HOSTILE.map((p, i) => ({
        id: i === 0 ? P_ID : '00000000-0000-4000-8000-00000000000' + i,
        business_name: p, ad_content: p, contact_phone: p, contact_email: p, duration: i === 1 ? 'constructor' : p,
        status: i === 2 ? 'constructor' : (i % 2 ? 'pending' : p), category: i === 3 ? null : p,
        fee: i === 1 ? P_BREAK : 900, notes: p, submitted_at: '2026-10-07T09:00:00.000Z', reviewed_at: null, is_hidden: i === 4
    }));

    test('escapeHTML / cssToken helpers', () => {
        const { sandbox } = page();
        HOSTILE.forEach(p => {
            expect(sandbox.escapeHTML(p)).not.toMatch(/[<>"']/);
            expect(unescapeHtml(sandbox.escapeHTML(p))).toBe(p);
            expect(sandbox.cssToken(p)).toMatch(/^[A-Za-z0-9_-]*$/);
        });
    });

    test('renderNotices: hostile fields stay inert; no inline handler carries a record id', () => {
        const ctx = page();
        ctx.sandbox.__n = HOSTILE.map((p, i) => ({ id: i === 0 ? P_ID : i, title: p, content: p + ' padding to be long enough', category: p, priority: p, isArchived: i === 1 }));
        ctx.run('state.notices = __n; renderNotices();');
        const html = ctx.getNode('noticesContainer').htmlWrites.slice(-1)[0];
        expect(inspectHtml(html, ADMIN_TAGS, ADMIN_ATTRS)).toEqual([]);
        expect(html).not.toContain('onclick="');
        expect(html).toContain('data-notice-action="edit"');
        HOSTILE.forEach(p => expect(html).toContain(escapeOnce(p.length > 100 ? p.substring(0, 100) : p)));
    });

    test('notice Edit / Delete: delegated click hands the record id over verbatim (hostile id included)', () => {
        const ctx = page();
        const calls = [];
        ctx.sandbox.__calls = calls;
        ctx.run('editNotice = id => __calls.push(["edit", id]); openDeleteModal = id => __calls.push(["delete", id]);');
        const listener = ctx.getNode('noticesContainer').listeners.click[0];
        expect(typeof listener).toBe('function');
        [P_ID, '42', P_JSBRK].forEach(id => {
            ['edit', 'delete'].forEach(action => {
                const btn = new FakeNode('button'); btn.setAttribute('data-notice-action', action); btn.setAttribute('data-notice-id', id);
                listener({ target: { closest: sel => (sel === 'button[data-notice-action]' ? btn : null) } });
            });
        });
        listener({ target: { closest: () => null } });   // click on empty area: ignored
        expect(calls).toEqual([['edit', P_ID], ['delete', P_ID], ['edit', '42'], ['delete', '42'], ['edit', P_JSBRK], ['delete', P_JSBRK]]);
    });

    test('renderAdRequests: hostile advertiser data produces only template markup; fee is always numeric', () => {
        const ctx = page();
        ctx.getNode('arStatusFilter').value = 'all';
        ctx.sandbox.__r = hostileRequests();
        ctx.run('allAdRequests = __r; renderAdRequests();');
        const html = ctx.getNode('adRequestsContainer').htmlWrites.slice(-1)[0];
        expect(inspectHtml(html, ADMIN_TAGS, ADMIN_ATTRS)).toEqual([]);
        expect(html).not.toContain('onclick="');
        expect(html).not.toContain('native code');
        HOSTILE.forEach(p => expect(html).toContain(escapeOnce(p)));
        const fees = [...html.matchAll(/value="([^"]*)"/g)].map(m => m[1]);
        expect(fees.length).toBeGreaterThan(0);
        fees.forEach(v => expect(v).toMatch(/^[0-9]+$/));
        // the hostile id appears only HTML-encoded, inside data-ar-id / id attributes
        expect(html).not.toContain(P_ID);
        expect(html).toContain('data-ar-id="' + escapeOnce(P_ID) + '"');
    });

    test('ad-request buttons: delegated click maps each action to the right call with the verbatim id', () => {
        const ctx = page();
        const calls = [];
        ctx.sandbox.__calls = calls;
        ctx.run('updateAdRequest = (id, s) => __calls.push(["status", id, s]); toggleHideAdRequest = (id, h) => __calls.push(["hide", id, h]); deleteAdRequest = (id, n) => __calls.push(["delete", id, n]);');
        ctx.getNode('arFee-' + P_ID).value = '';
        const listener = ctx.getNode('adRequestsContainer').listeners.click[0];
        const press = attrs => { const b = new FakeNode('button'); Object.keys(attrs).forEach(k => b.setAttribute(k, attrs[k])); listener({ target: { closest: sel => (sel === 'button[data-ar-action]' ? b : null) } }); };
        press({ 'data-ar-action': 'status', 'data-ar-id': P_ID, 'data-ar-status': 'approved' });
        press({ 'data-ar-action': 'toggle-hide', 'data-ar-id': P_ID, 'data-ar-hide': 'true' });
        press({ 'data-ar-action': 'toggle-hide', 'data-ar-id': 'b', 'data-ar-hide': 'false' });
        press({ 'data-ar-action': 'delete', 'data-ar-id': P_ID });
        press({ 'data-ar-action': 'fee-preset', 'data-ar-id': P_ID, 'data-ar-fee': '1500' });
        expect(calls).toEqual([['status', P_ID, 'approved'], ['hide', P_ID, true], ['hide', 'b', false], ['delete', P_ID, undefined]]);
        expect(ctx.getNode('arFee-' + P_ID).value).toBe(1500);
    });

    test('deleteAdRequest resolves the business name locally (not through a handler argument)', async () => {
        const ctx = page();
        const asked = [];
        ctx.sandbox.confirm = m => { asked.push(m); return false; };
        ctx.sandbox.__r = [{ id: 'abc', business_name: P_JSBRK }];
        ctx.run('allAdRequests = __r;');
        await ctx.run('deleteAdRequest("abc")');
        expect(asked).toHaveLength(1);
        expect(asked[0]).toContain(P_JSBRK);
    });
});

// ============================================
// Source guards (static): the unsafe patterns must not come back
// ============================================
describe('Static source guards', () => {

    test('no inline event-handler attribute interpolates record data (admin console, community.js)', () => {
        ['admin-notices.html', 'js/community.js'].forEach(f => {
            const offenders = read(f).split(/\r?\n/).filter(l => /\bon[a-z]+\s*=\s*(?:"[^"]*\$\{|'[^']*\$\{)/i.test(l));
            expect(offenders).toEqual([]);
        });
    });

    test('notice-board.html inline handlers interpolate only the numeric pagination index', () => {
        const hits = [...read('notice-board.html').matchAll(/\bon[a-z]+\s*=\s*"[^"]*\$\{([^}]*)\}/gi)].map(m => m[1].trim());
        hits.forEach(expr => expect(expr).toBe('i'));
    });

    test('community.js notice section assigns innerHTML only from constant strings', () => {
        const { src } = loadCommunityNoticeSection();
        const lines = src.split(/\r?\n/).filter(l => /\.innerHTML\s*=/.test(l));
        expect(lines.length).toBeGreaterThan(0);
        lines.forEach(l => expect(l).toMatch(/\.innerHTML\s*=\s*(?:'(?:[^'\\$]|\\.)*'|"(?:[^"\\$]|\\.)*")\s*;/));
    });

    test('the fix does not depend on the backend (nothing assumes notices arrive pre-sanitized)', () => {
        // data reaches textContent / escaped templates exactly once: a stored literal "&lt;" must display as "&lt;"
        const { api } = loadCommunityNoticeSection();
        const card = api.buildNoticeCard({ title: '&lt;b&gt; already escaped?', content: '&amp;', category: 'general', priority: 'normal', is_ad: false });
        expect(findByClass(card, 'notice-card-title')[0].textContent).toBe('&lt;b&gt; already escaped?');
    });
});
