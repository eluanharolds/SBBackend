import pool from './config/db.js';

const initDB = async () => {
  try {
    const connection = await pool.getConnection();
    console.log('Database connected successfully');

    // Create Users table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('BUYER', 'SELLER') DEFAULT 'BUYER',
        phone VARCHAR(20),
        address TEXT,
        profile_image TEXT,
        qr_code_path VARCHAR(255),
        is_verified BOOLEAN DEFAULT FALSE,
        reset_token VARCHAR(255),
        reset_token_expiry BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create Wallets table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        balance DECIMAL(15, 2) DEFAULT 0.00,
        currency VARCHAR(10) DEFAULT 'NGN',
        wallet_address VARCHAR(100),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Create Transactions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        wallet_id INT NOT NULL,
        amount DECIMAL(15, 2) NOT NULL,
        type ENUM('FUNDING', 'PURCHASE', 'WITHDRAWAL') NOT NULL,
        status ENUM('SUCCESS', 'PENDING', 'FAILED') DEFAULT 'PENDING',
        reference VARCHAR(255),
        merchant_name VARCHAR(255),
        buyer_id INT,
        card_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (wallet_id) REFERENCES wallets(id)
      )
    `);

    // Create QR Codes table (Moved up to satisfy foreign key in virtual_cards)
    await connection.query(`
        CREATE TABLE IF NOT EXISTS qr_codes (
            qr_code_id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            qr_code_path VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    // Create Virtual Cards table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS virtual_cards (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        card_alias  VARCHAR(50) NOT NULL,
        card_color VARCHAR(50) NOT NULL,
        card_number VARCHAR(20) NOT NULL UNIQUE,
        expiry_date VARCHAR(10) NOT NULL,
        card_balance VARCHAR(100) NOT NULL,
        qr_code_id INT,
        cvv VARCHAR(4) NOT NULL,
        daily_limit DECIMAL(15, 2) DEFAULT 2000.00,
        is_default BOOLEAN DEFAULT FALSE,
        is_frozen BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (qr_code_id) REFERENCES qr_codes(qr_code_id)
      )
    `);

    // Create Orders table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        buyer_id INT NOT NULL,
        seller_id INT NOT NULL,
        items TEXT NOT NULL,
        amount DECIMAL(15, 2) DEFAULT 0.00,
        status ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'READY', 'COMPLETED') DEFAULT 'PENDING',
        accepted_at TIMESTAMP NULL,
        ready_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (buyer_id) REFERENCES users(id),
        FOREIGN KEY (seller_id) REFERENCES users(id)
      )
    `);

    // Create Verification Media table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS verification_media (
        id INT AUTO_INCREMENT PRIMARY KEY,
        seller_id INT NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        file_type ENUM('PHOTO', 'VIDEO') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seller_id) REFERENCES users(id)
      )
    `);

    // Create Notifications table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        type ENUM('INFO', 'SUCCESS', 'WARNING', 'ERROR') DEFAULT 'INFO',
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Create Bank Accounts table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        bank_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(255) NOT NULL,
        bank_code VARCHAR(20),
        recipient_code VARCHAR(100),
        expiry VARCHAR(10),
        cvv VARCHAR(10),
        icon VARCHAR(10) DEFAULT '🏦',
        is_default BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Ensure new columns exist in bank_accounts if they were added later
    try {
      const [columns] = await connection.query('SHOW COLUMNS FROM bank_accounts');
      const columnNames = columns.map(col => col.Field);
      
      if (!columnNames.includes('bank_code')) {
        await connection.query('ALTER TABLE bank_accounts ADD COLUMN bank_code VARCHAR(20)');
      }
      if (!columnNames.includes('recipient_code')) {
        await connection.query('ALTER TABLE bank_accounts ADD COLUMN recipient_code VARCHAR(100)');
      }
    } catch (err) {
      console.log('Error checking/adding columns to bank_accounts:', err.message);
    }

    // Create Meal Tickets table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS meal_tickets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payer_id INT NOT NULL,
        requester_id INT NOT NULL,
        max_amount DECIMAL(10, 2) DEFAULT 0.00,
        status ENUM('PENDING', 'ACTIVE', 'USED', 'EXPIRED', 'REJECTED') DEFAULT 'PENDING',
        qr_code_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (payer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (qr_code_id) REFERENCES qr_codes(qr_code_id) ON DELETE SET NULL
      )
    `);

    // Create Reviews table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        seller_id INT NOT NULL,
        buyer_id INT NOT NULL,
        rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create Menu Items table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        seller_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(15, 2) DEFAULT 0.00,
        is_available BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create User Reports table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        reporter_id INT NOT NULL,
        reported_user_id INT NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    connection.release();
    console.log('Tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
};

export default initDB;
