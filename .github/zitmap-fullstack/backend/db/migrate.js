// Standalone migration/provisioning script.
//
// Run this once against your production DATABASE_URL to create all tables
// and seed the first admin account WITHOUT starting the HTTP server. Handy
// for:
//   • running as a "pre-deploy" / "release" step on hosts that support one
//     (Render's "Pre-Deploy Command", Railway's deploy hooks, a CI job, etc.)
//   • provisioning the database once before pointing your domain at it
//   • re-running safely any time — every step is idempotent, so this is
//     also a fine way to "verify" a database is correctly set up
//
// Usage:
//   DATABASE_URL=postgres://... node db/migrate.js
// or, with a .env file already in place:
//   npm run db:migrate
require('dotenv').config();
const db = require('./database');

(async () => {
  console.log('Connecting to database...');
  try {
    await db.ping();
    console.log('✅ Connected.');
  } catch (err) {
    console.error('❌ Could not connect to DATABASE_URL:', err.message);
    process.exit(1);
  }

  console.log('Creating tables (if they do not already exist)...');
  await db.initDb();
  console.log('✅ Schema is up to date and the default admin (if needed) has been seeded.');

  const admins = await db.all('admins');
  console.log(`\nAdmin accounts currently in the database: ${admins.length}`);
  admins.forEach((a) => console.log(`  • ${a.email} (${a.role})`));

  console.log('\nDone. You can now start the server with: npm start');
  await db.pool.end();
  process.exit(0);
})();
