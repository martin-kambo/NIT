// seed-notices.js — run once to populate the notices table
// Usage: node seed-notices.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function seed() {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM notices');
    const count = parseInt(rows[0].count);
    console.log('Current notice count:', count);

    if (count > 0) {
      console.log('Table already has data. Skipping seed.');
      console.log('If you want to re-seed, run: DELETE FROM notices;  first.');
      return;
    }

    await pool.query(`
      INSERT INTO notices (id, title, content, category, priority, expires_at, created_by) VALUES
      (
        gen_random_uuid(),
        'Ngoliba Farmers Market - Every Saturday',
        'Fresh produce, dairy, and crafts from local farmers. Open 7AM-1PM at Ngoliba Market grounds. Bulk orders welcome. Contact: 0712 111 222',
        'business', 'normal', NOW() + INTERVAL '90 days', 'system'
      ),
      (
        gen_random_uuid(),
        'Water Rationing Notice - Kilimambogo',
        'Kenya Water Authority advises reduced supply Mon-Wed for 30 days due to pipeline maintenance. Store water accordingly. Helpline: 0800 723 232',
        'public', 'high', NOW() + INTERVAL '30 days', 'system'
      ),
      (
        gen_random_uuid(),
        'Boda Boda Riders Wanted - Ngoliba Express',
        'Ngoliba Express recruiting 10 boda boda riders for parcel delivery. Valid licence required. Earn KES 800-1,500 daily. Apply in person at Ngoliba Town Centre. Contact: 0798 456 789',
        'jobs', 'normal', NOW() + INTERVAL '60 days', 'system'
      ),
      (
        gen_random_uuid(),
        'Community Health Camp - Mwea Ward',
        'Free health screening and vaccination services. First Saturday of every month, Mwea Ward Market. Services: Blood pressure, BMI, Immunizations. Bring ID. Contact: 0789 654 321',
        'health', 'normal', NOW() + INTERVAL '120 days', 'system'
      ),
      (
        gen_random_uuid(),
        'Road Maintenance - Ngoliba-Ruiru Highway',
        'The Ngoliba-Ruiru highway will be under maintenance June 15-22. Expect delays. Alternative routes recommended.',
        'public', 'high', NOW() + INTERVAL '45 days', 'system'
      )
    `);

    console.log('✅ 5 notices inserted successfully.');

    const verify = await pool.query('SELECT id, title, category FROM notices ORDER BY created_at');
    console.log('\nInserted notices:');
    verify.rows.forEach((r, i) => console.log(`  ${i+1}. [${r.category}] ${r.title}`));

  } catch (err) {
    console.error('❌ Seed error:', err.message);
  } finally {
    await pool.end();
  }
}

seed();