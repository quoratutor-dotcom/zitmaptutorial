const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, request, resetDb, loginAsAdmin } = require('./helpers');

let token;
before(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); token = await loginAsAdmin(); });

test('settings are publicly readable', async () => {
  const res = await request(app).get('/api/settings');
  assert.equal(res.status, 200);
  assert.ok('portal_name' in res.body);
});

test('updating settings requires admin auth', async () => {
  const res = await request(app).put('/api/settings').send({ portalName: 'Hacked' });
  assert.equal(res.status, 401);
});

test('REGRESSION: a partial settings update must NOT wipe out fields set by an earlier update', async () => {
  await request(app).put('/api/settings').set('Authorization', `Bearer ${token}`)
    .send({ portalName: 'ZITMAP Tutorials', contactEmail: 'info@zitmap.com' });

  // A second, unrelated partial update — must not blank out portalName/contactEmail
  await request(app).put('/api/settings').set('Authorization', `Bearer ${token}`)
    .send({ aboutUs: 'We are a tutoring portal.' });

  const res = await request(app).get('/api/settings');
  assert.equal(res.body.portal_name, 'ZITMAP Tutorials', 'portal_name must survive an unrelated partial update');
  assert.equal(res.body.contact_email, 'info@zitmap.com', 'contact_email must survive an unrelated partial update');
  assert.equal(res.body.about_us, 'We are a tutoring portal.');
});

test('privacy policy, about us, and terms and conditions all save and persist independently', async () => {
  await request(app).put('/api/settings').set('Authorization', `Bearer ${token}`)
    .send({ privacyPolicy: 'PRIVACY TEXT', aboutUs: 'ABOUT TEXT', termsConditions: 'TERMS TEXT' });

  const res = await request(app).get('/api/settings');
  assert.equal(res.body.privacy_policy, 'PRIVACY TEXT');
  assert.equal(res.body.about_us, 'ABOUT TEXT');
  assert.equal(res.body.terms_conditions, 'TERMS TEXT');
});
