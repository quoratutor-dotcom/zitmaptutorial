-- ZITMAP Tutorials — PostgreSQL schema
--
-- This is a standalone copy of exactly what db/database.js -> initDb()
-- creates automatically every time the server boots. You do NOT need to
-- run this by hand — starting the server with a valid DATABASE_URL does
-- this for you. This file exists so you can:
--   • review the schema without reading JS
--   • run it manually via `psql` or a provider's SQL editor if you'd
--     rather provision the schema before first deploy
--   • use it in a CI/CD pipeline as an explicit migration step
--
-- Every collection is a table with:
--   id          TEXT PRIMARY KEY   -- fast indexed lookups
--   data        JSONB NOT NULL     -- the full record as sent by the API
--   created_at  TIMESTAMPTZ        -- insertion order / auditing
--
-- Safe to run multiple times — every statement is idempotent
-- (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS admins (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admins_data_gin ON admins USING GIN (data);

CREATE TABLE IF NOT EXISTS students (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS students_data_gin ON students USING GIN (data);

CREATE TABLE IF NOT EXISTS schools (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schools_data_gin ON schools USING GIN (data);

CREATE TABLE IF NOT EXISTS programs (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS programs_data_gin ON programs USING GIN (data);

CREATE TABLE IF NOT EXISTS courses (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS courses_data_gin ON courses USING GIN (data);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_data_gin ON files USING GIN (data);

CREATE TABLE IF NOT EXISTS tests (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tests_data_gin ON tests USING GIN (data);

CREATE TABLE IF NOT EXISTS announcements (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS announcements_data_gin ON announcements USING GIN (data);

CREATE TABLE IF NOT EXISTS payments (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_data_gin ON payments USING GIN (data);

-- Single-row settings table (id is always 'singleton')
CREATE TABLE IF NOT EXISTS settings (
  id   TEXT PRIMARY KEY,
  data JSONB NOT NULL
);

-- Seed default settings row if none exists yet
INSERT INTO settings (id, data)
SELECT 'singleton', '{
  "portal_name": "ZITMAP Tutorials",
  "contact_email": "",
  "contact_phone": "",
  "office_address": "",
  "working_hours": "",
  "facebook": "",
  "youtube": "",
  "tiktok": "",
  "welcome_msg": "Welcome to ZITMAP Tutorials.",
  "self_reg": "yes",
  "term1_start": "", "term1_end": "",
  "term2_start": "", "term2_end": "",
  "term3_start": "", "term3_end": ""
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'singleton');

-- NOTE: the default admin account is intentionally NOT seeded here — it's
-- seeded by db/database.js (or db/migrate.js) instead, because it needs a
-- bcrypt password hash computed in Node, not plain SQL. Run
-- `npm run db:migrate` (or just start the server once) after applying
-- this schema to get that first admin account created.
