// routes/transactions.js
// Phase 4B.13: extracted verbatim from server.js. POST /api/transaction
// (record STK push initiation) and POST /api/transaction/confirm (mark
// STK push as paid). No dedicated M-Pesa/payment library module
// existed prior to this phase -- both routes were already plain
// inline SQL against the mpesa_transactions table, not delegated to a
// canonical helper, so none was introduced here either. No real
// Daraja API call exists anywhere in this codebase (confirmed: zero
// axios.* calls) -- both routes are bookkeeping only, exactly as they
// were.
//
// Every query, parameter, session check, and response shape below is
// byte-for-byte identical to the original inline version (line
// endings normalized from CRLF to LF, matching the convention already
// used by every other route file created during this modularization).

const express = require('express');
const { pool } = require('../bootstrap/database');
const { verifySession } = require('../lib/auth/session');

const router = express.Router();

// ════════════════════════════════════════════════
// ROUTE: /api/transaction  (record STK push initiation)
// ════════════════════════════════════════════════
router.post('/api/transaction', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { checkout_request_id, phone, amount, candidate_id } = req.body;
  if (!checkout_request_id) return res.status(400).json({ error: 'checkout_request_id required' });

  try {
    await pool.query(
      `INSERT INTO mpesa_transactions
         (id, phone, amount, account_reference, description, status, created_at)
       VALUES ($1, $2, $3, 'NIT-VOTE', $4, 'pending', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        checkout_request_id,
        phone || session.phone || null,
        amount || 10,
        `Vote for candidate ${candidate_id ?? 'unknown'}`
      ]
    );
    return res.json({ success: true });
  } catch (e) {
    console.error('/api/transaction error:', e);
    return res.status(500).json({ error: 'Failed to record transaction' });
  }
});


// ════════════════════════════════════════════════
// ROUTE: /api/transaction/confirm  (mark STK push as paid)
// ════════════════════════════════════════════════
router.post('/api/transaction/confirm', async (req, res) => {
  const session = verifySession(req.headers.cookie || '');
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { checkout_request_id, receipt } = req.body;
  if (!checkout_request_id || !receipt)
    return res.status(400).json({ error: 'checkout_request_id and receipt required' });

  try {
    await pool.query(
      `UPDATE mpesa_transactions
          SET status = 'confirmed',
              mpesa_receipt_number = $2,
              callback_received_at = NOW()
        WHERE id = $1`,
      [checkout_request_id, receipt]
    );
    return res.json({ success: true });
  } catch (e) {
    console.error('/api/transaction/confirm error:', e);
    return res.status(500).json({ error: 'Failed to confirm transaction' });
  }
});


module.exports = router;
