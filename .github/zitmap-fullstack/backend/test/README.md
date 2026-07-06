# Automated Testing

This project has two independent layers of automated testing, both run
against a REAL PostgreSQL database and REAL HTTP requests — nothing here
is mocked at the database or network level.

## 1. API test suite (`test/*.test.js`)

Real HTTP requests (via `supertest`) against the real Express app,
backed by a real, dedicated `zitmap_test` PostgreSQL database that gets
wiped clean before every test file runs.

**Setup (one-time):**
```bash
createdb -O zitmap zitmap_test
# or: psql -c "CREATE DATABASE zitmap_test OWNER zitmap;"
```

**Run everything:**
```bash
npm test
```

**Run just the storage tests** (these spin up a real, temporary
S3-compatible server via `s3rver` to prove the object-storage code path
actually works, not just the local-disk fallback):
```bash
npm run test:storage
```

Covers: registration & login (including login-by-application-number),
role-based access control (Course Manager / Finance Admin restrictions —
enforced server-side, not just hidden in the UI), course CRUD, real file
upload/download/delete through actual multipart HTTP requests (including
size-limit enforcement), settings persistence (including a regression
test for a real partial-update bug found during development), messages,
and the full course-enrollment-request approval flow.

## 2. Real-browser visual QA (`test/visual/run.js`)

Unlike the API suite above, this drives an actual, real Chrome browser
(via `puppeteer-core`, using whatever Chrome/Chromium binary is available
on the machine — no bundled browser download required) through the real
frontend HTML, at real viewport sizes, and takes real screenshots.

This exists as a distinct layer because some bugs are only visible to an
actual browser enforcing actual CSS and actual security headers — for
example, this suite is what caught a real Content-Security-Policy
misconfiguration that silently broke every button and every inline
script in the entire app the moment Helmet's default headers were
applied. Neither the API suite above nor jsdom-based interactive testing
would ever catch that class of bug, since neither of them enforces CSP.

**Setup (one-time):**
```bash
psql -c "CREATE DATABASE zitmap_visual OWNER zitmap;"
```
(Chrome must be available. If you don't already have `puppeteer-core`'s
cached Chrome, run `npx puppeteer browsers install chrome` once, or point
`test/visual/run.js`'s `findChrome()` at your system Chrome/Chromium.)

**Run it:**
```bash
node test/visual/run.js
```

It will: reset a dedicated visual-QA database, boot a real instance of
the app on a separate port, seed real test data through the real API,
launch real Chrome, and walk through the login page (at mobile/tablet/
desktop sizes), a real admin login and drawer-navigation click, a real
student login, the green "enrolled" course marking, and the register
page — taking a real PNG screenshot at every step (saved to
`test/visual/screenshots/`) and asserting on real computed styles and
real layout (e.g. "no horizontal overflow at mobile width", "this
course card's real computed border-color is the correct green").

Exits non-zero if anything fails, so it's CI-friendly.
