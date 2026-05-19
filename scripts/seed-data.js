// ============================================
// SEED DATA SCRIPT
// Run: node scripts/seed-data.js
// ============================================

const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

const CANDIDATES = [
    { id: 0, name: 'Hon. James Mwangi', party: 'UDA', bio: 'Two-term MCA, water projects.', img: 'https://randomuser.me/api/portraits/men/32.jpg', incumbent: true },
    { id: 1, name: 'Grace Wanjiku', party: 'Independent', bio: 'Teacher & community organizer.', img: 'https://randomuser.me/api/portraits/women/68.jpg' },
    { id: 2, name: 'Peter Kimani', party: 'Jubilee', bio: 'Agri-business entrepreneur.', img: 'https://randomuser.me/api/portraits/men/45.jpg' },
    { id: 3, name: 'Sarah Nduati', party: 'Wiper', bio: 'Public health expert.', img: 'https://randomuser.me/api/portraits/women/22.jpg' },
    { id: 4, name: 'John Otieno', party: 'Independent', bio: 'Farmer cooperative leader.', img: 'https://randomuser.me/api/portraits/men/89.jpg' },
    { id: 5, name: 'Mary Wambui', party: 'Maendeleo', bio: 'ICT & agribusiness graduate.', img: 'https://randomuser.me/api/portraits/women/54.jpg' },
    { id: 6, name: 'David Kiprotich', party: 'Roots', bio: 'Governance activist.', img: 'https://randomuser.me/api/portraits/men/99.jpg' }
];

async function seedCandidates() {
    console.log('🌱 Seeding candidate data...');
    
    // Candidates are stored as configuration in frontend
    // This just logs the info - actual candidate data is in frontend
    console.log('Candidates ready:', CANDIDATES.map(c => c.name).join(', '));
}

async function seedAdminUser() {
    console.log('👤 Checking admin user...');
    
    // Admin users are authenticated via ADMIN_PASSWORD_HASH env var
    // No database user needed
    console.log('Admin auth via environment variable');
}

async function createInitialPeriod() {
    console.log('📅 Creating initial voting period...');
    
    const result = await pool.query(`
        SELECT id FROM voting_periods LIMIT 1
    `);
    
    if (result.rows.length === 0) {
        await pool.query(`
            INSERT INTO voting_periods (id, period_start, period_end, is_active, total_votes)
            VALUES (1, NOW(), NOW() + INTERVAL '5 minutes', true, 0)
        `);
        
        await pool.query(`
            UPDATE metadata 
            SET value = jsonb_set(value, '{last_period_id}', '1'::jsonb)
            WHERE key = 'counters'
        `);
        
        console.log('✅ Initial period created');
    } else {
        console.log('ℹ️ Period already exists');
    }
}

async function seedForumSamplePosts() {
    console.log('💬 Seeding sample forum posts...');
    
    const samplePosts = [
        { title: 'Water shortage in Magogoni', content: 'When will the water pump be fixed? Residents are suffering.' },
        { title: 'Kilimambogo road needs repair', content: 'The road to the market is impassable during rains.' },
        { title: 'Youth employment opportunities', content: 'Any candidates with concrete youth employment plans?' }
    ];
    
    for (const post of samplePosts) {
        const exists = await pool.query(
            'SELECT id FROM forum_posts WHERE title = $1 LIMIT 1',
            [post.title]
        );
        
        if (exists.rows.length === 0) {
            await pool.query(`
                INSERT INTO forum_posts (id, title, content, author_name, created_at)
                VALUES (uuid_generate_v4(), $1, $2, 'System', NOW())
            `, [post.title, post.content]);
            console.log(`   Added: ${post.title}`);
        }
    }
}

async function main() {
    try {
        console.log('🚀 Starting data seeding...\n');
        
        await seedCandidates();
        await seedAdminUser();
        await createInitialPeriod();
        await seedForumSamplePosts();
        
        console.log('\n✅ Seeding completed successfully!');
    } catch (error) {
        console.error('❌ Seeding failed:', error);
    } finally {
        await pool.end();
    }
}

// Run if executed directly
if (require.main === module) {
    main();
}

module.exports = { CANDIDATES, seedCandidates };