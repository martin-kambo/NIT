// ───────────────────────────────────
// lib/static-cache.js — Phase 4B.5: moved verbatim from server.js.
// Pre-Phase 3B Task 3: in-memory cache for rarely-changing reference data.
// Used ONLY for: counties, constituencies, wards, candidate lists. NOT
// used for votes, leaderboards, analytics, forum, notices, or anything
// per-user — those remain fully live, unchanged by this task.
//
// A plain Map is sufficient and intentional here, not a placeholder for
// something more sophisticated: this is a single Node.js process (no
// clustering, confirmed elsewhere in this codebase), and Node is
// single-threaded for JS execution, so there is no concurrent-write race
// risk on this Map the way there would be with shared state across
// multiple processes — that's also exactly why this does NOT reach for
// Redis, which is explicitly out of scope for this phase.
//
// The TTL below is a safety net only, not the correctness mechanism — the
// real guarantee against stale data is invalidateStaticCache(), called
// synchronously right after each successful admin write (counties,
// constituencies, wards, candidates create/update/delete), before that
// write's response is sent. The TTL exists purely to bound staleness in
// the hypothetical case an invalidation call is ever missed in a future
// edit; it is not relied upon as the primary guarantee.
const staticDataCache = new Map();
const STATIC_CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute safety net

function getCached(key) {
  const entry = staticDataCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.time > STATIC_CACHE_TTL_MS) {
    staticDataCache.delete(key);
    return undefined;
  }
  return entry.value;
}
function setCached(key, value) {
  staticDataCache.set(key, { value, time: Date.now() });
}
// Clears every cached entry whose key starts with any of the given
// prefixes. Called after a successful admin write so the very next read —
// even one racing in immediately after — sees fresh data. Coarse-grained
// by design (clears the whole dataset's cache rather than computing
// exactly which filtered sub-keys are affected): these admin writes are
// infrequent, so the small extra cost of one cold cache repopulation per
// write is the deliberately conservative, low-risk choice.
function invalidateStaticCache(...prefixes) {
  for (const key of staticDataCache.keys()) {
    if (prefixes.some(p => key.startsWith(p))) staticDataCache.delete(key);
  }
}

module.exports = { getCached, setCached, invalidateStaticCache };
