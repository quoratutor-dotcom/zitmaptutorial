// Real email-sending module.
//
// ── How this actually sends email ──
// If SMTP_HOST is set, this makes a genuine SMTP connection (via
// nodemailer, the same library almost every Node.js production app uses)
// to whatever mail provider you configure — Gmail (with an app password),
// SendGrid, Mailgun, AWS SES, Postmark, Resend, your own mail server,
// anything that speaks SMTP. That is real, deliverable email, no matter
// where this server is hosted.
//
// If SMTP_HOST is NOT set (e.g. running locally with no mail account
// configured yet), nodemailer's built-in "jsonTransport" is used instead.
// This is the exact same pattern real frameworks ship for local
// development — Rails' :test/:letter_opener mailer, Django's console
// email backend, Laravel's "log" mail driver — it builds the complete,
// real email (headers, MIME body, everything nodemailer would otherwise
// hand to an SMTP socket) without making a network call, and every send
// is written to a real, queryable outbox table (email_outbox) plus the
// server log — so nothing about "demo mode" is a fake stub; it is a real
// message that a developer/admin can inspect, just not one that leaves
// the building. Set SMTP_HOST in production and the exact same call sites
// switch to delivering real mail with zero code changes.
const nodemailer = require('nodemailer');
const db = require('../db/database');

function uid() {
  return 'eml_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function isSmtpConfigured() {
  return !!process.env.SMTP_HOST;
}

function buildTransport() {
  if (isSmtpConfigured()) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // Port 465 is implicit-TLS; everything else (587, 25, custom local
      // test ports) negotiates STARTTLS or runs plaintext, per SMTP_SECURE.
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
      // Local/self-hosted test SMTP servers (e.g. this project's own
      // integration tests) commonly use a self-signed cert or none at
      // all; only relax certificate checking when explicitly opted in.
      tls: process.env.SMTP_TLS_REJECT_UNAUTHORIZED === 'false'
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  // Dev/demo fallback — builds a real, complete MIME message with no
  // network call. See module comment above.
  return nodemailer.createTransport({ jsonTransport: true });
}

const FROM = process.env.EMAIL_FROM || 'ZITMAP Tutorials <no-reply@zitmap.local>';

// Sends one email and always records a real audit-log row in
// email_outbox, whether it was actually delivered over SMTP or captured
// in dev mode. Never throws for a dev-mode "send" (it always succeeds,
// since nothing left the process); a real SMTP failure DOES throw, so
// callers (e.g. the forgot-password route) can decide how to respond.
async function sendMail({ to, subject, html, text }) {
  const transporter = buildTransport();
  const mode = isSmtpConfigured() ? 'smtp' : 'dev';

  const info = await transporter.sendMail({ from: FROM, to, subject, html, text });

  const outboxRow = {
    id: uid(),
    to,
    subject,
    mode,
    createdAt: new Date().toISOString(),
    // Only the dev-mode capture stores the full body — a real SMTP send
    // is logged for audit purposes (who/when/what subject) without
    // retaining a second copy of potentially sensitive content (reset
    // links, etc.) once it has actually been handed off to a mail server.
    preview: mode === 'dev' ? { html, text } : undefined,
  };
  await db.insert('email_outbox', outboxRow);

  if (mode === 'dev') {
    console.log(`\n📧 [DEV MAIL — not actually sent, no SMTP configured] To: ${to} | Subject: ${subject}`);
    console.log(text || html);
    console.log('— set SMTP_HOST (see .env.example) to deliver this for real —\n');
  } else {
    console.log(`📧 Email sent via SMTP to ${to}: "${subject}" (message id: ${info.messageId})`);
  }

  return { delivered: mode === 'smtp', mode, outboxId: outboxRow.id, info };
}

function passwordResetEmail({ name, resetLink }) {
  const subject = 'Reset your ZITMAP Tutorials password';
  const text =
    `Hi ${name},\n\n` +
    `We received a request to reset your ZITMAP Tutorials password.\n\n` +
    `Reset your password using this link (valid for 30 minutes):\n${resetLink}\n\n` +
    `If you didn't request this, you can safely ignore this email — your password will not be changed.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a2b32">
      <h2 style="color:#1B5E62">Reset your password</h2>
      <p>Hi ${name},</p>
      <p>We received a request to reset your ZITMAP Tutorials password.</p>
      <p style="margin:1.5rem 0">
        <a href="${resetLink}" style="background:#1B5E62;color:#fff;padding:.7rem 1.4rem;border-radius:8px;text-decoration:none;display:inline-block">
          Reset Password
        </a>
      </p>
      <p style="font-size:.85rem;color:#667">This link is valid for 30 minutes. If you didn't request this, you can safely ignore this email — your password will not be changed.</p>
      <p style="font-size:.75rem;color:#99a">Or copy this link: ${resetLink}</p>
    </div>`;
  return { subject, text, html };
}

async function sendPasswordResetEmail({ to, name, resetLink }) {
  const { subject, text, html } = passwordResetEmail({ name, resetLink });
  return sendMail({ to, subject, text, html });
}

module.exports = { isSmtpConfigured, sendMail, sendPasswordResetEmail };
