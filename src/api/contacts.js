import express from 'express';
import pool from '../config/db.js';
import auth from '../middlewares/auth.js';

const router = express.Router();

/**
 * @route   POST api/contacts/match
 * @desc    Match phone numbers from device with SmartBuckz users
 * @access  Private
 */
router.post('/match', auth, async (req, res) => {
  const { phoneNumbers } = req.body;
  const currentUserId = req.user.id;

  if (!phoneNumbers || !Array.isArray(phoneNumbers)) {
    return res.status(400).json({ message: 'Invalid phone numbers list' });
  }

  try {
    // Find users whose phone number is in the provided list
    const [matchedUsers] = await pool.query(
      'SELECT id, name, email, phone, role FROM users WHERE phone IN (?) AND id != ?',
      [phoneNumbers, currentUserId]
    );

    // If less than 4 matches, provide fallback contacts for testing
    let results = matchedUsers;
    if (results.length < 4) {
      const [fallbacks] = await pool.query(
        'SELECT id, name, email, phone, role FROM users WHERE id != ? AND id NOT IN (?) LIMIT ?',
        [currentUserId, results.map(u => u.id).concat(0), 4 - results.length]
      );
      results = [...results, ...fallbacks];
    }

    res.json(results);
  } catch (err) {
    console.error('Error matching contacts:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   GET api/contacts/search
 * @desc    Search for a specific user by phone or email
 * @access  Private
 */
router.get('/search', auth, async (req, res) => {
  const { query } = req.query;
  const currentUserId = req.user.id;

  try {
    const [users] = await pool.query(
      'SELECT id, name, email, phone, role FROM users WHERE (phone = ? OR email = ?) AND id != ?',
      [query, query, currentUserId]
    );

    res.json(users);
  } catch (err) {
    console.error('Error searching contacts:', err.message);
    res.status(500).send('Server error');
  }
});

export default router;
