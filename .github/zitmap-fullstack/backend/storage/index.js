// Persistent file storage adapter.
//
// Problem this solves: most container-based hosts (Render, Railway,
// Heroku-style platforms) do NOT guarantee that local disk survives a
// redeploy or restart. A file saved to backend/uploads/ today can be gone
// tomorrow. The fix is to store files in real object storage (S3 or an
// S3-compatible service) instead of local disk — that data lives
// independently of the app server entirely.
//
// This module is deliberately a drop-in abstraction: every route file
// calls saveFile() / getFileStream() / deleteFile() and never touches
// fs or S3 directly, so the same code works whether or not object
// storage is configured.
//
// ── Configuration ──
// Set these environment variables to use real object storage (recommended
// for any host without a persistent volume):
//   S3_BUCKET             - required to enable S3 mode
//   S3_REGION             - e.g. "auto" (R2), "us-east-1" (AWS)
//   S3_ENDPOINT           - required for R2/MinIO/Spaces; omit for real AWS S3
//   S3_ACCESS_KEY_ID
//   S3_SECRET_ACCESS_KEY
//   S3_FORCE_PATH_STYLE   - set to "true" for MinIO/some non-AWS providers
//
// If S3_BUCKET is not set, files are stored on local disk under
// backend/uploads/ — fine for a VPS with real persistent disk, but NOT
// safe on ephemeral-disk hosts without a mounted volume.
const fs = require('fs');
const path = require('path');

const useS3 = !!process.env.S3_BUCKET;

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

let s3Client = null;
let PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand;

if (useS3) {
  const s3sdk = require('@aws-sdk/client-s3');
  PutObjectCommand = s3sdk.PutObjectCommand;
  GetObjectCommand = s3sdk.GetObjectCommand;
  DeleteObjectCommand = s3sdk.DeleteObjectCommand;
  HeadBucketCommand = s3sdk.HeadBucketCommand;

  s3Client = new s3sdk.S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: process.env.S3_ACCESS_KEY_ID ? {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    } : undefined,
  });
}

function isS3Configured() {
  return useS3;
}

// Saves a file buffer under the given storage key. Returns the key
// unchanged — callers persist this key in the database and use it for
// later retrieval/deletion, regardless of which backend stored it.
async function saveFile(buffer, key, contentType) {
  if (useS3) {
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
    }));
    return key;
  }
  const filePath = path.join(uploadDir, key);
  await fs.promises.writeFile(filePath, buffer);
  return key;
}

// Returns a readable stream for the given key, ready to .pipe() into an
// HTTP response.
async function getFileStream(key) {
  if (useS3) {
    const result = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
    }));
    return result.Body; // a Node.js Readable in the AWS SDK v3 Node runtime
  }
  const filePath = path.join(uploadDir, key);
  if (!fs.existsSync(filePath)) {
    const err = new Error('File not found in local storage');
    err.code = 'ENOENT';
    throw err;
  }
  return fs.createReadStream(filePath);
}

// Deletes the file for the given key. Safe to call even if the file is
// already missing — deletion is treated as idempotent.
async function deleteFile(key) {
  if (useS3) {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
    }));
    return;
  }
  const filePath = path.join(uploadDir, key);
  if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
}

// Verifies the configured storage backend is actually reachable — used by
// /api/health so a broken S3 configuration shows up immediately instead of
// silently failing on the next real upload.
async function ping() {
  if (useS3) {
    await s3Client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    return { driver: 's3', bucket: process.env.S3_BUCKET };
  }
  // Local disk: just confirm the directory is writable.
  await fs.promises.access(uploadDir, fs.constants.W_OK);
  return { driver: 'local', path: uploadDir };
}

module.exports = { isS3Configured, saveFile, getFileStream, deleteFile, ping };
