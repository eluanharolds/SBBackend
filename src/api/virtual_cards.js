import express from 'express';
import pool from '../config/db.js';
import auth from '../middlewares/auth.js';
import { json } from 'express';
import { generate_qr_code, generateUniqueCardNumber } from './functions.js';
import axios from 'axios';

const router = express.Router();

/**
 * @route   POST api/virtual_cards/initialize-funding
 * @desc    Initialize Paystack payment for virtual card funding
 */
router.post('/initialize-funding', auth, async (req, res) => {
  const { cardId, amount, callback_url } = req.body;

  try {
    const [userRows] = await pool.query('SELECT email FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });

    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: userRows[0].email,
      amount: amount * 100,
      callback_url: callback_url || 'http://localhost:19006/card-funding-callback',
      metadata: {
        userId: req.user.id,
        cardId: cardId,
        type: 'CARD_FUNDING'
      }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data.data);
  } catch (err) {
    console.error('Paystack initialization error (card):', err.response?.data || err.message);
    res.status(500).json({ message: 'Error initializing card funding' });
  }
});

/**
 * @route   POST api/virtual_cards/verify-funding
 * @desc    Verify Paystack payment and fund virtual card
 */
router.post('/verify-funding', auth, async (req, res) => {
  const { reference, cardId } = req.body;

  try {
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });

    const { status, amount, metadata } = response.data.data;
    const finalCardId = cardId || metadata.cardId;

    if (status === 'success') {
      const [existingTrans] = await pool.query('SELECT * FROM transactions WHERE reference = ?', [reference]);
      if (existingTrans.length > 0) {
        return res.status(400).json({ message: 'Transaction already processed' });
      }

      const amountInNaira = amount / 100;
      const userId = req.user.id;

      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        // 1. Get Card and Wallet
        const [cardRows] = await connection.query('SELECT card_balance FROM virtual_cards WHERE id = ? AND user_id = ?', [finalCardId, userId]);
        if (cardRows.length === 0) {
          await connection.rollback();
          return res.status(404).json({ message: 'Card not found' });
        }

        const [walletRows] = await connection.query('SELECT id FROM wallets WHERE user_id = ?', [userId]);
        const walletId = walletRows[0].id;

        // 2. Update Card Balance
        const newBalance = parseFloat(cardRows[0].card_balance || 0) + amountInNaira;
        await connection.query('UPDATE virtual_cards SET card_balance = ? WHERE id = ?', [newBalance.toString(), finalCardId]);

        // 3. Record Transaction
        await connection.query(
          'INSERT INTO transactions (wallet_id, amount, type, status, reference, merchant_name) VALUES (?, ?, ?, ?, ?, ?)',
          [walletId, amountInNaira, 'FUNDING', 'SUCCESS', reference, 'Paystack Card Funding']
        );

        // 4. Notification
        await connection.query(
          'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
          [userId, 'Card Funded', `Successfully funded your card with ₦${amountInNaira.toLocaleString()}.`, 'SUCCESS']
        );

        await connection.commit();
        res.json({ message: 'Card funded successfully', newBalance });
      } catch (err) {
        await connection.rollback();
        throw err;
      } finally {
        connection.release();
      }
    } else {
      res.status(400).json({ message: 'Payment verification failed' });
    }
  } catch (err) {
    console.error('Paystack verification error (card):', err.response?.data || err.message);
    res.status(500).json({ message: 'Error verifying payment' });
  }
});

/**
 * @route   POST api/virtual_cards/create
 * @desc    Create a new virtual card for the logged-in user
 * @access  Private
 */
router.post('/create', auth, async (req, res) => {
  const { user_id, card_alias, card_color } = req.body;
  const userId = req.user.id; // Get the user ID from the auth middleware
  
  console.log(`Backend has been reached for user: ${userId}, Alias: ${card_alias}, Color: ${card_color}`);
  console.log('Full Request Body:', JSON.stringify(req.body, null, 2));

  try {
    // Generate virtual card details with uniqueness check
    const cardNumber = await generateUniqueCardNumber();
    const expiryDate = '12/28'; // Could be dynamic
    const cvv = Math.floor(100 + Math.random() * 900).toString();

    // Data for the QR code (Optimized format for scanner)
    const walletData = `SB-CARD-${cardResult.insertId}-${cardNumber}`;

    // Create QR code
    const qrCodePath = await generate_qr_code(userId, walletData);

    // If generate_qr_code returns an error string or fails
    if (typeof qrCodePath !== 'string' || qrCodePath.startsWith('Failed to create')) {
      return res.status(500).json({ message: 'Failed to generate QR code', error: qrCodePath });
    }

    // 3. Save QR Code to the database
    const [qrResult] = await pool.query(
      'INSERT INTO qr_codes (user_id, qr_code_path) VALUES (?, ?)',
      [userId, qrCodePath]
    );
    const qrCodeId = qrResult.insertId;

    // 4. Link the Virtual Card to the QR code
    await pool.query(
      'UPDATE virtual_cards SET qr_code_id = ? WHERE id = ?',
      [qrCodeId, cardResult.insertId]
    );

    res.status(201).json({
      message: 'Virtual card created successfully',
      card: {
        id: cardResult.insertId,
        user_id: userId,
        card_number: cardNumber,
        expiry_date: expiryDate,
        cvv: cvv,
        qr_code_path: qrCodePath,
        card_alias: card_alias,
        card_color: card_color
      }
    });

  } catch (err) {
    console.error('Error creating virtual card:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   GET api/virtual_cards
 * @desc    Get all virtual cards for the logged-in user
 * @access  Private
 */
router.get('/', auth, async (req, res) => {
  const userId = req.user.id;
  const { limit, offset } = req.body;
  try {
    const [cards] = await pool.query(
      `SELECT vc.*, qr.qr_code_path 
       FROM virtual_cards vc 
       JOIN qr_codes qr ON vc.qr_code_id = qr.qr_code_id 
       WHERE vc.user_id = ?`,
      [userId]
    );
    res.json(cards);
  } catch (err) {
    console.error('Error fetching virtual cards:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   PUT api/virtual_cards/:id/fund
 * @desc    Fund a virtual card
 * @access  Private
 */
router.put('/:id/fund', auth, async (req, res) => {
  const { amount, bankName } = req.body;
  const cardId = req.params.id;
  const userId = req.user.id;

  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. Get Card and Wallet
      const [cardRows] = await connection.query('SELECT card_balance, card_alias FROM virtual_cards WHERE id = ? AND user_id = ?', [cardId, userId]);
      if (cardRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ message: 'Card not found' });
      }

      const [walletRows] = await connection.query('SELECT id FROM wallets WHERE user_id = ?', [userId]);
      if (walletRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ message: 'Wallet not found' });
      }

      const walletId = walletRows[0].id;
      const currentBalance = parseFloat(cardRows[0].card_balance || 0);
      const newBalance = currentBalance + parseFloat(amount);

      // 2. Update Card Balance
      await connection.query('UPDATE virtual_cards SET card_balance = ? WHERE id = ?', [newBalance.toString(), cardId]);

      // 3. Record Transaction
      const reference = `FUND-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      await connection.query(
        'INSERT INTO transactions (wallet_id, amount, type, status, merchant_name, reference) VALUES (?, ?, ?, ?, ?, ?)',
        [walletId, amount, 'FUNDING', 'SUCCESS', bankName || 'Bank Transfer', reference]
      );

      await connection.commit();
      res.json({ message: 'Card funded successfully', newBalance });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Error funding card:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   PUT api/virtual_cards/:id/default
 * @desc    Set a virtual card as default
 * @access  Private
 */
router.put('/:id/default', auth, async (req, res) => {
  const cardId = req.params.id;
  const userId = req.user.id;

  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. Unset all other cards as default for this user
      await connection.query('UPDATE virtual_cards SET is_default = FALSE WHERE user_id = ?', [userId]);

      // 2. Set the selected card as default
      const [result] = await connection.query('UPDATE virtual_cards SET is_default = TRUE WHERE id = ? AND user_id = ?', [cardId, userId]);

      if (result.affectedRows === 0) {
        await connection.rollback();
        return res.status(404).json({ message: 'Card not found' });
      }

      await connection.commit();
      res.json({ message: 'Default card updated successfully' });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Error setting default card:', err.message);
    res.status(500).send('Server error');
  }
});

export default router;
