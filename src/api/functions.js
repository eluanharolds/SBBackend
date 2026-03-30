import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Folder where QR codes will be saved in the root directory
const outputDir = path.join(process.cwd(), 'uploads/qrcodes');

// Ensure the directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const generateUniqueCardNumber = async () => {
  let cardNumber;
  let exists = true;
  while (exists) {
    cardNumber = Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString();
    const [rows] = await pool.query('SELECT id FROM virtual_cards WHERE card_number = ?', [cardNumber]);
    if (rows.length === 0) {
      exists = false;
    }
  }
  return cardNumber;
};

const generate_qr_code = async(user_id, dataList) =>{

    const data = dataList;
    const fileName = `sb_qr_code__${user_id}.png`;
    const filePath = path.join(outputDir, fileName);

    try {
      await QRCode.toFile(filePath, data);

      console.log(`Saved: ${filePath}`);
      // Return a relative path for the database
      return `uploads/qrcodes/${fileName}`;
    } catch (err) {
      console.error(err);
      return ("Failed to create due to:", err);
    }
  
};

export { generate_qr_code, generateUniqueCardNumber };