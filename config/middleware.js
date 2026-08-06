// config/middleware.js
// Phase 4B.1: extracted verbatim from server.js — the compression/cors/
// json/static registration block. This is called from server.js in the
// exact same position these lines used to occupy: AFTER the custom
// req.user/req.wardId auth middleware (which stays in server.js — see the
// Phase 4B.1 report), BEFORE any route registration. Order relative to
// that middleware is preserved exactly; this function does not itself
// depend on anything from server.js beyond the `app` instance passed in.

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:10000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (!process.env.ALLOWED_ORIGIN) {
  console.warn('[CORS] ALLOWED_ORIGIN env var not set — restricting to localhost only. Set it to your Render URL in production.');
}

function applyCoreMiddleware(app) {
  // Pre-Phase 3B Task 2: HTTP response compression.
  // Placed first in this infrastructure group so it wraps every downstream
  // response — cors, json-parsed API responses, static assets, and the
  // votingRouter/analyticsRouter responses mounted later in this file —
  // since compression must patch res.write/res.end before any handler uses
  // them in order to apply.
  //
  // SSE is explicitly excluded. Verified, not assumed: the `compression`
  // package's default filter would otherwise compress text/event-stream
  // (confirmed directly against the `compressible` library it uses
  // internally), and the existing SSE implementation in routes/voting.js
  // (GET /api/votes/stream) never calls res.flush() — without that call,
  // individual SSE events could sit buffered inside compression's internal
  // zlib stream instead of reaching clients immediately, breaking the
  // real-time leaderboard/voting-page updates. filter() is confirmed (via
  // the package's own source) to run after the route handler sets headers,
  // so checking the request path here is reliable.
  app.use(compression({
    filter: (req, res) => {
      if (req.path === '/api/votes/stream') return false;
      if (res.getHeader('Content-Type') === 'text/event-stream') return false;
      return compression.filter(req, res);
    }
  }));
  app.use(cors({
    origin: (incomingOrigin, callback) => {
      // Allow server-to-server requests (no Origin header, e.g. curl, Render health checks)
      if (!incomingOrigin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(incomingOrigin)) return callback(null, true);
      console.warn(`[CORS] Blocked request from unlisted origin: ${incomingOrigin}`);
      callback(new Error(`CORS: origin ${incomingOrigin} is not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Password']
  }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
}

module.exports = { applyCoreMiddleware, ALLOWED_ORIGINS };
