// netlify/functions/send-otp.js
const africastalking = require('africastalking')({
  apiKey: process.env.AFRICASTALKING_API_KEY,
  username: process.env.AFRICASTALKING_USERNAME
});

exports.handler = async (event) => {
  const { phone } = JSON.parse(event.body);
  const otp = Math.floor(100000 + Math.random() * 900000);
  
  // Store OTP with expiry
  const store = getStore('otp');
  await store.set(phone, JSON.stringify({ code: otp, expires: Date.now() + 600000 }));
  
  // Send SMS
  await africastalking.SMS.send({
    to: phone,
    message: `Your Ngoliba InfoTrack verification code is: ${otp}`
  });
  
  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};