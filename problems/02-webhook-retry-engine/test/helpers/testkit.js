/**
 * Test helper: build a fully-wired service in an isolated temp directory.
 *
 * Uses fakeClock for deterministic time and a quiet logger; the store is
 * configured for the same values the module ships with unless overridden,
 * so tests assert against real backoff values without any sleeping.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildService } from '../../src/service.js';
import { fakeClock } from '../../src/clock.js';

export function createTestkit({ configOverrides = {} } = {}) {
  const clock = fakeClock();
  const dir = mkdtempSync(join(tmpdir(), 'wre-test-'));
  const config = {
    dbPath: join(dir, 'test.db'),
    webhookUrl: null, // tests point the worker at their receiver
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    multiplier: 2,
    jitterMs: 0, // deterministic backoff
    deliveryTimeoutMs: 2000,
    attemptBodyMaxBytes: 512,
    pollIntervalMs: 5,
    batchSize: 25,
    followRedirects: false,
    ...configOverrides,
  };
  const quietLog = () => {};
  const service = buildService({ config, clock, log: quietLog });

  return {
    // The service's own members (store, scheduler, app, transport, ...)
    // are exposed directly on the kit for readable tests.
    ...service,
    service,
    clock,
    config,
    dir,
    /**
     * Bind the Express app to an ephemeral port and return a base URL.
     */
    async listenApi() {
      const server = service.app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      return {
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        async close() {
        // Responses already use connection: close, so a plain graceful
        // server.close() resolves promptly. Never stack it with
        // closeIdleConnections(): double-closing sockets triggers a
        // libuv assertion on Windows.
        server.close();
      },
      };
    },
    close() {
      try {
        service.store.close();
      } catch {
        // already closed
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}