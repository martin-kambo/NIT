// lib/auth/password.js
// Phase 4B.2A: hashPassword() extracted verbatim from server.js — confirmed
// to depend only on the built-in `crypto` module, nothing from server.js.
//
// generateSalt() is new in the sense that it wasn't a named function before
// — it was the same `crypto.randomBytes(16).toString('hex')` expression
// duplicated inline at 3 call sites in server.js (registration,
// password-reset, change-password). This consolidates those 3 identical
// expressions into one function, per the phase's explicit instruction to
// replace duplicated inline logic with a single source of truth — the
// computation itself (16 random bytes, hex-encoded) is unchanged.

const crypto = require('crypto');

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = { hashPassword, generateSalt };
