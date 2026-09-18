import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestkit } from './helpers/testkit.js';
import { startScriptedReceiver } from './helpers/receiver.js';

const EVENT = {
  eventId: 'evt_ingest',
  type: 'incident.created',
  occurredAt: '2026-09-15T10:00:00Z',
  payload: { incidentId: 'inc_ingest', severity: 'low' },
};

async function startApi(t) {
  const kit = createTestkit();
  const receiver = await startScriptedReceiver();
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

test('API accepts a valid event with 201 and persists it as pending', async (t) => {
  const { kit, baseUrl } = await startApi(t);

  const res = await post(baseUrl, EVENT);
  assert.equal(res.status, 201);
  const { event, duplicate } = await res.json();
  assert.equal(duplicate, false);
  assert.equal(event.eventId, 'evt_ingest');
  assert.equal(event.state, 'pending');
  assert.equal(event.attempts, 0);
  assert.equal(event.payload.severity, 'low');
  assert.ok(event.nextAttemptAt, 'due immediately');
  assert.equal(event.createdAt, event.updatedAt);
});

test('API rejects invalid events with 400 and a machine-readable error', async (t) => {
  const { baseUrl } = await startApi(t);

  const cases = [
    [null, 'body is not an object'],
    [{}, 'missing eventId'],
    [{ eventId: '', type: 'incident.created' }, 'empty eventId'],
    [{ eventId: 42, type: 'incident.created' }, 'non-string eventId'],
    [{ eventId: 'evt_x', type: '' }, 'empty type'],
    [{ eventId: 'evt_x', type: 't', occurredAt: 'not-a-date' }, 'invalid occurredAt'],
  ];
  for (const [body, label] of cases) {
    const res = await post(baseUrl, body);
    assert.equal(res.status, 400, `${label} should be rejected`);
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_event', `${label} error code`);
    assert.ok(typeof json.error.message === 'string');
  }

  const malformed = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_json');
});

test('AC4: a repeated submission returns the existing event and schedules no second job', async (t) => {
  const { kit, receiver, baseUrl } = await startApi(t);

  const first = await post(baseUrl, EVENT);
  const second = await post(baseUrl, EVENT);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  const firstJson = await first.json();
  const secondJson = await second.json();
  assert.equal(firstJson.duplicate, false);
  assert.equal(secondJson.duplicate, true);
  assert.equal(secondJson.event.eventId, EVENT.eventId);

  // Deliver once: the receiver must see exactly one delivery.
  await kit.service.scheduler.processDue();
  assert.equal(receiver.hits.length, 1, 'single job despite two submissions');
  assert.equal(kit.store.getEventWithAttempts(EVENT.eventId).attempts.length, 1);
});

test('AC4: concurrent duplicate submissions produce exactly one event and one delivery', async (t) => {
  const { kit, receiver, baseUrl } = await startApi(t);

  const submissions = 8;
  const responses = await Promise.all(
    Array.from({ length: submissions }, () => post(baseUrl, EVENT))
  );
  const statuses = responses.map((r) => r.status).sort();

  assert.equal(statuses.filter((s) => s === 201).length, 1, 'exactly one creator');
  assert.equal(statuses.filter((s) => s === 200).length, submissions - 1, 'everyone else gets the existing event');
  for (const res of responses) {
    const json = await res.json();
    assert.equal(json.event.eventId, EVENT.eventId, 'all responses reference the same event');
  }

  const listed = await (await fetch(`${baseUrl}/events`)).json();
  assert.equal(listed.events.length, 1, 'a single row in the store');

  await kit.service.scheduler.processDue();
  assert.equal(receiver.hits.length, 1, 'a single delivery job for the concurrent burst');
});

test('duplicate submissions never create a second row even after delivery', async (t) => {
  const { kit, receiver, baseUrl } = await startApi(t);

  await post(baseUrl, EVENT);
  await kit.service.scheduler.processDue();
  const afterDelivery = await post(baseUrl, EVENT);

  assert.equal(afterDelivery.status, 200);
  const json = await afterDelivery.json();
  assert.equal(json.duplicate, true);
  assert.equal(json.event.state, 'delivered');
  assert.equal(receiver.hits.length, 1);
  assert.equal((await (await fetch(`${baseUrl}/events`)).json()).events.length, 1);
});