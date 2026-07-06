const express = require('express');
const db = require('../db/database');
const { requireAuth, requireAdmin, requireResourceAccess } = require('../middleware/auth');

const router = express.Router();
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

router.get('/schools', async (req, res) => {
  try {
    res.json(await db.all('schools'));
  } catch (err) {
    console.error('GET /api/schools failed:', err);
    res.status(500).json({ error: 'Could not load schools' });
  }
});
router.post('/schools', requireAuth, requireAdmin, requireResourceAccess('schools'), async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = uid('sch');
    await db.insert('schools', { id, name, code: code || '' });
    res.status(201).json({ message: 'School created', id });
  } catch (err) {
    console.error('POST /api/schools failed:', err);
    res.status(500).json({ error: 'Could not create school' });
  }
});
router.patch('/schools/:id', requireAuth, requireAdmin, requireResourceAccess('schools'), async (req, res) => {
  try {
    const allowed = ['name', 'code'];
    const patch = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.update('schools', req.params.id, patch);
    if (!result) return res.status(404).json({ error: 'School not found' });
    res.json({ message: 'School updated' });
  } catch (err) {
    console.error('PATCH /api/schools/:id failed:', err);
    res.status(500).json({ error: 'Could not update school' });
  }
});
router.delete('/schools/:id', requireAuth, requireAdmin, requireResourceAccess('schools'), async (req, res) => {
  try {
    await db.remove('schools', req.params.id);
    const orphaned = await db.filter('programs', (p) => p.schoolId === req.params.id);
    for (const p of orphaned) await db.remove('programs', p.id);
    res.json({ message: 'School deleted' });
  } catch (err) {
    console.error('DELETE /api/schools/:id failed:', err);
    res.status(500).json({ error: 'Could not delete school' });
  }
});

router.get('/programs', async (req, res) => {
  try {
    res.json(await db.all('programs'));
  } catch (err) {
    console.error('GET /api/programs failed:', err);
    res.status(500).json({ error: 'Could not load programs' });
  }
});
router.post('/programs', requireAuth, requireAdmin, requireResourceAccess('programs'), async (req, res) => {
  try {
    const { schoolId, name, code, courseIds } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = uid('prog');
    await db.insert('programs', { id, schoolId: schoolId || null, name, code: code || '', courseIds: courseIds || [] });
    res.status(201).json({ message: 'Program created', id });
  } catch (err) {
    console.error('POST /api/programs failed:', err);
    res.status(500).json({ error: 'Could not create program' });
  }
});
router.patch('/programs/:id', requireAuth, requireAdmin, requireResourceAccess('programs'), async (req, res) => {
  try {
    const allowed = ['name', 'code', 'schoolId', 'courseIds'];
    const patch = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.update('programs', req.params.id, patch);
    if (!result) return res.status(404).json({ error: 'Program not found' });
    res.json({ message: 'Program updated' });
  } catch (err) {
    console.error('PATCH /api/programs/:id failed:', err);
    res.status(500).json({ error: 'Could not update program' });
  }
});
router.delete('/programs/:id', requireAuth, requireAdmin, requireResourceAccess('programs'), async (req, res) => {
  try {
    await db.remove('programs', req.params.id);
    res.json({ message: 'Program deleted' });
  } catch (err) {
    console.error('DELETE /api/programs/:id failed:', err);
    res.status(500).json({ error: 'Could not delete program' });
  }
});

module.exports = router;
