require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/students');
const adminRoutes = require('./routes/admins');
const courseRoutes = require('./routes/courses');
const fileRoutes = require('./routes/files');
const settingsRoutes = require('./routes/settings');
const schoolsProgramsRoutes = require('./routes/schoolsPrograms');
const miscRoutes = require('./routes/misc');

const db = require('./db/database');
const storage = require('./storage');

const app = express();

// Trust the first hop reverse proxy (Render, Railway, Heroku, nginx, etc.)
// so req.ip reflects the real client IP — required for the rate limiter
// below to actually work per-client instead of per-proxy.
app.set('trust proxy', 1);

// ── Security headers ──
// crossOriginResourcePolicy is relaxed to "cross-origin" because uploaded
// files/images are legitimately fetched from a different origin than the
// API when the frontend is hosted separately from the backend.
//
// contentSecurityPolicy is deliberately customized: Helmet's default
// script-src/style-src ('self' only) blocks EVERY inline <script> and
// style="" attribute — and the entire frontend here is one self-contained
// HTML file with its whole application inline, by design. Without this,
// Helmet's own default CSP would silently break the entire frontend the
// moment it's deployed (this was caught by real-browser visual QA, not
// by jsdom-based testing, since jsdom doesn't enforce CSP at all). Every
// other Helmet protection (HSTS, X-Frame-Options, X-Content-Type-Options,
// etc.) stays fully enabled.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'"],
      'script-src-attr': ["'unsafe-inline'"], // needed for onclick="..." etc. used throughout the app
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
    },
  },
}));

// ── CORS ──
// Restrict to explicit origins in production via ALLOWED_ORIGINS (comma
// separated). If it's not set, every origin is allowed — convenient for
// local development, but you should set this before going live.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0 && process.env.NODE_ENV !== 'test') {
  console.warn(
    '⚠️  ALLOWED_ORIGINS is not set — CORS is open to any origin. ' +
    'Fine for local development; set ALLOWED_ORIGINS (comma-separated) ' +
    'before deploying so only your real frontend domain(s) can call this API.'
  );
}

app.use(cors({
  origin: allowedOrigins.length === 0
    ? true // reflect any origin (dev mode)
    : (origin, callback) => {
        // Allow non-browser requests (curl, server-to-server, no Origin header)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
      },
}));

app.use(express.json({ limit: '5mb' }));

// ── Rate limiting on auth endpoints ──
// Login and registration are the two endpoints most worth throttling —
// login to slow down credential-stuffing/brute-force, registration to
// slow down mass fake-account creation. Every other endpoint already
// requires a valid JWT, which is a much stronger gate than IP-based
// limiting alone.
// Disabled under NODE_ENV=test so the automated test suite can hit login
// repeatedly without tripping the same limiter a real attacker would.
const testMode = process.env.NODE_ENV === 'test';
const loginLimiter = testMode ? (req, res, next) => next() : rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
});
const registerLimiter = testMode ? (req, res, next) => next() : rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,                  // 20 registrations per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts from this network. Please try again later.' },
});
// Forgot-password is throttled separately from login: it triggers a real
// email send (or a dev-mode capture) per request, and — since its
// response is intentionally identical whether or not the email exists —
// rate limiting is the main defense against someone hammering it to
// enumerate emails or spam an inbox with reset links.
const forgotPasswordLimiter = testMode ? (req, res, next) => next() : rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                   // 5 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Please try again in a few minutes.' },
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', registerLimiter);
app.use('/api/auth/forgot-password', forgotPasswordLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/admins', adminRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api', schoolsProgramsRoutes); // /api/schools, /api/programs
app.use('/api', miscRoutes);            // /api/tests, /api/announcements, /api/payments

// Health check also verifies the database AND storage backend are
// actually reachable — useful for hosting-platform health checks / uptime
// monitors to catch a broken connection instead of reporting "ok" while
// every real request 500s.
app.get('/api/health', async (req, res) => {
  try {
    await db.ping();
    const storageInfo = await storage.ping();
    res.json({ status: 'ok', db: 'connected', storage: storageInfo, time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// Serve the frontend (the same ZITMAP_Tutorials.html, served as the site's index page)
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'frontend', 'ZITMAP_Tutorials.html'));
});

// Generic error handler — catches anything that slips past individual
// route try/catch blocks (e.g. the CORS rejection above) and makes sure
// the client never sees a raw stack trace or internal error detail.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message === 'Not allowed by CORS' ? 'Not allowed by CORS' : 'Something went wrong. Please try again.' });
});

module.exports = app;
