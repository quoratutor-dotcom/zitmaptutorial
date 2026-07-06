# ZITMAP Tutorials — Full-Stack Package

This package contains:

```
zitmap-fullstack/
├── frontend/
│   └── ZITMAP_Tutorials.html   ← the exact same portal you've been testing
└── backend/
    ├── server.js                ← Express server entry point
    ├── db/database.js           ← PostgreSQL data store + auto table creation/seeding
    ├── middleware/auth.js       ← JWT auth helpers
    ├── routes/                  ← REST API (auth, students, admins, courses,
    │                               files, settings, schools/programs,
    │                               tests, announcements, payments)
    ├── uploads/                 ← uploaded files are saved here on disk
    ├── package.json
    └── .env.example
```

## Important — please read this first

The HTML file (`frontend/ZITMAP_Tutorials.html`) now talks to the **real
backend for every feature** — courses, schools & programs, file uploads,
tests, announcements, payments, admin management (including the role
restrictions), student management, enrolment requests, the Messages
Received / Contact Us feature, settings, and the Privacy & Security
policy. This was a full pass, not just auth — every add/edit/delete/
approve action in the portal now calls a real API endpoint and persists
to the shared PostgreSQL database, tested end-to-end against a live
server for each one (including binary file upload → download round-trips
byte-for-byte, and the Course Manager / Finance Admin role restrictions
correctly extending to every new resource).

Two backend resources were added specifically to support this:
**Messages** (`/api/messages`) and **Course enrolment requests**
(`/api/course-requests`) — previously these only existed in the frontend
demo, with nowhere real to persist to.

### How this was verified

Beyond API-level curl testing, the frontend itself was loaded in a real
DOM environment (jsdom) against the live backend and exercised through
actual clicks — not just code review: logging in, clicking "Add Course"
and submitting the modal, toggling an announcement, sending a real
Contact Us message, clicking through every admin nav panel, and the full
student registration → login → course-browsing flow. This caught and
fixed one real bug: the registration page's school/program dropdowns were
showing stale local demo data instead of the real backend data, because
nothing synced public data before a session existed. That's fixed —
`syncPublicData()` now runs on load for anyone who isn't logged in yet.

### How the dual-mode fallback works

Every mutating action **tries the real backend API first**. If the
backend can't be reached at all (e.g. you open the HTML file directly
from disk without running the server, or you're testing offline), that
specific action automatically falls back to the original localStorage
demo logic, so the portal never breaks — it just won't be saving to a
shared database in that case. If the backend *is* reachable but returns a
real error (validation failure, permission denied, etc.), that real error
is shown — it does not silently fall back.

When the backend is reachable, a **sync layer** (`syncAllFromServer()`)
pulls fresh data from every endpoint right after login and on every page
refresh, and refreshes the relevant piece again after every mutation — so
what you see in the UI always reflects the real database, not a stale
local cache.

When you run the backend (see below) and open it in your browser, you are
using the real API throughout. The default admin account (seeded from
your `.env`) and everything anyone creates through the portal is stored
in your real **PostgreSQL database**, shared across every device/browser
that connects to the same backend — not in browser localStorage.



## Database setup (required — do this first)

The backend now uses **real PostgreSQL** for storage (previously a JSON
file — that's been fully replaced). You need a Postgres database before
the server will start.

**Option A — local Postgres via Docker (fastest way to get started):**
```bash
cd backend
docker compose up -d
# DATABASE_URL is already set correctly for this in .env.example
```

**Option B — local Postgres installed directly (no Docker):**
```bash
# macOS (Homebrew)
brew install postgresql@16 && brew services start postgresql@16
createuser zitmap --pwprompt
createdb zitmap -O zitmap

# Ubuntu/Debian
sudo apt-get install postgresql
sudo -u postgres psql -c "CREATE USER zitmap WITH PASSWORD 'yourpassword';"
sudo -u postgres psql -c "CREATE DATABASE zitmap OWNER zitmap;"
```
Then your `DATABASE_URL` is: `postgres://zitmap:yourpassword@localhost:5432/zitmap`

**Option C — free/low-cost managed Postgres (recommended for production):**
Any of these give you a `DATABASE_URL` connection string in a couple of
minutes, with backups handled for you:
- [Render](https://render.com) — Postgres add-on, free tier available
- [Railway](https://railway.app) — one-click Postgres
- [Supabase](https://supabase.com) — free tier, generous limits
- [Neon](https://neon.tech) — free tier, serverless Postgres

Copy the connection string it gives you into `DATABASE_URL` in your `.env`.
If the provider requires SSL (nearly all managed providers do), also set
`PGSSL=require` in `.env` — see `.env.example` for both.

The app creates all its tables automatically on first startup (see
`db/database.js` → `initDb()`) — there's no separate migration step you
*have* to run by hand. That said, two extra tools are included for
provisioning a database ahead of time or reviewing the schema directly:

- **`db/schema.sql`** — a standalone copy of the exact schema the app
  creates, as plain SQL. Run it yourself via `psql` or paste it into your
  provider's SQL editor (Supabase, Neon, etc. all have one) if you'd
  rather provision the database before your first deploy:
  ```bash
  psql "$DATABASE_URL" -f db/schema.sql
  ```
- **`npm run db:migrate`** — connects using `DATABASE_URL`, creates every
  table (safe to re-run), seeds the first admin account, and prints a
  summary — all without starting the HTTP server. Good as a "release" /
  "pre-deploy" step on hosts that support one (Render's Pre-Deploy
  Command, Railway deploy hooks, a CI job, etc.), or just to sanity-check
  a connection string before flipping your domain over.

Both are idempotent — running either against a database that's already
set up just confirms everything's in place and does nothing destructive.

## Running the backend

```bash
cd backend
cp .env.example .env       # set DATABASE_URL, JWT_SECRET, and default admin credentials
npm install
npm start
```

The server starts on `http://localhost:4000` (or the `PORT` you set in `.env`)
and also serves the frontend HTML directly, so opening
`http://localhost:4000` in a browser shows the same portal (still running in
its own localStorage mode — see note above).

On first run it connects to `DATABASE_URL`, creates every table it needs if
they don't already exist, and seeds **one** admin account using the
email/password from your `.env` file. Change that password immediately
after first login via the API (`PATCH /api/admins/me/password`).

If `DATABASE_URL` is missing or the database can't be reached, the server
logs a clear error and refuses to start (rather than silently running with
broken storage).

## API overview

All endpoints are prefixed with `/api`. Protected routes require
`Authorization: Bearer <token>` from `/api/auth/login`.

| Method | Endpoint                          | Auth        | Purpose |
|--------|------------------------------------|-------------|---------|
| POST   | `/auth/register`                   | public      | Student self-registration (pending approval) |
| POST   | `/auth/login`                      | public      | Login as admin or student, returns JWT |
| GET    | `/students`                        | admin       | List all students |
| GET    | `/students/me`                     | student     | Current student's profile |
| PATCH  | `/students/:id/approve`            | admin       | Approve a pending student |
| PATCH  | `/students/:id`                    | admin       | Edit a student record |
| DELETE | `/students/:id`                    | admin       | Delete a student |
| GET    | `/admins`                          | admin       | List admins |
| POST   | `/admins`                          | admin       | Create a new admin account |
| PATCH  | `/admins/me/password`              | admin       | Change own password |
| DELETE | `/admins/:id`                      | admin       | Delete an admin (last admin protected) |
| GET    | `/courses`                         | public      | List courses |
| POST   | `/courses`                         | admin       | Create a course |
| PATCH  | `/courses/:id`                     | admin       | Edit a course |
| DELETE | `/courses/:id`                     | admin       | Delete a course |
| GET    | `/files`                           | any logged-in | List files (filter by `?courseId=&term=&folder=`) |
| POST   | `/files` (multipart, field `file`) | admin       | Upload a file with `courseId, term, folder, title` |
| PATCH  | `/files/:id/title`                 | admin       | **Edit a file's title without re-uploading** |
| GET    | `/files/:id/download`              | any logged-in | Download a file |
| DELETE | `/files/:id`                       | admin       | Delete a file |
| GET    | `/settings`                        | public      | Read portal settings incl. term start/end dates |
| PUT    | `/settings`                        | admin       | Save portal settings incl. term start/end dates |
| GET/POST/DELETE | `/schools`, `/programs`   | mixed       | School & program management |
| GET/POST/DELETE | `/tests`, `/announcements` | mixed       | Tests & announcements |
| GET/POST/PATCH  | `/payments`               | mixed       | Payment records |
| GET/POST/PATCH/DELETE | `/messages`         | mixed       | Contact Us messages (students send, admins manage) |
| GET/POST/PATCH/DELETE | `/course-requests`  | mixed       | Course enrolment requests (students request, admins approve/reject) |

### Example: login

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@zitmap.com","password":"admin123"}'
```

### Example: upload a file (admin)

```bash
curl -X POST http://localhost:4000/api/files \
  -H "Authorization: Bearer <token>" \
  -F "file=@notes.pdf" \
  -F "courseId=c0" -F "term=term1" -F "folder=notes" -F "title=Algebra Notes"
```

## Deploying online

This backend has no localStorage dependency and no local-disk database
dependency — it's a normal Node app talking to a normal Postgres database,
so it deploys the same way any Express + Postgres app does:

1. Provision a Postgres database (see "Database setup" above) and get its
   `DATABASE_URL`.
2. Push this backend to a host that runs Node — Render, Railway, Fly.io, a
   VPS (DigitalOcean/Linode/EC2), etc.
3. Set the environment variables from `.env.example` on that host
   (`DATABASE_URL`, `PGSSL=require` if the DB needs it, `JWT_SECRET` — use a
   long random value, e.g. `openssl rand -hex 32` — and your real
   `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD`).
4. Point your domain at the host and deploy.

Two things to check for a healthy production deploy:
- **File storage**: uploaded files still save to local disk
  (`backend/uploads/`). Most container-based hosts (Render, Railway,
  Heroku, etc.) do **not** guarantee that disk survives a redeploy or
  restart unless you attach a persistent volume — check your host's docs
  and enable one, or migrate `routes/files.js` to a cloud storage bucket
  (S3, R2, etc.) if you need files to survive redeploys without a volume.
- **Health check**: `GET /api/health` returns `503` if the database is
  unreachable — point your host's health check / uptime monitor at this
  endpoint so a broken DB connection gets flagged instead of silently
  serving 500s.

## Security & privacy

Everything below is implemented and was verified against a live database
and running server — not just written and assumed to work.

**Authentication & authorization**
- Passwords are hashed with bcrypt — never stored in plain text.
- Sessions are JWTs signed with `JWT_SECRET`, valid for 7 days. Set a
  long, random value in production (`openssl rand -hex 32`) — the server
  logs a warning on startup if you're still using the insecure default.
- **Server-side role enforcement.** Restricted admin roles (`Course
  Manager`, `Finance Admin`) are enforced on every matching API route, not
  just hidden in the UI:
  - `Course Manager` can only manage `schools`, `programs`, and `courses`.
  - `Finance Admin` can only manage `payments`.
  - Any other role (`Super Admin`, `Student Manager`, or a custom one) has
    full access, same as before.
  - A restricted admin's token hitting a disallowed endpoint directly
    (curl, Postman, browser dev tools — it doesn't matter how) gets a
    `403` with a clear message, regardless of what the UI shows them.
  - Every admin, regardless of role, can still change their own password
    via `PATCH /admins/me/password` — that's self-service account
    security, not a "manage admins" permission.
  - The specific role is embedded in the JWT at login (`adminRole`), so
    this check costs no extra database lookup per request. Trade-off: if
    a Super Admin changes someone's role, it takes effect the next time
    that admin logs in (up to 7 days later), not instantly — standard for
    stateless JWT auth.

**Network-level protections**
- **Rate limiting**: login is capped at 10 attempts per IP per 15 minutes;
  registration at 20 per IP per hour. Both return `429` with a clear
  message once exceeded. Every other endpoint is protected by requiring a
  valid JWT instead, which is a stronger gate than IP limiting alone.
- **CORS**: restricted to the origins listed in `ALLOWED_ORIGINS` (comma
  separated) once you set it. Unset, it's open to any origin — convenient
  for local dev, but the server logs a warning and you should set this
  before deploying.
- **Security headers** via `helmet`: HSTS, `X-Content-Type-Options:
  nosniff`, `X-Frame-Options`, and friends are set on every response.
- The app trusts the first reverse-proxy hop (`trust proxy`) so rate
  limiting sees the real client IP on hosts like Render/Railway/Heroku
  that sit behind a proxy, instead of limiting the proxy itself.

**Error handling & data exposure**
- A generic error handler catches anything that slips past individual
  route try/catch blocks — the client never sees a raw stack trace.
- Admin and student list/detail endpoints never return `password_hash`.
- Login failures return the same generic "Incorrect email or password"
  whether the email exists or not, so the endpoint can't be used to
  enumerate registered accounts.

**File uploads**
- Capped at 240MB and saved under `backend/uploads/` with sanitized
  filenames. See the "Deploying online" note above about persistent disk
  or moving to cloud storage.

**Still your responsibility at deploy time**
- Set a real `JWT_SECRET`, `DATABASE_URL`, and `ALLOWED_ORIGINS` — the
  example/default values are for local testing only.
- Change the default admin password immediately after first login.
- No automated test suite exists yet — manual verification (or writing
  tests) is on you before major changes go live.

---
© ZITMAP Tutorials. All rights reserved.
