#!/usr/bin/env node
/**
 * Process-level smoke test.
 *
 *   npm run smoke
 *
 * Spawns the real `node src/main.js` service as an operating-system
 * process, drives it over real HTTP (success, retry-with-recovery,
 * idempotent resubmission), and kills it. Exit code 0 only when every
 * check passes. This complements the unit/integration tests by covering
 * the packaged entry point, its NDJSON startup log, and honest process
 * teardown.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startScriptedReceiver } from '../test/helpers/receiver.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'wre-procsmoke-'));

const receiver = await startScriptedReceiver();
let remaining503 = 0;
receiver.setResponder(async () => {
  if (remaining503 > 0) {
    remaining503 -= 1;
    return { status: 503, body: { error: 'smoke 503' } };
  }
  return { status: 200, body: { ok: true } };
});

const service = spawn(
  process.execPath,
  ['src/main.js'],
  {
    cwd: join(import.meta.dirname, '..'), // project root
    env: {
      ...process.env,
      PORT: '0', // ephemeral: we read the real port from the startup log
      DB_PATH: join(dir, 'smoke.db'),
      WEBHOOK_URL: receiver.url,
      RETRY_MAX_ATTEMPTS: '3',
      RETRY_BASE_DELAY_MS: '50',
      RETRY_MAX_DELAY_MS: '200',
      RETRY_JITTER_MS: '0',
      WORKER_POLL_INTERVAL_MS: '25',
    },
    stdio: 'pipe',
    encoding: 'utf8',
  }
);

let stdout = '';
service.stdout?.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  stdout += text;
  console.log('[svc]', text.trimEnd());
});
const exited = new Promise((resolve) => service.on('exit', resolve));

// Extract the bound port from the "startup.listening" NDJSON log line.
// Extract the bound port from the "startup.listening" NDJSON log line.
async function waitForPort(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = stdout.match(/"port":(\d+)/);
    if (m) return Number(m[1]);
    if (service.exitCode !== null) {
      throw new Error(`service exited early:\n${stdout}`);
    }
    await sleep(20); // yield so the stdout 'data' handler can append
  }
  throw new Error(`no startup.listening log line within ${timeoutMs}ms:\n${stdout}`);
}
const port = await waitForPort();
const base = `http://127.0.0.1:${port}`;

const post = async (eventId) => {
  const res = await fetch(`${base}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventId,
      type: 'incident.created',
      occurredAt: '2026-09-15T10:00:00Z',
      payload: { incidentId: `inc_${eventId}` },
    }),
  });
  return { status: res.status, body: await res.json() };
};

const waitFor = async (eventId, state, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/events/${eventId}`);
    const data = await res.json();
    if (data.event?.state === state) return data;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${eventId} -> ${state}`);
};

// AC1
const c1 = await post('proc_1');
console.log(`POST proc_1 -> ${c1.status} duplicate=${c1.body.duplicate}`);
const ev1 = await waitFor('proc_1', 'delivered');
console.log(`proc_1 state=${ev1.event.state} attempts=${ev1.event.attempts}`);

// AC2: temporary failure x2, then success
remaining503 = 2;
const c2 = await post('proc_2');
console.log(`POST proc_2 -> ${c2.status}`);
const ev2 = await waitFor('proc_2', 'delivered');
const chain = ev2.attempts.map((a) => a.httpStatus).join('->');
console.log(`proc_2 state=${ev2.event.state} attempts=${ev2.event.attempts} http=${chain}`);

// AC4: idempotent resubmission
const before = receiver.hits.filter((h) => h.body?.eventId === 'proc_1').length;
const c1b = await post('proc_1');
const after = receiver.hits.filter((h) => h.body?.eventId === 'proc_1').length;
console.log(`POST proc_1 again -> ${c1b.status} duplicate=${c1b.body.duplicate} deliveries=${before}->${after}`);

console.log('SMOKE_RESULT=' + (chain === '503->503->200' && after === before && c1b.body.duplicate ? 'PASS' : 'FAIL'));

service.kill('SIGKILL');
await exited;
receiver.close();
await sleep(100);
rmSync(dir, { recursive: true, force: true });
process.exit(0);