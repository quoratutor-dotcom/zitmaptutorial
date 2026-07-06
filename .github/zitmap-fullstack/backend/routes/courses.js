const express = require('express');
const db = require('../db/database');
const { requireAuth, requireAdmin, requireResourceAccess } = require('../middleware/auth');

const router = express.Router();
function uid() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

router.get('/', async (req, res) => {
  try {
    res.json(await db.all('courses'));
  } catch (err) {
    console.error('GET /api/courses failed:', err);
    res.status(500).json({ error: 'Could not load courses' });
  }
});

router.post('/', requireAuth, requireAdmin, requireResourceAccess('courses'), async (req, res) => {
  try {
    const { emoji, color, title, description, status } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const id = uid();
    await db.insert('courses', { id, emoji: emoji || '📘', color: color || '#1B5E62', title, description: description || '', status: status || 'active' });
    res.status(201).json({ message: 'Course created', id });
  } catch (err) {
    console.error('POST /api/courses failed:', err);
    res.status(500).json({ error: 'Could not create course' });
  }
});

router.patch('/:id', requireAuth, requireAdmin, requireResourceAccess('courses'), async (req, res) => {
  try {
    const allowed = ['emoji', 'color', 'title', 'description', 'status'];
    const patch = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.update('courses', req.params.id, patch);
    if (!result) return res.status(404).json({ error: 'Course not found' });
    res.json({ message: 'Course updated' });
  } catch (err) {
    console.error('PATCH /api/courses/:id failed:', err);
    res.status(500).json({ error: 'Could not update course' });
  }
});

router.delete('/:id', requireAuth, requireAdmin, requireResourceAccess('courses'), async (req, res) => {
  try {
    await db.remove('courses', req.params.id);
    res.json({ message: 'Course deleted' });
  } catch (err) {
    console.error('DELETE /api/courses/:id failed:', err);
    res.status(500).json({ error: 'Could not delete course' });
  }
});

module.exports = router;
