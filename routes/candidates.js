// routes/candidates.js
// Phase 4B.2B extracted the two routes below with no dependency on
// server.js's shared staticDataCache. Phase 4B.8 completes the Candidates
// domain: the cache (lib/static-cache.js), requirePermission()
// (lib/rbac.js), and the founding-ward singleton (lib/ward-cache.js) were
// each given a single-owner module home in Phase 4B.5, which removed the
// blocker that had kept GET /api/candidates and the write side of
// POST/PUT/DELETE /api/admin/candidates in server.js. All five candidate
// routes now live in this file.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../bootstrap/database');
const RBAC = require('../lib/rbac');
const { requirePermission } = RBAC;
const { getCached, setCached, invalidateStaticCache } = require('../lib/static-cache');
const {
  getAllCandidates,
  getCandidatesByCategory,
  FALLBACK_CANDIDATES,
  getCandidateWard,
  createCandidate,
  updateCandidate,
  deleteCandidate,
} = require('../lib/candidates');
const { getFoundingWardId } = require('../lib/ward-cache');

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


// ────────────────────────────────────────────────────────────────────────────
// Phase 4B.8: the remaining Candidates-domain routes below, moved
// verbatim from server.js -- GET /api/candidates (public read) and
// POST/PUT/DELETE /api/admin/candidates (mutations). Each was blocked
// from moving earlier only by the shared staticDataCache/
// requirePermission()/founding-ward dependencies, all resolved in
// Phase 4B.5. Every query, RBAC check, cache-invalidation call, and
// response shape below is byte-for-byte identical to the original
// inline version (only the line-ending style was normalized to match
// this file's existing LF convention, matching server.js's own CRLF
// only in content, not in bytes).
// ────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════
// ROUTE: /api/candidates (PUBLIC - NO AUTH REQUIRED)
// Supports ?category=MCA|MP|Governor|WomenRep
// Defaults to all candidates when no category specified (backward compat)
// Candidate data now comes exclusively from lib/candidates.js, which reads
// the `candidates` table — no in-memory candidate list lives in this file
// anymore (Phase 2.6C candidate fragmentation fix).
// ════════════════════════════════════════════════
router.get('/api/candidates', async (req, res) => {
  try {
    const { category } = req.query;
    const cacheKey = category
      ? `candidates:cat:${category}:ward:${req.wardId}`
      : `candidates:all:ward:${req.wardId}`;
    let candidates = getCached(cacheKey);
    if (candidates === undefined) {
      candidates = category
        ? await getCandidatesByCategory(pool, category, req.wardId)
        : await getAllCandidates(pool, req.wardId);
      setCached(cacheKey, candidates);
    }

    return res.json({ success: true, candidates });
  } catch (e) {
    console.error('/api/candidates error:', e);
    return res.json({ success: true, candidates: FALLBACK_CANDIDATES.map(c => ({ ...c, category: 'MCA' })) });
  }
});


// ══════════════════════════════════════════════════════════════════════
// ADMIN CANDIDATE MANAGEMENT — Multi-category support
// All routes require X-Admin-Password header (same as notices admin)
// ══════════════════════════════════════════════════════════════════════

// GET /api/admin/candidates moved to routes/candidates.js (Phase 4B.2B)
// — cache-independent (this route never touched getCached/setCached/
// invalidateStaticCache), safe to move as a complete route.

// POST /api/admin/candidates — add a new candidate
// Phase 4A.2: WARD_ADMIN+, scope-checked against the target wardId.
router.post('/api/admin/candidates', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  const { name, party, bio, img, category, incumbent, wardId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'name is required' });
  // Phase 4B.2B: `cat` normalization now happens inside createCandidate()
  // itself (lib/candidates.js) — no longer needed here.
  // Phase 3A Task 6: was hardcoded getFoundingWardId(). wardId now read from
  // body (sent by admin.html's new County→Constituency→Ward selector),
  // falling back so existing calls that don't send it keep working.
  const resolvedWardId = parseInt(wardId, 10) || getFoundingWardId();
  // Phase 4A.2: caller must actually administer the ward they're creating
  // this candidate in (SUPER_ADMIN bypasses via hasPermission's own check).
  if (!requirePermission(req, res, { wardId: resolvedWardId })) return;
  try {
    // Phase 4B.2B: SQL moved to lib/candidates.js createCandidate() — same
    // max-display_order-then-INSERT logic, called here instead of inline.
    const candidate = await createCandidate(pool, { name, party, bio, img, category, incumbent, wardId: resolvedWardId });
    // Pre-Phase 3B Task 3: invalidate the candidates cache so the very
    // next read (even one racing in immediately after this response)
    // sees the newly-created candidate, not a stale cached list.
    invalidateStaticCache('candidates');
    res.json({ success: true, candidate });
  } catch (err) {
    console.error('POST /api/admin/candidates error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/candidates/:id — edit an existing candidate
// Phase 4A.2: WARD_ADMIN+, scope-checked against the candidate's current
// ward (so a WARD_ADMIN can't edit a candidate outside their own ward just
// by omitting wardId from the request) and, if the request also reassigns
// the candidate to a different ward, against that target ward too.
router.put('/api/admin/candidates/:id', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  const { name, party, bio, img, category, incumbent, wardId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'name is required' });
  // Phase 4B.2B: `cat` normalization now happens inside updateCandidate()
  // itself (lib/candidates.js) — no longer needed here.
  try {
    // Phase 4B.2B: SQL moved to lib/candidates.js getCandidateWard().
    const currentWard = await getCandidateWard(pool, req.params.id);
    if (currentWard === undefined) return res.status(404).json({ success: false, error: 'Candidate not found' });
    if (!requirePermission(req, res, { wardId: currentWard })) return;

    // Phase 3A Task 7: ward_id is only updated when wardId is supplied in
    // the request — omitting it (as every pre-existing caller does) leaves
    // the candidate's ward exactly as it was, so existing edits keep
    // working unchanged.
    const parsedWardId = parseInt(wardId, 10);
    const hasWardId = !isNaN(parsedWardId);
    if (hasWardId && !requirePermission(req, res, { wardId: parsedWardId })) return;

    // Phase 4B.2B: SQL moved to lib/candidates.js updateCandidate() — same
    // conditional (with/without ward_id) UPDATE, called here instead of inline.
    const candidate = await updateCandidate(pool, req.params.id, { name, party, bio, img, category, incumbent, wardId: parsedWardId, hasWardId });
    if (!candidate) return res.status(404).json({ success: false, error: 'Candidate not found' });
    invalidateStaticCache('candidates');
    res.json({ success: true, candidate });
  } catch (err) {
    console.error('PUT /api/admin/candidates/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/candidates/:id — remove a candidate
// Phase 4A.2: WARD_ADMIN+, scope-checked against the candidate's current ward.
router.delete('/api/admin/candidates/:id', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  try {
    // Phase 4B.2B: SQL moved to lib/candidates.js getCandidateWard()/deleteCandidate().
    const currentWard = await getCandidateWard(pool, req.params.id);
    if (currentWard === undefined) return res.status(404).json({ success: false, error: 'Candidate not found' });
    if (!requirePermission(req, res, { wardId: currentWard })) return;

    const deleted = await deleteCandidate(pool, req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Candidate not found' });
    invalidateStaticCache('candidates');
    res.json({ success: true, deleted });
  } catch (err) {
    console.error('DELETE /api/admin/candidates/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


module.exports = router;
