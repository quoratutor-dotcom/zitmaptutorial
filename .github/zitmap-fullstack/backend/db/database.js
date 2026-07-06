// Real PostgreSQL-backed database module.
//
// Every collection (admins, students, schools, programs, courses, files,
// tests, announcements, payments) is stored as a proper Postgres table:
//   id   TEXT PRIMARY KEY   -- indexed, fast lookups
//   data JSONB NOT NULL     -- the full record (routes already read/write
//                              plain JS objects with varying optional
//                              fields, so JSONB avoids a large upfront
//                              migration of every route to hand-mapped SQL
//                              columns while still giving real ACID
//                              transactions, ce oncurrent-write safety, and
//                              durable storage that survives redeploys —
//                              unlike the old single-JSON-file approach).
//
// This keeps the exact same method names/signatures the route files
// already call (all/find/filter/insert/update/remove/getSettings/
// setSettings) so no route logic had to change — only that every call is
// now async and must be awaited.
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.error(
    'FATAL: DATABASE_URL is not set. Set it to a PostgreSQL connection ' +
    'string, e.g. postgres://user:password@host:5432/dbname — see .env.example.'
  );
  process.exit(1);
}

// Most managed Postgres hosts (Render, Railway, Heroku, Supabase, Neon,
// ElephantSQL, AWS RDS, etc.) require SSL and use certificates that Node's
// default TLS trust store won't automatically validate. Opt in with
// PGSSL=require (recommended for those hosts) or leave unset for local dev
// / self-hosted Postgres without SSL.
const useSSL = process.env.PGSSL === 'require';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,                       // reasonable ceiling for a small-to-medium app; raise if you outgrow it
  idleTimeoutMillis: 30000,      // close idle clients after 30s
  connectionTimeoutMillis: 5000, // fail fast (5s) instead of hanging forever if the DB is unreachable
});

pool.on('error', (err) => {
  // Errors on idle clients in the pool (e.g. connection dropped by the
  // host) — log them instead of letting them crash the whole process.
  console.error('Unexpected PostgreSQL pool error:', err);
});

const COLLECTIONS = [
  'admins', 'students', 'schools', 'programs',
  'courses', 'files', 'tests', 'announcements', 'payments',
  'messages', 'course_requests', 'password_resets', 'email_outbox',
];

const DEFAULT_SETTINGS = {
  portal_name:    'ZITMAP Tutorials',
  contact_email:  '',
  contact_phone:  '',
  office_address: '',
  working_hours:  '',
  facebook:       '',
  youtube:        '',
  tiktok:         '',
  welcome_msg:    'Welcome to ZITMAP Tutorials.',
  self_reg:       'yes',
  privacy_policy: '',
  about_us:       '',
  terms_conditions: '',
  term1_start: '', term1_end: '',
  term2_start: '', term2_end: '',
  term3_start: '', term3_end: '',
};

// ── Generic collection helpers (all async — callers must await them) ──
async function all(collection) {
  const { rows } = await pool.query(`SELECT data FROM ${collection} ORDER BY created_at ASC`);
  return rows.map((r) => r.data);
}

async function find(collection, predicate) {
  const rows = await all(collection);
  return rows.find(predicate);
}

async function filter(collection, predicate) {
  const rows = await all(collection);
  return rows.filter(predicate);
}

async function insert(collection, record) {
  await pool.query(
    `INSERT INTO ${collection} (id, data) VALUES ($1, $2)`,
    [record.id, record]
  );
  return record;
}

async function update(collection, id, patch) {
  const { rows } = await pool.query(`SELECT data FROM ${collection} WHERE id = $1`, [id]);
  if (!rows.length) return null;
  const merged = { ...rows[0].data, ...patch };
  await pool.query(`UPDATE ${collection} SET data = $1 WHERE id = $2`, [merged, id]);
  return merged;
}

async function remove(collection, id) {
  const { rowCount } = await pool.query(`DELETE FROM ${collection} WHERE id = $1`, [id]);
  return rowCount > 0;
}

async function getSettings() {
  const { rows } = await pool.query(`SELECT data FROM settings WHERE id = 'singleton'`);
  return rows.length ? rows[0].data : { ...DEFAULT_SETTINGS };
}

async function setSettings(patch) {
  const current = await getSettings();
  const merged = { ...current, ...patch };
  await pool.query(
    `INSERT INTO settings (id, data) VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET data = $1`,
    [merged]
  );
  return merged;
}

// ── Schema creation + seeding — called once from server.js before the
// app starts listening. Safe to run every time the server boots: all
// statements are idempotent (CREATE TABLE IF NOT EXISTS, etc.). ──
async function initDb() {
  for (const name of COLLECTIONS) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${name} (
        id         TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Speeds up any future queries that reach into the JSON document
    // (e.g. filtering by email, courseId, etc.) without needing a full
    // relational rewrite of every column up front.
    await pool.query(`CREATE INDEX IF NOT EXISTS ${name}_data_gin ON ${name} USING GIN (data);`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id   TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  // Seed default settings row if none exists yet
  const settingsRows = await pool.query(`SELECT 1 FROM settings WHERE id = 'singleton'`);
  if (settingsRows.rowCount === 0) {
    await pool.query(`INSERT INTO settings (id, data) VALUES ('singleton', $1)`, [DEFAULT_SETTINGS]);
  }

  // Seed a default admin on first run, using env vars — same behavior as
  // the old JSON-file version, just persisted in Postgres now.
  const adminCount = await pool.query(`SELECT COUNT(*)::int AS n FROM admins`);
  if (adminCount.rows[0].n === 0) {
    const email = process.env.DEFAULT_ADMIN_EMAIL || 'admin@zitmap.com';
    const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(password, 10);
    const admin = {
      id: 'admin_' + Date.now(),
      name: 'Super Admin',
      email,
      password_hash: hash,
      role: 'Super Admin',
      created_at: new Date().toISOString(),
    };
    await insert('admins', admin);
    console.log(`Seeded default admin: ${email} (change this password after first login!)`);
  }
}

// Lets server.js verify the database is actually reachable before
// declaring the app healthy (used by /api/health).
async function ping() {
  await pool.query('SELECT 1');
  return true;
}

module.exports = { all, find, filter, insert, update, remove, getSettings, setSettings, initDb, ping, pool };
