const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, resetDb, loginAsAdmin } = require('./helpers');

before(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });

test('courses list is publicly readable without a token', async () => {
  const res = await request(app).get('/api/courses');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('creating a course requires admin auth', async () => {
  const res = await request(app).post('/api/courses').send({ title: 'No Auth Course' });
  assert.equal(res.status, 401);
});

test('admin can create, edit, and delete a course — each change is really persisted', async () => {
  const token = await loginAsAdmin();

  const create = await request(app).post('/api/courses').set('Authorization', `Bearer ${token}`).send({ title: 'Biology', emoji: '🧬' });
  assert.equal(create.status, 201);
  const id = create.body.id;

  const listAfterCreate = await request(app).get('/api/courses');
  assert.ok(listAfterCreate.body.find(c => c.id === id && c.title === 'Biology'));

  const edit = await request(app).patch(`/api/courses/${id}`).set('Authorization', `Bearer ${token}`).send({ description: 'Intro to Biology' });
  assert.equal(edit.status, 200);
  const listAfterEdit = await request(app).get('/api/courses');
  assert.equal(listAfterEdit.body.find(c => c.id === id).description, 'Intro to Biology');

  const del = await request(app).delete(`/api/courses/${id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(del.status, 200);
  const listAfterDelete = await request(app).get('/api/courses');
  assert.ok(!listAfterDelete.body.find(c => c.id === id));
});

test('creating a course without a title is rejected', async () => {
  const token = await loginAsAdmin();
  const res = await request(app).post('/api/courses').set('Authorization', `Bearer ${token}`).send({});
  assert.equal(res.status, 400);
});
