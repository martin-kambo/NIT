// diagnose-notices.js — shows exact notices table schema then attempts a minimal insert
// Usage: node diagnose-notices.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    // 1. Show all columns and their types
    console.log('\n── notices table columns ──');
    const cols = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'notices'
      ORDER BY ordinal_position
    `);
    if (cols.rows.length === 0) {
      console.log('❌ notices table does not exist at all.');
    } else {
      cols.rows.forEach(c =>
        console.log(`  ${c.column_name.padEnd(15)} ${c.data_type.padEnd(20)} nullable:${c.is_nullable}  default:${c.column_default || 'none'}`)
      );
    }

    // 2. Row count
    const cnt = await pool.query('SELECT COUNT(*) AS count FROM notices');
    console.log(`\n── row count: ${cnt.rows[0].count} ──`);

    // 3. Try a bare-minimum insert using only columns that definitely exist
    console.log('\n── attempting minimal insert (title + content only) ──');
    await pool.query(`INSERT INTO notices (title, content) VALUES ('Test Notice', 'Test content') RETURNING id, title`);
    console.log('✅ minimal insert succeeded');

    // 4. Clean up the test row
    await pool.query(`DELETE FROM notices WHERE title = 'Test Notice'`);
    console.log('✅ test row cleaned up');

  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error('   Detail:', err.detail || '(none)');
    console.error('   Hint:  ', err.hint   || '(none)');
  } finally {
    await pool.end();
  }
}

run();