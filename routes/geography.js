// routes/geography.js
// Phase 4B.11: extracted verbatim from server.js. No geography-domain
// library file existed prior to this phase -- every query below was
// already inline SQL in server.js, not delegated to a canonical
// helper, so none was introduced here either (this is an extraction,
// not a redesign). Covers both the admin write side (POST
// /api/admin/counties, /constituencies, /wards) and the public read
// side (GET /api/counties, /constituencies, /wards). Both halves were
// confirmed to have zero remaining dependency blockers: the shared
// static cache (lib/static-cache.js) and requirePermission()
// (lib/rbac.js) each already have a single-owner module home (Phase
// 4B.5). Every query, cache key, invalidation call, RBAC check, and
// response shape below is byte-for-byte identical to the original
// inline version (line endings normalized from CRLF to LF, matching
// the convention already used by every other route file created
// during this modularization).

const express = require('express');
const { pool } = require('../bootstrap/database');
const RBAC = require('../lib/rbac');
const { requirePermission } = RBAC;
const { getCached, setCached, invalidateStaticCache } = require('../lib/static-cache');

const router = express.Router();

// ══════════════════════════════════════════════════════════════════
// PHASE 1: READ-ONLY GEOGRAPHIC ENDPOINTS
// These are purely additive. They do not touch authentication,
// session handling, voting, timers, candidates, or any existing route.
// ══════════════════════════════════════════════════════════════════

// GET /api/counties
// Returns all counties ordered alphabetically.
// ════════════════════════════════════════════════
// PHASE 3A — Geographic hierarchy administration
// Tables already exist (ensureGeographyTables, above) with the UNIQUE
// constraints needed — counties.name, constituencies(county_id,name),
// wards(constituency_id,name). These endpoints are new write-paths onto
// that existing schema; no migration, no new table.
// ════════════════════════════════════════════════

// POST /api/admin/counties  { name }
// Phase 4A.2: SUPER_ADMIN-only — top of the geography hierarchy, no parent scope to check against.
router.post('/api/admin/counties', RBAC.requireRole(RBAC.ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const existing = await pool.query('SELECT id FROM counties WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: `County '${name}' already exists` });
    }

    const result = await pool.query(
      'INSERT INTO counties (name) VALUES ($1) RETURNING id, name, created_at',
      [name]
    );
    invalidateStaticCache('counties');
    return res.status(201).json({ success: true, county: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') { // unique_violation — race with the pre-check above
      return res.status(409).json({ success: false, error: 'County already exists' });
    }
    console.error('[POST /api/admin/counties] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to create county' });
  }
});

// POST /api/admin/constituencies  { name, countyId }
// Phase 4A.2: COUNTY_ADMIN+, scope-checked against the target county.
router.post('/api/admin/constituencies', RBAC.requireMinRole(RBAC.ROLES.COUNTY_ADMIN), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const countyId = parseInt(req.body.countyId, 10);
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!countyId || isNaN(countyId)) {
      return res.status(400).json({ success: false, error: 'countyId is required' });
    }
    if (!requirePermission(req, res, { countyId })) return;

    const county = await pool.query('SELECT id FROM counties WHERE id = $1', [countyId]);
    if (county.rows.length === 0) {
      return res.status(404).json({ success: false, error: `County ${countyId} does not exist` });
    }

    const existing = await pool.query(
      'SELECT id FROM constituencies WHERE county_id = $1 AND name = $2',
      [countyId, name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: `Constituency '${name}' already exists in this county` });
    }

    const result = await pool.query(
      'INSERT INTO constituencies (county_id, name) VALUES ($1, $2) RETURNING id, county_id, name, created_at',
      [countyId, name]
    );
    invalidateStaticCache('constituencies');
    return res.status(201).json({ success: true, constituency: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ success: false, error: 'Constituency already exists in this county' });
    }
    console.error('[POST /api/admin/constituencies] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to create constituency' });
  }
});

// POST /api/admin/wards  { name, constituencyId }
// Phase 4A.2: CONSTITUENCY_ADMIN+, scope-checked against the target constituency.
router.post('/api/admin/wards', RBAC.requireMinRole(RBAC.ROLES.CONSTITUENCY_ADMIN), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const constituencyId = parseInt(req.body.constituencyId, 10);
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!constituencyId || isNaN(constituencyId)) {
      return res.status(400).json({ success: false, error: 'constituencyId is required' });
    }
    if (!requirePermission(req, res, { constituencyId })) return;

    const constituency = await pool.query('SELECT id FROM constituencies WHERE id = $1', [constituencyId]);
    if (constituency.rows.length === 0) {
      return res.status(404).json({ success: false, error: `Constituency ${constituencyId} does not exist` });
    }

    const existing = await pool.query(
      'SELECT id FROM wards WHERE constituency_id = $1 AND name = $2',
      [constituencyId, name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: `Ward '${name}' already exists in this constituency` });
    }

    const result = await pool.query(
      'INSERT INTO wards (constituency_id, name) VALUES ($1, $2) RETURNING id, constituency_id, name, created_at',
      [constituencyId, name]
    );
    invalidateStaticCache('wards');
    return res.status(201).json({ success: true, ward: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ success: false, error: 'Ward already exists in this constituency' });
    }
    console.error('[POST /api/admin/wards] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to create ward' });
  }
});


router.get('/api/counties', async (req, res) => {
  try {
    const cacheKey = 'counties:all';
    let counties = getCached(cacheKey);
    if (counties === undefined) {
      const result = await pool.query(
        'SELECT id, name, created_at FROM counties ORDER BY name ASC'
      );
      counties = result.rows;
      setCached(cacheKey, counties);
    }
    return res.json({ success: true, counties });
  } catch (e) {
    console.error('[/api/counties] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch counties' });
  }
});

// GET /api/constituencies
// Optional query param: ?county_id=<integer>
// Returns all constituencies, or only those belonging to a specific county.
router.get('/api/constituencies', async (req, res) => {
  try {
    const { county_id } = req.query;
    const cacheKey = county_id ? `constituencies:county:${county_id}` : 'constituencies:all';
    let constituencies = getCached(cacheKey);
    if (constituencies === undefined) {
      const result = county_id
        ? await pool.query(
            'SELECT id, county_id, name, created_at FROM constituencies WHERE county_id = $1 ORDER BY name ASC',
            [parseInt(county_id, 10)]
          )
        : await pool.query(
            'SELECT id, county_id, name, created_at FROM constituencies ORDER BY name ASC'
          );
      constituencies = result.rows;
      setCached(cacheKey, constituencies);
    }
    return res.json({ success: true, constituencies });
  } catch (e) {
    console.error('[/api/constituencies] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch constituencies' });
  }
});

// GET /api/wards
// Optional query param: ?constituency_id=<integer>
// Returns all wards, or only those belonging to a specific constituency.
router.get('/api/wards', async (req, res) => {
  try {
    const { constituency_id } = req.query;
    const cacheKey = constituency_id ? `wards:constituency:${constituency_id}` : 'wards:all';
    let wards = getCached(cacheKey);
    if (wards === undefined) {
      const result = constituency_id
        ? await pool.query(
            'SELECT id, constituency_id, name, created_at FROM wards WHERE constituency_id = $1 ORDER BY name ASC',
            [parseInt(constituency_id, 10)]
          )
        : await pool.query(
            'SELECT id, constituency_id, name, created_at FROM wards ORDER BY name ASC'
          );
      wards = result.rows;
      setCached(cacheKey, wards);
    }
    return res.json({ success: true, wards });
  } catch (e) {
    console.error('[/api/wards] ERROR:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch wards' });
  }
});


module.exports = router;
