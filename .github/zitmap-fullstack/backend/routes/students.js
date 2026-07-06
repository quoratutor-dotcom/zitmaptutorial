const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAuth, requireAdmin, requireResourceAccess } = require('../middleware/auth');

const router = express.Router();

function sanitize(s) {
  const { password_hash, ...rest } = s;
  return rest;
}

router.get('/', requireAuth, requireAdmin, requireResourceAccess('students'), async (req, res) => {
  try {
    const students = await db.all('students');
    res.json(students.map(sanitize));
  } catch (err) {
    console.error('GET /api/students failed:', err);
    res.status(500).json({ error: 'Could not load students' });
  }
});

// Admin-only: create a student directly, already approved — distinct from
// self-registration (POST /auth/register), which always starts pending.
router.post('/', requireAuth, requireAdmin, requireResourceAccess('students'), async (req, res) => {
  try {
    const { name, email, password, gender, phone, schoolId, programId, year } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    if (await db.find('students', (s) => s.email === email)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const yy = String(new Date().getFullYear()).slice(-2);
    const count = (await db.filter('students', (s) => (s.appId || '').startsWith(yy))).length;
    const appId = yy + String(count + 1).padStart(4, '0');
    const id = 'stu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const hash = bcrypt.hashSync(password, 10);
    const student = {
      id, name, email, password_hash: hash,
      gender: gender || null, phone: phone || null,
      schoolId: schoolId || null, programId: programId || null, year: year || null,
      appId, approved: true, enrolled: [],
      created_at: new Date().toISOString(),
    };
    await db.insert('students', student);
    res.status(201).json({ message: 'Student created', id, appId });
  } catch (err) {
    console.error('POST /api/students failed:', err);
    res.status(500).json({ error: 'Could not create student' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
    const row = await db.find('students', (s) => s.id === req.user.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(sanitize(row));
  } catch (err) {
    console.error('GET /api/students/me failed:', err);
    res.status(500).json({ error: 'Could not load your profile' });
  }
});

router.patch('/:id/approve', requireAuth, requireAdmin, requireResourceAccess('students'), async (req, res) => {
  try {
    const result = await db.update('students', req.params.id, { approved: true });
    if (!result) return res.status(404).json({ error: 'Student not found' });
    res.json({ message: 'Student approved' });
  } catch (err) {
    console.error('PATCH /api/students/:id/approve failed:', err);
    res.status(500).json({ error: 'Could not approve student' });
  }
});

// ── Bulk course approval: the single "Approve Enrolled Courses" button ──
// Distinct from PATCH /:id/approve above, which approves the STUDENT'S
// ACCOUNT (lets them log in at all). This approves every one of that
// student's PENDING course-enrolment requests in one click, adding all
// of those courses to student.enrolled at once — which is what actually
// unlocks the document/video access gate in routes/files.js. An admin
// therefore has exactly two buttons per student: approve the account,
// and approve all of that student's requested courses.
router.patch('/:id/approve-courses', requireAuth, requireAdmin, requireResourceAccess('students'), async (req, res) => {
  try {
    const student = await db.find('students', (s) => s.id === req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const pending = await db.filter('course_requests',
      (r) => r.userId === req.params.id && r.status === 'pending');

    if (!pending.length) {
      return res.status(200).json({ message: 'No pending course requests for this student', approvedCount: 0, courseIds: [] });
    }

    const now = new Date().toISOString();
    const newCourseIds = pending.map((r) => r.courseId);

    // Mark every pending request approved...
    await Promise.all(pending.map((r) =>
      db.update('course_requests', r.id, { status: 'approved', resolvedAt: now })
    ));

    // ...and add every one of those courses to the student's enrolled
    // list in a single update (dedupe in case of any overlap).
    const enrolled = student.enrolled || [];
    const merged = [...new Set([...enrolled, ...newCourseIds])];
    await db.update('students', student.id, { enrolled: merged });

    res.json({ message: `Approved ${pending.length} course request(s)`, approvedCount: pending.length, courseIds: newCourseIds });
  } catch (err) {
    console.error('PATCH /api/students/:id/approve-courses failed:', err);
    res.status(500).json({ error: 'Could not approve enrolled courses' });
  }
});

router.patch('/:id', requireAuth, requireAdmin, requireResourceAccess('students'), async (req, res) => {
  try {
    const allowed = ['name', 'gender', 'phone', 'schoolId', 'programId', 'year', 'enrolled', 'termActivation'];
    const patch = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
    if (req.body.password) patch.password_hash = bcrypt.hashSync(req.body.password, 10);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.update('students', req.params.id, patch);
    if (!result) return res.status(404).json({ error: 'Student not found' });
    res.json({ message: 'Student updated' });
  } catch (err) {
    console.error('PATCH /api/students/:id failed:', err);
    res.status(500).json({ error: 'Could not update student' });
  }
});

router.delete('/:id', requireAuth, requireAdmin, requireResourceAccess('students'), async (req, res) => {
  try {
    await db.remove('students', req.params.id);
    res.json({ message: 'Student deleted' });
  } catch (err) {
    console.error('DELETE /api/students/:id failed:', err);
    res.status(500).json({ error: 'Could not delete student' });
  }
});

module.exports = router;
