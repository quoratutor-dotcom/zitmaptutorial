// Loaded via `node --test --require ./test/env.js` (see package.json's
// "test" script) — sets up an isolated test environment BEFORE app.js or
// db/database.js are required by any test file, since both read
// process.env at module-load time.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://zitmap:zitmap_dev_pw@localhost:5432/zitmap_test';
process.env.JWT_SECRET = 'test_jwt_secret_for_automated_tests_only_do_not_use_in_production';
process.env.DEFAULT_ADMIN_EMAIL = 'admin@zitmap.com';
process.env.DEFAULT_ADMIN_PASSWORD = 'admin123';
// Ensure tests run against local-disk storage unless a specific test file
// explicitly configures S3 mode itself (see test/storage.test.js).
delete process.env.S3_BUCKET;
delete process.env.ALLOWED_ORIGINS;
