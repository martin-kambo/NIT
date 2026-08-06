// bootstrap/database.js
// Phase 4B.1: extracted verbatim from server.js (Pool creation and the
// connection-test function). Both depend only on process.env and the pool
// object itself — no other module-level state from server.js — confirmed
// before moving. dotenv.config() has already run by the time server.js
// requires this module, so process.env.DATABASE_URL is populated.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 60000, // ✅ INCREASED FROM 15s to 60s
  statement_timeout: 30000,
  ssl: {
    rejectUnauthorized: false
  }
});

async function testDBConnection() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected at:', res.rows[0].now);
    return true;
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('   Make sure DATABASE_URL in .env is correct');
    console.error('   And that Render PostgreSQL instance is running');
    return false;
  }
}

module.exports = { pool, testDBConnection };
