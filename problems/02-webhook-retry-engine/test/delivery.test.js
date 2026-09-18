import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestkit } from './helpers/testkit.js';
import {
  startScriptedReceiver,
  statusResponder,
  sequenceResponder,
  detailedResponder,
} from './helpers/receiver.js';
import { createScheduler } from '../src/scheduler.js';

const makeIncident = (eventId) => ({
  eventId,
  type: 'incident.created',
  occurredAt: '2026-09-15T10:00:00Z',
  payload: { incidentId: `inc_${eventId}`, severity: 'high' },
});

/** Kit + receiver wired together and auto-cleaned on test exit. */
async function kitWithReceiver(t, { responder, configOverrides } = {}) {
  const kit = createTestkit({ configOverrides });
  const receiver = await startScriptedReceiver(responder);
  kit.service.config.webhookUrl = receiver.url;
  t.after(() => {
    receiver.close();
    kit.close();
  });
  return { kit, receiver };
}

test('AC1: a valid event is delivered once and marked delivered with one attempt', async (t) => {
  const { kit, receiver } = await kitWithReceiver(t);

  const { event, inserted } = kit.store.ingest(makeIncident('evt_1'));
  assert.equal(inserted, true);
  assert.equal(event.state, 'pending');
  assert.equal(event.attempts, 0);

  const results = await kit.service.scheduler.processDue();
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'success');

  const after = kit.store.getEventWithAttempts('evt_1');
  assert.equal(after.event.state, 'delivered');
  assert.equal(after.event.nextAttemptAt, null);
  assert.equal(after.attempts.length, 1);
  assert.equal(after.attempts[0].attemptNumber, 1);
  assert.equal(after.attempts[0].outcome, 'success');
  assert.equal(after.attempts[0].httpStatus, 200);
  assert.ok(after.attempts[0].startedAt <= after.attempts[0].finishedAt);

  // The receiver saw the exact contract plus an idempotency key.
  assert.equal(receiver.hits.length, 1);
  assert.equal(receiver.hits[0].body.eventId, 'evt_1');
  assert.deepEqual(receiver.hits[0].body.payload, { incidentId: 'inc_evt_1', severity: 'high' });
  assert.equal(receiver.hits[0].idempotencyKey, 'evt_1');
});

test('AC2: a temporary 500 is recorded, the backoff is scheduled, and the retry succeeds', async (t) => {
  const { kit } = await kitWithReceiver(t, { responder: sequenceResponder([500, 200]) });

  kit.store.ingest(makeIncident('evt_retry'));

  await kit.service.scheduler.processDue();
  let ev = kit.store.getEvent('evt_retry');
  assert.equal(ev.state, 'pending', 'retryable failure keeps the event pending');
  assert.equal(ev.attempts, 1);
  assert.equal(
    ev.nextAttemptAt,
    new Date(kit.clock.now() + 1000).toISOString(),
    'next attempt scheduled at now + baseDelayMs (no jitter)'
  );

  // Not due yet: an immediate sweep must not deliver.
  const early = await kit.service.scheduler.processDue();
  assert.equal(early.length, 0);

  kit.clock.advance(1000);
  const results = await kit.service.scheduler.processDue();
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'success');

  const after = kit.store.getEventWithAttempts('evt_retry');
  assert.equal(after.event.state, 'delivered');
  assert.deepEqual(after.attempts.map((a) => a.attemptNumber), [1, 2]);
  assert.deepEqual(after.attempts.map((a) => a.httpStatus), [500, 200]);
  assert.deepEqual(after.attempts.map((a) => a.outcome), ['retryable_failure', 'success']);
  assert.match(after.attempts[0].error, /HTTP 500/);
});

test('AC3: repeated failures exhaust the attempt limit and delivery stops forever', async (t) => {
  const { kit, receiver } = await kitWithReceiver(t, { responder: statusResponder(500) });

  kit.store.ingest(makeIncident('evt_exhausted'));

  // attempt 1
  await kit.service.scheduler.processDue();
  assert.equal(kit.store.getEvent('evt_exhausted').attempts, 1);
  // attempt 2 (delay before attempt 2 = base = 1000)
  kit.clock.advance(1000);
  await kit.service.scheduler.processDue();
  assert.equal(kit.store.getEvent('evt_exhausted').attempts, 2);
  // attempt 3 (delay before attempt 3 = 2000)
  kit.clock.advance(2000);
  await kit.service.scheduler.processDue();

  const after = kit.store.getEventWithAttempts('evt_exhausted');
  assert.equal(after.event.state, 'failed');
  assert.equal(after.event.attempts, 3, 'maxAttempts=3');
  assert.equal(after.event.nextAttemptAt, null);
  assert.deepEqual(after.attempts.map((a) => a.outcome), [
    'retryable_failure',
    'retryable_failure',
    'retryable_failure',
  ]);

  const hitCount = receiver.hits.length;
  // No matter how much time passes, nothing is retried after exhaustion.
  kit.clock.advance(60_000);
  const again = await kit.service.scheduler.processDue();
  assert.equal(again.length, 0);
  assert.equal(receiver.hits.length, hitCount, 'no 4th attempt');
});

test('permanent failures (400) stop immediately and are never retried', async (t) => {
  const { kit, receiver } = await kitWithReceiver(t, { responder: statusResponder(400) });

  kit.store.ingest(makeIncident('evt_bad'));

  const results = await kit.service.scheduler.processDue();
  assert.equal(results[0].outcome, 'permanent_failure');

  const after = kit.store.getEventWithAttempts('evt_bad');
  assert.equal(after.event.state, 'failed');
  assert.equal(after.attempts.length, 1);
  assert.equal(after.attempts[0].httpStatus, 400);

  kit.clock.advance(10_000);
  await kit.service.scheduler.processDue();
  assert.equal(receiver.hits.length, 1, 'no retry for a permanent failure');
});

test('a retryable 429 with Retry-After defers the next attempt past the header', async (t) => {
  // First request: 429 with Retry-After: 3; later requests succeed.
  const raAfter429 = (() => {
    let calls = 0;
    return async () => {
      calls += 1;
      if (calls === 1) {
        return { status: 429, headers: { 'retry-after': '3' }, body: { error: 'mock 429' } };
      }
      return { status: 200, body: { ok: true } };
    };
  })();

  const { kit, receiver } = await kitWithReceiver(t, { responder: raAfter429 });

  kit.store.ingest(makeIncident('evt_ra'));

  await kit.service.scheduler.processDue();
  const ev = kit.store.getEvent('evt_ra');
  assert.equal(ev.state, 'pending');
  assert.equal(
    ev.nextAttemptAt,
    new Date(kit.clock.now() + 3000).toISOString(),
    'Retry-After (3s) beats the 1s backoff'
  );

  kit.clock.advance(1000);
  assert.equal((await kit.service.scheduler.processDue()).length, 0, 'still waiting per Retry-After');
  kit.clock.advance(2000);
  const retried = await kit.service.scheduler.processDue();
  assert.equal(retried.length, 1, 'due after Retry-After expires');
  assert.equal(retried[0].outcome, 'success');
  assert.equal(receiver.hits.length, 2, 'one 429 attempt + one successful retry');
  assert.equal(kit.store.getEvent('evt_ra').state, 'delivered');
});

test('network errors are retryable and the event recovers once the endpoint is reachable', async (t) => {
  // A receiver that accepts the TCP connection and then destroys it, which
  // the client observes as a network error (no HTTP response at all).
  // Deterministic: no reliance on a "free" port (racy under parallel runs).
  const deadEndpoint = await startScriptedReceiver(async () => ({ destroy: true }));
  const kit = createTestkit();
  const receiver = await startScriptedReceiver(statusResponder(200));
  t.after(() => {
    deadEndpoint.close();
    receiver.close();
    kit.close();
  });

  kit.service.config.webhookUrl = deadEndpoint.url;
  kit.store.ingest(makeIncident('evt_net'));

  const results = await kit.service.scheduler.processDue();
  assert.equal(results[0].outcome, 'retryable_failure');

  const ev = kit.store.getEvent('evt_net');
  assert.equal(ev.state, 'pending');
  assert.equal(ev.lastHttpStatus, null, 'no HTTP status for a network error');
  assert.ok(/network error/i.test(ev.lastError), `lastError mentions network: ${ev.lastError}`);

  // Endpoint comes back: the next scheduled attempt succeeds.
  kit.service.config.webhookUrl = receiver.url;
  kit.clock.advance(1000);
  const recovered = await kit.service.scheduler.processDue();
  assert.equal(recovered.length, 1);
  assert.equal(kit.store.getEvent('evt_net').state, 'delivered');
});

test('two workers can never deliver the same event twice (atomic claim)', async (t) => {
  const { kit, receiver } = await kitWithReceiver(t);

  const second = createScheduler({
    store: kit.store,
    transport: kit.service.transport,
    config: kit.config,
    clock: kit.clock,
    log: () => {},
  });

  kit.store.ingest(makeIncident('evt_race'));
  await Promise.all([kit.service.scheduler.processDue(), second.processDue()]);

  assert.equal(receiver.hits.length, 1, 'exactly one delivery despite two competing workers');
  assert.equal(kit.store.getEvent('evt_race').state, 'delivered');
});

test('a worker without a webhook URL does not claim or burn attempts', async (t) => {
  const kit = createTestkit(); // config.webhookUrl stays null
  t.after(() => kit.close());

  const event = kit.store.ingest(makeIncident('evt_nowhere')).event;
  const results = await kit.service.scheduler.processDue();

  assert.equal(results.length, 0);
  const ev = kit.store.getEvent(event.eventId);
  assert.equal(ev.state, 'pending');
  assert.equal(ev.attempts, 0);
});