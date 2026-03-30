import express from 'express';
const router = express.Router();
import auth from '../middlewares/auth.js';
import pool from '../config/db.js';

// @route   POST api/orders
// @desc    Place an order
router.post('/', auth, async (req, res) => {
  const { seller_id, items, amount } = req.body;
  try {
    const [result] = await pool.query(
      'INSERT INTO orders (buyer_id, seller_id, items, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, seller_id, items, amount || 0, 'PENDING']
    );

    // Create notification for seller
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [seller_id, 'New Order Received', `You have a new order for ${items}`, 'INFO']
    );

    res.json({ message: 'Order placed successfully', order_id: result.insertId });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET api/orders
// @desc    Get orders for current user (Buyer or Seller)
router.get('/', auth, async (req, res) => {
  const userId = req.user.id;
  const role = req.user.role;

  try {
    let query = '';
    if (role === 'BUYER') {
      query = `
        SELECT o.*, u.name as seller_name, u.phone as seller_phone, u.address as seller_address, u.profile_image as seller_image 
        FROM orders o 
        JOIN users u ON o.seller_id = u.id 
        WHERE o.buyer_id = ? 
        ORDER BY o.created_at DESC
      `;
    } else {
      query = `
        SELECT o.*, u.name as buyer_name, u.phone as buyer_phone, u.address as buyer_address, u.profile_image as buyer_image 
        FROM orders o 
        JOIN users u ON o.buyer_id = u.id 
        WHERE o.seller_id = ? 
        ORDER BY o.created_at DESC
      `;
    }

    const [orders] = await pool.query(query, [userId]);
    res.json(orders);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   PATCH api/orders/:id/status
// @desc    Update order status (ACCEPTED, DECLINED, READY, COMPLETED)
router.patch('/:id/status', auth, async (req, res) => {

  if (req.user.role !== 'SELLER') {
    return res.status(403).json({ message: 'Access denied. Only sellers can update order status.' });
  }

  const { status, amount } = req.body; // ACCEPTED, DECLINED, READY, COMPLETED
  const orderId = req.params.id;
  const sellerId = req.user.id;

  try {
    // If completing, we need full transaction logic
    if (status === 'COMPLETED') {
      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        // 1. Get Order and check ownership
        const [orderRows] = await connection.query(`
          SELECT o.*, b.name as buyer_name, s.name as seller_name 
          FROM orders o 
          JOIN users b ON o.buyer_id = b.id 
          JOIN users s ON o.seller_id = s.id 
          WHERE o.id = ? AND o.seller_id = ?
        `, [orderId, sellerId]);
        const order = orderRows[0];

        if (!order) {
          await connection.rollback();
          return res.status(404).json({ message: 'Order not found or unauthorized' });
        }

        if (order.status === 'COMPLETED') {
          await connection.rollback();
          return res.status(400).json({ message: 'Order already completed' });
        }

        // 2. Get Buyer's default virtual card
        const [cardRows] = await connection.query('SELECT * FROM virtual_cards WHERE user_id = ? AND is_default = TRUE', [order.buyer_id]);
        if (cardRows.length === 0) {
          await connection.rollback();
          return res.status(400).json({ message: 'Buyer has no default card for payment' });
        }

        const card = cardRows[0];
        const finalAmount = amount || order.amount;

        if (parseFloat(card.card_balance) < parseFloat(finalAmount)) {
          await connection.rollback();
          return res.status(400).json({ message: 'Insufficient card balance' });
        }

        // 3. Deduct from Buyer Card
        const newCardBalance = parseFloat(card.card_balance) - parseFloat(finalAmount);
        await connection.query('UPDATE virtual_cards SET card_balance = ? WHERE id = ?', [newCardBalance.toString(), card.id]);

        // 4. Credit Seller Wallet
        const [sellerWalletRows] = await connection.query('SELECT id, balance FROM wallets WHERE user_id = ?', [sellerId]);
        if (sellerWalletRows.length > 0) {
          const newSellerBalance = parseFloat(sellerWalletRows[0].balance) + parseFloat(finalAmount);
          await connection.query('UPDATE wallets SET balance = ? WHERE id = ?', [newSellerBalance, sellerWalletRows[0].id]);
        }

        // 5. Update Order Status
        await connection.query('UPDATE orders SET status = ?, amount = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?', ['COMPLETED', finalAmount, orderId]);

        // 6. Record Transactions
        const timestamp = Date.now();
        const buyerRef = `ORD-${orderId}-B-${timestamp}`;
        const sellerRef = `ORD-${orderId}-S-${timestamp}`;
        
        // 1. Buyer Transaction Record
        const [buyerWalletRows] = await connection.query('SELECT id FROM wallets WHERE user_id = ?', [order.buyer_id]);
        if (buyerWalletRows.length > 0) {
          await connection.query(
            'INSERT INTO transactions (wallet_id, amount, type, status, merchant_name, reference) VALUES (?, ?, ?, ?, ?, ?)',
            [buyerWalletRows[0].id, finalAmount, 'PURCHASE', 'SUCCESS', order.seller_name || 'Food Order', buyerRef]
          );
        }

        // 2. Seller Transaction Record
        if (sellerWalletRows.length > 0) {
          await connection.query(
            'INSERT INTO transactions (wallet_id, amount, type, status, merchant_name, reference) VALUES (?, ?, ?, ?, ?, ?)',
            [sellerWalletRows[0].id, finalAmount, 'PURCHASE', 'SUCCESS', order.buyer_name || 'Food Order Sale', sellerRef]
          );
        }

        // 7. Notify Parties
        // To Buyer
        await connection.query(
          'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
          [order.buyer_id, 'Payment Successful', `₦${finalAmount} has been deducted for your order. Enjoy your meal!`, 'SUCCESS']
        );
        // To Seller
        await connection.query(
          'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
          [sellerId, 'Order Completed', `Order #${orderId} completed. ₦${finalAmount} credited to your wallet.`, 'SUCCESS']
        );

        await connection.commit();
        return res.json({ message: 'Order completed and charged successfully', amount: finalAmount });
      } catch (err) {
        await connection.rollback();
        throw err;
      } finally {
        connection.release();
      }
    }

    // Standard status updates (ACCEPTED, DECLINED, READY)
    const [orderRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    const order = orderRows[0];

    if (!order) return res.status(404).json({ message: 'Order not found' });

    let updateQuery = 'UPDATE orders SET status = ?';
    const queryParams = [status];

    if (status === 'ACCEPTED') {
      updateQuery += ', accepted_at = CURRENT_TIMESTAMP';
    } else if (status === 'READY') {
      updateQuery += ', ready_at = CURRENT_TIMESTAMP';
    }

    updateQuery += ' WHERE id = ?';
    queryParams.push(req.params.id);

    await pool.query(updateQuery, queryParams);

    // Notify buyer
    let title = `Order ${status}`;
    let message = `Your order has been ${status.toLowerCase()}`;
    let type = 'INFO';

    if (status === 'ACCEPTED') {
      type = 'SUCCESS';
      message = 'Your order has been accepted and is being prepared!';
    } else if (status === 'DECLINED') {
      type = 'ERROR';
      message = 'Sorry, your order was declined by the vendor.';
    } else if (status === 'READY') {
      type = 'SUCCESS';
      title = 'Order Ready!';
      message = 'Your order is packed and ready for pickup. See you soon!';
    }

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [order.buyer_id, title, message, type]
    );

    res.json({ message: `Order status updated to ${status} successfully` });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   POST api/orders/:id/charge
// @desc    Conclude order and charge customer (Seller scanning QR)
router.post('/:id/charge', auth, async (req, res) => {
  const { amount } = req.body;
  const orderId = req.params.id;
  const sellerId = req.user.id;

  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
        // 1. Get Order and check ownership
        const [orderRows] = await connection.query(`
          SELECT o.*, b.name as buyer_name, s.name as seller_name 
          FROM orders o 
          JOIN users b ON o.buyer_id = b.id 
          JOIN users s ON o.seller_id = s.id 
          WHERE o.id = ? AND o.seller_id = ?
        `, [orderId, sellerId]);
        const order = orderRows[0];

        if (!order) {
          await connection.rollback();
          return res.status(404).json({ message: 'Order not found or unauthorized' });
        }

        if (order.status === 'COMPLETED') {
          await connection.rollback();
          return res.status(400).json({ message: 'Order already completed' });
        }

      // 2. Get Buyer's default virtual card
      const [cardRows] = await connection.query('SELECT * FROM virtual_cards WHERE user_id = ? AND is_default = TRUE', [order.buyer_id]);
      if (cardRows.length === 0) {
        await connection.rollback();
        return res.status(400).json({ message: 'Buyer has no default card for payment' });
      }

      const card = cardRows[0];
      const finalAmount = amount || order.amount;

      if (parseFloat(card.card_balance) < parseFloat(finalAmount)) {
        await connection.rollback();
        return res.status(400).json({ message: 'Insufficient card balance' });
      }

      // 3. Deduct from Buyer Card
      const newCardBalance = parseFloat(card.card_balance) - parseFloat(finalAmount);
      await connection.query('UPDATE virtual_cards SET card_balance = ? WHERE id = ?', [newCardBalance.toString(), card.id]);

      // 4. Credit Seller Wallet
      const [sellerWalletRows] = await connection.query('SELECT id, balance FROM wallets WHERE user_id = ?', [sellerId]);
      if (sellerWalletRows.length > 0) {
        const newSellerBalance = parseFloat(sellerWalletRows[0].balance) + parseFloat(finalAmount);
        await connection.query('UPDATE wallets SET balance = ? WHERE id = ?', [newSellerBalance, sellerWalletRows[0].id]);
      }

      // 5. Update Order Status
      await connection.query('UPDATE orders SET status = ?, amount = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?', ['COMPLETED', finalAmount, orderId]);

      // 6. Record Transactions
      const timestamp = Date.now();
      const buyerRef = `ORD-${orderId}-B-${timestamp}`;
      const sellerRef = `ORD-${orderId}-S-${timestamp}`;
      
      // 1. Buyer Transaction Record
    const [buyerWalletRows] = await connection.query('SELECT id FROM wallets WHERE user_id = ?', [order.buyer_id]);
    if (buyerWalletRows.length > 0) {
      await connection.query(
        'INSERT INTO transactions (wallet_id, amount, type, status, merchant_name, reference) VALUES (?, ?, ?, ?, ?, ?)',
        [buyerWalletRows[0].id, finalAmount, 'PURCHASE', 'SUCCESS', order.seller_name || 'Food Order', buyerRef]
      );
    }

      // 2. Seller Transaction Record
      if (sellerWalletRows.length > 0) {
        await connection.query(
          'INSERT INTO transactions (wallet_id, amount, type, status, merchant_name, reference) VALUES (?, ?, ?, ?, ?, ?)',
          [sellerWalletRows[0].id, finalAmount, 'PURCHASE', 'SUCCESS', order.buyer_name || 'Food Order Sale', sellerRef]
        );
      }

      // 7. Notify Parties
      // To Buyer
      await connection.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [order.buyer_id, 'Payment Successful', `₦${finalAmount} has been deducted for your order. Enjoy your meal!`, 'SUCCESS']
      );
      // To Seller
      await connection.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [sellerId, 'Order Completed', `Order #${orderId} completed. ₦${finalAmount} credited to your wallet.`, 'SUCCESS']
      );

      await connection.commit();
      res.json({ message: 'Order charged and completed successfully', amount: finalAmount });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Error charging order:', err.message);
    res.status(500).send('Server error');
  }
});

export default router;
