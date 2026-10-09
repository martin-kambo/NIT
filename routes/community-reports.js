// routes/community-reports.js
// Engage extension: civic reports (with photos), community support, and consultations.
// Additive only. Does NOT touch forum_posts, /api/forum, lib/forum.js or any voting table.
// Reports are a separate record type; a forum post may reference one via related_report_ref
// on the client, but no report is ever copied into forum_posts.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { pool } = require('../bootstrap/database');
const { verifySession } = require('../lib/auth/session');
const { getFoundingWardId } = require('../lib/ward-cache');
const RBAC = require('../lib/rbac');

const router = express.Router();

const CATEGORIES = ['Roads & Transport', 'Waste Management', 'Water', 'Street Lighting', 'Public Safety', 'Unlicensed Business', 'Other'];
const STATUSES = ['Reported', 'Under Review', 'Assigned', 'In Progress', 'Resolved', 'Rejected'];

// ---------- schema (idempotent, additive) ----------
async function ensureCommunityReportsTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS community_reports (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ward_id INT,
    category VARCHAR(40) NOT NULL,
    title VARCHAR(140) NOT NULL,
    description TEXT,
    location VARCHAR(200),
    status VARCHAR(20) NOT NULL DEFAULT 'Reported',
    demo_support INT NOT NULL DEFAULT 0,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS community_report_photos (
    id SERIAL PRIMARY KEY,
    report_id INT NOT NULL REFERENCES community_reports(id) ON DELETE CASCADE,
    path VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS community_report_supports (
    report_id INT NOT NULL REFERENCES community_reports(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (report_id, user_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS community_report_events (
    id SERIAL PRIMARY KEY,
    report_id INT NOT NULL REFERENCES community_reports(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL,
    note VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS consultations (
    id SERIAL PRIMARY KEY, ward_id INT, title VARCHAR(160) NOT NULL, description TEXT,
    opens_on DATE, closes_on DATE, venue VARCHAR(160), status VARCHAR(20) DEFAULT 'Open',
    is_demo BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS consultation_views (
    id SERIAL PRIMARY KEY, consultation_id INT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, body VARCHAR(1500) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS consultation_rsvps (
    consultation_id INT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(), UNIQUE (consultation_id, user_id))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cr_ward_status ON community_reports (ward_id, status)`);

  // Demo seed (idempotent): only when the tables are empty. Clearly flagged is_demo.
  const wardId = getFoundingWardId() || null;
  if (!(await pool.query('SELECT 1 FROM community_reports LIMIT 1')).rows.length) {
    const seed = [
      [249, 'Waste Management', 'Blocked drainage at Ngoliba Market', 'Ngoliba Market', 'In Progress', 37],
      [250, 'Street Lighting', 'Broken streetlights along Ngoliba Road', 'Ngoliba Road', 'Reported', 24],
      [251, 'Waste Management', 'Irregular waste collection', 'Estate 2', 'Resolved', 51],
    ];
    for (const [id, cat, title, loc, st, sup] of seed) {
      await pool.query(
        `INSERT INTO community_reports (id, ward_id, category, title, description, location, status, demo_support, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) ON CONFLICT (id) DO NOTHING`,
        [id, wardId, cat, title, 'Demo report for presentation.', loc, st, sup]);
      await pool.query(`INSERT INTO community_report_events (report_id, status, note) VALUES ($1,'Reported','Report submitted'),($1,$2,'Demo status')`, [id, st]);
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('community_reports','id'), GREATEST((SELECT MAX(id) FROM community_reports), 251))`);
  }
  if (!(await pool.query('SELECT 1 FROM consultations LIMIT 1')).rows.length) {
    await pool.query(`INSERT INTO consultations (ward_id,title,description,opens_on,closes_on,venue,is_demo) VALUES
      ($1,'Ward Development Priorities 2026','Residents are invited to submit views on priority development projects.','2026-09-15','2026-10-14','Ngoliba Social Hall, 7 Oct 10am',true),
      ($1,'Draft Waste Management Plan','Comment on collection routes and schedules.','2026-09-20','2026-10-20','Online only',true)`, [wardId]);
  }
}

// ---------- helpers ----------
const ref = (id) => `REP-${new Date().getFullYear()}-${String(1000 + id).padStart(6, '0')}`;
const clean = (s, max) => String(s || '').replace(/<[^>]*>/g, '').trim().slice(0, max);
const session = (req) => verifySession(req.headers.cookie || '');
const isOfficer = (req) => req.user && RBAC.rankOf ? RBAC.rankOf(req.user.role) >= RBAC.rankOf(RBAC.ROLES.WARD_ADMIN) : false;

// Strict positive int32 id parser: '12' -> 12; '12abc', '-1', '0', '1e3', '99999999999' -> null.
function parseId(raw) {
  const s = String(raw);
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 2147483647 ? n : null;
}

// Consultation lifecycle (Phase 4B.31). ONE definition, used by the resident list, the write
// guards and the officer list, so what the UI shows as "Open" is exactly what the API accepts.
// Open = stored status is 'Open' AND the closing day has not finished. The closing day is
// inclusive and is evaluated on the Africa/Nairobi calendar date, independent of server/DB timezone.
const CONSULT_OPEN_SQL = `(COALESCE(c.status, 'Open') = 'Open' AND (c.closes_on IS NULL OR c.closes_on >= (NOW() AT TIME ZONE 'Africa/Nairobi')::date))`;
// Geography joins + scope columns for officer reads (same pattern as GET /api/admin/notices).
const CONSULT_GEO_JOIN = `LEFT JOIN wards w ON w.id = c.ward_id LEFT JOIN constituencies con ON con.id = w.constituency_id`;
const CONSULT_SCOPE_COLS = { ward: 'c.ward_id', constituency: 'w.constituency_id', county: 'con.county_id' };

function publicReport(r, photos, mine, latest) {
  return { id: r.id, reference: ref(r.id), title: r.title, category: r.category, location: r.location,
    description: r.description, status: r.status, ward: r.ward_name || 'Your ward', demo: r.is_demo,
    createdAt: r.created_at, supporters: parseInt(r.supporters) || 0, supportedByMe: !!mine,
    latestUpdate: latest || null,   // { status, note, at } from community_report_events, or null
    photos: photos || [] };   // no reporter identity is ever exposed
}

const REPORT_SQL = `SELECT r.*, w.name AS ward_name,
  (r.demo_support + (SELECT COUNT(*) FROM community_report_supports s WHERE s.report_id = r.id)) AS supporters
  FROM community_reports r LEFT JOIN wards w ON w.id = r.ward_id`;

async function hydrate(rows, userId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = await pool.query('SELECT report_id, path FROM community_report_photos WHERE report_id = ANY($1) ORDER BY id', [ids]);
  const sup = userId ? await pool.query('SELECT report_id FROM community_report_supports WHERE user_id = $1 AND report_id = ANY($2)', [userId, ids]) : { rows: [] };
  const sset = new Set(sup.rows.map((x) => x.report_id));
  // Latest status-history entry per report (one batched query; no schema change).
  const lt = await pool.query(`SELECT DISTINCT ON (report_id) report_id, status, note, created_at
    FROM community_report_events WHERE report_id = ANY($1) ORDER BY report_id, id DESC`, [ids]);
  const latest = new Map(lt.rows.map((x) => [x.report_id, { status: x.status, note: x.note, at: x.created_at }]));
  return rows.map((r) => publicReport(r, ph.rows.filter((p) => p.report_id === r.id).map((p) => p.path), sset.has(r.id), latest.get(r.id)));
}

// ---------- uploads (validated: type, size, count, magic bytes) ----------
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'reports');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, UPLOAD_DIR),
    filename: (_r, f, cb) => cb(null, `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${EXT[f.mimetype] || '.bin'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 4 },
  fileFilter: (_r, f, cb) => (EXT[f.mimetype] ? cb(null, true) : cb(new Error('Only JPG, PNG or WEBP images are allowed'))),
});
function looksLikeImage(file) {
  const b = Buffer.alloc(12); const fd = fs.openSync(file, 'r'); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
  return (b[0] === 0xff && b[1] === 0xd8) || b.slice(1, 4).toString() === 'PNG' || (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP');
}
const reportLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many reports. Please wait before submitting again.' } });

// ---------- report routes ----------
router.get('/api/community-reports', async (req, res) => {
  try {
    const s = session(req); const params = [req.wardId]; let where = 'WHERE r.ward_id = $1';
    if (req.query.status && STATUSES.includes(req.query.status)) { params.push(req.query.status); where += ` AND r.status = $${params.length}`; }
    if (req.query.mine === '1' && s) { params.push(s.userId); where += ` AND r.user_id = $${params.length}`; }
    const { rows } = await pool.query(`${REPORT_SQL} ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT 100`, params);
    res.json({ success: true, reports: await hydrate(rows, s && s.userId) });
  } catch (e) { console.error('GET /api/community-reports', e.message); res.status(500).json({ success: false, error: 'Failed to load reports' }); }
});

router.get('/api/community-reports/:id', async (req, res) => {
  try {
    const id = parseInt(String(req.params.id).replace(/^REP-\d{4}-0*/, ''), 10) - 1000;
    if (!(id > 0)) return res.status(400).json({ success: false, error: 'Invalid reference' });
    const s = session(req);
    const { rows } = await pool.query(`${REPORT_SQL} WHERE r.id = $1 AND r.ward_id = $2`, [id, req.wardId]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Report not found' });
    const ev = await pool.query('SELECT status, note, created_at FROM community_report_events WHERE report_id = $1 ORDER BY id', [id]);
    res.json({ success: true, report: (await hydrate(rows, s && s.userId))[0], events: ev.rows });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to load report' }); }
});

router.post('/api/community-reports', reportLimiter, (req, res) => {
  const s = session(req);
  if (!s) return res.status(401).json({ success: false, error: 'Login required to submit a report' });
  upload.array('photos', 4)(req, res, async (err) => {
    const files = req.files || [];
    const discard = () => files.forEach((f) => fs.unlink(f.path, () => {}));
    if (err) { discard(); return res.status(400).json({ success: false, error: err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5 MB or smaller' : err.message }); }
    const title = clean(req.body.title, 140), description = clean(req.body.description, 2000), location = clean(req.body.location, 200);
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : null;
    if (title.length < 5 || !category || description.length < 10) { discard(); return res.status(400).json({ success: false, error: 'Title (5+), category and description (10+) are required' }); }
    if (files.some((f) => !looksLikeImage(f.path))) { discard(); return res.status(400).json({ success: false, error: 'One of the files is not a valid image' }); }
    try {
      const ins = await pool.query(`INSERT INTO community_reports (user_id, ward_id, category, title, description, location)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at, status`, [s.userId, req.wardId, category, title, description, location]);
      const r = ins.rows[0];
      for (const f of files) await pool.query('INSERT INTO community_report_photos (report_id, path) VALUES ($1,$2)', [r.id, `/uploads/reports/${f.filename}`]);
      await pool.query(`INSERT INTO community_report_events (report_id, status, note) VALUES ($1,'Reported','Report submitted'),($1,'Reported','Ward officer notified')`, [r.id]);
      res.status(201).json({ success: true, reference: ref(r.id), category, location, status: r.status, createdAt: r.created_at, photos: files.length });
    } catch (e) { discard(); console.error('POST /api/community-reports', e.message); res.status(500).json({ success: false, error: 'Failed to save report' }); }
  });
});

// Support = one per user per report; calling again removes it (same pattern as forum likes).
router.post('/api/community-reports/:id/support', async (req, res) => {
  const s = session(req);
  if (!s) return res.status(401).json({ success: false, error: 'Login required to support a report' });
  try {
    const id = parseInt(req.params.id, 10);
    const ok = await pool.query('SELECT 1 FROM community_reports WHERE id = $1 AND ward_id = $2', [id, req.wardId]);
    if (!ok.rows.length) return res.status(404).json({ success: false, error: 'Report not found' });
    const ins = await pool.query('INSERT INTO community_report_supports (report_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, s.userId]);
    if (!ins.rowCount) await pool.query('DELETE FROM community_report_supports WHERE report_id = $1 AND user_id = $2', [id, s.userId]);
    const c = await pool.query(`SELECT (demo_support + (SELECT COUNT(*) FROM community_report_supports WHERE report_id = $1)) AS n FROM community_reports WHERE id = $1`, [id]);
    res.json({ success: true, supported: !!ins.rowCount, supporters: parseInt(c.rows[0].n) });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to update support' }); }
});

// ---------- officer routes (RBAC enforced server-side) ----------
router.get('/api/admin/community-reports', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  try {
    const all = RBAC.rankOf(req.user.role) >= RBAC.rankOf(RBAC.ROLES.COUNTY_ADMIN);
    const { rows } = all ? await pool.query(`${REPORT_SQL} ORDER BY r.created_at DESC LIMIT 200`)
      : await pool.query(`${REPORT_SQL} WHERE r.ward_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [req.user.adminWardId || req.wardId]);
    res.json({ success: true, reports: await hydrate(rows, null) });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to load queue' }); }
});

router.patch('/api/community-reports/:id/status', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  const status = req.body && req.body.status, id = parseInt(req.params.id, 10);
  if (!STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });
  try {
    const cur = await pool.query('SELECT ward_id FROM community_reports WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: 'Report not found' });
    if (!RBAC.hasPermission(req, { role: RBAC.ROLES.WARD_ADMIN, wardId: cur.rows[0].ward_id }))
      return res.status(403).json({ success: false, error: 'Not authorised for this ward' });
    await pool.query('UPDATE community_reports SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
    await pool.query('INSERT INTO community_report_events (report_id, status, note) VALUES ($1,$2,$3)', [id, status, clean(req.body.note, 200) || 'Status updated by ward officer']);
    res.json({ success: true, reference: ref(id), status });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to update status' }); }
});

// ---------- consultations ----------
router.get('/api/consultations', async (req, res) => {
  try {
    const s = session(req);
    const params = [req.wardId];
    if (s) params.push(s.userId);
    const { rows } = await pool.query(`SELECT c.*, w.name AS ward_name, ${CONSULT_OPEN_SQL} AS is_open,
      (SELECT COUNT(DISTINCT u) FROM (SELECT user_id u FROM consultation_views WHERE consultation_id = c.id
        UNION SELECT user_id FROM consultation_rsvps WHERE consultation_id = c.id) x) AS participants,
      ${s ? 'EXISTS (SELECT 1 FROM consultation_rsvps WHERE consultation_id = c.id AND user_id = $2)' : 'false'} AS rsvped
      FROM consultations c LEFT JOIN wards w ON w.id = c.ward_id WHERE c.ward_id = $1 ORDER BY c.closes_on`, params);
    res.json({ success: true, consultations: rows.map((c) => ({ id: c.id, title: c.title, description: c.description, opensOn: c.opens_on, closesOn: c.closes_on,
      venue: c.venue, status: c.is_open ? 'Open' : 'Closed', participants: parseInt(c.participants) || 0, rsvped: c.rsvped,
      ward: c.ward_name || 'Your ward', demo: !!c.is_demo })) });
  } catch (e) { res.status(500).json({ success: false, error: 'Failed to load consultations' }); }
});

// Shared guard for consultation WRITES (views, RSVP). Sends the error response itself and returns null on
// any failure; otherwise returns { s, id }. Checks, in order: authenticated session -> valid id ->
// consultation exists IN THE CALLER'S OWN WARD (server-derived req.wardId; a consultation of another ward
// is reported as 404, never confirmed) -> consultation is open.
async function consultationWriteGuard(req, res) {
  const s = session(req);
  if (!s) { res.status(401).json({ success: false, error: 'Login required' }); return null; }
  if (!req.user) { res.status(503).json({ success: false, error: 'Could not verify your account. Please try again.' }); return null; }
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ success: false, error: 'Invalid consultation id' }); return null; }
  const { rows } = await pool.query(`SELECT c.id, ${CONSULT_OPEN_SQL} AS is_open FROM consultations c WHERE c.id = $1 AND c.ward_id = $2`, [id, req.wardId]);
  if (!rows.length) { res.status(404).json({ success: false, error: 'Consultation not found' }); return null; }
  if (!rows[0].is_open) { res.status(409).json({ success: false, error: 'This consultation is closed' }); return null; }
  return { s, id };
}
const writeError = (res, e, msg) => e && e.code === '23503'   // FK violation: session is valid but the user row is gone
  ? res.status(401).json({ success: false, error: 'Your session is no longer valid. Please log in again.' })
  : res.status(500).json({ success: false, error: msg });

router.post('/api/consultations/:id/views', async (req, res) => {
  try {
    const g = await consultationWriteGuard(req, res); if (!g) return;
    const body = clean(req.body && req.body.text, 1500);
    if (body.length < 5) return res.status(400).json({ success: false, error: 'Please write at least 5 characters' });
    await pool.query('INSERT INTO consultation_views (consultation_id, user_id, body) VALUES ($1,$2,$3)', [g.id, g.s.userId, body]);
    res.status(201).json({ success: true });
  } catch (e) { writeError(res, e, 'Failed to submit view'); }
});
router.post('/api/consultations/:id/rsvp', async (req, res) => {
  try {
    const g = await consultationWriteGuard(req, res); if (!g) return;
    const ins = await pool.query('INSERT INTO consultation_rsvps (consultation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.id, g.s.userId]);
    res.json({ success: true, alreadyRsvped: !ins.rowCount });
  } catch (e) { writeError(res, e, 'Failed to RSVP'); }
});

// ---------- consultation officer read path (WARD_ADMIN and above, scoped) ----------
// Scope comes from RBAC.resolveReadScope(req.user): WARD_ADMIN -> own admin ward, CONSTITUENCY_ADMIN -> own
// constituency, COUNTY_ADMIN -> own county, SUPER_ADMIN -> everything. A VOTER/MODERATOR never reaches here
// (requireMinRole). Residents have no read path to other residents' submissions.
router.get('/api/admin/consultations', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  try {
    const f = RBAC.buildScopeFilter(RBAC.resolveReadScope(req.user), CONSULT_SCOPE_COLS, []);
    const { rows } = await pool.query(`SELECT c.id, c.title, c.opens_on, c.closes_on, c.venue, c.is_demo, w.name AS ward_name,
        ${CONSULT_OPEN_SQL} AS is_open,
        (SELECT COUNT(*) FROM consultation_views v WHERE v.consultation_id = c.id) AS views,
        (SELECT COUNT(*) FROM consultation_rsvps r WHERE r.consultation_id = c.id) AS rsvps
      FROM consultations c ${CONSULT_GEO_JOIN} ${f.clause ? 'WHERE ' + f.clause : ''}
      ORDER BY c.closes_on DESC NULLS LAST, c.id DESC LIMIT 200`, f.params);
    res.json({ success: true, consultations: rows.map((c) => ({ id: c.id, title: c.title, ward: c.ward_name || null, opensOn: c.opens_on, closesOn: c.closes_on,
      venue: c.venue, status: c.is_open ? 'Open' : 'Closed', demo: !!c.is_demo, views: parseInt(c.views) || 0, rsvps: parseInt(c.rsvps) || 0 })) });
  } catch (e) { console.error('GET /api/admin/consultations', e.message); res.status(500).json({ success: false, error: 'Failed to load consultations' }); }
});

// Submitted views for ONE consultation. No user identifier of any kind is returned (no id, name, phone).
router.get('/api/admin/consultations/:id/views', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid consultation id' });
    const f = RBAC.buildScopeFilter(RBAC.resolveReadScope(req.user), CONSULT_SCOPE_COLS, [id]);
    const c = await pool.query(`SELECT c.id, c.title, w.name AS ward_name, ${CONSULT_OPEN_SQL} AS is_open, (${f.clause || 'true'}) AS in_scope
      FROM consultations c ${CONSULT_GEO_JOIN} WHERE c.id = $1`, f.params);
    if (!c.rows.length) return res.status(404).json({ success: false, error: 'Consultation not found' });
    if (!c.rows[0].in_scope) return res.status(403).json({ success: false, error: 'Not authorised for this consultation' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const [tot, rows] = await Promise.all([
      pool.query('SELECT COUNT(*) AS n FROM consultation_views WHERE consultation_id = $1', [id]),
      pool.query('SELECT id, body, created_at FROM consultation_views WHERE consultation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3', [id, limit, offset]),
    ]);
    res.json({ success: true, consultation: { id, title: c.rows[0].title, ward: c.rows[0].ward_name || null, status: c.rows[0].is_open ? 'Open' : 'Closed' },
      total: parseInt(tot.rows[0].n) || 0, limit, offset, views: rows.rows.map((v) => ({ id: v.id, text: v.body, createdAt: v.created_at })) });
  } catch (e) { console.error('GET /api/admin/consultations/:id/views', e.message); res.status(500).json({ success: false, error: 'Failed to load submissions' }); }
});

// ---------- My Ward (resident overview, read-only) ----------
// Ward identity is NEVER taken from the client: it is req.wardId (the logged-in user's own ward_id, resolved by
// the session middleware in server.js). The lists on the My Ward screen come from the existing endpoints
// (/api/community-reports, /api/consultations, /api/notices); this route supplies identity, headline counts and
// the recent-activity feed, all from existing tables. Reports carry no coordinates today, so there is no map data.
router.get('/api/my-ward', async (req, res) => {
  if (!session(req)) return res.status(401).json({ success: false, error: 'Login required' });
  try {
    const w = await pool.query(`SELECT w.id, w.name, con.name AS constituency, cty.name AS county
      FROM wards w LEFT JOIN constituencies con ON con.id = w.constituency_id LEFT JOIN counties cty ON cty.id = con.county_id
      WHERE w.id = $1`, [req.wardId]);
    if (!w.rows.length) return res.status(404).json({ success: false, error: 'Ward not found' });
    const [sum, act, cons] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'Resolved') AS resolved,
          COUNT(*) FILTER (WHERE status NOT IN ('Resolved','Rejected')) AS active, COUNT(*) FILTER (WHERE is_demo) AS demo
        FROM community_reports WHERE ward_id = $1`, [req.wardId]),
      pool.query(`SELECT * FROM (
          SELECT DISTINCT ON (e.report_id) e.report_id, e.status, e.note, e.created_at, r.title, r.is_demo
          FROM community_report_events e JOIN community_reports r ON r.id = e.report_id
          WHERE r.ward_id = $1 ORDER BY e.report_id, e.id DESC) x
        ORDER BY x.created_at DESC, x.report_id DESC LIMIT 6`, [req.wardId]),
      pool.query(`SELECT COUNT(*) AS n FROM consultations c WHERE c.ward_id = $1 AND ${CONSULT_OPEN_SQL}`, [req.wardId]),
    ]);
    const k = sum.rows[0];
    res.json({ success: true,
      ward: { id: w.rows[0].id, name: w.rows[0].name, constituency: w.rows[0].constituency || null, county: w.rows[0].county || null },
      summary: { reports: { total: parseInt(k.total) || 0, active: parseInt(k.active) || 0, resolved: parseInt(k.resolved) || 0, demo: parseInt(k.demo) || 0 },
        consultationsOpen: parseInt(cons.rows[0].n) || 0 },
      activity: act.rows.map((a) => ({ reference: ref(a.report_id), title: a.title, status: a.status, note: a.note, at: a.created_at, demo: !!a.is_demo })) });
  } catch (e) { console.error('GET /api/my-ward', e.message); res.status(500).json({ success: false, error: 'Failed to load your ward' }); }
});

module.exports = router;
module.exports.ensureCommunityReportsTables = ensureCommunityReportsTables;
