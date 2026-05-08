// netlify/functions/profile.js
// Update user profile information

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

function verifySession(cookieHeader) {
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;
  
  const [payloadBase64, signature] = match[1].split('.');
  const expectedSig = crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(payloadBase64)
    .digest('base64');
  
  if (signature !== expectedSig) return null;
  
  const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
  if (payload.exp < Date.now()) return null;
  
  return payload;
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidNationalId(id) {
  if (!id) return true;
  return /^[0-9]{7,8}$/.test(id);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'PUT' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Verify session
  const session = verifySession(event.headers.cookie || '');
  if (!session) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { action } = JSON.parse(event.body);
    const usersStore = getStore('users');
    
    // Get current user data
    const userData = await usersStore.get(session.phone);
    if (!userData) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
    }
    
    const user = JSON.parse(userData);

    // --- UPDATE PROFILE ---
    if (action === 'update_profile') {
      const { firstName, surname, sublocation, email, nationalId, language } = JSON.parse(event.body);

      // Validate inputs
      if (firstName && (firstName.length < 2 || firstName.length > 50)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'First name must be 2-50 characters' }) };
      }
      if (surname && (surname.length < 2 || surname.length > 50)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Surname must be 2-50 characters' }) };
      }
      if (email && !isValidEmail(email)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email address' }) };
      }
      if (nationalId && !isValidNationalId(nationalId)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'National ID must be 7-8 digits' }) };
      }

      // Update user
      if (firstName) user.firstName = firstName;
      if (surname) user.surname = surname;
      if (sublocation) user.sublocation = sublocation;
      if (email !== undefined) user.email = email;
      if (nationalId !== undefined) user.nationalId = nationalId;
      if (language) user.language = language;
      user.updatedAt = new Date().toISOString();

      await usersStore.set(session.phone, JSON.stringify(user));

      const { passwordHash, salt, ...safeUser } = user;
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, user: safeUser })
      };
    }

    // --- UPDATE PASSWORD ---
    if (action === 'change_password') {
      const { currentPassword, newPassword } = JSON.parse(event.body);

      if (!currentPassword || !newPassword) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Current password and new password are required' }) };
      }
      if (newPassword.length < 6) {
        return { statusCode: 400, body: JSON.stringify({ error: 'New password must be at least 6 characters' }) };
      }

      // Verify current password
      const currentHash = crypto.createHash('sha256').update(currentPassword + user.salt).digest('hex');
      if (currentHash !== user.passwordHash) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Current password is incorrect' }) };
      }

      // Hash new password
      const newSalt = crypto.randomBytes(16).toString('hex');
      const newHash = crypto.createHash('sha256').update(newPassword + newSalt).digest('hex');

      user.passwordHash = newHash;
      user.salt = newSalt;
      user.updatedAt = new Date().toISOString();

      await usersStore.set(session.phone, JSON.stringify(user));

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Password changed successfully' })
      };
    }

    // --- UPDATE PROFILE PHOTO ---
    if (action === 'update_photo') {
      const { photoBase64 } = JSON.parse(event.body);

      if (!photoBase64) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Photo data is required' }) };
      }

      // Validate base64 image size (max 2MB)
      const estimatedSize = photoBase64.length * 0.75;
      if (estimatedSize > 2 * 1024 * 1024) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Image must be less than 2MB' }) };
      }

      user.profilePhoto = photoBase64;
      user.updatedAt = new Date().toISOString();

      await usersStore.set(session.phone, JSON.stringify(user));

      const { passwordHash, salt, ...safeUser } = user;
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, user: safeUser })
      };
    }

    // --- REMOVE PROFILE PHOTO ---
    if (action === 'remove_photo') {
      delete user.profilePhoto;
      user.updatedAt = new Date().toISOString();

      await usersStore.set(session.phone, JSON.stringify(user));

      const { passwordHash, salt, ...safeUser } = user;
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, user: safeUser })
      };
    }

    // --- GET PROFILE ---
    if (action === 'get_profile') {
      const { passwordHash, salt, ...safeUser } = user;
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, user: safeUser })
      };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid action' })
    };

  } catch (error) {
    console.error('profile error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};