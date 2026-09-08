// routes/forum.js
// Phase 4B.2D: the 3 forum routes confirmed to have no dependency on
// requirePermission() or NGOLIBA_WARD_ID — safe to move as complete
// routes. GET /api/admin/forum-posts (requirePermission) and POST
// /api/forum (NGOLIBA_WARD_ID, inside its create_post action) stay in
// server.js as orchestrators calling into lib/forum.js — see the Phase
// 4B.2D report.
//
// Phase 4B.10 / 4B.28A: POST /api/forum and GET /api/admin/forum-posts
// restored here. The getFoundingWardId() ward-fallback (formerly
// NGOLIBA_WARD_ID) is now in lib/ward-cache.js, and requirePermission()
// is in lib/rbac.js — both importable without going through server.js.
// Handlers are verbatim equivalents of the original server.js handlers.

const express = require('express');
const { pool } = require('../bootstrap/database');
const { verifySession } = require('../lib/auth/session');
const { getFoundingWardId } = require('../lib/ward-cache');
const RBAC = require('../lib/rbac');
const { requirePermission } = RBAC;
const {
  listForumPosts,
  getRepliesForPost,
  postExistsAndVisible,
  createReply,
  createForumPost,
  toggleLikePost,
  getAdminForumPosts,
} = require('../lib/forum');

const router = express.Router();

// GET /api/forum — list posts, optional ?category= filter. Ward-filtered
// via req.wardId, already attached to every request by the existing
// session middleware — no import needed for that, it's just a property
// read off req.
router.get('/api/forum', async (req, res) => {
  try {
    const posts = await listForumPosts(pool, { category: req.query.category, wardId: req.wardId });
    res.json({ success: true, posts });
  } catch (error) {
    console.error('GET /api/forum error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to get forum posts' });
  }
});

// GET /api/forum/replies/:postId — list replies for a post
router.get('/api/forum/replies/:postId', async (req, res) => {
  try {
    const replies = await getRepliesForPost(pool, req.params.postId);
    res.json({ success: true, replies });
  } catch (error) {
    console.error('GET /api/forum/replies error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to get replies' });
  }
});

// POST /api/forum — action-dispatcher: create_post, like_post, list_posts
// Restored Phase 4B.28A (was declared moved in Phase 4B.10 but not written).
// forumPostLimiter: separate instance from forumReplyLimiter, identical config.
const { rateLimit } = require('express-rate-limit');
const forumPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  statusCode: 429,
  message: { success: false, message: 'Too many forum submissions. Please wait before posting again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/api/forum', forumPostLimiter, async (req, res) => {
  const { action, text, category, postId } = req.body || {};

  // ── list_posts (legacy action, mirrors GET /api/forum) ─────────────
  if (action === 'list_posts') {
    try {
      const posts = await listForumPosts(pool, { category, wardId: req.wardId });
      return res.json({ success: true, posts });
    } catch (err) {
      console.error('POST /api/forum list_posts error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to get forum posts' });
    }
  }

  // ── like_post ───────────────────────────────────────────────────────
  if (action === 'like_post') {
    const session = verifySession(req.headers.cookie || '');
    if (!session) return res.status(401).json({ success: false, error: 'Login required to like posts' });

    if (!postId) return res.status(400).json({ success: false, error: 'postId required' });

    try {
      const result = await toggleLikePost(pool, postId, session.userId);
      return res.json({ success: true, ...result });
    } catch (err) {
      console.error('POST /api/forum like_post error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to update like' });
    }
  }

  // ── create_post (default action) ────────────────────────────────────
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Login required to post' });

  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length < 3)
    return res.status(400).json({ success: false, error: 'Post must be at least 3 characters' });
  if (trimmed.length > 2000)
    return res.status(400).json({ success: false, error: 'Post cannot exceed 2000 characters' });

  const safeText = trimmed.replace(/<[^>]*>/g, '');

  try {
    const userRow = await pool.query(
      'SELECT id, first_name, surname, phone FROM users WHERE id = $1',
      [session.userId]
    );
    if (!userRow.rows.length)
      return res.status(404).json({ success: false, error: 'User not found' });

    const u = userRow.rows[0];
    const authorName = `${u.first_name} ${u.surname}`.trim() || 'Anonymous';
    const resolvedWardId = req.wardId != null ? req.wardId : getFoundingWardId();

    const post = await createForumPost(pool, {
      userId: u.id,
      authorName,
      phone: u.phone,
      title: null,
      text: safeText,
      category: category || 'general',
      wardId: resolvedWardId,
    });

    return res.json({ success: true, post });
  } catch (err) {
    console.error('POST /api/forum create_post error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create post' });
  }
});

// GET /api/admin/forum-posts — scoped admin view of all forum posts.
// Restored Phase 4B.28A (was declared moved in Phase 4B.10 but not written).
// RBAC gate: WARD_ADMIN+. Explicit ?wardId=/?constituencyId=/?countyId=
// query params trigger requirePermission() scope check; omitting them
// falls back to RBAC.resolveReadScope() (same as admin/notices pattern).
router.get('/api/admin/forum-posts', RBAC.requireMinRole(RBAC.ROLES.WARD_ADMIN), async (req, res) => {
  const wardId        = req.query.wardId        ? parseInt(req.query.wardId, 10)        : null;
  const constituencyId = req.query.constituencyId ? parseInt(req.query.constituencyId, 10) : null;
  const countyId      = req.query.countyId      ? parseInt(req.query.countyId, 10)      : null;

  // Explicit scope filter: verify the requesting admin has permission for
  // the requested scope before delegating the query.
  if (wardId != null && !requirePermission(req, res, { wardId })) return;
  if (constituencyId != null && !requirePermission(req, res, { constituencyId })) return;
  if (countyId != null && !requirePermission(req, res, { countyId })) return;

  try {
    const result = await getAdminForumPosts(pool, req.user, { wardId, constituencyId, countyId });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('GET /api/admin/forum-posts error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/forum/replies — add a reply to a post
// forumReplyLimiter moves here too — it was exclusively used by this one
// route (forumPostLimiter, used by the different POST /api/forum route
// that stays in server.js, is a separate instance). New independent
// rate-limiter instance, identical config to the original.
const forumReplyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  statusCode: 429,
  message: { success: false, message: 'Too many forum submissions. Please wait before posting again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/api/forum/replies', forumReplyLimiter, async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ success: false, error: 'Login required to reply' });

  const { postId, text } = req.body;
  if (!postId) return res.status(400).json({ success: false, error: 'postId required' });

  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length < 1)
    return res.status(400).json({ success: false, error: 'Reply cannot be empty' });
  if (trimmed.length > 1000)
    return res.status(400).json({ success: false, error: 'Reply cannot exceed 1000 characters' });

  const safeText = trimmed.replace(/<[^>]*>/g, '');

  try {
    const exists = await postExistsAndVisible(pool, postId);
    if (!exists) return res.status(404).json({ success: false, error: 'Post not found' });

    const user = await pool.query(
      'SELECT id, first_name, surname FROM users WHERE id = $1', [session.userId]
    );
    if (!user.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    const u = user.rows[0];
    const author = `${u.first_name} ${u.surname}`.trim() || 'Anonymous';

    const reply = await createReply(pool, { postId, userId: u.id, authorName: author, phone: session.phone, text: safeText });
    res.json({ success: true, reply });
  } catch (error) {
    console.error('POST /api/forum/replies error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to post reply' });
  }
});

module.exports = router;
