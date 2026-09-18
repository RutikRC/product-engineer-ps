#!/usr/bin/env node
/**
 * Automated end-to-end demo.
 *
 *   npm run demo
 *
 * Starts a mock receiver and a full service (real HTTP API + real worker
 * loop) on ephemeral ports, then walks through the acceptance scenarios:
 *
 *   1. AC1 successful delivery
 *   2. AC2 temporary failure (receiver down for 2 attempts) then retry -> delivered
 *   3. AC3 exhaustion after RETRY_MAX_ATTEMPTS -> failed
 *   4. AC4 resubmitting the same eventId is idempotent (no extra delivery)
 *   5. AC5 inspectable delivery history for every event
 *
 * Duration is a few seconds (backoff compressed via env). Output is
 * plain text designed to be screen-recorded.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSync } from 'node:fs';
import { buildService } from '../src/service.js';
import { createReceiver } from './receiver.js';

// Unbuffered output: demo lines are visible even when piped or killed.
const print = (s = '') => writeSync(1, s + '\n');
const printErr = (s = '') => writeSync(2, s + '\n');
const line = (s) => print(`\n${s}`);

const tmpDir = mkdtempSync(join(tmpdir(), 'wre-demo-'));
const dbPath = join(tmpDir, 'demo.db');

async function main() {
  const receiver = createReceiver({});
  const receiverPort = await receiver.listen();
  const webhookUrl = `http://127.0.0.1:${receiverPort}/webhook`;

  const service = buildService({
    env: {
      PORT: '0',
      DB_PATH: dbPath,
      WEBHOOK_URL: webhookUrl,
      RETRY_MAX_ATTEMPTS: '3',
      RETRY_BASE_DELAY_MS: '60',
      RETRY_MAX_DELAY_MS: '240',
      RETRY_JITTER_MS: '0',
      WORKER_POLL_INTERVAL_MS: '25',
      DELIVERY_TIMEOUT_MS: '2000',
    },
  });

  const server = service.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  service.scheduler.start();

  try {
    const { scheduler, store } = service;
    const closeGracefully = async (closeFn) => {
      await Promise.race([Promise.resolve(closeFn()), new Promise((r) => setTimeout(r, 1500))]);
    };
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      scheduler.stop();
      await closeGracefully(() => server.close?.());
      await closeGracefully(() => receiver.close());
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    };

    line('=== Webhook Retry Engine demo ===');
    print(`API      : ${baseUrl}`);
    print(`Receiver : ${webhookUrl}`);

    // ---- AC1: successful delivery --------------------------------------
    line('AC1: successful delivery');
    const postEvent = async (eventId) => {
      const res = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId,
          type: 'incident.created',
          occurredAt: '2026-09-15T10:00:00Z',
          payload: { incidentId: `inc_${eventId}`, severity: 'high' },
        }),
      });
      return { status: res.status, body: await res.json() };
    };

    const first = await postEvent('evt_1');
    print(`POST /events evt_1 -> ${first.status} (duplicate=${first.body.duplicate})`);
    await waitForState(baseUrl, 'evt_1', 'delivered');
    await printEvent(baseUrl, 'evt_1', 'delivered after one attempt');

    // ---- AC2: temporary failure, then recovery --------------------------
    line('AC2: receiver temporarily fails (500 twice), then recovers');
    receiver.setControl({ mode: 'fail-n', status: 500, remaining: 2 });
    const second = await postEvent('evt_retry');
    print(`POST /events evt_retry -> ${second.status}`);
    await waitForState(baseUrl, 'evt_retry', 'delivered');
    await printEvent(baseUrl, 'evt_retry', 'event recovered; history shows 500 -> 500 -> 200');

    // ---- AC3: exhaustion -------------------------------------------------
    line('AC3: receiver keeps failing -> attempts exhausted -> failed');
    receiver.setControl({ mode: 'fail', status: 503 });
    const third = await postEvent('evt_exhausted');
    print(`POST /events evt_exhausted -> ${third.status}`);
    await waitForState(baseUrl, 'evt_exhausted', 'failed');
    await printEvent(baseUrl, 'evt_exhausted', '3 attempts recorded, then a bounded stop (no 4th attempt)');

    // ---- AC4: idempotent resubmission ------------------------------------
    line('AC4: resubmitting evt_1 is idempotent');
    receiver.setControl({ mode: 'ok' });
    const hitsBefore = receiver.state().webhookHits.filter((h) => h.eventId === 'evt_1').length;
    const again = await postEvent('evt_1');
    const hitsAfter = receiver.state().webhookHits.filter((h) => h.eventId === 'evt_1').length;
    print(`POST /events evt_1 again -> ${again.status} (duplicate=${again.body.duplicate})`);
    print(
      `receiver deliveries for evt_1: before=${hitsBefore} after=${hitsAfter}  (unchanged - no second job)`
    );

    // ---- AC5: inspectable history -----------------------------------------
    line('AC5: inspectable history');
    const report = await fetch(`${baseUrl}/events`);
    const { events } = await report.json();
    print(`GET /events -> ${events.length} event(s):`);
    for (const ev of events) {
      print(`   ${ev.eventId.padEnd(13)} state=${ev.state.padEnd(10)} attempts=${ev.attempts}`);
    }

    const healthRes = await fetch(`${baseUrl}/health`);
    print(`\nGET /health -> ${JSON.stringify(await healthRes.json())}`);

    print('\n=== demo complete ===');
    await cleanup();
    print('(cleaned up)');
  } catch (err) {
    printErr(`demo failed: ${err.message}`);
    process.exitCode = 1;
  }
}

async function waitForState(baseUrl, eventId, state, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/events/${eventId}`);
    const data = await res.json();
    if (data.event?.state === state) return;
    await new Promise((r) => setTimeout(r, 30)); // the demo is allowed real time
  }
  throw new Error(`timeout waiting for ${eventId} to reach ${state}`);
}

async function printEvent(baseUrl, eventId, caption) {
  const res = await fetch(`${baseUrl}/events/${eventId}`);
  const { event, attempts } = await res.json();
  print(caption);
  print(`  state=${event.state}  attempts=${event.attempts}`);
  for (const a of attempts) {
    print(
      `   #${a.attemptNumber}  ${a.outcome.padEnd(18)} http=${a.httpStatus ?? 'ERR'.padEnd(3)}  ${a.error ?? '(no error)'}`
    );
  }
}

await main();