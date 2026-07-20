// Manually reset a user's password (for when someone forgets theirs).
// Usage: node scripts/reset-password.js <username> <newPassword>
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const [, , username, newPassword] = process.argv;

if (!username || !newPassword) {
  console.error("Usage: node scripts/reset-password.js <username> <newPassword>");
  process.exit(1);
}

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true",
});

async function main() {
  const client = await pool.connect();
  try {
    const hashed = await bcrypt.hash(newPassword, 10);
    const result = await client.query(
      "UPDATE users SET password = $1 WHERE username = $2",
      [hashed, username]
    );
    if (result.rowCount === 0) {
      console.error(`No user found with username: ${username}`);
      process.exit(1);
    }
    console.log(`Password reset for user: ${username}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
