// ============================================
// CRON JOB: Period Reset Scheduler
// Runs every minute to check and reset voting periods
// ============================================

const axios = require('axios');

const API_URL = process.env.API_URL || 'https://your-app.onrender.com';
const CRON_SECRET = process.env.CRON_SECRET;

async function checkAndResetPeriod() {
    if (!CRON_SECRET) {
        console.error('❌ CRON_SECRET not set');
        return;
    }

    try {
        const response = await axios.post(
            `${API_URL}/api/webhook`,
            {},
            {
                headers: {
                    'x-cron-secret': CRON_SECRET
                },
                timeout: 30000
            }
        );

        const now = new Date().toISOString();
        
        if (response.data.success) {
            if (response.data.completedPeriod) {
                console.log(`[${now}] ✅ Period ${response.data.completedPeriod} completed. New period ${response.data.newPeriod} started. Winner: ${response.data.winner || 'unknown'}`);
            } else if (response.data.message === 'Period still active') {
                console.log(`[${now}] ⏳ Period active until ${response.data.endsAt}`);
            } else {
                console.log(`[${now}] ℹ️ ${response.data.message}`);
            }
        } else {
            console.error(`[${now}] ❌ Reset failed: ${response.data.error}`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Cron error:`, error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

// Run immediately on start
checkAndResetPeriod();

// Then every minute
setInterval(checkAndResetPeriod, 60 * 1000);

console.log('🕐 Period reset cron job started (running every minute)');