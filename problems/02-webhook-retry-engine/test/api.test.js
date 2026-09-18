import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestkit } from './helpers/testkit.js';
import { startScriptedReceiver, sequenceResponder } from './helpers/receiver.js';

async function startApi(t, responder) {
  const kit = createTestkit();
  const receiver = await startScriptedReceiver(responder);
  kit.service.config.webhookUrl = receiver.url;
  const { server, baseUrl } = await kit.listenApi();
  t.after(() => {
    server.close();
    receiver.close();
    kit.close();
  });
  return { kit, receiver, baseUrl };
}

const post = (baseUrl, body) =>
  fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('AC5: GET /events/:eventId exposes state and ordered attempt history', async (t) => {
  const { kit, baseUrl } = await startApi(t, sequenceResponder([500, 200]));

  const created = await (await post(baseUrl, {
    eventId: 'evt_h1',
    type: 'incident.created',
    occurredAt: '2026-09-15T10:00:00Z',
    payload: { incidentId: 'inc_h1', severity: 'high' },
  })).json();
  assert.equal(created.duplicate, false);

  // Attempt 1 fails...
  await kit.service.scheduler.processDue();
  const mid = await (await fetch(`${baseUrl}/events/evt_h1`)).json();
  assert.equal(mid.event.state, 'pending');
  assert.equal(mid.event.attempts, 1);
  assert.equal(mid.attempts.length, 1);
  assert.equal(mid.attempts[0].attemptNumber, 1);

  // ...retry succeeds after the backoff elapses.
  kit.clock.advance(1000);
  await kit.service.scheduler.processDue();

  const final = await (await fetch(`${baseUrl}/events/evt_h1`)).json();
  assert.equal(final.event.state, 'delivered');
  assert.equal(final.event.attempts, 2);
  assert.deepEqual(final.attempts.map((a) => a.attemptNumber), [1, 2]);
  assert.deepEqual(final.attempts.map((a) => a.httpStatus), [500, 200]);
  assert.deepEqual(final.attempts.map((a) => a.outcome), ['retryable_failure', 'success']);
  for (const a of final.attempts) {
    assert.ok(typeof a.startedAt === 'string' && typeof a.finishedAt === 'string');
    assert.ok(a.startedAt <= a.finishedAt, 'startedAt <= finishedAt');
  }
});

test('GET /events lists events with attempt counts and supports a state filter', async (t) => {
  const { kit, baseUrl } = await startApi(t);

  await post(baseUrl, { eventId: 'evt_a', type: 't', occurredAt: '2026-09-15T10:00:00Z', payload: null });
  await post(baseUrl, { eventId: 'evt_b', type: 't', occurredAt: '2026-09-15T10:00:00Z', payload: null });
  await kit.service.scheduler.processDue();

  const all = await (await fetch(`${baseUrl}/events`)).json();
  assert.equal(all.events.length, 2);
  const delivered = all.events.filter((e) => e.state === 'delivered');
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].attemptCount, 1);

  const pending = await (await fetch(`${baseUrl}/events?state=pending`)).json();
  assert.equal(pending.events.length, 0);

  const invalid = await fetch(`${baseUrl}/events?state=bogus`);
  assert.equal(invalid.status, 400);
});

test('GET /events/:unknown and unknown routes return structured 404s', async (t) => {
  const { baseUrl } = await startApi(t);

  const missing = await fetch(`${baseUrl}/events/evt_does_not_exist`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'event_not_found');

  const route = await fetch(`${baseUrl}/nope`);
  assert.equal(route.status, 404);
  assert.equal((await route.json()).error.code, 'not_found');
});

test('GET /health reports worker state and event-count breakdown', async (t) => {
  const { kit, baseUrl } = await startApi(t);

  await post(baseUrl, { eventId: 'evt_ok', type: 't', occurredAt: '2026-09-15T10:00:00Z', payload: null });
  await kit.service.scheduler.processDue();

  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.worker.running, false, 'scheduler was not started in this kit');
  assert.deepEqual(health.states, { delivered: 1 });
  assert.ok(typeof health.now === 'string');
});