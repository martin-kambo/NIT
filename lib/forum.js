// lib/forum.js
// Phase 4B.2D: forum SQL and helpers extracted verbatim from server.js.
//
// FORUM_CATEGORIES, formatPost(), formatReply() were forum-exclusive
// (confirmed: no other subsystem references them) and moved outright.
//
// listForumPosts() consolidates a genuine pre-existing duplication: GET
// /api/forum and POST /api/forum's `list_posts` legacy action ran the
// identical query (same WHERE-building logic, same SELECT, same
// formatPost mapping) — extracted once here rather than copied twice,
// per this phase's "exactly one source of truth" requirement. This is
// deduplication of an already-duplicated implementation, not a rewrite —
// the query itself is unchanged.
//
// createForumPost()/toggleLikePost() back the `create_post`/`like_post`
// actions inside POST /api/forum, which stays in server.js as a whole
// (it's one Express route with an internal action-dispatcher, and the
// create_post branch reads NGOLIBA_WARD_ID, which must stay in
// server.js) — the orchestrator resolves the ward fallback itself and
// passes the final wardId in, so this function never touches that
// variable directly.
//
// getAdminForumPosts() backs GET /api/admin/forum-posts, which also stays
// in server.js as a whole (it calls requirePermission() for the
// explicit-filter case) — this function only builds and runs the query;
// the permission check happens in the orchestrator before this is called.

const RBAC = require('./rbac');

const FORUM_CATEGORIES = ['general', 'water', 'roads', 'health', 'youth'];

function formatPost(p) {
  return {
    id: p.id,
    author: p.author_name || 'Anonymous',
    authorPhone: p.author_phone || null,
    text: p.content,
    title: p.title,
    category: p.category || 'general',
    likes: parseInt(p.like_count) || 0,
    reply_count: parseInt(p.reply_count) || 0,
    created_at: p.created_at,
    last_activity_at: p.last_activity_at
  };
}

function formatReply(r) {
  return {
    id: r.id,
    postId: r.post_id,
    author: r.author_name || 'Anonymous',
    text: r.content,
    likes: parseInt(r.like_count) || 0,
    created_at: r.created_at
  };
}

async function listForumPosts(pool, { category, wardId }) {
  const validCat = category && FORUM_CATEGORIES.includes(category) ? category : null;
  const params = [];
  let where = `COALESCE(is_deleted, false) = false AND COALESCE(is_hidden, false) = false`;
  if (validCat) {
    params.push(validCat);
    where += ` AND category = $${params.length}`;
  }
  if (wardId != null) {
    params.push(wardId);
    where += ` AND ward_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT * FROM forum_posts
      WHERE ${where}
      ORDER BY last_activity_at DESC LIMIT 60`,
    params
  );
  return result.rows.map(formatPost);
}

async function getAdminForumPosts(pool, user, { wardId, constituencyId, countyId }) {
  const params = [];
  let whereClause = '';
  if (wardId != null) {
    params.push(parseInt(wardId, 10));
    whereClause = `WHERE p.ward_id = $${params.length}`;
  } else if (constituencyId != null) {
    params.push(parseInt(constituencyId, 10));
    whereClause = `WHERE w.constituency_id = $${params.length}`;
  } else if (countyId != null) {
    params.push(parseInt(countyId, 10));
    whereClause = `WHERE con.county_id = $${params.length}`;
  } else {
    const scope = RBAC.resolveReadScope(user);
    const scopeFilter = RBAC.buildScopeFilter(
      scope, { ward: 'p.ward_id', constituency: 'w.constituency_id', county: 'con.county_id' }, []
    );
    if (scopeFilter.clause) { whereClause = `WHERE ${scopeFilter.clause}`; params.push(...scopeFilter.params); }
  }

  const result = await pool.query(
    `SELECT p.*,
            w.name   AS ward_name,
            con.name AS constituency_name,
            cty.name AS county_name
       FROM forum_posts p
       LEFT JOIN wards         w   ON w.id = p.ward_id
       LEFT JOIN constituencies con ON con.id = w.constituency_id
       LEFT JOIN counties      cty ON cty.id = con.county_id
       ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT 100`,
    params
  );
  return {
    posts: result.rows.map(p => ({
      ...formatPost(p),
      wardName: p.ward_name,
      constituencyName: p.constituency_name,
      countyName: p.county_name
    })),
    total: result.rowCount
  };
}

// userId/wardId/phone are all already resolved by the caller (session
// lookup + NGOLIBA_WARD_ID fallback happen in server.js, since the latter
// must stay there) — this function only does the DB write.
async function createForumPost(pool, { userId, authorName, phone, title, text, category, wardId }) {
  const safeCategory = FORUM_CATEGORIES.includes(category) ? category : 'general';
  const autoTitle = title?.trim() || text.slice(0, 80);
  const post = await pool.query(
    `INSERT INTO forum_posts
       (title, content, author_id, author_name, author_phone, category, ward_id, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING *`,
    [autoTitle, text, userId, authorName, phone, safeCategory, wardId]
  );
  return formatPost(post.rows[0]);
}

async function toggleLikePost(pool, postId, userId) {
  const existing = await pool.query(
    'SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]
  );
  if (existing.rows.length) {
    await pool.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
  } else {
    await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, userId]);
  }
  await pool.query(
    'UPDATE forum_posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1) WHERE id = $1',
    [postId]
  );
  const updated = await pool.query('SELECT like_count FROM forum_posts WHERE id = $1', [postId]);
  return { likes: parseInt(updated.rows[0]?.like_count) || 0, liked: !existing.rows.length };
}

async function getRepliesForPost(pool, postId) {
  const result = await pool.query(
    `SELECT * FROM forum_replies
      WHERE post_id = $1
        AND COALESCE(is_deleted, false) = false
        AND COALESCE(is_hidden,  false) = false
      ORDER BY created_at ASC`,
    [postId]
  );
  return result.rows.map(formatReply);
}

async function postExistsAndVisible(pool, postId) {
  const postCheck = await pool.query(
    `SELECT id FROM forum_posts WHERE id = $1 AND COALESCE(is_deleted,false)=false AND COALESCE(is_hidden,false)=false`,
    [postId]
  );
  return postCheck.rows.length > 0;
}

async function createReply(pool, { postId, userId, authorName, phone, text }) {
  const reply = await pool.query(
    `INSERT INTO forum_replies (post_id, content, author_id, author_name, author_phone)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [postId, text, userId, authorName, phone]
  );
  await pool.query(
    `UPDATE forum_posts
       SET reply_count = (SELECT COUNT(*) FROM forum_replies WHERE post_id = $1 AND COALESCE(is_deleted,false)=false),
           last_activity_at = NOW()
     WHERE id = $1`,
    [postId]
  );
  return formatReply(reply.rows[0]);
}

module.exports = {
  FORUM_CATEGORIES,
  formatPost,
  formatReply,
  listForumPosts,
  getAdminForumPosts,
  createForumPost,
  toggleLikePost,
  getRepliesForPost,
  postExistsAndVisible,
  createReply,
};
