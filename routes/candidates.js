// routes/candidates.js
// Phase 4B.2B: extracted verbatim from server.js. Contains only the two
// candidate routes confirmed to have no dependency on server.js's shared
// staticDataCache (getCached/setCached/invalidateStaticCache) — that cache
// is also used by the geography routes (counties/constituencies/wards),
// which are out of scope for this phase, so it could not move or be
// duplicated without violating Stop Condition 5. See the Phase 4B.2B
// report for the full reasoning and for what stayed in server.js because
// of it (GET /api/candidates, and the write side of
// POST/PUT/DELETE /api/admin/candidates).

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../bootstrap/database');
const RBAC = require('../lib/rbac');

const router = express.Router();

// ── Candidate Photo Upload (Multer) ──
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'candidates');
// Ensure upload directory exists at startup (no crash if already present)
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const candidateStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, unique);
  }
});

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const candidateUpload = multer({
  storage: candidateStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, JPEG, PNG, and WEBP images are allowed'));
  }
});

// POST /api/admin/candidates/upload-photo — upload a candidate photo, return its public path
// Phase 4A.2: WARD_ADMIN+ (candidates are ward-managed content per the RBAC
// role hierarchy). No wardId is available on this route to scope-check
// against — it's a stateless file-upload utility, not tied to any specific
// candidate record — so role-only gating is all that applies here.
router.post('/api/admin/candidates/upload-photo', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), (req, res) => {
  candidateUpload.single('photo')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: 'Image must be smaller than 5 MB' });
      return res.status(400).json({ success: false, error: err.message });
    }
    if (err) return res.status(400).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    // Return a public URL path that works with express.static
    const publicPath = `/uploads/candidates/${req.file.filename}`;
    return res.json({ success: true, url: publicPath });
  });
});

// GET /api/admin/candidates?category=MCA — list candidates (optionally filtered)
// Phase 4A.2: WARD_ADMIN+. Note: this route has no ward/geography filter to
// scope-check against (returns all wards' candidates for any caller who
// passes the role gate) — a pre-existing route-design limitation, not
// something this migration adds filtering logic to invent a fix for.
// Phase 4A.4: read-side scope added. SUPER_ADMIN/MODERATOR unchanged
// (global); COUNTY_ADMIN/CONSTITUENCY_ADMIN/WARD_ADMIN now only see
// candidates within their own county/constituency/ward, joined through
// wards/constituencies since candidates only stores ward_id directly.
router.get('/api/admin/candidates', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  const { category } = req.query;
  try {
    const scope = RBAC.resolveReadScope(req.user);
    const baseParams = category ? [category] : [];
    const { clause: scopeClause, params } = RBAC.buildScopeFilter(
      scope,
      { ward: 'c.ward_id', constituency: 'w.constituency_id', county: 'con.county_id' },
      baseParams
    );
    const conditions = [];
    if (category) conditions.push('c.category = $1');
    if (scopeClause) conditions.push(scopeClause);
    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT c.* FROM candidates c
         LEFT JOIN wards w ON w.id = c.ward_id
         LEFT JOIN constituencies con ON con.id = w.constituency_id
       ${whereSql}
       ORDER BY c.category, c.display_order, c.id`,
      params
    );
    res.json({ success: true, candidates: result.rows });
  } catch (err) {
    console.error('GET /api/admin/candidates error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
