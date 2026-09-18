/**
 * Composition root.
 *
 * Wires configuration, clock, logger, store, transport, scheduler and
 * HTTP API into one service object. Production (src/main.js), the
 * automated demo, and the tests all build services through here, passing
 * overrides where they need different behaviour (fake clock, scripted
 * receiver, in-memory database, ...).
 */

import { loadConfig } from './config.js';
import { realClock } from './clock.js';
import { createLogger } from './log.js';
import { createStore } from './store.js';
import { createHttpTransport } from './transport.js';
import { createScheduler } from './scheduler.js';
import { createApi } from './api.js';

export function buildService(overrides = {}) {
  const config = overrides.config ?? loadConfig(overrides.env ?? process.env);
  const clock = overrides.clock ?? realClock;
  const log = overrides.log ?? createLogger('engine');
  const store = overrides.store ?? createStore({ dbPath: config.dbPath, now: clock.now });
  const transport =
    overrides.transport ??
    createHttpTransport({
      timeoutMs: config.deliveryTimeoutMs,
      maxBodyBytes: config.attemptBodyMaxBytes,
      followRedirects: config.followRedirects,
    });
  const scheduler = createScheduler({ store, transport, config, clock, log });
  const app = createApi({ store, scheduler, config, clock, log });

  return { config, clock, log, store, transport, scheduler, app };
}