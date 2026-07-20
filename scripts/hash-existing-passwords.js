// One-time migration: hashes any plaintext passwords in the users table.
// Safe to re-run - skips rows that already look like a bcrypt hash ($2...).
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

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
    const { rows } = await client.query("SELECT id, username, password FROM users");
    let migrated = 0;

    for (const user of rows) {
      if (user.password && user.password.startsWith("$2")) {
        continue;
      }
      const hashed = await bcrypt.hash(user.password, 10);
      await client.query("UPDATE users SET password = $1 WHERE id = $2", [
        hashed,
        user.id,
      ]);
      console.log(`Hashed password for user: ${user.username}`);
      migrated++;
    }

    console.log(`Done. Migrated ${migrated} of ${rows.length} users.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
