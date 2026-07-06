const express = require('express');
const db = require('../db/database');
const { requireAuth, requireAdmin, requireResourceAccess, optionalAuth } = require('../middleware/auth');

const router = express.Router();
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Valid term values ──
const VALID_TERMS = ['term1', 'term2', 'term3'];

// ── Tests ──
// Tests now map to specific folder keys per term:
//   term1 → test1 (Test 1)
//   term2 → test2 (Test 2)
//   term3 → sessional (Sessional Exam)
const TERM_TEST_FOLDER = { term1: 'test1', term2: 'test2', term3: 'sessional' };
const TERM_TEST_LABEL  = { term1: 'Test 1', term2: 'Test 2', term3: 'Sessional Exam' };

router.get('/tests', requireAuth, async (req, res) => {
  try {
    const rows = (await db.all('tests')).map(t => ({
      ...t,
      folder: TERM_TEST_FOLDER[t.term] || t.term,
      folderLabel: TERM_TEST_LABEL[t.term] || t.term,
    }));
    res.json(rows);
  } catch (err) {
    console.error('GET /api/tests failed:', err);
    res.status(500).json({ error: 'Could not load tests' });
  }
});

router.post('/tests', requireAuth, requireAdmin, requireResourceAccess('tests'), async (req, res) => {
  try {
    const { courseId, term, title, questions, duration } = req.body;
    if (!courseId || !title) return res.status(400).json({ error: 'courseId and title required' });
    if (term && !VALID_TERMS.includes(term)) {
      return res.status(400).json({ error: `Invalid term "${term}". Must be term1, term2, or term3.` });
    }
    const resolvedTerm = term || 'term1';
    const id = uid('t');
    await db.insert('tests', {
      id, courseId,
      term: resolvedTerm,
      folder: TERM_TEST_FOLDER[resolvedTerm],
      title,
      questions: questions || 0,
      duration: duration || 0
    });
    res.status(201).json({
      message: 'Test created',
      id,
      folder: TERM_TEST_FOLDER[resolvedTerm],
      folderLabel: TERM_TEST_LABEL[resolvedTerm],
    });
  } catch (err) {
    console.error('POST /api/tests failed:', err);
    res.status(500).json({ error: 'Could not create test' });
  }
});

router.delete('/tests/:id', requireAuth, requireAdmin, requireResourceAccess('tests'), async (req, res) => {
  try {
    await db.remove('tests', req.params.id);
    res.json({ message: 'Test deleted' });
  } catch (err) {
    console.error('DELETE /api/tests/:id failed:', err);
    res.status(500).json({ error: 'Could not delete test' });
  }
});
router.patch('/tests/:id', requireAuth, requireAdmin, requireResourceAccess('tests'), async (req, res) => {
  try {
    const { courseId, term, title, questions, duration } = req.body;
    if (term && !VALID_TERMS.includes(term)) {
      return res.status(400).json({ error: `Invalid term "${term}". Must be term1, term2, or term3.` });
    }
    const patch = {};
    if (courseId !== undefined) patch.courseId = courseId;
    if (term !== undefined) { patch.term = term; patch.folder = TERM_TEST_FOLDER[term]; }
    if (title !== undefined) patch.title = title;
    if (questions !== undefined) patch.questions = questions;
    if (duration !== undefined) patch.duration = duration;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.update('tests', req.params.id, patch);
    if (!result) return res.status(404).json({ error: 'Test not found' });
    res.json({ message: 'Test updated' });
  } catch (err) {
    console.error('PATCH /api/tests/:id failed:', err);
    res.status(500).json({ error: 'Could not update test' });
  }
});

// ── Announcements ──
router.get('/announcements', optionalAuth, async (req, res) => {
  try {
    const isAdmin = req.user && req.user.role === 'admin';
    res.json(isAdmin ? await db.all('announcements') : await db.filter('announcements', (a) => a.active));
  } catch (err) {
    console.error('GET /api/announcements failed:', err);
    res.status(500).json({ error: 'Could not load announcements' });
  }
});
router.post('/announcements', requireAuth, requireAdmin, requireResourceAccess('announcements'), async (req, res) => {
  try {
    const { title, body, type } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const id = uid('a');
    await db.insert('announcements', { id, title, body: body || '', type: type || 'info', active: true, created_at: new Date().toISOString() });
    res.status(201).json({ message: 'Announcement created', id });
  } catch (err) {
    console.error('POST /api/announcements failed:', err);
    res.status(500).json({ error: 'Could not create announcement' });
  }
});
router.delete('/announcements/:id', requireAuth, requireAdmin, requireResourceAccess('announcements'), async (req, res) => {
  try {
    await db.remove('announcements', req.params.id);
    res.json({ message: 'Announcement deleted' });
  } catch (err) {
    console.error('DELETE /api/announcements/:id failed:', err);
    res.status(500).json({ error: 'Could not delete announcement' });
  }
});
router.patch('/announcements/:id', requireAuth, requireAdmin, requireResourceAccess('announcements'), async (req, res) => {
  try {
    const allowed = ['title', 'body', 'type', 'active'];
    const patch = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.update('announcements', req.params.id, patch);
    if (!result) return res.status(404).json({ error: 'Announcement not found' });
    res.json({ message: 'Announcement updated' });
  } catch (err) {
    console.error('PATCH /api/announcements/:id failed:', err);
    res.status(500).json({ error: 'Could not update announcement' });
  }
});

// ── Payments ──
router.get('/payments', requireAuth, requireAdmin, requireResourceAccess('payments'), async (req, res) => {
  try {
    res.json(await db.all('payments'));
  } catch (err) {
    console.error('GET /api/payments failed:', err);
    res.status(500).json({ error: 'Could not load payments' });
  }
});
router.post('/payments', requireAuth, requireResourceAccess('payments'), async (req, res) => {
  try {
    const studentId = req.user.role === 'student' ? req.user.id : req.body.studentId;
    const { amount, term, status } = req.body;
    if (!studentId || !amount || !term) return res.status(400).json({ error: 'studentId, amount and term required' });
    if (!['term1', 'term2', 'term3'].includes(term)) {
      return res.status(400).json({ error: 'Invalid term. Must be term1, term2, or term3.' });
    }
    if (parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });
    const id = uid('p');
    await db.insert('payments', {
      id, studentId, amount: parseFloat(amount), term,
      status: status || 'pending',
      date: new Date().toISOString()
    });
    res.status(201).json({ message: 'Payment recorded', id });
  } catch (err) {
    console.error('POST /api/payments failed:', err);
    res.status(500).json({ error: 'Could not record payment' });
  }
});
router.patch('/payments/:id', requireAuth, requireAdmin, requireResourceAccess('payments'), async (req, res) => {
  try {
    const { amount, term, status } = req.body;
    const patch = {};
    if (amount !== undefined) patch.amount = parseFloat(amount);
    if (term)   patch.term   = term;
    if (status) patch.status = status;
    patch.date = new Date().toISOString();
    const result = await db.update('payments', req.params.id, patch);
    if (!result) return res.status(404).json({ error: 'Payment not found' });
    res.json({ message: 'Payment updated' });
  } catch (err) {
    console.error('PATCH /api/payments/:id failed:', err);
    res.status(500).json({ error: 'Could not update payment' });
  }
});
router.patch('/payments/:id/status', requireAuth, requireAdmin, requireResourceAccess('payments'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['paid', 'pending', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const result = await db.update('payments', req.params.id, { status, date: new Date().toISOString() });
    if (!result) return res.status(404).json({ error: 'Payment not found' });
    res.json({ message: 'Payment status updated' });
  } catch (err) {
    console.error('PATCH /api/payments/:id/status failed:', err);
    res.status(500).json({ error: 'Could not update payment status' });
  }
});
router.delete('/payments/:id', requireAuth, requireAdmin, requireResourceAccess('payments'), async (req, res) => {
  try {
    await db.remove('payments', req.params.id);
    res.json({ message: 'Payment deleted' });
  } catch (err) {
    console.error('DELETE /api/payments/:id failed:', err);
    res.status(500).json({ error: 'Could not delete payment' });
  }
});

// ── Messages (student "Contact Us" submissions) ──
// Only students can create one; only admins (with 'messages' resource
// access — Super Admin, Student Manager, or Finance Admin) can read/manage
// them. Name and email are derived from the authenticated student's own
// record server-side, never trusted from the request body, so a message
// can't be spoofed as coming from someone else.
router.get('/messages', requireAuth, requireAdmin, requireResourceAccess('messages'), async (req, res) => {
  try {
    res.json(await db.all('messages'));
  } catch (err) {
    console.error('GET /api/messages failed:', err);
    res.status(500).json({ error: 'Could not load messages' });
  }
});
router.post('/messages', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ error: 'Only students can send messages here' });
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });
    const student = await db.find('students', (s) => s.id === req.user.id);
    const id = uid('msg');
    await db.insert('messages', {
      id,
      userId: req.user.id,
      name: student ? student.name : 'Unknown user',
      email: req.user.email,
      message: message.trim(),
      sentAt: new Date().toISOString(),
      read: false,
    });
    res.status(201).json({ message: 'Message sent', id });
  } catch (err) {
    console.error('POST /api/messages failed:', err);
    res.status(500).json({ error: 'Could not send message' });
  }
});
router.patch('/messages/:id/read', requireAuth, requireAdmin, requireResourceAccess('messages'), async (req, res) => {
  try {
    const result = await db.update('messages', req.params.id, { read: true });
    if (!result) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: 'Marked as read' });
  } catch (err) {
    console.error('PATCH /api/messages/:id/read failed:', err);
    res.status(500).json({ error: 'Could not update message' });
  }
});
router.delete('/messages/:id', requireAuth, requireAdmin, requireResourceAccess('messages'), async (req, res) => {
  try {
    await db.remove('messages', req.params.id);
    res.json({ message: 'Message deleted' });
  } catch (err) {
    console.error('DELETE /api/messages/:id failed:', err);
    res.status(500).json({ error: 'Could not delete message' });
  }
});

// ── Course enrolment requests ──
// A student requests enrolment in a course; an admin approves (which also
// adds the course to the student's `enrolled` list) or rejects it. Not
// covered by Course Manager / Finance Admin's restricted resource list —
// same as the frontend, this stays Super-Admin/Student-Manager territory.
router.get('/course-requests', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await db.all('course_requests'));
  } catch (err) {
    console.error('GET /api/course-requests failed:', err);
    res.status(500).json({ error: 'Could not load course requests' });
  }
});
// A student's own requests — not admin-only, but strictly scoped to the
// authenticated student's own userId so they can never see anyone else's.
router.get('/course-requests/mine', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
    const mine = await db.filter('course_requests', (r) => r.userId === req.user.id);
    res.json(mine);
  } catch (err) {
    console.error('GET /api/course-requests/mine failed:', err);
    res.status(500).json({ error: 'Could not load your course requests' });
  }
});
router.post('/course-requests', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ error: 'Only students can request enrolment' });
    const { courseId } = req.body;
    if (!courseId) return res.status(400).json({ error: 'courseId is required' });

    const student = await db.find('students', (s) => s.id === req.user.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if ((student.enrolled || []).includes(courseId)) {
      return res.status(409).json({ error: 'You are already enrolled in this course' });
    }
    const existingPending = await db.find('course_requests',
      (r) => r.userId === req.user.id && r.courseId === courseId && r.status === 'pending');
    if (existingPending) {
      return res.status(409).json({ error: 'You already have a pending request for this course' });
    }

    const course = await db.find('courses', (c) => c.id === courseId);
    const id = uid('creq');
    await db.insert('course_requests', {
      id,
      userId: req.user.id,
      userName: student.name,
      courseId,
      courseTitle: course ? course.title : courseId,
      courseEmoji: course ? course.emoji : '📘',
      status: 'pending',
      requestedAt: new Date().toISOString(),
    });
    res.status(201).json({ message: 'Enrolment request sent', id });
  } catch (err) {
    console.error('POST /api/course-requests failed:', err);
    res.status(500).json({ error: 'Could not submit enrolment request' });
  }
});
router.patch('/course-requests/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const request = await db.find('course_requests', (r) => r.id === req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    await db.update('course_requests', req.params.id, { status: 'approved', resolvedAt: new Date().toISOString() });

    const student = await db.find('students', (s) => s.id === request.userId);
    if (student) {
      const enrolled = student.enrolled || [];
      if (!enrolled.includes(request.courseId)) {
        await db.update('students', student.id, { enrolled: [...enrolled, request.courseId] });
      }
    }
    res.json({ message: 'Request approved and student enrolled' });
  } catch (err) {
    console.error('PATCH /api/course-requests/:id/approve failed:', err);
    res.status(500).json({ error: 'Could not approve request' });
  }
});
router.patch('/course-requests/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.update('course_requests', req.params.id, { status: 'rejected', resolvedAt: new Date().toISOString() });
    if (!result) return res.status(404).json({ error: 'Request not found' });
    res.json({ message: 'Request rejected' });
  } catch (err) {
    console.error('PATCH /api/course-requests/:id/reject failed:', err);
    res.status(500).json({ error: 'Could not reject request' });
  }
});
router.delete('/course-requests/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.remove('course_requests', req.params.id);
    res.json({ message: 'Request deleted' });
  } catch (err) {
    console.error('DELETE /api/course-requests/:id failed:', err);
    res.status(500).json({ error: 'Could not delete request' });
  }
});

// ── Email outbox (admin-only) ──
// A real audit log of every email the system has sent (or, in dev/demo
// mode with no SMTP configured, captured instead of delivering over the
// network — see email/index.js). Real SMTP sends are logged with just
// to/subject/timestamp for audit purposes; dev-mode captures also include
// the full rendered email so an admin can inspect exactly what a
// password-reset link looked like without needing a real inbox.
const email = require('../email');
router.get('/email-outbox', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await db.all('email_outbox');
    const sorted = rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100);
    res.json({ smtpConfigured: email.isSmtpConfigured(), emails: sorted });
  } catch (err) {
    console.error('GET /api/email-outbox failed:', err);
    res.status(500).json({ error: 'Could not load email outbox' });
  }
});

module.exports = router;
