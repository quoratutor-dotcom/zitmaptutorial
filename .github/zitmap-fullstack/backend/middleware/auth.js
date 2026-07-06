const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev_only_secret_change_me';
if (!process.env.JWT_SECRET) {
  console.warn(
    '⚠️  JWT_SECRET is not set — using an insecure default. ' +
    'This is fine for local testing only. Set a real random JWT_SECRET ' +
    'before deploying (e.g. `openssl rand -hex 32`).'
  );
}

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '7d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Populates req.user if a valid token is present, but never blocks the
// request if it's missing or invalid — used for endpoints that behave
// differently for logged-in admins vs. the general public (e.g.
// announcements: the public only sees active ones, admins see all).
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, SECRET); } catch (e) { /* ignore invalid/expired token here */ }
  }
  next();
}

// ── Per-role resource restrictions ──
// Mirrors the same restriction the frontend already applies to the admin
// nav (Course Manager only sees Schools/Courses; Finance Admin only sees
// Payments). This is the SERVER-SIDE enforcement of that boundary — the
// frontend hiding buttons is a UX nicety, this is what actually stops a
// restricted admin's token from being used against a disallowed API route
// directly (e.g. via curl/Postman), regardless of what the UI shows them.
//
// Roles not listed here (Super Admin, Student Manager, the generic
// "Admin" default, or any future role) get unrestricted access — same
// convention as the frontend's ROLE_ACCESS map.
const RESOURCE_ACCESS = {
  'Course Manager': ['schools', 'programs', 'courses'],
  'Finance Admin':  ['payments', 'messages'],
};

// The admin's specific role (Super Admin / Course Manager / Finance Admin /
// Student Manager / etc.) is embedded in the JWT at login time as
// `adminRole` — see routes/auth.js. That means this check is a fast,
// local decode with no extra database lookup per request. The trade-off:
// if an admin's role is changed by a Super Admin, that change takes
// effect the next time they log in (tokens are valid up to 7 days) rather
// than instantly on their next request — a standard, expected trade-off
// of stateless JWT auth.
function requireResourceAccess(resource) {
  return (req, res, next) => {
    const adminRole = req.user && req.user.adminRole;
    const allowed = adminRole ? RESOURCE_ACCESS[adminRole] : null;
    if (allowed && !allowed.includes(resource)) {
      return res.status(403).json({
        error: `Your admin role (${adminRole}) does not have access to manage ${resource}.`,
      });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireAdmin, requireResourceAccess, optionalAuth, RESOURCE_ACCESS, SECRET };
