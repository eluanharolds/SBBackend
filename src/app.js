import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import initDB from './dbInit.js';

dotenv.config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Initialize Database
initDB();

// Root route
app.get('/', (req, res) => {
  res.send('SmartBuckz API is running...');
});

// Import Routes
import authRoutes from './api/auth.js';
import walletRoutes from './api/wallet.js';
import orderRoutes from './api/order.js';
import virtualCardRoutes from './api/virtual_cards.js';
import bankAccountRoutes from './api/bank_accounts.js';
import sellerRoutes from './api/sellers.js';
import userRoutes from './api/users.js';

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/virtual_cards', virtualCardRoutes);
app.use('/api/bank_accounts', bankAccountRoutes);
app.use('/api/sellers', sellerRoutes);
app.use('/api/users', userRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
