#!/usr/bin/env node
// Real, runnable proof that password reset actually works end-to-end —
// against a genuinely running server and its real database, not a unit
// test or a mock. Works whether or not SMTP is configured:
//
//   - Demo mode (no SMTP_HOST set): the server hands back the real reset
//     link in its response (see routes/auth.js), and this script uses it
//     directly to complete the reset — proving the whole mechanism (token
//     generation, hashing, expiry, single-use enforcement, password
//     update) works without needing a real mailbox.
//   - Real SMTP mode (SMTP_HOST set): the server sends a genuine email
//     instead, so no token is available here to finish the reset
//     automatically — the script confirms the send was accepted and
//     tells you to check the email-outbox audit log (or the real inbox)
//     for the link, since that's the correct real-world flow.
//
// Usage:
//   node scripts/verify-password-reset-demo.js
//   BASE_URL=https://your-deployed-app.example.com node scripts/verify-password-reset-demo.js
//
// Requires the server to already be running (locally or deployed) and
// reachable at BASE_URL, and requires DEFAULT_ADMIN_EMAIL/PASSWORD to
// match a real admin account on that server (defaults match .env.example).

const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
const ADMIN_EMAIL = process.env.DEFAULT_ADMIN_EMAIL || 'admin@zitmap.com';
const ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

let pass = 0;
let fail = 0;

function ok(label, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(BASE_URL + '/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON response */ }
  return { status: res.status, body };
}

async function main() {
  console.log(`\n🔎 Verifying the real password-reset flow against: ${BASE_URL}\n`);

  // 0. Confirm the server is actually up and its DB/storage are reachable.
  const health = await api('/health');
  ok('server is reachable and /api/health reports ok', health.status === 200 && health.body && health.body.status === 'ok',
    JSON.stringify(health.body));
  if (health.status !== 200) {
    console.log('\nCannot continue — the server is not reachable at ' + BASE_URL + '. Is it running?\n');
    process.exit(1);
  }

  // 1. Log in as the real admin.
  const adminLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  ok('admin login succeeds', adminLogin.status === 200 && adminLogin.body.token, JSON.stringify(adminLogin.body));
  if (adminLogin.status !== 200) {
    console.log('\nCannot continue without a valid admin token — check DEFAULT_ADMIN_EMAIL/DEFAULT_ADMIN_PASSWORD.\n');
    process.exit(1);
  }
  const adminToken = adminLogin.body.token;
  const authHeader = { Authorization: `Bearer ${adminToken}` };

  // 2. Create a fresh, already-approved demo student account with a known password.
  const stamp = Date.now();
  const demoEmail = `reset_verify_${stamp}@example.com`;
  const oldPassword = 'OldDemoPass123!';
  const newPassword = 'NewDemoPass456!';

  const createRes = await api('/students', {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify({ name: 'Reset Verification', email: demoEmail, password: oldPassword }),
  });
  ok('demo student account created', createRes.status === 201, JSON.stringify(createRes.body));

  const loginWithOld = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: demoEmail, password: oldPassword }),
  });
  ok('demo account can log in with its ORIGINAL password (before reset)', loginWithOld.status === 200, JSON.stringify(loginWithOld.body));

  // 3. Trigger the real forgot-password endpoint.
  const forgot = await api('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: demoEmail }),
  });
  ok('POST /auth/forgot-password returns 200', forgot.status === 200, JSON.stringify(forgot.body));

  if (forgot.body && forgot.body.devPreview) {
    console.log('\n  ℹ️  DEMO MODE detected — no SMTP configured on this server.');
    console.log('     The server handed back the real reset link so this can be verified without a mailbox:');
    console.log('     ' + forgot.body.devPreview.resetLink + '\n');

    const token = new URL(forgot.body.devPreview.resetLink).searchParams.get('resetToken');
    ok('a real reset token was extracted from the link', !!token && token.length === 64);

    // 4. Actually reset the password using that real token.
    const resetRes = await api('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password: newPassword }),
    });
    ok('POST /auth/reset-password succeeds with the real token', resetRes.status === 200, JSON.stringify(resetRes.body));

    // 5. Prove the password ACTUALLY changed.
    const oldStillWorks = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: demoEmail, password: oldPassword }),
    });
    ok('OLD password is now REJECTED', oldStillWorks.status === 401, `got status ${oldStillWorks.status}`);

    const newWorks = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: demoEmail, password: newPassword }),
    });
    ok('NEW password now logs in successfully', newWorks.status === 200, JSON.stringify(newWorks.body));

    // 6. Prove the token cannot be replayed.
    const replay = await api('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password: 'SomeOtherPass789!' }),
    });
    ok('the SAME token is rejected on a second use (single-use enforcement)', replay.status === 400, `got status ${replay.status}`);
  } else {
    console.log('\n  ℹ️  REAL SMTP MODE detected — an actual email was sent, so no token is available here.');
    console.log('     Check the real inbox for ' + demoEmail + ', or ask an admin to open Email Outbox');
    console.log('     (GET /api/email-outbox) to confirm the send was logged.\n');
    const outbox = await api('/email-outbox', { headers: authHeader });
    const sent = outbox.body && outbox.body.emails && outbox.body.emails.find((e) => e.to === demoEmail);
    ok('the send was recorded in the real email-outbox audit log', !!sent, JSON.stringify(outbox.body));
  }

  // 7. No-enumeration check: an unknown email must behave identically.
  const unknown = await api('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: 'this_email_does_not_exist_' + stamp + '@example.com' }),
  });
  ok('an unknown email gets the exact same response shape (no account enumeration)',
    unknown.status === 200 && unknown.body.message === forgot.body.message);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 Verification script crashed:', err);
  process.exit(1);
});
