const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

exports.handler = async (event) => {
  const { action, phone, password, otp } = JSON.parse(event.body);
  
  if (action === 'login') {
    // Verify phone + password
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();
    
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid credentials' }) };
    
    const isValid = await verifyPassword(password, user.password_hash, user.salt);
    if (!isValid) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid credentials' }) };
    
    // Generate JWT token
    const token = createJWT({ userId: user.id, phone: user.phone });
    
    return { statusCode: 200, body: JSON.stringify({ token, user: sanitizeUser(user) }) };
  }
  
  if (action === 'register') {
    // Create new user
    const { hash, salt } = await createUserHash(password);
    const voterNumber = await getNextVoterNumber();
    
    const { data, error } = await supabase
      .from('users')
      .insert([{ phone, first_name, surname, dob, sublocation, email, national_id, language, voter_number: voterNumber, password_hash: hash, salt }])
      .select()
      .single();
    
    return { statusCode: 200, body: JSON.stringify({ success: true, user: sanitizeUser(data) }) };
  }
};