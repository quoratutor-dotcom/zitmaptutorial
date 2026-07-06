const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, resetDb, loginAsAdmin } = require('./helpers');

before(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });

test('admin can log in with correct credentials', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: process.env.DEFAULT_ADMIN_EMAIL, password: process.env.DEFAULT_ADMIN_PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'admin');
  assert.ok(res.body.token);
});

test('login fails with wrong password', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: process.env.DEFAULT_ADMIN_EMAIL, password: 'wrong-password' });
  assert.equal(res.status, 401);
});

test('student registration creates a pending account with an application number', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Jane', lastName: 'Doe', email: 'jane@example.com', password: 'Pass123!' });
  assert.equal(res.status, 201);
  assert.match(res.body.appId, /^\d{6}$/);
});

test('duplicate registration email is rejected', async () => {
  await request(app).post('/api/auth/register').send({ name: 'A', email: 'dupe@example.com', password: 'x' });
  const res = await request(app).post('/api/auth/register').send({ name: 'B', email: 'dupe@example.com', password: 'y' });
  assert.equal(res.status, 409);
});

test('unapproved student cannot log in yet', async () => {
  await request(app).post('/api/auth/register').send({ name: 'Pending', email: 'pending@example.com', password: 'Pass123!' });
  const res = await request(app).post('/api/auth/login').send({ email: 'pending@example.com', password: 'Pass123!' });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /awaiting admin approval/i);
});

test('student can log in with EMAIL after being approved by an admin', async () => {
  const adminToken = await loginAsAdmin();
  const reg = await request(app).post('/api/auth/register').send({ name: 'Approved', email: 'approved@example.com', password: 'Pass123!' });

  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const student = students.body.find(s => s.email === 'approved@example.com');
  await request(app).patch(`/api/students/${student.id}/approve`).set('Authorization', `Bearer ${adminToken}`);

  const loginRes = await request(app).post('/api/auth/login').send({ email: 'approved@example.com', password: 'Pass123!' });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.role, 'student');
  assert.equal(loginRes.body.user.appId, reg.body.appId);
});

test('student can ALSO log in with their APPLICATION NUMBER instead of email', async () => {
  const adminToken = await loginAsAdmin();
  const reg = await request(app).post('/api/auth/register').send({ name: 'ByAppId', email: 'byappid@example.com', password: 'Pass123!' });
  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const student = students.body.find(s => s.email === 'byappid@example.com');
  await request(app).patch(`/api/students/${student.id}/approve`).set('Authorization', `Bearer ${adminToken}`);

  const loginRes = await request(app).post('/api/auth/login').send({ email: reg.body.appId, password: 'Pass123!' });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.user.email, 'byappid@example.com');
});

test('login with a wrong application number fails cleanly, no server error', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: '999999', password: 'whatever' });
  assert.equal(res.status, 401);
});

test('an unauthenticated request to an admin-only route is rejected', async () => {
  const res = await request(app).get('/api/students');
  assert.equal(res.status, 401);
});

test('courses ticked on the sign-up form become real PENDING course_requests, not auto-enrolled', async () => {
  const adminToken = await loginAsAdmin();
  const course1 = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Sign-up Math' });
  const course2 = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Sign-up Science' });

  const reg = await request(app).post('/api/auth/register').send({
    name: 'Signup', lastName: 'Picker', email: 'signup_picker@example.com', password: 'Pass123!',
    courseIds: [course1.body.id, course2.body.id],
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.requestedCourses, 2);

  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const student = students.body.find((s) => s.email === 'signup_picker@example.com');

  // Not auto-enrolled — still needs admin approval.
  assert.deepEqual(student.enrolled, []);

  // But both courses now show up as real, pending course_requests for the admin.
  const requests = await request(app).get('/api/course-requests').set('Authorization', `Bearer ${adminToken}`);
  const mine = requests.body.filter((r) => r.userId === student.id);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((r) => r.status === 'pending'));
  assert.ok(mine.some((r) => r.courseId === course1.body.id));
  assert.ok(mine.some((r) => r.courseId === course2.body.id));
});

test('leaving a course UNCHECKED at sign-up means no request is created for it — only ticked ones are pending', async () => {
  const adminToken = await loginAsAdmin();
  const ticked = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Ticked Course' });
  const unticked = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Unticked Course' });

  await request(app).post('/api/auth/register').send({
    name: 'Partial', email: 'partial_pick@example.com', password: 'Pass123!',
    courseIds: [ticked.body.id],
  });

  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const student = students.body.find((s) => s.email === 'partial_pick@example.com');
  const requests = await request(app).get('/api/course-requests').set('Authorization', `Bearer ${adminToken}`);
  const mine = requests.body.filter((r) => r.userId === student.id);

  assert.equal(mine.length, 1);
  assert.equal(mine[0].courseId, ticked.body.id);
  assert.ok(!mine.some((r) => r.courseId === unticked.body.id));
});

test('a course requested at sign-up can be approved (individually or in bulk) exactly like a post-login request', async () => {
  const adminToken = await loginAsAdmin();
  const course = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Approvable Signup Course' });

  await request(app).post('/api/auth/register').send({
    name: 'ToApprove', email: 'to_approve@example.com', password: 'Pass123!',
    courseIds: [course.body.id],
  });

  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const student = students.body.find((s) => s.email === 'to_approve@example.com');
  await request(app).patch(`/api/students/${student.id}/approve`).set('Authorization', `Bearer ${adminToken}`);

  const bulk = await request(app).patch(`/api/students/${student.id}/approve-courses`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.approvedCount, 1);

  const updated = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const updatedStudent = updated.body.find((s) => s.id === student.id);
  assert.ok(updatedStudent.enrolled.includes(course.body.id));
});

test('if the SAME user later requests MORE courses after logging in, those show up again as new pending requests', async () => {
  const adminToken = await loginAsAdmin();
  const signupCourse = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Original Signup Course' });
  const laterCourse = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Added Later Course' });

  await request(app).post('/api/auth/register').send({
    name: 'GrowingList', email: 'growing_list@example.com', password: 'Pass123!',
    courseIds: [signupCourse.body.id],
  });

  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const student = students.body.find((s) => s.email === 'growing_list@example.com');
  await request(app).patch(`/api/students/${student.id}/approve`).set('Authorization', `Bearer ${adminToken}`);
  await request(app).patch(`/api/students/${student.id}/approve-courses`).set('Authorization', `Bearer ${adminToken}`);

  const login = await request(app).post('/api/auth/login').send({ email: 'growing_list@example.com', password: 'Pass123!' });
  const studentToken = login.body.token;

  // Same user, now logged in, requests ANOTHER course later on.
  const laterReq = await request(app).post('/api/course-requests').set('Authorization', `Bearer ${studentToken}`).send({ courseId: laterCourse.body.id });
  assert.equal(laterReq.status, 201);

  const allRequests = await request(app).get('/api/course-requests').set('Authorization', `Bearer ${adminToken}`);
  const mine = allRequests.body.filter((r) => r.userId === student.id);

  // The original sign-up request is approved; the newly-added course shows
  // up again, freshly pending, for the admin to approve.
  assert.equal(mine.length, 2);
  assert.equal(mine.find((r) => r.courseId === signupCourse.body.id).status, 'approved');
  assert.equal(mine.find((r) => r.courseId === laterCourse.body.id).status, 'pending');
});
