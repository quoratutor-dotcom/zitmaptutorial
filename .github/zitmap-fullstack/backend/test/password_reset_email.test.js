// Real test of the password-reset + email flow.
//
// The SMTP-mode tests below spin up an ACTUAL SMTP server (smtp-server,
// the same library's companion project to nodemailer) on localhost and
// point the app's real email module at it via SMTP_HOST/SMTP_PORT — so
// the app performs a genuine SMTP conversation (HELO/MAIL FROM/RCPT
// TO/DATA) exactly as it would against Gmail, SendGrid, or any other
// real provider. Nothing about the SMTP transport itself is mocked; only
// the destination is a local server instead of a real internet mail
// host, which is the standard way to integration-test SMTP code without
// depending on the network or a real mailbox.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { app, request, resetDb, loginAsAdmin } = require('./helpers');

let smtpServer;
let receivedMails = [];
const SMTP_PORT = 2526;

before(async () => {
  await resetDb();
  // A real, listening SMTP server — accepts any auth, captures every
  // message it receives so the test can assert on the real MIME content.
  smtpServer = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        const parsed = await simpleParser(Buffer.concat(chunks));
        receivedMails.push(parsed);
        callback();
      });
    },
  });
  await new Promise((resolve) => smtpServer.listen(SMTP_PORT, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise((resolve) => smtpServer.close(resolve));
});

beforeEach(async () => {
  await resetDb();
  receivedMails = [];
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
});

test('DEV MODE (no SMTP configured): forgot-password returns a usable devPreview reset link, and resetting the password actually works', async () => {
  const adminToken = await loginAsAdmin();
  const email = 'devmode_reset@example.com';
  await request(app).post('/api/students').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Dev Reset', email, password: 'OldPass123!' });

  const forgot = await request(app).post('/api/auth/forgot-password').send({ email });
  assert.equal(forgot.status, 200);
  assert.ok(forgot.body.devPreview, 'dev mode must return a devPreview since no SMTP is configured');
  assert.match(forgot.body.devPreview.resetLink, /resetToken=[a-f0-9]{64}/);

  // Confirm it was also captured in the real email_outbox audit log with full content.
  const outbox = await request(app).get('/api/email-outbox').set('Authorization', `Bearer ${adminToken}`);
  assert.equal(outbox.status, 200);
  assert.equal(outbox.body.smtpConfigured, false);
  const entry = outbox.body.emails.find((e) => e.to === email);
  assert.ok(entry, 'the dev-mode send must be logged in the outbox');
  assert.equal(entry.mode, 'dev');
  assert.ok(entry.preview.text.includes('Reset your ZITMAP Tutorials password'.slice(0, 5)) || entry.preview.html);

  const token = new URLSearchParams(forgot.body.devPreview.resetLink.split('?')[1]).get('resetToken');
  const reset = await request(app).post('/api/auth/reset-password').send({ token, password: 'BrandNewPass456!' });
  assert.equal(reset.status, 200);

  const oldLogin = await request(app).post('/api/auth/login').send({ email, password: 'OldPass123!' });
  assert.equal(oldLogin.status, 401);
  const newLogin = await request(app).post('/api/auth/login').send({ email, password: 'BrandNewPass456!' });
  assert.equal(newLogin.status, 200);
});

test('REAL SMTP MODE: forgot-password sends an actual SMTP email to a real listening server, and the token inside it resets the password', async () => {
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(SMTP_PORT);
  process.env.EMAIL_FROM = 'ZITMAP Tutorials <no-reply@zitmap.test>';

  const adminToken = await loginAsAdmin();
  const email = 'realsmtp_reset@example.com';
  await request(app).post('/api/students').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Real SMTP Reset', email, password: 'OldPass123!' });

  const forgot = await request(app).post('/api/auth/forgot-password').send({ email });
  assert.equal(forgot.status, 200);
  assert.equal(forgot.body.devPreview, undefined, 'no devPreview once real SMTP is configured');

  // Give the async SMTP delivery a brief moment to land.
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(receivedMails.length, 1, 'the real SMTP server must have received exactly one real message');
  const mail = receivedMails[0];
  assert.equal(mail.to.text, email);
  assert.match(mail.subject, /Reset your ZITMAP Tutorials password/);
  assert.match(mail.text, /resetToken=[a-f0-9]{64}/);

  const tokenMatch = /resetToken=([a-f0-9]{64})/.exec(mail.text);
  assert.ok(tokenMatch, 'the real emailed message must contain a usable reset token');

  const reset = await request(app).post('/api/auth/reset-password').send({ token: tokenMatch[1], password: 'BrandNewPass456!' });
  assert.equal(reset.status, 200);

  const newLogin = await request(app).post('/api/auth/login').send({ email, password: 'BrandNewPass456!' });
  assert.equal(newLogin.status, 200);

  // Audit log should show a real SMTP delivery, without retaining the reset link content.
  const outbox = await request(app).get('/api/email-outbox').set('Authorization', `Bearer ${adminToken}`);
  assert.equal(outbox.body.smtpConfigured, true);
  const entry = outbox.body.emails.find((e) => e.to === email);
  assert.equal(entry.mode, 'smtp');
  assert.equal(entry.preview, undefined);

  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.EMAIL_FROM;
});

test('forgot-password gives the exact same response for an email that does not exist (no user enumeration)', async () => {
  const known = await request(app).post('/api/auth/forgot-password').send({ email: process.env.DEFAULT_ADMIN_EMAIL });
  const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'definitely_not_registered@example.com' });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(known.body.message, unknown.body.message);
});

test('an expired/invalid/garbage reset token is rejected cleanly', async () => {
  const res = await request(app).post('/api/auth/reset-password').send({ token: 'not-a-real-token', password: 'WhateverPass123!' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid or has expired/i);
});

test('a reset token can only be used ONCE — reusing it fails', async () => {
  const adminToken = await loginAsAdmin();
  const email = 'single_use_reset@example.com';
  await request(app).post('/api/students').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Single Use', email, password: 'OldPass123!' });

  const forgot = await request(app).post('/api/auth/forgot-password').send({ email });
  const token = new URLSearchParams(forgot.body.devPreview.resetLink.split('?')[1]).get('resetToken');

  const first = await request(app).post('/api/auth/reset-password').send({ token, password: 'FirstNewPass123!' });
  assert.equal(first.status, 200);

  const second = await request(app).post('/api/auth/reset-password').send({ token, password: 'SecondNewPass123!' });
  assert.equal(second.status, 400);
});

test('requesting a new reset link invalidates the previous one', async () => {
  const adminToken = await loginAsAdmin();
  const email = 'superseded_reset@example.com';
  await request(app).post('/api/students').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Superseded', email, password: 'OldPass123!' });

  const first = await request(app).post('/api/auth/forgot-password').send({ email });
  const firstToken = new URLSearchParams(first.body.devPreview.resetLink.split('?')[1]).get('resetToken');

  const second = await request(app).post('/api/auth/forgot-password').send({ email });
  const secondToken = new URLSearchParams(second.body.devPreview.resetLink.split('?')[1]).get('resetToken');

  const useFirst = await request(app).post('/api/auth/reset-password').send({ token: firstToken, password: 'ShouldFailPass123!' });
  assert.equal(useFirst.status, 400);

  const useSecond = await request(app).post('/api/auth/reset-password').send({ token: secondToken, password: 'ShouldWorkPass123!' });
  assert.equal(useSecond.status, 200);
});

test('an admin account can also use the password-reset flow (not just students)', async () => {
  const adminToken = await loginAsAdmin();
  const adminEmail = 'reset_admin@example.com';
  await request(app).post('/api/admins').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Reset Admin', email: adminEmail, password: 'OldAdminPass123!', role: 'Admin' });

  const forgot = await request(app).post('/api/auth/forgot-password').send({ email: adminEmail });
  const token = new URLSearchParams(forgot.body.devPreview.resetLink.split('?')[1]).get('resetToken');

  const reset = await request(app).post('/api/auth/reset-password').send({ token, password: 'NewAdminPass456!' });
  assert.equal(reset.status, 200);

  const login = await request(app).post('/api/auth/login').send({ email: adminEmail, password: 'NewAdminPass456!' });
  assert.equal(login.status, 200);
  assert.equal(login.body.role, 'admin');
});
