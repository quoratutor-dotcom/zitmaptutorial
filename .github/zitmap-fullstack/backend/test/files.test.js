const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, resetDb, loginAsAdmin } = require('./helpers');

let token, courseId;

before(async () => { await resetDb(); });
beforeEach(async () => {
  await resetDb();
  token = await loginAsAdmin();
  const course = await request(app).post('/api/courses').set('Authorization', `Bearer ${token}`).send({ title: 'File Test Course' });
  courseId = course.body.id;
});

test('uploading a file through the real HTTP API works and round-trips real bytes', async () => {
  const content = Buffer.from('This is real file content sent through a real multipart HTTP request.');

  const upload = await request(app)
    .post('/api/files')
    .set('Authorization', `Bearer ${token}`)
    .field('courseId', courseId)
    .field('term', 'term1')
    .field('folder', 'notes')
    .field('title', 'Automated Test Upload')
    .attach('file', content, 'test.txt');

  assert.equal(upload.status, 201);
  const fileId = upload.body.id;

  const download = await request(app).get(`/api/files/${fileId}/download`).set('Authorization', `Bearer ${token}`);
  assert.equal(download.status, 200);
  assert.equal(Buffer.compare(download.body.length ? download.body : Buffer.from(download.text), content) === 0 || download.text === content.toString(), true);
});

test('rejects a document upload over the 13MB folder limit', async () => {
  const big = Buffer.alloc(14 * 1024 * 1024, 'x'); // 14MB > 13MB doc limit

  const res = await request(app)
    .post('/api/files')
    .set('Authorization', `Bearer ${token}`)
    .field('courseId', courseId)
    .field('term', 'term1')
    .field('folder', 'notes')
    .field('title', 'Too Big')
    .attach('file', big, 'big.txt');

  assert.equal(res.status, 400);
  assert.match(res.body.error, /too large/i);
});

test('accepts a "video" upload well under the 240MB video limit even though it exceeds the 13MB doc limit', async () => {
  const mid = Buffer.alloc(14 * 1024 * 1024, 'v'); // 14MB — over doc limit, well under video limit

  const res = await request(app)
    .post('/api/files')
    .set('Authorization', `Bearer ${token}`)
    .field('courseId', courseId)
    .field('term', 'term1')
    .field('folder', 'videos')
    .field('title', 'A Video')
    .attach('file', mid, 'lecture.mp4');

  assert.equal(res.status, 201);
});

test('rejects a folder that is not valid for the given term', async () => {
  const res = await request(app)
    .post('/api/files')
    .set('Authorization', `Bearer ${token}`)
    .field('courseId', courseId)
    .field('term', 'term1')
    .field('folder', 'sessional') // sessional only belongs to term3
    .field('title', 'Wrong Folder')
    .attach('file', Buffer.from('x'), 'x.txt');

  assert.equal(res.status, 400);
  assert.match(res.body.error, /not valid for term1/i);
});

test('deleting a file removes it from both the database and storage', async () => {
  const upload = await request(app)
    .post('/api/files')
    .set('Authorization', `Bearer ${token}`)
    .field('courseId', courseId)
    .field('term', 'term1')
    .field('folder', 'notes')
    .field('title', 'To Delete')
    .attach('file', Buffer.from('temp'), 'temp.txt');
  const fileId = upload.body.id;

  const del = await request(app).delete(`/api/files/${fileId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(del.status, 200);

  const list = await request(app).get('/api/files').set('Authorization', `Bearer ${token}`);
  assert.ok(!list.body.find(f => f.id === fileId));

  const download = await request(app).get(`/api/files/${fileId}/download`).set('Authorization', `Bearer ${token}`);
  assert.equal(download.status, 404);
});

test('editing a file title updates it without re-uploading', async () => {
  const upload = await request(app)
    .post('/api/files')
    .set('Authorization', `Bearer ${token}`)
    .field('courseId', courseId)
    .field('term', 'term1')
    .field('folder', 'notes')
    .field('title', 'Original Title')
    .attach('file', Buffer.from('content'), 'file.txt');
  const fileId = upload.body.id;

  const rename = await request(app).patch(`/api/files/${fileId}/title`).set('Authorization', `Bearer ${token}`).send({ title: 'Renamed Title' });
  assert.equal(rename.status, 200);

  const list = await request(app).get('/api/files').set('Authorization', `Bearer ${token}`);
  assert.equal(list.body.find(f => f.id === fileId).description, 'Renamed Title');
});
