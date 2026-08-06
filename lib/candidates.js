// ════════════════════════════════════════════════════════════════════════
// SINGLE CANONICAL CANDIDATE SOURCE  (Phase 2.6C — candidate fragmentation fix)
// ════════════════════════════════════════════════════════════════════════
// The `candidates` table in PostgreSQL is the ONLY source of truth for
// candidate data. Before this module existed, three independently
// maintained copies of the same seven candidates lived in:
//   - server.js          (const CANDIDATES = [...])
//   - routes/voting.js   (const FALLBACK_CANDIDATES = [...])
//   - routes/analytics.js (function getCandidates() { return [...] })
// Each copy had slightly different fields (some missing `bio`, some
// missing `img`, some missing `incumbent`), and analytics.js's copy was
// never backed by the database at all — it was a second, permanent source
// of truth that could silently drift from whatever admins changed in the
// `candidates` table.
//
// This module is now the ONLY place hardcoded candidate data is allowed to
// exist, and it exists strictly as a last-resort fallback for when the
// database is unreachable or not yet seeded — never as a competing source.
// Every exported function reads the database first; the constant below is
// only ever used if that read fails or returns nothing.
//
// These values intentionally mirror the exact rows ensureCandidatesTable()
// seeds into the database on first boot (server.js), so the fallback and a
// freshly-initialized database start out identical.
const FALLBACK_CANDIDATES = [
  { id: 0, name: 'Hon. James Mwangi', party: 'UDA (Incumbent)', bio: 'Two-term MCA, water projects.',   img: 'https://randomuser.me/api/portraits/men/32.jpg',   incumbent: true  },
  { id: 1, name: 'Grace Wanjiku',     party: 'Independent',     bio: 'Teacher & community organizer.',  img: 'https://randomuser.me/api/portraits/women/68.jpg', incumbent: false },
  { id: 2, name: 'Peter Kimani',      party: 'Jubilee',         bio: 'Agri-business entrepreneur.',     img: 'https://randomuser.me/api/portraits/men/45.jpg',   incumbent: false },
  { id: 3, name: 'Sarah Nduati',      party: 'Wiper',           bio: 'Public health expert.',           img: 'https://randomuser.me/api/portraits/women/22.jpg', incumbent: false },
  { id: 4, name: 'John Otieno',       party: 'Independent',     bio: 'Farmer cooperative leader.',      img: 'https://randomuser.me/api/portraits/men/89.jpg',   incumbent: false },
  { id: 5, name: 'Mary Wambui',       party: 'Maendeleo',       bio: 'ICT & agribusiness graduate.',    img: 'https://randomuser.me/api/portraits/women/54.jpg', incumbent: false },
  { id: 6, name: 'David Kiprotich',   party: 'Roots',           bio: 'Governance activist.',            img: 'https://randomuser.me/api/portraits/men/99.jpg',   incumbent: false }
];

/**
 * Read-only projection of the candidates table, filtered to one category.
 * Used by routes/voting.js (leaderboard, face-off) and routes/analytics.js
 * (both of which only ever dealt with the MCA category historically).
 *
 * Falls back to FALLBACK_CANDIDATES only when category === 'MCA', matching
 * every caller's pre-existing behavior — there is no hardcoded fallback
 * data for any other category, so those correctly return [] instead of
 * silently substituting unrelated MCA names.
 *
 * Phase 2.6D Group 3: wardId is optional and defaults to null (no filter),
 * so any caller not yet updated to pass one gets the exact same result as
 * before — this only changes behavior for callers that explicitly pass a
 * wardId (currently always NGOLIBA_WARD_ID via req.wardId, so today's
 * single-ward output is identical either way; this is what makes the
 * query itself ward-aware rather than structurally global).
 */
async function getCandidatesByCategory(pool, category = 'MCA', wardId = null) {
  try {
    const params = [category];
    let whereClause = 'category = $1';
    if (wardId != null) {
      params.push(wardId);
      whereClause += ' AND ward_id = $2';
    }
    const result = await pool.query(
      `SELECT id, name, party, bio, img, incumbent
         FROM candidates
        WHERE ${whereClause}
        ORDER BY display_order, id`,
      params
    );
    if (result.rows.length > 0) {
      return result.rows.map(c => ({
        id:        parseInt(c.id),
        name:      c.name,
        party:     c.party     || '',
        bio:       c.bio       || '',
        img:       c.img       || '',
        incumbent: c.incumbent || false
      }));
    }
  } catch (error) {
    console.error(`[lib/candidates] DB read failed for category=${category}, using fallback:`, error.message);
  }
  return category === 'MCA' ? FALLBACK_CANDIDATES : [];
}

/**
 * Read-only projection of the full candidates table, all categories.
 * Used by server.js's /api/candidates route when no ?category filter is given.
 *
 * Phase 2.6D Group 3: wardId is optional, defaults to null (no filter) —
 * see getCandidatesByCategory's doc comment above for the same reasoning.
 */
async function getAllCandidates(pool, wardId = null) {
  try {
    const params = [];
    let whereClause = '';
    if (wardId != null) {
      params.push(wardId);
      whereClause = 'WHERE ward_id = $1';
    }
    const result = await pool.query(
      `SELECT id, name, party, bio, img, category, incumbent
         FROM candidates
         ${whereClause}
        ORDER BY category, display_order, id`,
      params
    );
    if (result.rows.length > 0) return result.rows;
  } catch (error) {
    console.error('[lib/candidates] DB read failed for all categories, using fallback:', error.message);
  }
  return FALLBACK_CANDIDATES.map(c => ({ ...c, category: 'MCA' }));
}

// Phase 4B.2B: CANDIDATE_CATEGORIES and the create/update/delete SQL moved
// here verbatim from server.js's POST/PUT/DELETE /api/admin/candidates
// route handlers, extending this already-canonical module rather than
// creating a second one. The route handlers themselves — which interleave
// RBAC scope checks (requirePermission) and shared cache invalidation
// (invalidateStaticCache, also used by the geography routes and therefore
// out of scope to move — see the Phase 4B.2B report) with these DB calls —
// stay in server.js and now call these functions instead of running the
// queries inline. Every query, parameter, and conditional branch below is
// byte-for-byte identical to the original inline version.

const CANDIDATE_CATEGORIES = ['MCA', 'WomenRep', 'MP', 'Senator', 'Governor', 'President'];

// Looks up a candidate's current ward_id, or null if the candidate doesn't
// exist. Used by the PUT/DELETE route handlers (in server.js) to resolve
// the existing ward BEFORE checking permission on it — identical to what
// each route's own inline `SELECT ward_id FROM candidates WHERE id = $1`
// did before this extraction.
async function getCandidateWard(pool, id) {
  const result = await pool.query('SELECT ward_id FROM candidates WHERE id = $1', [id]);
  return result.rows.length ? result.rows[0].ward_id : undefined; // undefined = not found
}

async function createCandidate(pool, { name, party, bio, img, category, incumbent, wardId }) {
  const cat = CANDIDATE_CATEGORIES.includes(category) ? category : 'MCA';
  // display_order = 1 + current max within category
  const maxOrd = await pool.query(
    `SELECT COALESCE(MAX(display_order), -1) AS max_ord FROM candidates WHERE category = $1`,
    [cat]
  );
  const nextOrd = parseInt(maxOrd.rows[0].max_ord) + 1;
  const result = await pool.query(
    `INSERT INTO candidates (name, party, bio, img, category, incumbent, display_order, ward_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [name.trim(), party || '', bio || '', img || '', cat, incumbent === true || incumbent === 'true', nextOrd, wardId]
  );
  return result.rows[0];
}

async function updateCandidate(pool, id, { name, party, bio, img, category, incumbent, wardId, hasWardId }) {
  const cat = CANDIDATE_CATEGORIES.includes(category) ? category : 'MCA';
  const result = hasWardId
    ? await pool.query(
        `UPDATE candidates
            SET name=$1, party=$2, bio=$3, img=$4, category=$5, incumbent=$6, ward_id=$7
          WHERE id=$8
          RETURNING *`,
        [name.trim(), party || '', bio || '', img || '', cat, incumbent === true || incumbent === 'true', wardId, id]
      )
    : await pool.query(
        `UPDATE candidates
            SET name=$1, party=$2, bio=$3, img=$4, category=$5, incumbent=$6
          WHERE id=$7
          RETURNING *`,
        [name.trim(), party || '', bio || '', img || '', cat, incumbent === true || incumbent === 'true', id]
      );
  return result.rows.length ? result.rows[0] : null;
}

async function deleteCandidate(pool, id) {
  const result = await pool.query(
    `DELETE FROM candidates WHERE id=$1 RETURNING id, name, category`,
    [id]
  );
  return result.rows.length ? result.rows[0] : null;
}

module.exports = {
  FALLBACK_CANDIDATES,
  CANDIDATE_CATEGORIES,
  getCandidatesByCategory,
  getAllCandidates,
  getCandidateWard,
  createCandidate,
  updateCandidate,
  deleteCandidate,
};
