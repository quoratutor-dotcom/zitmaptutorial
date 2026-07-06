const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, resetDb, loginAsAdmin, createAndLoginStudent } = require('./helpers');

let adminToken, student, courseId;
before(async () => { await resetDb(); });
beforeEach(async () => {
  await resetDb();
  adminToken = await loginAsAdmin();
  student = await createAndLoginStudent(adminToken);
  const course = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Requestable Course' });
  courseId = course.body.id;
});

test('a student can send a message, and only an admin can read it', async () => {
  const send = await request(app).post('/api/messages').set('Authorization', `Bearer ${student.token}`).send({ message: 'I need help enrolling.' });
  assert.equal(send.status, 201);

  const studentReadAttempt = await request(app).get('/api/messages').set('Authorization', `Bearer ${student.token}`);
  assert.equal(studentReadAttempt.status, 403);

  const adminRead = await request(app).get('/api/messages').set('Authorization', `Bearer ${adminToken}`);
  assert.equal(adminRead.status, 200);
  assert.ok(adminRead.body.find(m => m.message === 'I need help enrolling.' && m.email === student.email));
});

test('a message cannot be spoofed as coming from someone else — name/email are derived server-side', async () => {
  const send = await request(app)
    .post('/api/messages')
    .set('Authorization', `Bearer ${student.token}`)
    .send({ message: 'test', name: 'Fake Name', email: 'fake@spoofed.com' });
  assert.equal(send.status, 201);

  const adminRead = await request(app).get('/api/messages').set('Authorization', `Bearer ${adminToken}`);
  const msg = adminRead.body.find(m => m.message === 'test');
  assert.equal(msg.email, student.email, 'email must be the real authenticated student email, not attacker-supplied');
});

test('full course enrolment flow: request -> approve -> student is actually enrolled', async () => {
  const requestRes = await request(app).post('/api/course-requests').set('Authorization', `Bearer ${student.token}`).send({ courseId });
  assert.equal(requestRes.status, 201);

  const mine = await request(app).get('/api/course-requests/mine').set('Authorization', `Bearer ${student.token}`);
  assert.equal(mine.body.length, 1);
  assert.equal(mine.body[0].status, 'pending');

  const allRequests = await request(app).get('/api/course-requests').set('Authorization', `Bearer ${adminToken}`);
  const reqId = allRequests.body.find(r => r.courseId === courseId).id;

  const approve = await request(app).patch(`/api/course-requests/${reqId}/approve`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(approve.status, 200);

  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const updatedStudent = students.body.find(s => s.id === student.id);
  assert.ok(updatedStudent.enrolled.includes(courseId), 'student must actually be enrolled after approval');
});

test('a rejected request does NOT enrol the student', async () => {
  const requestRes = await request(app).post('/api/course-requests').set('Authorization', `Bearer ${student.token}`).send({ courseId });
  const allRequests = await request(app).get('/api/course-requests').set('Authorization', `Bearer ${adminToken}`);
  const reqId = allRequests.body.find(r => r.courseId === courseId).id;

  await request(app).patch(`/api/course-requests/${reqId}/reject`).set('Authorization', `Bearer ${adminToken}`);

  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const updatedStudent = students.body.find(s => s.id === student.id);
  assert.ok(!updatedStudent.enrolled.includes(courseId));
});

test('a student cannot request the same course twice while pending', async () => {
  await request(app).post('/api/course-requests').set('Authorization', `Bearer ${student.token}`).send({ courseId });
  const second = await request(app).post('/api/course-requests').set('Authorization', `Bearer ${student.token}`).send({ courseId });
  assert.equal(second.status, 409);
});

test("a student's /course-requests/mine never includes another student's requests", async () => {
  const student2 = await createAndLoginStudent(adminToken);
  await request(app).post('/api/course-requests').set('Authorization', `Bearer ${student.token}`).send({ courseId });

  const student2Mine = await request(app).get('/api/course-requests/mine').set('Authorization', `Bearer ${student2.token}`);
  assert.equal(student2Mine.body.length, 0);
});
