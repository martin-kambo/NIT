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

module.exports = {
  FALLBACK_CANDIDATES,
  getCandidatesByCategory,
  getAllCandidates
};
