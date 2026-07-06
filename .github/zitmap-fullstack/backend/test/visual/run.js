// Real-browser visual QA.
//
// Unlike the jsdom-based interactive tests used earlier in this project
// (which verify logic and data flow), this suite drives an ACTUAL Chrome
// browser rendering the ACTUAL CSS, at ACTUAL viewport sizes, and takes
// real screenshots — the only way to catch things like broken layouts,
// overflow, invisible elements, or a color that doesn't compute to what
// the CSS says it should.
//
// Requires: a real Postgres reachable at TEST_DATABASE_URL (or the
// default below), and the machine's real Chrome binary (auto-detected).
//
// Usage: node test/visual/run.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { Client } = require('pg');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const PORT = 4123; // distinct from the dev server's default port
const BASE_URL = `http://localhost:${PORT}`;
const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://zitmap:zitmap_dev_pw@localhost:5432/zitmap_visual';

const VIEWPORTS = {
  mobile:  { width: 390,  height: 844  }, // iPhone 12/13-class
  tablet:  { width: 834,  height: 1194 }, // iPad-class
  desktop: { width: 1440, height: 900  },
};

let failures = 0;
let checks = 0;

function assertTrue(condition, message) {
  checks++;
  if (!condition) {
    failures++;
    console.log(`  ❌ FAIL: ${message}`);
  } else {
    console.log(`  ✅ ${message}`);
  }
}

function findChrome() {
  const candidates = [
    path.join(require('os').homedir(), '.cache', 'puppeteer', 'chrome'),
    '/home/claude/.cache/puppeteer/chrome',
    '/root/.cache/puppeteer/chrome',
  ];
  for (const cacheDir of candidates) {
    if (!fs.existsSync(cacheDir)) continue;
    const versions = fs.readdirSync(cacheDir);
    for (const version of versions) {
      const chromePath = path.join(cacheDir, version, 'chrome-linux64', 'chrome');
      if (fs.existsSync(chromePath)) return chromePath;
    }
  }
  throw new Error('No cached Chrome binary found in any known location: ' + candidates.join(', '));
}

async function resetDatabase() {
  // Connect to the default 'postgres' maintenance DB to drop/recreate the
  // dedicated visual-QA database, guaranteeing a clean slate every run.
  const admin = new Client({ connectionString: DB_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  const dbName = DB_URL.split('/').pop();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName} OWNER zitmap`);
  await admin.end();
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DATABASE_URL: DB_URL,
        JWT_SECRET: 'visual_qa_secret',
        DEFAULT_ADMIN_EMAIL: 'admin@zitmap.com',
        DEFAULT_ADMIN_PASSWORD: 'admin123',
        ALLOWED_ORIGINS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); if (out.includes('Database: connected')) resolve(child); });
    child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    child.on('exit', (code) => { if (code !== null && code !== 0) reject(new Error('Server exited early with code ' + code)); });
    setTimeout(() => reject(new Error('Server did not start within 15s')), 15000);
  });
}

async function seedTestData() {
  const fetch = global.fetch;
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@zitmap.com', password: 'admin123' }),
  }).then(r => r.json());
  const token = login.token;
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const course1 = await fetch(`${BASE_URL}/api/courses`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ title: 'Mathematics', emoji: '🧮' }) }).then(r => r.json());
  await fetch(`${BASE_URL}/api/courses`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ title: 'Physics', emoji: '⚛️' }) });

  const student = await fetch(`${BASE_URL}/api/students`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Visual QA Student', email: 'visualqa@example.com', password: 'TestPass123!' }) }).then(r => r.json());
  await fetch(`${BASE_URL}/api/students/${student.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ enrolled: [course1.id] }) });

  return { token };
}

async function run() {
  console.log('=== Real-Browser Visual QA ===\n');

  console.log('Resetting visual-QA database...');
  await resetDatabase();

  console.log('Starting real backend server...');
  const server = await startServer();
  console.log('Server is up.\n');

  console.log('Seeding real test data via the real API...');
  await seedTestData();

  console.log('Launching real Chrome...');
  const chromePath = findChrome();
  console.log(`Using Chrome at: ${chromePath}\n`);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  // Every test scenario gets its OWN isolated browser context (separate
  // localStorage/cookies) — otherwise a login in one scenario (e.g. the
  // admin dashboard test) leaks into the next scenario's fresh page via
  // shared localStorage, silently skipping straight past the login form.
  async function freshPage() {
    const context = await browser.createBrowserContext();
    return context.newPage();
  }

  try {
    // ── 1. Login page at three real viewport sizes ──
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const page = await freshPage();
      await page.setViewport(viewport);
      await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
      await new Promise(r => setTimeout(r, 400));

      console.log(`--- Login page @ ${name} (${viewport.width}x${viewport.height}) ---`);
      const shot = path.join(SCREENSHOT_DIR, `01-login-${name}.png`);
      await page.screenshot({ path: shot });
      console.log(`  📸 saved ${path.relative(process.cwd(), shot)}`);

      // Real pixel/layout checks — not simulated, actually measured in the real DOM
      const card = await page.$('.auth-wrap .card');
      assertTrue(!!card, 'login card is present in the DOM');
      const box = await card.boundingBox();
      assertTrue(box && box.width > 0 && box.height > 0, 'login card has a real, non-zero rendered size');

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      assertTrue(!overflow, `no horizontal overflow at ${name} width (common responsive-design bug)`);

      const loginBtnColor = await page.evaluate(() => {
        const btn = document.querySelector('.auth-wrap .btn-primary');
        return btn ? getComputedStyle(btn).backgroundColor : null;
      });
      assertTrue(!!loginBtnColor && loginBtnColor !== 'rgba(0, 0, 0, 0)', `Login button has a real computed background color (got: ${loginBtnColor})`);

      await page.close();
    }

    // ── 2. Real admin login + dashboard screenshot ──
    {
      const page = await freshPage();
      await page.setViewport(VIEWPORTS.desktop);
      await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
      await page.type('#login-email', 'admin@zitmap.com');
      await page.type('#login-pass', 'admin123');
      await Promise.all([
        page.waitForFunction(() => document.getElementById('page-admin').classList.contains('active'), { timeout: 5000 }),
        page.click('button[onclick="doUnifiedLogin()"]'),
      ]);
      await new Promise(r => setTimeout(r, 500));

      console.log('\n--- Admin dashboard (real login) ---');
      const shot = path.join(SCREENSHOT_DIR, '02-admin-dashboard.png');
      await page.screenshot({ path: shot, fullPage: true });
      console.log(`  📸 saved ${path.relative(process.cwd(), shot)}`);

      const adminVisible = await page.evaluate(() => document.getElementById('page-admin').classList.contains('active'));
      assertTrue(adminVisible, 'admin dashboard is genuinely active after a real login click');

      // Admin navigation here is a collapsible hamburger drawer, not an
      // always-visible sidebar — verify the real interaction: click the
      // real hamburger button, confirm the drawer actually slides into
      // view with real nav items in it.
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button[onclick="openAdminDrawer()"]'));
        const visibleBtn = buttons.find(b => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (visibleBtn) visibleBtn.click();
      });
      await new Promise(r => setTimeout(r, 400));
      const drawerOpen = await page.evaluate(() => {
        const drawer = document.querySelector('.admin-drawer');
        if (!drawer) return false;
        const rect = drawer.getBoundingClientRect();
        const navItems = drawer.querySelectorAll('.nav-item');
        return rect.left >= -5 && navItems.length > 0; // slid into view (left ~0), with real nav items
      });
      assertTrue(drawerOpen, 'admin navigation drawer opens on a real click and contains real nav items');
      const drawerShot = path.join(SCREENSHOT_DIR, '02b-admin-drawer-open.png');
      await page.screenshot({ path: drawerShot });
      console.log(`  📸 saved ${path.relative(process.cwd(), drawerShot)}`);

      await page.close();
    }

    // ── 3. Real student login + dashboard buttons, at mobile size ──
    {
      const page = await freshPage();
      await page.setViewport(VIEWPORTS.mobile);
      await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
      await page.type('#login-email', 'visualqa@example.com');
      await page.type('#login-pass', 'TestPass123!');
      try {
        await page.waitForSelector('button[onclick="doUnifiedLogin()"]', { visible: true, timeout: 5000 });
        await Promise.all([
          page.waitForFunction(() => document.getElementById('page-dashboard').classList.contains('active'), { timeout: 5000 }),
          page.click('button[onclick="doUnifiedLogin()"]'),
        ]);
      } catch (clickErr) {
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'DEBUG-student-login-failure.png') });
        throw clickErr;
      }
      await new Promise(r => setTimeout(r, 600));

      console.log('\n--- Student dashboard @ mobile (real login) ---');
      const shot = path.join(SCREENSHOT_DIR, '03-student-dashboard-mobile.png');
      await page.screenshot({ path: shot, fullPage: true });
      console.log(`  📸 saved ${path.relative(process.cwd(), shot)}`);

      const myCoursesText = await page.$eval('#dash-my-courses-count', el => el.textContent).catch(() => null);
      assertTrue(myCoursesText === '1 enrolled', `My Courses button shows real live count (got: "${myCoursesText}")`);

      const availText = await page.$eval('#dash-available-courses-count', el => el.textContent).catch(() => null);
      assertTrue(availText === '1 available', `Available Courses button shows real live count (got: "${availText}")`);

      const btnOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      assertTrue(!btnOverflow, 'no horizontal overflow on the student dashboard at mobile width');

      // ── 4. Click into Available Courses — real click, real navigation ──
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.dash-course-nav-btn')).find(b => b.textContent.includes('Available Courses'));
        btn.click();
      });
      await new Promise(r => setTimeout(r, 400));

      console.log('\n--- Available Courses panel @ mobile (real click) ---');
      const shot2 = path.join(SCREENSHOT_DIR, '04-available-courses-mobile.png');
      await page.screenshot({ path: shot2, fullPage: true });
      console.log(`  📸 saved ${path.relative(process.cwd(), shot2)}`);

      // Real computed-style check on the green "enrolled" marking
      const enrolledCardStyle = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#available-courses-grid .course-card'));
        const enrolledCard = cards.find(c => c.textContent.includes('Mathematics'));
        if (!enrolledCard) return null;
        const style = getComputedStyle(enrolledCard);
        return { borderColor: style.borderColor, background: style.backgroundColor };
      });
      assertTrue(!!enrolledCardStyle, 'the enrolled course card (Mathematics) is present');
      assertTrue(
        !!enrolledCardStyle && enrolledCardStyle.borderColor === 'rgb(63, 174, 88)',
        `enrolled course card's REAL computed border color is the correct green (got: ${enrolledCardStyle && enrolledCardStyle.borderColor})`
      );

      const unenrolledCardStyle = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#available-courses-grid .course-card'));
        const card = cards.find(c => c.textContent.includes('Physics'));
        return card ? getComputedStyle(card).borderColor : null;
      });
      assertTrue(
        unenrolledCardStyle !== 'rgb(63, 174, 88)',
        `unenrolled course card's border is genuinely NOT marked green (got: ${unenrolledCardStyle})`
      );

      await page.close();
    }

    // ── 5. Real register page render check ──
    {
      const page = await freshPage();
      await page.setViewport(VIEWPORTS.desktop);
      await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
      await page.click("button[onclick=\"showPage('page-register')\"]");
      await new Promise(r => setTimeout(r, 300));

      console.log('\n--- Register page (real click to navigate) ---');
      const shot = path.join(SCREENSHOT_DIR, '05-register.png');
      await page.screenshot({ path: shot });
      console.log(`  📸 saved ${path.relative(process.cwd(), shot)}`);

      const registerVisible = await page.evaluate(() => document.getElementById('page-register').classList.contains('active'));
      assertTrue(registerVisible, 'register page is genuinely active after a real click');

      await page.close();
    }

  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n=== ${checks - failures}/${checks} checks passed ===`);
  if (failures > 0) {
    console.log(`❌ ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('✅ All real-browser visual QA checks passed.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Visual QA run crashed:', err);
  process.exit(1);
});
