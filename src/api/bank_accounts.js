import express from 'express';
import pool from '../config/db.js';
import auth from '../middlewares/auth.js';

const router = express.Router();

/**
 * @route   POST api/bank_accounts
 * @desc    Register a new bank account
 * @access  Private
 */
router.post('/', auth, async (req, res) => {
  const { name, accountNumber, bankCode, expiry, cvv, icon } = req.body;
  const userId = req.user.id;

  if (!name || !accountNumber) {
    return res.status(400).json({ message: 'Bank name and account number are required' });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO bank_accounts (user_id, bank_name, account_number, bank_code, expiry, cvv, icon) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, name, accountNumber, bankCode, expiry, cvv, icon || '🏦']
    );

    res.status(201).json({
      message: 'Bank account registered successfully',
      bank: {
        id: result.insertId,
        user_id: userId,
        name,
        accountNumber,
        expiry,
        cvv,
        icon: icon || '🏦'
      }
    });
  } catch (err) {
    console.error('Error registering bank account:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   GET api/bank_accounts
 * @desc    Get all registered bank accounts for the logged-in user
 * @access  Private
 */
router.get('/', auth, async (req, res) => {
  const userId = req.user.id;

  try {
    const [rows] = await pool.query(
      'SELECT id, bank_name as name, account_number as accountNumber, bank_code as bankCode, recipient_code as recipientCode, expiry, cvv, icon, is_default FROM bank_accounts WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    res.json(rows);
  } catch (err) {
    console.error('Error fetching bank accounts:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   PUT api/bank_accounts/:id/default
 * @desc    Set a bank account as default for withdrawal/funding
 * @access  Private
 */
router.put('/:id/default', auth, async (req, res) => {
  const userId = req.user.id;
  const bankId = req.params.id;

  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. Unset all other banks as default for this user
      await connection.query('UPDATE bank_accounts SET is_default = FALSE WHERE user_id = ?', [userId]);

      // 2. Set the selected bank as default
      const [result] = await connection.query('UPDATE bank_accounts SET is_default = TRUE WHERE id = ? AND user_id = ?', [bankId, userId]);

      if (result.affectedRows === 0) {
        await connection.rollback();
        return res.status(404).json({ message: 'Bank account not found' });
      }

      await connection.commit();
      res.json({ message: 'Default bank account updated successfully' });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Error setting default bank account:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   DELETE api/bank_accounts/:id
 * @desc    Delete a registered bank account
 * @access  Private
 */
router.delete('/:id', auth, async (req, res) => {
  const userId = req.user.id;
  const bankId = req.params.id;

  try {
    const [result] = await pool.query(
      'DELETE FROM bank_accounts WHERE id = ? AND user_id = ?',
      [bankId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Bank account not found or unauthorized' });
    }

    res.json({ message: 'Bank account deleted successfully' });
  } catch (err) {
    console.error('Error deleting bank account:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   PUT api/bank_accounts/:id
 * @desc    Update a registered bank account
 * @access  Private
 */
router.put('/:id', auth, async (req, res) => {
  const { name, accountNumber, expiry, cvv, icon } = req.body;
  const userId = req.user.id;
  const bankId = req.params.id;

  if (!name || !accountNumber) {
    return res.status(400).json({ message: 'Bank name and account number are required' });
  }

  try {
    const [result] = await pool.query(
      'UPDATE bank_accounts SET bank_name = ?, account_number = ?, expiry = ?, cvv = ?, icon = ? WHERE id = ? AND user_id = ?',
      [name, accountNumber, expiry, cvv, icon || '🏦', bankId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Bank account not found or unauthorized' });
    }

    res.json({
      message: 'Bank account updated successfully',
      bank: { id: parseInt(bankId), name, accountNumber, expiry, cvv, icon: icon || '🏦' }
    });
  } catch (err) {
    console.error('Error updating bank account:', err.message);
    res.status(500).send('Server error');
  }
});

export default router;
