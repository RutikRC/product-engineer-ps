import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createTestkit } from './helpers/testkit.js';
import { startScriptedReceiver, statusResponder } from './helpers/receiver.js';

const makeIncident = (eventId) => ({
  eventId,
  type: 'incident.created',
  occurredAt: '2026-09-15T10:00:00Z',
  payload: { incidentId: `inc_${eventId}`, severity: 'high' },
});

/**
 * Deterministic, strictly ordered teardown.
 *
 * Windows libuv aborts if a directory/file is removed while the SQLite
 * store (or its -wal/-shm siblings) is still open, so every cleanup step
 * is awaited in order: receiver -> store -> directory removal.
 */
function registerCleanup(t, ...steps) {
  let done = false;
  t.after(async () => {
    if (done) return;
    done = true;
    for (const step of steps) {
      try {
        await step();
      } catch {
        // best-effort cleanup; never mask the test result
      }
    }
  });
}

const removeDir = (dir) => () => rmSync(dir, { recursive: true, force: true });

test('accepted events survive a restart and are delivered by the new process', async (t) => {
  const kit1 = createTestkit();
  const eventId = 'evt_persist';
  kit1.store.ingest(makeIncident(eventId));
  const dbPath = kit1.config.dbPath;

  // Simulate process exit: close the store; the DB file stays on disk.
  const storedBefore = kit1.store.getEvent(eventId);
  assert.equal(storedBefore.state, 'pending');
  kit1.store.close();

  // Reopen the same database file in a new service instance (restart).
  const restartedKit = createTestkit({ configOverrides: { dbPath } });
  const receiver = await startScriptedReceiver(statusResponder(200));
  restartedKit.service.config.webhookUrl = receiver.url;
  registerCleanup(
    t,
    () => receiver.close(),
    () => restartedKit.close(), // closes its store first, then removes its own dir
    () => removeDir(kit1.dir)()
  );

  const storedAfter = restartedKit.store.getEvent(eventId);
  assert.equal(storedAfter.eventId, eventId, 'event still present after restart');
  assert.equal(storedAfter.state, 'pending');

  const results = await restartedKit.service.scheduler.processDue();
  assert.equal(results.length, 1);
  assert.equal(restartedKit.store.getEvent(eventId).state, 'delivered');
  assert.equal(receiver.hits.length, 1);
  assert.equal(restartedKit.store.getEventWithAttempts(eventId).attempts[0].attemptNumber, 1);
});

test('startup sweep requeues events stuck in "delivering" by a crashed process', async (t) => {
  const kit = createTestkit();
  const receiver = await startScriptedReceiver(statusResponder(200));
  registerCleanup(t, () => receiver.close(), () => kit.close());

  kit.store.ingest(makeIncident('evt_stuck'));

  // Simulate a crash mid-delivery: the worker claimed the event
  // (state -> delivering) but the process died before recording anything.
  const claimed = kit.store.claimForDelivery('evt_stuck', kit.clock.now());
  assert.ok(claimed, 'the worker claimed the event');
  assert.equal(kit.store.getEvent('evt_stuck').state, 'delivering');
  assert.equal(kit.store.getEvent('evt_stuck').attempts, 0);

  // The next process start requeues stuck deliveries...
  const requeued = kit.store.requeueStuckDelivering(kit.clock.now());
  assert.equal(requeued, 1);
  assert.equal(kit.store.getEvent('evt_stuck').state, 'pending');

  // ...and the new worker can deliver normally afterwards.
  kit.service.config.webhookUrl = receiver.url;
  await kit.service.scheduler.processDue();
  assert.equal(kit.store.getEvent('evt_stuck').state, 'delivered');
  assert.equal(receiver.hits.length, 1, 'a single delivery after recovery');
});

test('attempt history and attempt counts are preserved across a restart', async (t) => {
  const kit1 = createTestkit();
  const dbPath = kit1.config.dbPath;

  // One failed attempt, then close (crash).
  const failing = await startScriptedReceiver(statusResponder(500));
  kit1.service.config.webhookUrl = failing.url;
  kit1.store.ingest(makeIncident('evt_history'));
  await kit1.service.scheduler.processDue();
  assert.equal(kit1.store.getEvent('evt_history').attempts, 1);
  await failing.close();
  kit1.store.close();

  // Restart against the recovered endpoint; history must be intact.
  const restarted = createTestkit({ configOverrides: { dbPath } });
  const ok = await startScriptedReceiver(statusResponder(200));
  restarted.service.config.webhookUrl = ok.url;
  registerCleanup(
    t,
    () => ok.close(),
    () => restarted.close(),
    () => removeDir(kit1.dir)()
  );

  restarted.clock.advance(1000);
  await restarted.service.scheduler.processDue();
  const data = restarted.store.getEventWithAttempts('evt_history');
  assert.equal(data.event.attempts, 2);
  assert.deepEqual(data.attempts.map((a) => a.httpStatus), [500, 200]);
  assert.equal(data.event.state, 'delivered');
});