// routes/forum.js
// Phase 4B.2D: the 3 forum routes confirmed to have no dependency on
// requirePermission() or NGOLIBA_WARD_ID — safe to move as complete
// routes. GET /api/admin/forum-posts (requirePermission) and POST
// /api/forum (NGOLIBA_WARD_ID, inside its create_post action) stay in
// server.js as orchestrators calling into lib/forum.js — see the Phase
// 4B.2D report.

const express = require('express');
const { pool } = require('../bootstrap/database');
const { verifySession } = require('../lib/auth/session');
const {
  listForumPosts,
  getRepliesForPost,
  postExistsAndVisible,
  createReply,
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

// POST /api/forum/replies — add a reply to a post
// forumReplyLimiter moves here too — it was exclusively used by this one
// route (forumPostLimiter, used by the different POST /api/forum route
// that stays in server.js, is a separate instance). New independent
// rate-limiter instance, identical config to the original.
const { rateLimit } = require('express-rate-limit');
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
