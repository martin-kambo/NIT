// lib/notices.js
// Phase 4B.2C: notice-related SQL extracted verbatim from server.js.
//
// These functions back the 5 notice routes that could NOT move as complete
// routes: POST /api/notices, DELETE /api/notices/:id, and
// POST/PUT/DELETE /api/admin/notices — all five call requirePermission()
// and/or read NGOLIBA_WARD_ID, both of which stay in server.js per this
// phase's explicit "Leave in server.js" list. Those route handlers remain
// in server.js as thin orchestrators (RBAC/scope-check -> call one of
// these -> respond), now calling these functions instead of running the
// queries inline. Every query and parameter below is byte-for-byte
// identical to the original inline version.
//
// GET /api/notices and GET /api/admin/notices had no such dependency and
// moved as complete routes to routes/notices.js instead — they don't need
// anything from this file.
//
// Phase 4B.36: two changes, both required by approved policy decisions and
// nothing else in this file was touched -- getNoticeWardAndCategory() is new,
// and updateNotice() now distinguishes an omitted expiry from an explicit null
// and refuses to put the legacy `health` category on a notice that does not
// already have it. Input validation itself lives in lib/notice-validation.js.

const { LEGACY_CATEGORY } = require('./notice-validation');

// POST /api/notices' version: expiry computed server-side from a number of
// days (defaults to 30), title/content required by the caller (checked by
// the route before this is called).
async function createNoticeWithDays(pool, { title, content, category, priority, days, wardId }) {
  const result = await pool.query(
    `INSERT INTO notices (title, content, category, priority, expires_at, created_by, ward_id)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::INTERVAL, 'admin', $6)
     RETURNING *`,
    [title, content, category || 'general', priority || 'normal', String(days || 30), wardId]
  );
  return result.rows[0];
}

// POST /api/admin/notices' version: caller supplies expires_at directly
// (or null for no expiry) rather than a day count.
async function createNoticeWithExpiresAt(pool, { title, content, category, priority, expiresAt, wardId }) {
  const result = await pool.query(
    'INSERT INTO notices (title,content,category,priority,expires_at,created_by,ward_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [title, content, category || 'general', priority || 'normal', expiresAt || null, 'admin', wardId]
  );
  return result.rows[0];
}

// Looks up a notice's current ward_id, or undefined if it doesn't exist.
// Used by the PUT/DELETE route handlers (in server.js) to resolve the
// existing ward BEFORE checking permission on it.
async function getNoticeWard(pool, id) {
  const result = await pool.query('SELECT ward_id FROM notices WHERE id = $1', [id]);
  return result.rows.length ? result.rows[0].ward_id : undefined;
}

// Phase 4B.36: looks up a notice's ward AND stored category in ONE statement,
// so the authorization decision and the legacy-category decision are made
// from the same snapshot. Returns undefined if the notice does not exist,
// otherwise { wardId, category } -- wardId is null for a notice that has no
// ward. (DELETE keeps using getNoticeWard(): it does not need the category.)
async function getNoticeWardAndCategory(pool, id) {
  const result = await pool.query('SELECT ward_id, category FROM notices WHERE id = $1', [id]);
  if (!result.rows.length) return undefined;
  return { wardId: result.rows[0].ward_id, category: result.rows[0].category };
}

// Phase 4B.36 expiry semantics (set by the `expiresAt` argument):
//   undefined -> keep the stored expiry (the property was omitted)
//   null      -> clear the expiry
//   string    -> replace the expiry
// It is decided inside the single UPDATE (not by reading the old value first),
// so a concurrent edit cannot be overwritten with a stale expiry.
//
// The last WHERE predicate is the atomic backstop for the legacy-category rule:
// the category `health` can only be written onto a row that already stores
// `health`. The route checks this earlier to give a clear 400; this predicate
// guarantees it even if the stored category changes between that check and
// this statement (the UPDATE then matches no row and returns null).
async function updateNotice(pool, id, { title, content, category, priority, expiresAt }) {
  const setExpiry = expiresAt !== undefined;
  const result = await pool.query(
    `UPDATE notices
        SET title = $1, content = $2, category = $3, priority = $4,
            expires_at = CASE WHEN $7::boolean THEN $5::timestamp ELSE expires_at END,
            updated_at = NOW()
      WHERE id = $6
        AND ($3 <> $8 OR category = $8)
      RETURNING *`,
    [title, content, category || 'general', priority || 'normal', setExpiry ? expiresAt : null, id, setExpiry, LEGACY_CATEGORY]
  );
  return result.rows.length ? result.rows[0] : null;
}

// Shared by both DELETE /api/notices/:id and DELETE /api/admin/notices/:id
// — both ran the identical query (only whitespace differed) before this
// extraction.
async function deleteNotice(pool, id) {
  await pool.query('DELETE FROM notices WHERE id = $1', [id]);
}

module.exports = {
  createNoticeWithDays,
  createNoticeWithExpiresAt,
  getNoticeWard,
  getNoticeWardAndCategory,
  updateNotice,
  deleteNotice,
};
