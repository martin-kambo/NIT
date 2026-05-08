// netlify/functions/verify-otp.js
// Verifies OTP code for password reset

const { getStore } = require('@netlify/blobs');
const store = (name) => getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { phone, otpCode, newPassword } = JSON.parse(event.body);

    if (!phone || !otpCode) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Phone and OTP code are required' })
      };
    }

    // Get OTP store
    const otpStore = store('otp');
    const storedOtp = await otpStore.get(phone);

    if (!storedOtp) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'No OTP request found for this phone' })
      };
    }

    const otpData = JSON.parse(storedOtp);

    // Check if OTP has expired (10 minutes)
    if (Date.now() > otpData.expiresAt) {
      await otpStore.delete(phone);
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'OTP has expired. Please request a new one.' })
      };
    }

    // Check OTP attempts
    if (otpData.attempts >= 5) {
      await otpStore.delete(phone);
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Too many failed attempts. Please request a new OTP.' })
      };
    }

    // Verify OTP code
    if (otpData.code !== otpCode) {
      otpData.attempts = (otpData.attempts || 0) + 1;
      await otpStore.set(phone, JSON.stringify(otpData));
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: `Invalid OTP. ${5 - otpData.attempts} attempts remaining.` })
      };
    }

    // If new password provided, update it
    if (newPassword) {
      if (newPassword.length < 6) {
        return {
          statusCode: 400,
          body: JSON.stringify({ success: false, error: 'Password must be at least 6 characters' })
        };
      }

      // Hash new password
      const crypto = require('crypto');
      const usersStore = store('users');
      const userData = await usersStore.get(phone);

      if (!userData) {
        return {
          statusCode: 404,
          body: JSON.stringify({ success: false, error: 'User not found' })
        };
      }

      const user = JSON.parse(userData);
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.createHash('sha256').update(newPassword + salt).digest('hex');

      user.passwordHash = passwordHash;
      user.salt = salt;
      user.updatedAt = new Date().toISOString();

      await usersStore.set(phone, JSON.stringify(user));
    }

    // Delete used OTP
    await otpStore.delete(phone);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: newPassword ? 'Password reset successfully' : 'OTP verified successfully'
      })
    };

  } catch (error) {
    console.error('verify-otp error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'Internal server error' })
    };
  }
};