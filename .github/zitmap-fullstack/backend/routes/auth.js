const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db/database');
const { signToken } = require('../middleware/auth');
const email = require('../email');

const router = express.Router();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function genAppId() {
  const yy = String(new Date().getFullYear()).slice(-2);
  const count = (await db.filter('students', (s) => (s.appId || '').startsWith(yy))).length;
  const seq = String(count + 1).padStart(4, '0');
  return yy + seq;
}

// ── Student self-registration ──
// Any courses the applicant ticked on the sign-up form (courseIds) are NOT
// auto-enrolled — each becomes its own real, pending row in course_requests,
// exactly like a request submitted after login (see POST /api/course-requests
// in routes/misc.js). That means every course a new applicant picks shows up
// on the admin's "Course Enrolment Requests" screen and must be explicitly
// approved (individually, or all at once via PATCH /students/:id/approve-courses)
// before that course's documents/videos unlock — ticking a checkbox at sign-up
// carries exactly the same weight as requesting it later.
router.post('/register', async (req, res) => {
  try {
    const { name, lastName, email, password, gender, phone, schoolId, programId, year, courseIds } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    if (await db.find('students', (s) => s.email === email)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const appId = await genAppId();
    const fullName = lastName ? `${name} ${lastName}` : name;
    const studentId = uid();

    await db.insert('students', {
      id: studentId, name: fullName, email, password_hash: hash,
      gender: gender || null, phone: phone || null,
      schoolId: schoolId || null, programId: programId || null, year: year || null,
      appId, approved: false, enrolled: [],
      created_at: new Date().toISOString(),
    });

    // De-duplicate whatever the client sent, then only act on courseIds
    // that actually exist — an unknown/stale id is silently skipped rather
    // than creating a request for a course that no longer exists.
    const requestedIds = Array.isArray(courseIds) ? [...new Set(courseIds.filter((c) => typeof c === 'string' && c))] : [];
    let requestedCount = 0;
    if (requestedIds.length) {
      const allCourses = await db.all('courses');
      for (const courseId of requestedIds) {
        const course = allCourses.find((c) => c.id === courseId);
        if (!course) continue;
        await db.insert('course_requests', {
          id: 'creq_' + uid(),
          userId: studentId,
          userName: fullName,
          courseId,
          courseTitle: course.title,
          courseEmoji: course.emoji,
          status: 'pending',
          requestedAt: new Date().toISOString(),
        });
        requestedCount++;
      }
    }

    res.status(201).json({ message: 'Registration submitted. Awaiting admin approval.', appId, requestedCourses: requestedCount });
  } catch (err) {
    console.error('POST /api/auth/register failed:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── Unified login: tries admin table first, then student table ──
// Accepts EITHER an email address OR a student's application number
// (appId) in the 'email' field — the field name is kept for backward
// compatibility with existing clients, but its value is now treated as a
// general login identifier.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const identifier = (email || '').trim();
    if (!identifier || !password) return res.status(400).json({ error: 'email/application number and password required' });
    const identifierLower = identifier.toLowerCase();

    const admin = await db.find('admins', (a) => (a.email || '').toLowerCase() === identifierLower);
    if (admin && bcrypt.compareSync(password, admin.password_hash)) {
      const token = signToken({ id: admin.id, role: 'admin', email: admin.email, adminRole: admin.role });
      return res.json({ token, role: 'admin', user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
    }

    // Students can log in with either their email OR their application
    // number (appId) — application numbers are compared exactly (they're
    // not case-sensitive-ambiguous like emails, they're plain digits).
    const student = await db.find('students', (s) =>
      (s.email || '').toLowerCase() === identifierLower || (s.appId && s.appId === identifier)
    );
    if (student && bcrypt.compareSync(password, student.password_hash)) {
      if (!student.approved) {
        return res.status(403).json({ error: 'Your account is awaiting admin approval', appId: student.appId });
      }
      const token = signToken({ id: student.id, role: 'student', email: student.email });
      return res.json({
        token, role: 'student',
        user: { id: student.id, name: student.name, email: student.email, appId: student.appId }
      });
    }

    res.status(401).json({ error: 'Incorrect email/application number or password' });
  } catch (err) {
    console.error('POST /api/auth/login failed:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── Password reset ──
// Real, hashed, expiring, single-use tokens — the same pattern used by
// virtually every production auth system:
//   1. POST /forgot-password: if the email matches an account (student OR
//      admin), generate a random 32-byte token, store only its SHA-256
//      hash (never the raw token) with a 30-minute expiry, and email the
//      raw token as a link. The response is IDENTICAL whether or not the
//      email matched anything, so this endpoint can never be used to
//      discover which emails have accounts (no user enumeration).
//   2. POST /reset-password: the raw token from the link is re-hashed and
//      looked up; if it matches an unused, unexpired row, the account's
//      password is updated and the token is marked used (so it cannot be
//      replayed).
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function buildResetLink(token) {
  const base = (process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
  return `${base}/?resetToken=${token}`;
}

router.post('/forgot-password', async (req, res) => {
  try {
    const identifier = (req.body.email || '').trim();
    const generic = { message: 'If an account exists for that email, a password reset link has been sent.' };
    if (!identifier) return res.json(generic); // still generic — don't hint at validation either

    const identifierLower = identifier.toLowerCase();
    const student = await db.find('students', (s) => (s.email || '').toLowerCase() === identifierLower);
    const admin = !student && await db.find('admins', (a) => (a.email || '').toLowerCase() === identifierLower);
    const account = student || admin;

    if (!account) {
      // Same response either way — see comment above.
      return res.json(generic);
    }

    // Invalidate any previous still-usable reset tokens for this account
    // before issuing a new one, so only the newest link ever works.
    const stale = await db.filter('password_resets', (r) => r.userId === account.id && !r.usedAt);
    await Promise.all(stale.map((r) => db.update('password_resets', r.id, { usedAt: new Date().toISOString(), supersededAt: new Date().toISOString() })));

    const token = genToken();
    const resetId = 'pwr_' + uid();
    await db.insert('password_resets', {
      id: resetId,
      tokenHash: hashToken(token),
      userId: account.id,
      role: student ? 'student' : 'admin',
      email: account.email,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      usedAt: null,
    });

    const resetLink = buildResetLink(token);
    const sendResult = await email.sendPasswordResetEmail({ to: account.email, name: account.name, resetLink });

    // Convenience only for non-production, and only when nothing was
    // actually delivered over SMTP — lets this exact flow be exercised
    // end-to-end without a real mailbox during local development/demos.
    // Never included once SMTP is configured or in production, since that
    // would defeat the point of emailing the link in the first place.
    const devPreview = (process.env.NODE_ENV !== 'production' && !sendResult.delivered)
      ? { resetLink, note: 'Shown only because no SMTP is configured and NODE_ENV is not production — see .env.example.' }
      : undefined;

    res.json(devPreview ? { ...generic, devPreview } : generic);
  } catch (err) {
    console.error('POST /api/auth/forgot-password failed:', err);
    // Even on an internal error, don't leak account existence — but DO
    // signal failure so the client doesn't think an email is on its way.
    res.status(500).json({ error: 'Could not process password reset request. Please try again.' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const tokenHash = hashToken(token);
    const nowIso = new Date().toISOString();
    const record = await db.find('password_resets', (r) => r.tokenHash === tokenHash && !r.usedAt && r.expiresAt > nowIso);
    if (!record) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    const collection = record.role === 'admin' ? 'admins' : 'students';
    const hash = bcrypt.hashSync(password, 10);
    const updated = await db.update(collection, record.userId, { password_hash: hash });
    if (!updated) return res.status(404).json({ error: 'Account no longer exists' });

    // Single-use: mark it spent so the same link can never be replayed.
    await db.update('password_resets', record.id, { usedAt: nowIso });

    res.json({ message: 'Password updated successfully. You can now log in with your new password.' });
  } catch (err) {
    console.error('POST /api/auth/reset-password failed:', err);
    res.status(500).json({ error: 'Could not reset password. Please try again.' });
  }
});

module.exports = router;
