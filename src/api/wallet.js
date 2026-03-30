import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';
import auth from '../middlewares/auth.js';
import axios from 'axios';
const router = express.Router();

// @route   POST api/wallet/initialize-payment
// @desc    Initialize Paystack payment (for Web/Fallback)
router.post('/initialize-payment', auth, async (req, res) => {
  const { amount, callback_url } = req.body;

  try {
    const [userRows] = await pool.query('SELECT email FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });

    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: userRows[0].email,
      amount: amount * 100,
      callback_url: callback_url || 'http://localhost:19006/funding-callback', // Fallback for web
      metadata: {
        userId: req.user.id
      }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data.data);
  } catch (err) {
    console.error('Paystack initialization error:', err.response?.data || err.message);
    res.status(500).json({ message: 'Error initializing payment' });
  }
});

// @route   POST api/wallet/verify-payment
// @desc    Verify Paystack payment and fund wallet
router.post('/verify-payment', auth, async (req, res) => {
  const { reference } = req.body;

  try {
    // 1. Verify transaction with Paystack
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });

    const { status, amount, customer, metadata } = response.data.data;

    if (status === 'success') {
      // 2. Check if transaction reference already exists to prevent double funding
      const [existingTrans] = await pool.query('SELECT * FROM transactions WHERE reference = ?', [reference]);
      if (existingTrans.length > 0) {
        return res.status(400).json({ message: 'Transaction already processed' });
      }

      const amountInNaira = amount / 100;
      const userId = req.user.id;

      // 3. Update User Wallet
      const [walletRows] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [userId]);
      const wallet = walletRows[0];

      const newBalance = parseFloat(wallet.balance) + parseFloat(amountInNaira);
      await pool.query('UPDATE wallets SET balance = ? WHERE id = ?', [newBalance, wallet.id]);

      // 4. Record Transaction
      await pool.query(
        'INSERT INTO transactions (wallet_id, amount, type, status, reference, merchant_name) VALUES (?, ?, ?, ?, ?, ?)',
        [wallet.id, amountInNaira, 'FUNDING', 'SUCCESS', reference, 'Paystack Funding']
      );

      // 5. Create Notification
      await pool.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [userId, 'Wallet Funded', `Successfully funded your wallet with ₦${amountInNaira.toLocaleString()}.`, 'SUCCESS']
      );

      return res.json({ message: 'Payment verified and wallet funded', newBalance });
    } else {
      return res.status(400).json({ message: 'Payment verification failed' });
    }
  } catch (err) {
    console.error('Paystack verification error:', err.response?.data || err.message);
    res.status(500).json({ message: 'Error verifying payment' });
  }
});

// @route   GET api/wallet
// @desc    Get current user wallet & transactions
router.get('/', auth, async (req, res) => {
  try {
    const [walletRows] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [req.user.id]);
    const wallet = walletRows[0];

    // Added buyer_id and card_id to transaction query to support seller refunds
    const [transRows] = await pool.query(
      'SELECT * FROM transactions WHERE wallet_id = ? ORDER BY created_at DESC',
      [wallet.id]
    );

    res.json({ balance: wallet.balance, history: transRows });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   POST api/wallet/fund
// @desc    Fund wallet
router.post('/fund', auth, async (req, res) => {
  const { amount } = req.body;
  try {
    const [walletRows] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [req.user.id]);
    const wallet = walletRows[0];

    const newBalance = parseFloat(wallet.balance) + parseFloat(amount);
    await pool.query('UPDATE wallets SET balance = ? WHERE id = ?', [newBalance, wallet.id]);

    await pool.query(
      'INSERT INTO transactions (wallet_id, amount, type, status, reference) VALUES (?, ?, ?, ?, ?)',
      [wallet.id, amount, 'FUNDING', 'SUCCESS', `FUND-${Date.now()}`]
    );

    res.json({ message: 'Wallet funded successfully', newBalance });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   POST api/wallet/charge
 * @desc    Charge a user's QR code (Card) and credit seller
 * @access  Private (Sellers only)
 */
router.post('/charge', auth, async (req, res) => {
  if (req.user.role !== 'SELLER') {
    return res.status(403).json({ message: 'Access denied. Sellers only.' });
  }

  const { qrData, amount } = req.body;
  const sellerId = req.user.id;

  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. Parse QR Data (Expected: SB-CARD-CARD_ID-NUMBER)
      const parts = qrData.split('-');
      if (parts.length < 3 || parts[0] !== 'SB' || parts[1] !== 'CARD') {
        await connection.rollback();
        return res.status(400).json({ message: 'Invalid QR Code format' });
      }
      const cardId = parts[2];

      // 2. Find Buyer's Card and Balance
      const [cardRows] = await connection.query(
        'SELECT vc.*, u.id as buyer_id, u.name as buyer_name FROM virtual_cards vc JOIN users u ON vc.user_id = u.id WHERE vc.id = ?',
        [cardId]
      );

      if (cardRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ message: 'Virtual card not found' });
      }

      const card = cardRows[0];
      const buyerId = card.buyer_id;

      // Handle Insufficient Balance
      if (parseFloat(card.card_balance || 0) < parseFloat(amount)) {
        await connection.rollback();
        
        // Notify Buyer of failed transaction
        await pool.query(
          'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
          [buyerId, 'Transaction Failed', `Your purchase of ₦${amount} at ${req.user.name} failed due to insufficient balance.`, 'DANGER']
        );

        return res.status(400).json({ 
          message: 'Insufficient balance on customer account',
          error_code: 'INSUFFICIENT_BALANCE',
          buyerName: card.buyer_name
        });
      }

      // 3. Deduct from Buyer Card (Ensure result is a valid number and at least 0.00)
      const currentBalance = parseFloat(card.card_balance || 0);
      const chargeAmount = parseFloat(amount || 0);
      let newCardBalance = currentBalance - chargeAmount;
      
      // Prevent NaN and negative balances
      if (isNaN(newCardBalance) || newCardBalance < 0) {
        newCardBalance = 0.00;
      }

      await connection.query('UPDATE virtual_cards SET card_balance = ? WHERE id = ?', [newCardBalance.toFixed(2), cardId]);

      // 4. Credit Seller Wallet
      const [sellerWalletRows] = await connection.query('SELECT * FROM wallets WHERE user_id = ?', [sellerId]);
      const sellerWallet = sellerWalletRows[0];
      const currentSellerBalance = parseFloat(sellerWallet.balance || 0);
      const newSellerBalance = currentSellerBalance + chargeAmount;

      await connection.query('UPDATE wallets SET balance = ? WHERE id = ?', [newSellerBalance.toFixed(2), sellerWallet.id]);

      // 5. Record Transactions
      const reference = `QRCHG-${Date.now()}`;
      
      // Buyer Transaction
      const [buyerWalletRows] = await connection.query('SELECT id FROM wallets WHERE user_id = ?', [buyerId]);
      if (buyerWalletRows.length > 0) {
        await connection.query(
          'INSERT INTO transactions (wallet_id, amount, type, status, merchant_name, reference, card_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [buyerWalletRows[0].id, chargeAmount.toFixed(2), 'PURCHASE', 'SUCCESS', req.user.name, reference, cardId]
        );
      }

      // Seller Transaction
      await connection.query(
        'INSERT INTO transactions (wallet_id, amount, type, status, merchant_name, reference, buyer_id, card_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [sellerWallet.id, chargeAmount.toFixed(2), 'SALE', 'SUCCESS', card.buyer_name, reference, buyerId, cardId]
      );

      // 6. Send Notifications
      // To Buyer
      await connection.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [buyerId, 'Payment Successful', `₦${chargeAmount.toLocaleString()} has been charged from your card by ${req.user.name}.`, 'SUCCESS']
      );

      // To Seller
      await connection.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [sellerId, 'Payment Received', `Successfully charged ₦${chargeAmount.toLocaleString()} from ${card.buyer_name}.`, 'SUCCESS']
      );

      await connection.commit();
      res.json({ message: 'Transaction successful', amount: chargeAmount, buyerName: card.buyer_name, newBalance: newCardBalance });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Error processing QR charge:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   POST api/wallet/refund
 * @desc    Refund a transaction back to a customer
 * @access  Private (Sellers only)
 */
router.post('/refund', auth, async (req, res) => {
  if (req.user.role !== 'SELLER') {
    return res.status(403).json({ message: 'Access denied. Sellers only.' });
  }

  const { transactionId, amount, buyerId, cardId } = req.body;
  const sellerId = req.user.id;

  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. Check Seller's Balance
      const [sellerWalletRows] = await connection.query('SELECT * FROM wallets WHERE user_id = ?', [sellerId]);
      const sellerWallet = sellerWalletRows[0];
      const refundAmount = parseFloat(amount || 0);

      if (parseFloat(sellerWallet.balance || 0) < refundAmount) {
        await connection.rollback();
        return res.status(400).json({ message: 'Insufficient balance in your wallet to process refund.' });
      }

      // 2. Deduct from Seller Wallet
      const newSellerBalance = parseFloat(sellerWallet.balance) - refundAmount;
      await connection.query('UPDATE wallets SET balance = ? WHERE id = ?', [newSellerBalance.toFixed(2), sellerWallet.id]);

      // 3. Credit Buyer (Card or Wallet)
      let creditedTo = 'wallet';
      if (cardId) {
        const [cardRows] = await connection.query('SELECT card_balance, card_alias FROM virtual_cards WHERE id = ?', [cardId]);
        if (cardRows.length > 0) {
          const newCardBalance = parseFloat(cardRows[0].card_balance || 0) + refundAmount;
          await connection.query('UPDATE virtual_cards SET card_balance = ? WHERE id = ?', [newCardBalance.toFixed(2), cardId]);
          creditedTo = 'card';
        }
      }

      // If not credited to card (or no cardId provided), credit main wallet
      const [buyerWalletRows] = await connection.query('SELECT id, balance FROM wallets WHERE user_id = ?', [buyerId]);
      if (buyerWalletRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ message: 'Customer wallet not found' });
      }

      const buyerWalletId = buyerWalletRows[0].id;
      if (creditedTo === 'wallet') {
        const newBuyerBalance = parseFloat(buyerWalletRows[0].balance || 0) + refundAmount;
        await connection.query('UPDATE wallets SET balance = ? WHERE id = ?', [newBuyerBalance.toFixed(2), buyerWalletId]);
      }

      // 4. Update Original Transaction status (if provided) or record new REFUND transaction
      const reference = `RFND-${Date.now()}`;
      
      // Seller record
      await connection.query(
        'INSERT INTO transactions (wallet_id, amount, type, status, merchant_name, reference) VALUES (?, ?, ?, ?, ?, ?)',
        [sellerWallet.id, refundAmount.toFixed(2), 'REFUND', 'SUCCESS', 'Refund to Customer', reference]
      );

      // Buyer record
      await connection.query(
        'INSERT INTO transactions (wallet_id, amount, type, status, merchant_name, reference) VALUES (?, ?, ?, ?, ?, ?)',
        [buyerWalletId, refundAmount.toFixed(2), 'REFUND', 'SUCCESS', req.user.name, reference]
      );

      // 5. Notifications
      const destination = creditedTo === 'card' ? 'your card' : 'your wallet';
      await connection.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [buyerId, 'Refund Received', `₦${refundAmount.toLocaleString()} has been refunded to ${destination} by ${req.user.name}.`, 'SUCCESS']
      );

      await connection.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [sellerId, 'Refund Processed', `Successfully refunded ₦${refundAmount.toLocaleString()} to customer.`, 'SUCCESS']
      );

      await connection.commit();
      res.json({ message: 'Refund processed successfully', newBalance: newSellerBalance });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Error processing refund:', err.message);
    res.status(500).send('Server error');
  }
});

/**
 * @route   POST api/wallet/withdraw
 * @desc    Withdraw funds from seller wallet to bank account via Paystack
 * @access  Private (Sellers only)
 */
router.post('/withdraw', auth, async (req, res) => {
  if (req.user.role !== 'SELLER') {
    return res.status(403).json({ message: 'Access denied. Sellers only.' });
  }

  const { amount } = req.body;
  const sellerId = req.user.id;
  const withdrawAmount = parseFloat(amount || 0);

  if (withdrawAmount <= 0) {
    return res.status(400).json({ message: 'Invalid withdrawal amount' });
  }

  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. Check Seller's Balance
      const [walletRows] = await connection.query('SELECT * FROM wallets WHERE user_id = ?', [sellerId]);
      if (walletRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ message: 'Wallet not found' });
      }

      const wallet = walletRows[0];
      if (parseFloat(wallet.balance || 0) < withdrawAmount) {
        await connection.rollback();
        return res.status(400).json({ 
          message: 'Insufficient balance for withdrawal.',
          error_code: 'INSUFFICIENT_FUNDS'
        });
      }

      // 2. Get Seller's Default Bank Account
      const [bankRows] = await connection.query(
        'SELECT * FROM bank_accounts WHERE user_id = ? AND is_default = TRUE',
        [sellerId]
      );

      if (bankRows.length === 0) {
        await connection.rollback();
        return res.status(400).json({ message: 'No default bank account set. Please add a bank account first.' });
      }

      const bank = bankRows[0];

      // 3. Initiate Paystack Transfer
      // 3a. Create Transfer Recipient if not already existing
      let recipientCode = bank.recipient_code;
      
      if (!recipientCode) {
        if (!bank.bank_code) {
          await connection.rollback();
          return res.status(400).json({ 
            message: 'Your bank details are incomplete (missing bank code). Please remove and re-add your bank account.',
            error_code: 'INCOMPLETE_BANK_DETAILS'
          });
        }

        try {
          const recipientResponse = await axios.post('https://api.paystack.co/transferrecipient', {
            type: 'nuban',
            name: req.user.name,
            account_number: bank.account_number,
            bank_code: bank.bank_code,
            currency: 'NGN'
          }, {
            headers: {
              Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
              'Content-Type': 'application/json'
            }
          });

          if (recipientResponse.data.status) {
            recipientCode = recipientResponse.data.data.recipient_code;
            // Update the bank account with the recipient code for future use
            await connection.query('UPDATE bank_accounts SET recipient_code = ? WHERE id = ?', [recipientCode, bank.id]);
          } else {
            throw new Error(recipientResponse.data.message || 'Failed to create Paystack recipient');
          }
        } catch (err) {
          const paystackMsg = err.response?.data?.message || err.message;
          console.error('Paystack Recipient Error:', paystackMsg);
          await connection.rollback();
          return res.status(400).json({ 
            message: `Bank Validation Failed: ${paystackMsg}`,
            error_code: 'RECIPIENT_CREATION_FAILED'
          });
        }
      }

      // 3b. Initiate the actual transfer
      try {
        const transferResponse = await axios.post('https://api.paystack.co/transfer', {
          source: 'balance',
          amount: Math.round(withdrawAmount * 100), // Amount in kobo
          recipient: recipientCode,
          reason: `SmartBuckz Withdrawal for ${req.user.name}`
        }, {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (!transferResponse.data.status) {
          throw new Error(transferResponse.data.message || 'Paystack transfer failed');
        }

        // 4. Deduct from Seller Wallet
        const newBalance = parseFloat(wallet.balance) - withdrawAmount;
        await connection.query('UPDATE wallets SET balance = ? WHERE id = ?', [newBalance.toFixed(2), wallet.id]);

        // 5. Record Transaction
        const reference = transferResponse.data.data.reference || `WITHDRAW-${Date.now()}`;
        await connection.query(
          'INSERT INTO transactions (wallet_id, amount, type, status, reference, merchant_name) VALUES (?, ?, ?, ?, ?, ?)',
          [wallet.id, withdrawAmount.toFixed(2), 'WITHDRAWAL', 'SUCCESS', reference, `Withdrawal to ${bank.bank_name}`]
        );

        // 6. Send Notification
        await connection.query(
          'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
          [sellerId, 'Withdrawal Successful', `₦${withdrawAmount.toLocaleString()} has been sent to your bank account (${bank.bank_name}).`, 'SUCCESS']
        );

        await connection.commit();
        res.json({ 
          message: 'Withdrawal processed successfully', 
          newBalance: newBalance.toFixed(2),
          reference: reference
        });
      } catch (err) {
        const paystackMsg = err.response?.data?.message || err.message;
        console.error('Paystack Transfer Error:', paystackMsg);
        await connection.rollback();
        
        // Handle specific Paystack errors like "Insufficient balance" (from your Paystack account)
        if (paystackMsg.toLowerCase().includes('insufficient balance')) {
          return res.status(400).json({
            message: 'System payout balance is low. Please contact support.',
            error_code: 'SYSTEM_BALANCE_LOW'
          });
        }

        return res.status(400).json({ 
          message: `Payout Failed: ${paystackMsg}`,
          error_code: 'TRANSFER_FAILED'
        });
      }
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Error processing withdrawal:', err.message);
    res.status(500).send('Server error');
  }
});

export default router;
