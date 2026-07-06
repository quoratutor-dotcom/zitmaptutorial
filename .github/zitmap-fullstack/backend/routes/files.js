const express = require('express');
const multer = require('multer');
const db = require('../db/database');
const storage = require('../storage');
const { requireAuth, requireAdmin, requireResourceAccess } = require('../middleware/auth');

const router = express.Router();

// Files are read into memory by multer, then handed to the storage adapter
// (storage/index.js), which persists them to S3-compatible object storage
// when configured, or local disk otherwise. Routes never touch fs or S3
// directly — that's what makes uploads survive redeploys on hosts without
// persistent disk, with zero code change needed here if you add S3 later.

const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm'];

// ── Per-folder size limits ──
// The "videos" folder gets a much larger ceiling; every other folder
// (test1/test2/sessional, notes, tutorial) is a document folder capped at
// the smaller limit. We can't know which folder a request is for until the
// multipart "folder" field has been parsed, so multer itself is configured
// with the larger of the two limits (VIDEO_MAX) purely so it never rejects
// a legitimate video before we get a chance to inspect req.body.folder.
// The real, folder-specific limit is enforced in the route handler below.
const DOC_MAX_MB = 13;
const DOC_MAX_BYTES = DOC_MAX_MB * 1024 * 1024;
const VIDEO_MAX_MB = 240;
const VIDEO_MAX_BYTES = VIDEO_MAX_MB * 1024 * 1024;

function maxBytesForFolder(folder) {
  return folder === 'videos' ? VIDEO_MAX_BYTES : DOC_MAX_BYTES;
}
function maxMbForFolder(folder) {
  return folder === 'videos' ? VIDEO_MAX_MB : DOC_MAX_MB;
}

// multer needs its size cap set at construction time; memoryStorage means
// every uploaded file is read into req.file.buffer, which the storage
// adapter then persists wherever it's configured to (S3 or local disk).
const uploadWithLimit = multer({ storage: multer.memoryStorage(), limits: { fileSize: VIDEO_MAX_BYTES } });

// ── Valid folder keys per term — mirrors the TERM_FOLDERS spec in the frontend ──
const TERM_FOLDERS = {
  term1: ['test1', 'notes', 'tutorial', 'videos'],
  term2: ['test2', 'notes', 'tutorial', 'videos'],
  term3: ['sessional', 'notes', 'tutorial', 'videos'],
};

// Subtype is derived from the folder key for the three test/exam folders
const FOLDER_SUBTYPE = { test1: 'test1', test2: 'test2', sessional: 'sessional' };

function uid() {
  return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Generates the storage key used for a new upload — kept separate from the
// original filename so two different uploads can never collide, whether
// they land on local disk or in an S3 bucket.
function makeStorageKey(originalname) {
  return Date.now() + '_' + originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// A student can only ever see/download files for courses that (a) the
// admin has approved their account for (student.approved — enforced at
// login, re-checked here in case approval is revoked mid-session) AND
// (b) the admin has approved an enrolment request for (student.enrolled
// contains the courseId — see routes/misc.js /course-requests/:id/approve,
// the single "Approve" button on the admin Enrolments screen).
// This is server-side enforcement — the frontend already hides locked
// courses in the UI, but that alone would not stop a direct API call.
async function getApprovedEnrolledCourseIds(userId) {
  const student = await db.find('students', (s) => s.id === userId);
  if (!student || !student.approved) return null; // null = no access at all
  return student.enrolled || [];
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const { courseId, term, folder } = req.query;
    let rows = await db.all('files');

    if (req.user.role === 'student') {
      const enrolledIds = await getApprovedEnrolledCourseIds(req.user.id);
      if (enrolledIds === null) return res.status(403).json({ error: 'Your account is not approved yet' });
      rows = rows.filter((f) => enrolledIds.includes(f.courseId));
    }

    if (courseId) rows = rows.filter((f) => f.courseId === courseId);
    if (term)     rows = rows.filter((f) => f.term === term);
    if (folder)   rows = rows.filter((f) => f.folder === folder);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/files failed:', err);
    res.status(500).json({ error: 'Could not load files' });
  }
});

router.post('/', requireAuth, requireAdmin, requireResourceAccess('files'), uploadWithLimit.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { courseId, term, folder, title } = req.body;

    // Validate required fields
    if (!courseId || !term || !folder || !title) {
      return res.status(400).json({ error: 'courseId, term, folder, and title are required' });
    }

    // Validate term value
    if (!TERM_FOLDERS[term]) {
      return res.status(400).json({ error: `Invalid term "${term}". Must be term1, term2, or term3.` });
    }

    // Validate folder is allowed for this term
    if (!TERM_FOLDERS[term].includes(folder)) {
      return res.status(400).json({
        error: `Folder "${folder}" is not valid for ${term}. Allowed: ${TERM_FOLDERS[term].join(', ')}`
      });
    }

    // Enforce the folder-specific size limit now that we know which folder
    // this upload targets: 240 MB for "videos", 13 MB for every document
    // folder (test1/test2/sessional, notes, tutorial).
    const maxBytes = maxBytesForFolder(folder);
    if (req.file.size > maxBytes) {
      const sizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
      const maxMB = maxMbForFolder(folder);
      return res.status(400).json({
        error: `File too large. "${req.file.originalname}" is ${sizeMB} MB. The maximum allowed size for the "${folder}" folder is ${maxMB} MB.`
      });
    }

    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let type = 'file';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) type = 'image';
    else if (VIDEO_EXTS.includes(ext)) type = 'video';
    else if (ext === 'pdf') type = 'pdf';

    const id = uid();
    const sizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
    // Derive subtype automatically from folder key — no need to send it from the frontend
    const subtype = FOLDER_SUBTYPE[folder] || null;

    // Persist the bytes via the storage adapter — S3-compatible object
    // storage if configured, local disk otherwise. Either way, only the
    // resulting key is stored in the database, not a raw filesystem path.
    const storageKey = makeStorageKey(req.file.originalname);
    await storage.saveFile(req.file.buffer, storageKey, req.file.mimetype);

    await db.insert('files', {
      id, courseId, term, folder, subtype,
      name: req.file.originalname, description: title,
      filepath: storageKey, type, sizeMB,
      uploaded_at: new Date().toISOString(),
    });

    res.status(201).json({ message: 'File uploaded', id, sizeMB, type, folder, term, subtype });
  } catch (err) {
    console.error('POST /api/files failed:', err);
    res.status(500).json({ error: 'Could not upload file' });
  }
});

// Edit a file's title without re-uploading
router.patch('/:id/title', requireAuth, requireAdmin, requireResourceAccess('files'), async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const result = await db.update('files', req.params.id, { description: title.trim() });
    if (!result) return res.status(404).json({ error: 'File not found' });
    res.json({ message: 'Title updated' });
  } catch (err) {
    console.error('PATCH /api/files/:id/title failed:', err);
    res.status(500).json({ error: 'Could not update title' });
  }
});

router.get('/:id/download', requireAuth, async (req, res) => {
  try {
    const file = await db.find('files', (f) => f.id === req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (req.user.role === 'student') {
      const enrolledIds = await getApprovedEnrolledCourseIds(req.user.id);
      if (enrolledIds === null) return res.status(403).json({ error: 'Your account is not approved yet' });
      if (!enrolledIds.includes(file.courseId)) {
        return res.status(403).json({ error: 'You are not approved for this course yet. Ask an admin to approve your enrolment request.' });
      }
    }

    const encodedName = encodeURIComponent(file.name);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"; filename*=UTF-8''${encodedName}`);

    const stream = await storage.getFileStream(file.filepath);
    stream.on('error', (err) => {
      console.error('GET /api/files/:id/download stream failed:', err);
      if (!res.headersSent) res.status(404).json({ error: 'File not found in storage' });
    });
    stream.pipe(res);
  } catch (err) {
    console.error('GET /api/files/:id/download failed:', err);
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found in storage' });
    res.status(500).json({ error: 'Could not download file' });
  }
});

router.delete('/:id', requireAuth, requireAdmin, requireResourceAccess('files'), async (req, res) => {
  try {
    const file = await db.find('files', (f) => f.id === req.params.id);
    if (file) {
      try { await storage.deleteFile(file.filepath); }
      catch (err) { console.warn('Could not delete stored file (continuing to remove DB record):', err.message); }
    }
    await db.remove('files', req.params.id);
    res.json({ message: 'File deleted' });
  } catch (err) {
    console.error('DELETE /api/files/:id failed:', err);
    res.status(500).json({ error: 'Could not delete file' });
  }
});

// Return the valid folder list per term (useful for frontend validation or future API clients)
router.get('/folders/:term', (req, res) => {
  const folders = TERM_FOLDERS[req.params.term];
  if (!folders) return res.status(400).json({ error: 'Invalid term' });
  res.json({ term: req.params.term, folders });
});

module.exports = router;
