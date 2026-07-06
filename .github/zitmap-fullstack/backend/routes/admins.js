const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAuth, requireAdmin, requireResourceAccess } = require('../middleware/auth');

const router = express.Router();

function uid() {
  return 'admin_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function sanitize(a) {
  const { password_hash, ...rest } = a;
  return rest;
}

router.get('/', requireAuth, requireAdmin, requireResourceAccess('admins'), async (req, res) => {
  try {
    const admins = await db.all('admins');
    res.json(admins.map(sanitize));
  } catch (err) {
    console.error('GET /api/admins failed:', err);
    res.status(500).json({ error: 'Could not load admins' });
  }
});

router.post('/', requireAuth, requireAdmin, requireResourceAccess('admins'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
    if (await db.find('admins', (a) => a.email === email)) {
      return res.status(409).json({ error: 'An admin with this email already exists' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const id = uid();
    await db.insert('admins', { id, name, email, password_hash: hash, role: role || 'Admin', created_at: new Date().toISOString() });
    res.status(201).json({ message: 'Admin created', id });
  } catch (err) {
    console.error('POST /api/admins failed:', err);
    res.status(500).json({ error: 'Could not create admin' });
  }
});

router.patch('/me/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const admin = await db.find('admins', (a) => a.id === req.user.id);
    if (!admin || !bcrypt.compareSync(currentPassword || '', admin.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await db.update('admins', admin.id, { password_hash: bcrypt.hashSync(newPassword, 10) });
    res.json({ message: 'Password updated' });
  } catch (err) {
    console.error('PATCH /api/admins/me/password failed:', err);
    res.status(500).json({ error: 'Could not update password' });
  }
});

// General edit — name/email/role, and optionally a new password (used by
// a Super Admin editing someone else's account, unlike me/password above
// which is self-service and requires the current password).
router.patch('/:id', requireAuth, requireAdmin, requireResourceAccess('admins'), async (req, res) => {
  try {
    const { name, email, role, password } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (email !== undefined) patch.email = email;
    if (role !== undefined) patch.role = role;
    if (password) patch.password_hash = bcrypt.hashSync(password, 10);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.update('admins', req.params.id, patch);
    if (!result) return res.status(404).json({ error: 'Admin not found' });
    res.json({ message: 'Admin updated' });
  } catch (err) {
    console.error('PATCH /api/admins/:id failed:', err);
    res.status(500).json({ error: 'Could not update admin' });
  }
});

router.delete('/:id', requireAuth, requireAdmin, requireResourceAccess('admins'), async (req, res) => {
  try {
    if ((await db.all('admins')).length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last remaining admin' });
    }
    await db.remove('admins', req.params.id);
    res.json({ message: 'Admin deleted' });
  } catch (err) {
    console.error('DELETE /api/admins/:id failed:', err);
    res.status(500).json({ error: 'Could not delete admin' });
  }
});

module.exports = router;
