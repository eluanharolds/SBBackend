import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pool from '../config/db.js';

const router = express.Router();



import { generate_qr_code, generateUniqueCardNumber } from './functions.js';

import auth from '../middlewares/auth.js';

// @route   GET api/auth/notifications
// @desc    Get notifications for current user
router.get('/notifications', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   POST api/auth/signup
// @desc    Register user


router.post('/signup', async (req, res) => {

  /**
   * The goal of this method is to first register the user,
   * --- Then create for them a virtual account and virtual card (A user can    have multiple virual cards),
   * --- Then create a QR Code for them
   * --- Initialize their transactions to zero and their account balance to zero.
   * Set their first card to be their default card,
   */
  const { name, email, password, phone, role } = req.body;

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length > 0) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const [result] = await pool.query(
      'INSERT INTO users (name, email, password, phone, role) VALUES (?, ?, ?, ?, ?)',
      [name, email, hashedPassword, phone, role]
    );

    const userId = result.insertId;
    
   
    // 1 -- Create wallet for new user
    await pool.query('INSERT INTO wallets (user_id) VALUES (?)', [userId]);
    
    // 2 -- Create a virtual account here.
    const card_number = await generateUniqueCardNumber();
    const expiry_date = '12/28';
    const cvv = Math.floor(100 + Math.random() * 900).toString();
    
    const wallet_data = `user_id: ${userId}, card_number: ${card_number}, expiry_date: ${expiry_date}, cvv: ${cvv}`;

    // 3 -- Create qr code here
    const qr_code_path = await generate_qr_code(userId, wallet_data);
    if (typeof qr_code_path !== 'string' || qr_code_path.startsWith('Failed to create')) {
      return res.status(400).json({ message: 'Failed to create QR Code' });
    }
    // 4 -- Save QR Code to Database.
    const [qrResult] = await pool.query(
      'INSERT INTO qr_codes (user_id, qr_code_path) VALUES (?, ?)',
      [userId, qr_code_path]
    );

    const qr_code_id = qrResult.insertId;

    // 5 -- Create Virtual Card for new User.
    await pool.query(
        'INSERT INTO virtual_cards (user_id, card_number, expiry_date, cvv, qr_code_id, is_default) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, card_number, expiry_date, cvv, qr_code_id, true]
    );

    const payload = { user: { id: userId, role } };
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' }, async (err, token) => {
      if (err) throw err;
      // 6 -- Fetch the user's current wallet balance
      const [walletRows] = await pool.query('SELECT balance FROM wallets WHERE user_id = ?', [userId]);
      const balance = walletRows.length > 0 ? walletRows[0].balance : 0;

      res.json({ token, user: { id: userId, name, email, phone, role, qr_code_path, balance, card_number } });

    });

  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   POST api/auth/login
// @desc    Authenticate user & get token
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(400).json({ message: 'Invalid Credentials' });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid Credentials' });
    }

    const payload = { user: { id: user.id, role: user.role } };
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' }, (err, token) => {
      if (err) throw err;
      delete user.password;
      res.json({ token, user });
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   POST api/auth/forgot-password
// @desc    Request password reset token
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      // Return 200 for security reasons (don't reveal if user exists)
      return res.json({ message: 'If an account with that email exists, a reset code has been sent.' });
    }

    const userId = rows[0].id;
    // Generate a 6-digit code for simplicity in mobile apps
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + 3600000; // 1 hour

    await pool.query(
      'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
      [resetCode, expiry, userId]
    );

    // In a real app, send an email here. For this demo, we'll return the code.
    console.log(`Password reset code for ${email}: ${resetCode}`);
    
    res.json({ 
      message: 'If an account with that email exists, a reset code has been sent.',
      demo_code: resetCode // Returning code only for testing purposes
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   POST api/auth/reset-password
// @desc    Reset password using token
router.post('/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;

  try {
    const [rows] = await pool.query(
      'SELECT id, reset_token, reset_token_expiry FROM users WHERE email = ?',
      [email]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: 'Invalid request' });
    }

    const user = rows[0];

    if (!user.reset_token || user.reset_token !== code || Date.now() > user.reset_token_expiry) {
      return res.status(400).json({ message: 'Invalid or expired reset code' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await pool.query(
      'UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
      [hashedPassword, user.id]
    );

    res.json({ message: 'Password has been reset successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

export default router;
