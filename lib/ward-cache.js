// ────────────────────────────────────────────────────────────────────────
// lib/ward-cache.js — Phase 4B.5: moved from server.js's bare
// module-scoped `let`-declared founding-ward singleton.
//
// Exactly one variable, exactly one writer (ensurePhase2Migrations(),
// called once during startup, before app.listen() — see
// bootstrap/startup.js), many readers across server.js and (eventually)
// the route files that depend on it. This module exists purely to give
// those readers a way to reach the value without requiring server.js
// itself, which has no module.exports and would create a circular
// dependency if anything tried.
// ────────────────────────────────────────────────────────────────────────

let foundingWardId = null;

function getFoundingWardId() {
  return foundingWardId;
}

function setFoundingWardId(id) {
  foundingWardId = id;
}

module.exports = { getFoundingWardId, setFoundingWardId };
