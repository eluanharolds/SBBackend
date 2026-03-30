import express from 'express';
import pool from '../config/db.js';
import auth from '../middlewares/auth.js';

const router = express.Router();

/**
 * @route   GET api/sellers
 * @desc    Get all registered sellers with pagination
 * @access  Private
 */
router.get('/', auth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const offset = parseInt(req.query.offset) || 0;
  const searchQuery = req.query.search || '';

  try {
    let query = `
      SELECT u.id, u.name, u.email, u.phone, u.address, u.is_verified, u.profile_image, u.created_at,
      COALESCE(AVG(r.rating), 0) as avg_rating,
      COUNT(r.id) as review_count
      FROM users u
      LEFT JOIN reviews r ON u.id = r.seller_id
      WHERE u.role = 'SELLER'
    `;
    
    const queryParams = [];
    if (searchQuery) {
      query += ` AND (u.name LIKE ? OR u.address LIKE ?)`;
      queryParams.push(`%${searchQuery}%`, `%${searchQuery}%`);
    }

    query += ` GROUP BY u.id LIMIT ? OFFSET ?`;
    queryParams.push(limit, offset);

    const [sellers] = await pool.query(query, queryParams);

    const enhancedSellers = sellers.map(seller => ({
      ...seller,
      rating: parseFloat(seller.avg_rating).toFixed(1),
      reviewCount: seller.review_count,
      distance: (Math.random() * 5).toFixed(1) + 'km', // Still mock distance
      isAvailable: true // Still mock availability
    }));

    res.json(enhancedSellers);
  } catch (err) {
    console.error('Error fetching sellers:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   GET api/sellers/:id
 * @desc    Get single seller details with real stats
 * @access  Private
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.address, u.is_verified, u.profile_image,
       COALESCE(AVG(r.rating), 0) as avg_rating,
       COUNT(r.id) as review_count
       FROM users u
       LEFT JOIN reviews r ON u.id = r.seller_id
       WHERE u.id = ? AND u.role = 'SELLER'
       GROUP BY u.id`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Seller not found' });
    }

    const seller = rows[0];
    res.json({
      ...seller,
      rating: parseFloat(seller.avg_rating).toFixed(1),
      reviewCount: seller.review_count,
      distance: (Math.random() * 5).toFixed(1) + 'km',
      isAvailable: true
    });
  } catch (err) {
    console.error('Error fetching seller details:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   POST api/sellers/:id/reviews
 * @desc    Add a review for a seller
 * @access  Private
 */
router.post('/:id/reviews', auth, async (req, res) => {
  const { rating, comment } = req.body;
  const sellerId = req.params.id;
  const buyerId = req.user.id;

  try {
    await pool.query(
      'INSERT INTO reviews (seller_id, buyer_id, rating, comment) VALUES (?, ?, ?, ?)',
      [sellerId, buyerId, rating, comment]
    );

    res.status(201).json({ message: 'Review added successfully' });
  } catch (err) {
    console.error('Error adding review:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   GET api/sellers/:id/reviews
 * @desc    Get reviews for a seller with pagination
 * @access  Private
 */
router.get('/:id/reviews', auth, async (req, res) => {
  const sellerId = req.params.id;
  const limit = parseInt(req.query.limit) || 16;
  const offset = parseInt(req.query.offset) || 0;

  try {
    const [reviews] = await pool.query(
      `SELECT r.*, u.name as reviewer_name 
       FROM reviews r 
       JOIN users u ON r.buyer_id = u.id 
       WHERE r.seller_id = ? 
       ORDER BY r.created_at DESC 
       LIMIT ? OFFSET ?`,
      [sellerId, limit, offset]
    );

    res.json(reviews);
  } catch (err) {
    console.error('Error fetching reviews:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   GET api/sellers/:id/menu
 * @desc    Get all menu items for a seller
 * @access  Private
 */
router.get('/:id/menu', auth, async (req, res) => {
  try {
    const [menu] = await pool.query(
      'SELECT * FROM menu_items WHERE seller_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(menu);
  } catch (err) {
    console.error('Error fetching menu:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   POST api/sellers/menu
 * @desc    Add a new menu item
 * @access  Private (Sellers only)
 */
router.post('/menu', auth, async (req, res) => {
  if (req.user.role !== 'SELLER') {
    return res.status(403).json({ message: 'Access denied. Sellers only.' });
  }

  const { name, description, price, is_available } = req.body;

  try {
    const [result] = await pool.query(
      'INSERT INTO menu_items (seller_id, name, description, price, is_available) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, name, description, price, is_available ?? true]
    );

    res.status(201).json({ 
      id: result.insertId, 
      seller_id: req.user.id, 
      name, 
      description, 
      price, 
      is_available: is_available ?? true 
    });
  } catch (err) {
    console.error('Error adding menu item:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   PUT api/sellers/menu/:id
 * @desc    Update a menu item
 * @access  Private (Sellers only)
 */
router.put('/menu/:id', auth, async (req, res) => {
  if (req.user.role !== 'SELLER') {
    return res.status(403).json({ message: 'Access denied. Sellers only.' });
  }

  const { name, description, price, is_available } = req.body;

  try {
    const [result] = await pool.query(
      'UPDATE menu_items SET name = ?, description = ?, price = ?, is_available = ? WHERE id = ? AND seller_id = ?',
      [name, description, price, is_available, req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Menu item not found or unauthorized' });
    }

    res.json({ message: 'Menu item updated successfully' });
  } catch (err) {
    console.error('Error updating menu item:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   DELETE api/sellers/menu/:id
 * @desc    Delete a menu item
 * @access  Private (Sellers only)
 */
router.delete('/menu/:id', auth, async (req, res) => {
  if (req.user.role !== 'SELLER') {
    return res.status(403).json({ message: 'Access denied. Sellers only.' });
  }

  try {
    const [result] = await pool.query(
      'DELETE FROM menu_items WHERE id = ? AND seller_id = ?',
      [req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Menu item not found or unauthorized' });
    }

    res.json({ message: 'Menu item deleted successfully' });
  } catch (err) {
    console.error('Error deleting menu item:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   PUT api/sellers/profile
 * @desc    Update seller's profile info
 * @access  Private (Sellers only)
 */
router.put('/profile', auth, async (req, res) => {
  if (req.user.role !== 'SELLER') {
    return res.status(403).json({ message: 'Access denied. Sellers only.' });
  }

  const { name, address, phone } = req.body;

  try {
    await pool.query(
      'UPDATE users SET name = ?, address = ?, phone = ? WHERE id = ?',
      [name, address, phone, req.user.id]
    );

    res.json({ message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Error updating seller profile:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   POST api/sellers/verify
 * @desc    Submit seller verification media
 * @access  Private (Sellers only)
 */
router.post('/verify', auth, async (req, res) => {
  if (req.user.role !== 'SELLER') {
    return res.status(403).json({ message: 'Access denied. Sellers only.' });
  }

  const { photos, video } = req.body;

  if (!photos || !Array.isArray(photos) || photos.length === 0) {
    return res.status(400).json({ message: 'Please provide at least one photo' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Insert photos
    for (const photo of photos) {
      await connection.query(
        'INSERT INTO verification_media (seller_id, file_path, file_type) VALUES (?, ?, ?)',
        [req.user.id, photo, 'PHOTO']
      );
    }

    // 2. Insert video if provided
    if (video) {
      await connection.query(
        'INSERT INTO verification_media (seller_id, file_path, file_type) VALUES (?, ?, ?)',
        [req.user.id, video, 'VIDEO']
      );
    }

    // 3. Update user verification status to "PENDING" or just set is_verified if you want auto-verify
    // For now, let's just mark them as verified to satisfy the UX requirement
    await connection.query(
      'UPDATE users SET is_verified = TRUE WHERE id = ?',
      [req.user.id]
    );

    await connection.commit();
    res.json({ message: 'Verification submitted successfully' });
  } catch (err) {
    await connection.rollback();
    console.error('Error submitting verification:', err.message);
    res.status(500).send('Server error');
  } finally {
    connection.release();
  }
});

export default router;
