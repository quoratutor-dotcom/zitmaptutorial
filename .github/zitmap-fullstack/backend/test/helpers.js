const db = require('../db/database');
const request = require('supertest');
const app = require('../app');

const TABLES = [
  'admins', 'students', 'schools', 'programs', 'courses',
  'files', 'tests', 'announcements', 'payments', 'messages', 'course_requests',
  'password_resets', 'email_outbox',
];

// Wipes every table (but keeps the schema) so each test file starts from a
// known-empty state. Also re-seeds the default admin, matching what a
// real fresh boot does.
async function resetDb() {
  await db.initDb(); // idempotent — creates tables if this is the very first run
  await db.pool.query(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
  await db.pool.query(`DELETE FROM settings`);
  await db.initDb(); // re-seed default settings + default admin after wiping
}

// Logs in as the seeded default admin and returns a real JWT.
async function loginAsAdmin() {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: process.env.DEFAULT_ADMIN_EMAIL, password: process.env.DEFAULT_ADMIN_PASSWORD });
  if (res.status !== 200) throw new Error('loginAsAdmin failed: ' + JSON.stringify(res.body));
  return res.body.token;
}

// Creates (via the real admin API) and returns a real, already-approved
// student account + login token.
async function createAndLoginStudent(adminToken, overrides = {}) {
  const email = overrides.email || `student_${Date.now()}_${Math.random().toString(36).slice(2,6)}@example.com`;
  const createRes = await request(app)
    .post('/api/students')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: overrides.name || 'Test Student', email, password: overrides.password || 'TestPass123!', ...overrides });
  if (createRes.status !== 201) throw new Error('createAndLoginStudent failed: ' + JSON.stringify(createRes.body));

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password: overrides.password || 'TestPass123!' });
  if (loginRes.status !== 200) throw new Error('student login failed: ' + JSON.stringify(loginRes.body));

  return { id: createRes.body.id, appId: createRes.body.appId, email, token: loginRes.body.token };
}

module.exports = { app, request, db, resetDb, loginAsAdmin, createAndLoginStudent };
