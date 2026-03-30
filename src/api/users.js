import express from 'express';
import pool from '../config/db.js';
import auth from '../middlewares/auth.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();

// Ensure uploads directory exists
const uploadDir = 'uploads/profile-images';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'profile-' + req.user.id + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only images (JPEG, JPG, PNG) are allowed!'));
  }
});

/**
 * @route   POST api/users/upload-profile-image
 * @desc    Upload user's profile image to server
 * @access  Private
 */
router.post('/upload-profile-image', auth, (req, res) => {
  upload.single('profileImage')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      console.error('Multer error:', err);
      return res.status(400).json({ message: 'Upload error', error: err.message });
    } else if (err) {
      console.error('General upload error:', err);
      return res.status(400).json({ message: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Please upload a file' });
    }

    try {
      const filePath = `/uploads/profile-images/${req.file.filename}`;
      
      // Update user's profile image in database
      await pool.query(
        'UPDATE users SET profile_image = ? WHERE id = ?',
        [filePath, req.user.id]
      );

      res.json({ 
        message: 'Profile image uploaded successfully', 
        profile_image: filePath 
      });
    } catch (err) {
      console.error('Error updating profile in DB:', err.message);
      res.status(500).send('Server error');
    }
  });
});

/**
 * @route   GET api/users/search
 * @desc    Search for users by name or email
 * @access  Private
 */
router.get('/search', auth, async (req, res) => {
  const { query } = req.query;
  if (!query || query.length < 2) {
    return res.json([]);
  }

  try {
    const [users] = await pool.query(
      'SELECT id, name, email, role, profile_image FROM users WHERE (name LIKE ? OR email LIKE ?) AND id != ? LIMIT 10',
      [`%${query}%`, `%${query}%`, req.user.id]
    );
    res.json(users);
  } catch (err) {
    console.error('Error searching users:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   PUT api/users/profile-image
 * @desc    Update user's profile image
 * @access  Private
 */
router.put('/profile-image', auth, async (req, res) => {
  const { profile_image } = req.body;

  try {
    await pool.query(
      'UPDATE users SET profile_image = ? WHERE id = ?',
      [profile_image, req.user.id]
    );
    res.json({ message: 'Profile image updated successfully', profile_image });
  } catch (err) {
    console.error('Error updating profile image:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   POST api/users/report
 * @desc    Submit a report against a user
 * @access  Private
 */
router.post('/report', auth, async (req, res) => {
  const { reported_user_id, reason } = req.body;

  if (!reported_user_id || !reason) {
    return res.status(400).json({ message: 'Please provide a user and a reason for reporting' });
  }

  try {
    await pool.query(
      'INSERT INTO user_reports (reporter_id, reported_user_id, reason) VALUES (?, ?, ?)',
      [req.user.id, reported_user_id, reason]
    );
    res.json({ message: 'Report submitted successfully. Thank you for helping keep our community safe.' });
  } catch (err) {
    console.error('Error submitting report:', err.message);
    res.status(500).send('Server error');
  }
});

export default router;
