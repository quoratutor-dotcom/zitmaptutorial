const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, resetDb, loginAsAdmin } = require('./helpers');

let adminToken, courseId, studentEmail, studentPassword, studentToken, fileId;

before(async () => { await resetDb(); });

beforeEach(async () => {
  await resetDb();
  adminToken = await loginAsAdmin();

  // Admin creates a course and uploads a document + a video to it.
  const course = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Gated Course' });
  courseId = course.body.id;

  const doc = await request(app).post('/api/files').set('Authorization', `Bearer ${adminToken}`)
    .field('courseId', courseId).field('term', 'term1').field('folder', 'notes').field('title', 'Lecture Notes')
    .attach('file', Buffer.from('secret notes content'), 'notes.txt');
  fileId = doc.body.id;

  await request(app).post('/api/files').set('Authorization', `Bearer ${adminToken}`)
    .field('courseId', courseId).field('term', 'term1').field('folder', 'videos').field('title', 'Lecture Video')
    .attach('file', Buffer.from('fake video bytes'), 'lecture.mp4');

  // A brand new student self-registers (starts unapproved) rather than
  // being created pre-approved via the admin endpoint, since we need to
  // test the pending-approval account state too.
  studentEmail = `pending_${Date.now()}@example.com`;
  studentPassword = 'StudentPass123!';
  await request(app).post('/api/auth/register').send({
    name: 'Pending', lastName: 'Student', email: studentEmail, password: studentPassword,
  });
});

test('an unapproved student account cannot log in at all', async () => {
  const login = await request(app).post('/api/auth/login').send({ email: studentEmail, password: studentPassword });
  assert.equal(login.status, 403);
  assert.match(login.body.error, /awaiting admin approval/i);
});

test('once the admin approves the account, the student can log in but still cannot see any course files (no course approved yet)', async () => {
  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const studentId = students.body.find((s) => s.email === studentEmail).id;

  const approveAccount = await request(app).patch(`/api/students/${studentId}/approve`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(approveAccount.status, 200);

  const login = await request(app).post('/api/auth/login').send({ email: studentEmail, password: studentPassword });
  assert.equal(login.status, 200);
  studentToken = login.body.token;

  // Logged in, but not enrolled/approved for the course yet — the file
  // list must come back empty and a direct download must be blocked.
  const list = await request(app).get('/api/files').set('Authorization', `Bearer ${studentToken}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 0);

  const download = await request(app).get(`/api/files/${fileId}/download`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(download.status, 403);
  assert.match(download.body.error, /not approved for this course/i);
});

test('full flow: account approval + single-button course-request approval unlocks the documents and videos', async () => {
  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const studentId = students.body.find((s) => s.email === studentEmail).id;
  await request(app).patch(`/api/students/${studentId}/approve`).set('Authorization', `Bearer ${adminToken}`);

  const login = await request(app).post('/api/auth/login').send({ email: studentEmail, password: studentPassword });
  studentToken = login.body.token;

  // Student requests enrolment in the course.
  const reqRes = await request(app).post('/api/course-requests').set('Authorization', `Bearer ${studentToken}`).send({ courseId });
  assert.equal(reqRes.status, 201);
  const requestId = reqRes.body.id;

  // Before approval: still locked out.
  const beforeApprove = await request(app).get('/api/files').set('Authorization', `Bearer ${studentToken}`).query({ courseId });
  assert.equal(beforeApprove.body.length, 0);

  // Admin clicks the single "Approve" button for the course request.
  const approveCourse = await request(app).patch(`/api/course-requests/${requestId}/approve`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(approveCourse.status, 200);

  // After approval: the student's own enrolled list now contains the course...
  const me = await request(app).get('/api/students/me').set('Authorization', `Bearer ${studentToken}`);
  assert.ok(me.body.enrolled.includes(courseId));

  // ...and both the document and the video for that course are now visible and downloadable.
  const afterApprove = await request(app).get('/api/files').set('Authorization', `Bearer ${studentToken}`).query({ courseId });
  assert.equal(afterApprove.body.length, 2);
  assert.ok(afterApprove.body.some((f) => f.folder === 'notes'));
  assert.ok(afterApprove.body.some((f) => f.folder === 'videos'));

  const download = await request(app).get(`/api/files/${fileId}/download`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(download.status, 200);
});

test('an admin can approve ALL of a student\'s pending course requests in a single click, unlocking every course at once', async () => {
  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const studentId = students.body.find((s) => s.email === studentEmail).id;
  await request(app).patch(`/api/students/${studentId}/approve`).set('Authorization', `Bearer ${adminToken}`);
  const login = await request(app).post('/api/auth/login').send({ email: studentEmail, password: studentPassword });
  studentToken = login.body.token;

  // A second course, so we can prove BOTH pending requests get approved at once.
  const secondCourse = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Second Gated Course' });
  const secondDoc = await request(app).post('/api/files').set('Authorization', `Bearer ${adminToken}`)
    .field('courseId', secondCourse.body.id).field('term', 'term1').field('folder', 'notes').field('title', 'Second Notes')
    .attach('file', Buffer.from('second course content'), 'second.txt');

  const req1 = await request(app).post('/api/course-requests').set('Authorization', `Bearer ${studentToken}`).send({ courseId });
  const req2 = await request(app).post('/api/course-requests').set('Authorization', `Bearer ${studentToken}`).send({ courseId: secondCourse.body.id });
  assert.equal(req1.status, 201);
  assert.equal(req2.status, 201);

  // Before the bulk click: locked out of both.
  const beforeList = await request(app).get('/api/files').set('Authorization', `Bearer ${studentToken}`);
  assert.equal(beforeList.body.length, 0);

  // The admin's single "Approve Enrolled Courses" button.
  const bulkApprove = await request(app).patch(`/api/students/${studentId}/approve-courses`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(bulkApprove.status, 200);
  assert.equal(bulkApprove.body.approvedCount, 2);
  assert.ok(bulkApprove.body.courseIds.includes(courseId));
  assert.ok(bulkApprove.body.courseIds.includes(secondCourse.body.id));

  // Both course requests are now marked approved...
  const allRequests = await request(app).get('/api/course-requests').set('Authorization', `Bearer ${adminToken}`);
  assert.equal(allRequests.body.find((r) => r.id === req1.body.id).status, 'approved');
  assert.equal(allRequests.body.find((r) => r.id === req2.body.id).status, 'approved');

  // ...the student's enrolled list contains both courses...
  const me = await request(app).get('/api/students/me').set('Authorization', `Bearer ${studentToken}`);
  assert.ok(me.body.enrolled.includes(courseId));
  assert.ok(me.body.enrolled.includes(secondCourse.body.id));

  // ...and files/videos from BOTH courses are now visible and downloadable.
  const afterList = await request(app).get('/api/files').set('Authorization', `Bearer ${studentToken}`);
  assert.equal(afterList.body.length, 3); // notes + video from course 1, notes from course 2
  const download1 = await request(app).get(`/api/files/${fileId}/download`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(download1.status, 200);
  const download2 = await request(app).get(`/api/files/${secondDoc.body.id}/download`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(download2.status, 200);
});

test('bulk-approving courses for a student with no pending requests is a harmless no-op', async () => {
  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const studentId = students.body.find((s) => s.email === studentEmail).id;
  await request(app).patch(`/api/students/${studentId}/approve`).set('Authorization', `Bearer ${adminToken}`);

  const res = await request(app).patch(`/api/students/${studentId}/approve-courses`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.approvedCount, 0);
});

test('a student stays locked out of a DIFFERENT course they never requested, even after being approved for the first one', async () => {
  const students = await request(app).get('/api/students').set('Authorization', `Bearer ${adminToken}`);
  const studentId = students.body.find((s) => s.email === studentEmail).id;
  await request(app).patch(`/api/students/${studentId}/approve`).set('Authorization', `Bearer ${adminToken}`);
  const login = await request(app).post('/api/auth/login').send({ email: studentEmail, password: studentPassword });
  studentToken = login.body.token;

  const reqRes = await request(app).post('/api/course-requests').set('Authorization', `Bearer ${studentToken}`).send({ courseId });
  await request(app).patch(`/api/course-requests/${reqRes.body.id}/approve`).set('Authorization', `Bearer ${adminToken}`);

  // A second, unrelated course with its own file.
  const otherCourse = await request(app).post('/api/courses').set('Authorization', `Bearer ${adminToken}`).send({ title: 'Other Course' });
  const otherDoc = await request(app).post('/api/files').set('Authorization', `Bearer ${adminToken}`)
    .field('courseId', otherCourse.body.id).field('term', 'term1').field('folder', 'notes').field('title', 'Other Notes')
    .attach('file', Buffer.from('other content'), 'other.txt');

  const download = await request(app).get(`/api/files/${otherDoc.body.id}/download`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(download.status, 403);
});
