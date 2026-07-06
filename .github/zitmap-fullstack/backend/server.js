const app = require('./app');
const db = require('./db/database');

const PORT = process.env.PORT || 4000;

// ── Crash resilience ──
// Without these handlers, a single unexpected error anywhere in the app
// (a rejected promise nobody awaited, a genuinely unforeseen exception)
// would either crash the process with no useful log, or — worse under
// older Node defaults — leave it running in a silently corrupted state.
// We log clearly either way. For a truly uncaught exception we exit
// deliberately: continuing to serve requests after the process has hit
// a state nobody coded for is riskier than a clean restart, and every
// real host (Render, Railway, PM2, systemd, Docker) is already set up to
// restart the process automatically when it exits.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (process continues running):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('FATAL: uncaught exception. Exiting so the host can restart the process cleanly.');
  console.error(err);
  process.exit(1);
});

// Create tables (if they don't exist yet) and seed the default admin
// account BEFORE accepting any traffic, so the very first request never
// races against an empty/half-initialized database.
(async () => {
  try {
    await db.initDb();
    const server = app.listen(PORT, () => {
      console.log(`ZITMAP Tutorials backend running at http://localhost:${PORT}`);
      console.log(`Database: connected (PostgreSQL)`);
    });

    // ── Graceful shutdown ──
    // Render, Railway, and most container hosts send SIGTERM before
    // killing a process during a redeploy or scale-down — this is what
    // makes a deploy "zero-downtime" instead of dropping in-flight
    // requests. Stop accepting new connections, let in-flight requests
    // finish, close the database pool cleanly, then exit.
    function shutdown(signal) {
      console.log(`\n${signal} received: shutting down gracefully...`);
      server.close(async () => {
        console.log('HTTP server closed (no longer accepting new connections).');
        try {
          await db.pool.end();
          console.log('Database pool closed.');
        } catch (err) {
          console.error('Error while closing the database pool:', err);
        }
        process.exit(0);
      });
      // Safety net: if something keeps an in-flight request open forever,
      // don't hang the shutdown indefinitely.
      setTimeout(() => {
        console.error('Shutdown timed out after 10s — forcing exit.');
        process.exit(1);
      }, 10000).unref();
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('FATAL: could not initialize the database. The server was not started.');
    console.error(err);
    process.exit(1);
  }
})();
