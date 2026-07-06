// Verifies the local-disk fallback path still works correctly when no
// S3_BUCKET is configured — this is what a VPS with real persistent disk
// (or local development) uses. Run as its own process (see package.json)
// so its unset env vars never leak into the S3-mode test file.
const { test } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.S3_BUCKET;
delete require.cache[require.resolve('../storage')];
const storage = require('../storage');

test('storage adapter reports local mode when S3_BUCKET is not set', () => {
  assert.equal(storage.isS3Configured(), false);
});

test('ping() confirms the local uploads directory is writable', async () => {
  const result = await storage.ping();
  assert.equal(result.driver, 'local');
});

test('saveFile -> getFileStream round-trips real bytes correctly on local disk', async () => {
  const original = Buffer.from('Real content saved to real local disk.');
  const key = 'local-test-' + Date.now() + '.txt';

  await storage.saveFile(original, key, 'text/plain');
  const stream = await storage.getFileStream(key);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const downloaded = Buffer.concat(chunks);

  assert.equal(downloaded.toString(), original.toString());
  await storage.deleteFile(key); // clean up
});

test('deleteFile removes the file from local disk', async () => {
  const key = 'local-test-delete-' + Date.now() + '.txt';
  await storage.saveFile(Buffer.from('temp'), key, 'text/plain');
  await storage.deleteFile(key);
  await assert.rejects(() => storage.getFileStream(key));
});
