// Real test of the storage adapter's S3 code path — not mocked at the
// module level, but exercised against an actual running S3-compatible
// server (s3rver), so this proves saveFile/getFileStream/deleteFile
// genuinely work against the real S3 API surface, not just against our
// own assumptions about it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const S3rver = require('s3rver');

const S3_DIR = path.join(__dirname, '.tmp-s3rver');
const BUCKET = 'zitmap-test-bucket';
let s3rverInstance;

before(async () => {
  fs.rmSync(S3_DIR, { recursive: true, force: true });
  fs.mkdirSync(S3_DIR, { recursive: true });

  s3rverInstance = new S3rver({
    port: 4569,
    address: 'localhost',
    silent: true,
    directory: S3_DIR,
    configureBuckets: [{ name: BUCKET }],
  });
  await s3rverInstance.run();

  // Point the storage adapter at the local S3-compatible server BEFORE
  // requiring it, since it reads env vars at module load time.
  process.env.S3_BUCKET = BUCKET;
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_ENDPOINT = 'http://localhost:4569';
  process.env.S3_FORCE_PATH_STYLE = 'true';
  process.env.S3_ACCESS_KEY_ID = 'S3RVER';
  process.env.S3_SECRET_ACCESS_KEY = 'S3RVER';
});

after(async () => {
  await new Promise((resolve) => s3rverInstance.close(resolve));
  fs.rmSync(S3_DIR, { recursive: true, force: true });
});

test('storage adapter reports S3 mode when S3_BUCKET is set', () => {
  delete require.cache[require.resolve('../storage')];
  const storage = require('../storage');
  assert.equal(storage.isS3Configured(), true);
});

test('ping() confirms the real S3-compatible bucket is reachable', async () => {
  delete require.cache[require.resolve('../storage')];
  const storage = require('../storage');
  const result = await storage.ping();
  assert.equal(result.driver, 's3');
  assert.equal(result.bucket, BUCKET);
});

test('saveFile -> getFileStream round-trips real bytes correctly through real S3', async () => {
  delete require.cache[require.resolve('../storage')];
  const storage = require('../storage');

  const original = Buffer.from('Real content uploaded through the real storage adapter, round-tripped through a real S3-compatible server.');
  const key = 'test-uploads/' + Date.now() + '_roundtrip.txt';

  await storage.saveFile(original, key, 'text/plain');

  const stream = await storage.getFileStream(key);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const downloaded = Buffer.concat(chunks);

  assert.equal(downloaded.toString(), original.toString());
  assert.equal(downloaded.length, original.length);
});

test('deleteFile actually removes the object from S3', async () => {
  delete require.cache[require.resolve('../storage')];
  const storage = require('../storage');

  const key = 'test-uploads/' + Date.now() + '_to-delete.txt';
  await storage.saveFile(Buffer.from('temporary'), key, 'text/plain');

  // Confirm it exists first
  const stream = await storage.getFileStream(key);
  assert.ok(stream);

  await storage.deleteFile(key);

  // Now it should be gone
  await assert.rejects(() => storage.getFileStream(key));
});

test('saveFile handles binary data correctly (not just text)', async () => {
  delete require.cache[require.resolve('../storage')];
  const storage = require('../storage');

  // A small binary buffer with all byte values, including nulls and high bytes
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const key = 'test-uploads/' + Date.now() + '_binary.bin';

  await storage.saveFile(binary, key, 'application/octet-stream');
  const stream = await storage.getFileStream(key);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const downloaded = Buffer.concat(chunks);

  assert.equal(Buffer.compare(binary, downloaded), 0, 'binary content must match byte-for-byte');
});
