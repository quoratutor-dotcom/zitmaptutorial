const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, resetDb, loginAsAdmin } = require('./helpers');

let superToken, courseManagerToken, financeAdminToken;

before(async () => { await resetDb(); });
beforeEach(async () => {
  await resetDb();
  superToken = await loginAsAdmin();

  await request(app).post('/api/admins').set('Authorization', `Bearer ${superToken}`)
    .send({ name: 'CM', email: 'cm@example.com', password: 'Pass123!', role: 'Course Manager' });
  const cmLogin = await request(app).post('/api/auth/login').send({ email: 'cm@example.com', password: 'Pass123!' });
  courseManagerToken = cmLogin.body.token;

  await request(app).post('/api/admins').set('Authorization', `Bearer ${superToken}`)
    .send({ name: 'FA', email: 'fa@example.com', password: 'Pass123!', role: 'Finance Admin' });
  const faLogin = await request(app).post('/api/auth/login').send({ email: 'fa@example.com', password: 'Pass123!' });
  financeAdminToken = faLogin.body.token;
});

test('Course Manager CAN create courses and schools', async () => {
  const courseRes = await request(app).post('/api/courses').set('Authorization', `Bearer ${courseManagerToken}`).send({ title: 'Chemistry' });
  assert.equal(courseRes.status, 201);

  const schoolRes = await request(app).post('/api/schools').set('Authorization', `Bearer ${courseManagerToken}`).send({ name: 'School of Science' });
  assert.equal(schoolRes.status, 201);
});

test('Course Manager is BLOCKED from payments, students, admins, settings, messages', async () => {
  const payments = await request(app).get('/api/payments').set('Authorization', `Bearer ${courseManagerToken}`);
  assert.equal(payments.status, 403);

  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${courseManagerToken}`);
  assert.equal(students.status, 403);

  const admins = await request(app).get('/api/admins').set('Authorization', `Bearer ${courseManagerToken}`);
  assert.equal(admins.status, 403);

  const settings = await request(app).put('/api/settings').set('Authorization', `Bearer ${courseManagerToken}`).send({ portalName: 'Hacked' });
  assert.equal(settings.status, 403);

  const messages = await request(app).get('/api/messages').set('Authorization', `Bearer ${courseManagerToken}`);
  assert.equal(messages.status, 403);
});

test('Finance Admin CAN manage payments and messages', async () => {
  const paymentsGet = await request(app).get('/api/payments').set('Authorization', `Bearer ${financeAdminToken}`);
  assert.equal(paymentsGet.status, 200);

  const messagesGet = await request(app).get('/api/messages').set('Authorization', `Bearer ${financeAdminToken}`);
  assert.equal(messagesGet.status, 200);
});

test('Finance Admin is BLOCKED from courses, schools, and file uploads', async () => {
  const courseRes = await request(app).post('/api/courses').set('Authorization', `Bearer ${financeAdminToken}`).send({ title: 'Should Fail' });
  assert.equal(courseRes.status, 403);

  const schoolRes = await request(app).post('/api/schools').set('Authorization', `Bearer ${financeAdminToken}`).send({ name: 'Should Fail' });
  assert.equal(schoolRes.status, 403);

  const fileRes = await request(app).post('/api/files').set('Authorization', `Bearer ${financeAdminToken}`);
  assert.equal(fileRes.status, 403);
});

test('Super Admin retains FULL access — no regression from adding restricted roles', async () => {
  const payments = await request(app).get('/api/payments').set('Authorization', `Bearer ${superToken}`);
  assert.equal(payments.status, 200);
  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${superToken}`);
  assert.equal(students.status, 200);
  const courses = await request(app).post('/api/courses').set('Authorization', `Bearer ${superToken}`).send({ title: 'Physics' });
  assert.equal(courses.status, 201);
});

test('EVERY admin, regardless of role, can change their own password', async () => {
  const res = await request(app)
    .patch('/api/admins/me/password')
    .set('Authorization', `Bearer ${courseManagerToken}`)
    .send({ currentPassword: 'Pass123!', newPassword: 'NewPass456!' });
  assert.equal(res.status, 200);
});
