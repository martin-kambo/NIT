// routes/notices.js
// Phase 4B.2C: this replaces the previous routes/notices.js, which was a
// stale, pre-RBAC implementation that had never been mounted (confirmed
// dead across multiple prior audits this session — it used the legacy
// ADMIN_SECRET/x-admin-password mechanism retired in Phase 4A.3D, and had
// none of the ward-scope filtering built since). Rather than reuse that
// content, this file is the CURRENT, live implementation of every notice
// and ad-request route that had no dependency on requirePermission() or
// NGOLIBA_WARD_ID (both of which stay in server.js per this phase's
// explicit "Leave in server.js" list) — extracted verbatim, not
// redesigned. This becomes the single source of truth for these 10 routes,
// finally giving this file a real, mounted purpose.
//
// The 5 notice routes that DO depend on requirePermission()/NGOLIBA_WARD_ID
// (POST /api/notices, DELETE /api/notices/:id, and POST/PUT/DELETE
// /api/admin/notices) stay in server.js as thin orchestrators, now calling
// lib/notices.js for their SQL instead of running it inline.

const express = require('express');
const { pool } = require('../bootstrap/database');
const RBAC = require('../lib/rbac');
const { verifySession } = require('../lib/auth/session');

const router = express.Router();

// GET /api/notices — public notice board feed (notices + approved paid ads,
// merged and sorted the same way). Ward-filtered via req.wardId, already
// attached to every request by the existing session middleware — no import
// needed for that, it's just a property read off req.
router.get('/api/notices', async (req, res) => {
  try {
    const { cat } = req.query;
    const filterCat = cat && cat !== 'all' ? cat : null;

    // Query 1: admin notices
    // Phase 2.6D Group 3: filtered by ward_id when req.wardId is set.
    // (ad_requests below has no ward_id column — it's not in GEO_TABLES —
    // so that query is left as-is; this table is the only one of the two
    // that can be ward-filtered.)
    const noticeParams = [];
    let noticeWhere = `(expires_at IS NULL OR expires_at > NOW()) AND COALESCE(is_archived, false) = false`;
    if (filterCat) {
      noticeParams.push(filterCat);
      noticeWhere += ` AND category = $${noticeParams.length}`;
    }
    if (req.wardId != null) {
      noticeParams.push(req.wardId);
      noticeWhere += ` AND ward_id = $${noticeParams.length}`;
    }
    const noticesQ = pool.query(
      `SELECT id, title, content, category, priority, created_at, expires_at,
              NULL AS contact_phone, NULL AS business_name, false AS is_ad
       FROM notices
       WHERE ${noticeWhere}
       ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC`,
      noticeParams
    );

    // Query 2: approved paid ad requests shaped to match notice cards
    const adsQ = filterCat
      ? pool.query(
          `SELECT id,
                  business_name                AS title,
                  ad_content                   AS content,
                  COALESCE(category,'general') AS category,
                  'normal'                     AS priority,
                  submitted_at                 AS created_at,
                  NULL                         AS expires_at,
                  contact_phone,
                  business_name,
                  true                         AS is_ad
           FROM ad_requests
           WHERE status = 'approved'
             AND COALESCE(is_hidden, false) = false
             AND COALESCE(category, 'general') = $1
           ORDER BY submitted_at DESC`,
          [filterCat]
        )
      : pool.query(
          `SELECT id,
                  business_name                AS title,
                  ad_content                   AS content,
                  COALESCE(category,'general') AS category,
                  'normal'                     AS priority,
                  submitted_at                 AS created_at,
                  NULL                         AS expires_at,
                  contact_phone,
                  business_name,
                  true                         AS is_ad
           FROM ad_requests
           WHERE status = 'approved'
             AND COALESCE(is_hidden, false) = false
           ORDER BY submitted_at DESC`
        );

    // Run both queries — ads query is isolated so a missing column never kills notices
    const [noticesResult, adsResultRaw] = await Promise.all([
      noticesQ,
      adsQ.catch(err => {
        console.error('/api/notices ads query error (non-fatal):', err.message);
        return { rows: [] };
      })
    ]);

    // Merge: high-priority first, then newest
    const all = [...noticesResult.rows, ...adsResultRaw.rows].sort((a, b) => {
      const pa = a.priority === 'high' ? 0 : 1;
      const pb = b.priority === 'high' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    res.json({ success: true, notices: all });
  } catch (error) {
    console.error('/api/notices GET error:', error.message, '|', error.detail || '');
    res.status(500).json({ success: false, notices: [], error: error.message });
  }
});

// Phase 4A.2: MODERATOR+. Phase 4A.4: read-side scope added — MODERATOR
// still sees every ward's notices (it has no geographic scope by design,
// see lib/rbac.js resolveReadScope), but WARD_ADMIN/CONSTITUENCY_ADMIN/
// COUNTY_ADMIN now only see notices within their own scope.
router.get('/api/admin/notices', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  try {
    const scope = RBAC.resolveReadScope(req.user);
    const { clause: scopeClause, params } = RBAC.buildScopeFilter(
      scope,
      { ward: 'n.ward_id', constituency: 'w.constituency_id', county: 'con.county_id' },
      []
    );
    const whereSql = scopeClause ? `WHERE ${scopeClause}` : '';
    const result = await pool.query(
      `SELECT n.* FROM notices n
         LEFT JOIN wards w ON w.id = n.ward_id
         LEFT JOIN constituencies con ON con.id = w.constituency_id
       ${whereSql}
       ORDER BY n.created_at DESC`,
      params
    );
    res.json({ success: true, data: { notices: result.rows } });
  } catch (err) {
    console.error('GET /api/admin/notices error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/ad-requests', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Please log in to submit an ad request.' });

  const { businessName, adContent, category, contactPhone, contactEmail, budget, duration } = req.body;
  if (!businessName || !adContent || !contactPhone) {
    return res.status(400).json({ success: false, error: 'businessName, adContent and contactPhone are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO ad_requests (id, business_name, ad_content, contact_phone, contact_email, budget, duration, status, submitted_by_phone, submitted_at, category)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'pending', $7, NOW(), $8) RETURNING id, submitted_at`,
      [businessName, adContent, contactPhone, contactEmail || null, budget || null, duration || '7 days', session.phone, category || 'general']
    );
    res.json({ success: true, id: result.rows[0].id, submittedAt: result.rows[0].submitted_at });
  } catch (err) {
    console.error('POST /api/ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/my-ad-requests — returns all requests submitted by the logged-in user
router.get('/api/my-ad-requests', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Not authenticated' });
  try {
    const result = await pool.query(
      `SELECT id, business_name, ad_content, duration, status, fee, notes, submitted_at, reviewed_at
       FROM ad_requests
       WHERE submitted_by_phone = $1
       ORDER BY submitted_at DESC`,
      [session.phone]
    );
    res.json({ success: true, adRequests: result.rows });
  } catch (err) {
    console.error('GET /api/my-ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/ad-requests — admin: list all ad requests (hidden excluded by default)
// Phase 4A.2: MODERATOR+ (ad requests have no ward concept in the schema, so role-only gating applies).
// Phase 4A.4 STOP CONDITION (reported, not worked around): ad_requests has
// no ward_id, no constituency_id, no county_id, and not even a user_id FK
// — only free-text contact_phone/contact_email. There is no geographic
// relationship in this table's schema to filter on at all, so read-side
// ward isolation cannot be implemented here without a schema change
// (adding and backfilling a ward_id column, or a user_id FK), which is
// out of scope for this phase. Left unfiltered, same as before.
router.get('/api/admin/ad-requests', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  try {
    const showHidden = req.query.showHidden === 'true';
    const result = await pool.query(
      showHidden
        ? `SELECT * FROM ad_requests ORDER BY submitted_at DESC`
        : `SELECT * FROM ad_requests WHERE COALESCE(is_hidden, false) = false ORDER BY submitted_at DESC`
    );
    res.json({ success: true, adRequests: result.rows });
  } catch (err) {
    console.error('GET /api/admin/ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/ad-requests/:id/hide — toggle is_hidden
router.patch('/api/admin/ad-requests/:id/hide', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  const { hidden } = req.body; // true = hide, false = unhide
  try {
    const result = await pool.query(
      `UPDATE ad_requests SET is_hidden = $1 WHERE id = $2 RETURNING id, is_hidden`,
      [hidden === true, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Ad request not found' });
    res.json({ success: true, hidden: result.rows[0].is_hidden });
  } catch (err) {
    console.error('PATCH /api/admin/ad-requests/:id/hide error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/ad-requests/:id — permanently delete an ad request
router.delete('/api/admin/ad-requests/:id', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM ad_requests WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Ad request not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/ad-requests/:id — admin: update status + notes + optional fee
router.patch('/api/admin/ad-requests/:id', RBAC.requireMinRole(RBAC.ROLES.MODERATOR), async (req, res) => {
  const { status, notes, fee } = req.body;
  const allowed = ['pending', 'payment_pending', 'approved', 'rejected', 'completed'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ success: false, error: `status must be one of: ${allowed.join(', ')}` });
  }
  if (status === 'payment_pending' && (!fee || isNaN(parseInt(fee)) || parseInt(fee) <= 0)) {
    return res.status(400).json({ success: false, error: 'A valid fee (KES) is required when requesting payment.' });
  }
  try {
    const result = await pool.query(
      `UPDATE ad_requests
         SET status=$1, notes=$2, fee=COALESCE($3, fee), reviewed_at=NOW(), reviewed_by='admin'
       WHERE id=$4 RETURNING *`,
      [status, notes || null, fee ? parseInt(fee) : null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Ad request not found' });
    res.json({ success: true, adRequest: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/admin/ad-requests error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/ad-requests/:id — public: requester checks their own request status
router.get('/api/ad-requests/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, business_name, status, fee, duration, notes, submitted_at, reviewed_at FROM ad_requests WHERE id=$1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, adRequest: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/ad-requests/:id/pay — requester confirms payment (M-Pesa receipt)
router.post('/api/ad-requests/:id/pay', async (req, res) => {
  const { mpesaReceiptNumber, phone } = req.body;
  if (!mpesaReceiptNumber) return res.status(400).json({ success: false, error: 'mpesaReceiptNumber is required' });
  try {
    // Verify the request is in payment_pending state
    const check = await pool.query(`SELECT status, fee FROM ad_requests WHERE id=$1`, [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ success: false, error: 'Ad request not found' });
    if (check.rows[0].status !== 'payment_pending') {
      return res.status(400).json({ success: false, error: `Cannot confirm payment — request is currently "${check.rows[0].status}"` });
    }
    const result = await pool.query(
      `UPDATE ad_requests
         SET status='approved', notes=COALESCE(notes||' | ', '')||'Paid via M-Pesa: '||$1
       WHERE id=$2 RETURNING *`,
      [mpesaReceiptNumber, req.params.id]
    );
    res.json({ success: true, adRequest: result.rows[0] });
  } catch (err) {
    console.error('POST /api/ad-requests/:id/pay error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
