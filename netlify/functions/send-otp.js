// netlify/functions/send-otp.js
const { getStore } = require('@netlify/blobs');
const africastalking = require('africastalking')({
  apiKey: process.env.AFRICASTALKING_API_KEY,
  username: process.env.AFRICASTALKING_USERNAME
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let phone;
  try { ({ phone } = JSON.parse(event.body)); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone is required' }) };
  }

  // Verify phone exists in users store before sending OTP
  const usersStore = getStore('users');
  const userData = await usersStore.get(phone);
  if (!userData) {
    // Return success anyway to avoid phone enumeration
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  // Store OTP with expiry and attempt counter
  const otpStore = getStore('otp');
  await otpStore.set(phone, JSON.stringify({
    code: otp,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    attempts: 0
  }));

  // Send SMS via Africa's Talking
  await africastalking.SMS.send({
    to: [phone],
    message: `Your Ngoliba InfoTrack verification code is: ${otp}. Valid for 10 minutes.`,
    from: process.env.AFRICASTALKING_SENDER_ID || undefined
  });

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};