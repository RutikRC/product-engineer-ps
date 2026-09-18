#!/usr/bin/env node
/**
 * Main entry point.
 *
 *   npm start            (reads env: PORT, DB_PATH, WEBHOOK_URL, retry knobs)
 *
 * On startup:
 *   1. opens the SQLite store,
 *   2. requeues any event left in 'delivering' by a previous process
 *      (crash recovery - at-least-once semantics),
 *   3. starts the delivery worker,
 *   4. serves the ingestion/inspection API until SIGINT/SIGTERM.
 */

import { buildService } from './service.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { log, store, scheduler, app, clock } = buildService({ config });

// --- crash recovery -----------------------------------------------------
const requeued = store.requeueStuckDelivering(clock.now());
if (requeued > 0) {
  log('warn', 'startup.requeued', {
    count: requeued,
    message: 'events left in "delivering" by a previous process were requeued as pending',
  });
}

if (!config.webhookUrl) {
  log('warn', 'startup.no_webhook_url', {
    message: 'WEBHOOK_URL is not set: events will be accepted but a worker without it will not deliver.',
  });
}

scheduler.start();

const server = app.listen(config.port, () => {
  log('info', 'startup.listening', {
    port: server.address().port,
    dbPath: config.dbPath,
    webhookUrl: config.webhookUrl,
  });
});

server.on('error', (err) => {
  log('error', 'startup.listen_failed', { error: err.message });
  process.exit(1);
});

function shutdown(signal) {
  log('info', 'shutdown.start', { signal });
  scheduler.stop();
  server.close(() => {
    store.close();
    log('info', 'shutdown.complete');
    process.exit(0);
  });
  // Force-exit if the server refuses to drain after a generous grace period.
  setTimeout(() => process.exit(0), 5000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled_rejection', { error: reason?.message ?? String(reason) });
});