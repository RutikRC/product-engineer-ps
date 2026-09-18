import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHttpStatus, delayBeforeAttempt, withJitter } from '../src/retryPolicy.js';

test('classifyHttpStatus: 2xx is success', () => {
  assert.deepEqual(classifyHttpStatus(200), { outcome: 'success', retryable: false });
  assert.deepEqual(classifyHttpStatus(204), { outcome: 'success', retryable: false });
});

test('classifyHttpStatus: documented temporary statuses are retryable', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.deepEqual(
      classifyHttpStatus(status),
      { outcome: 'retryable_failure', retryable: true },
      `status ${status} should be retryable`
    );
  }
});

test('classifyHttpStatus: other 4xx and all 3xx are permanent failures', () => {
  for (const status of [301, 302, 308, 400, 401, 403, 404, 409, 422, 501, 505]) {
    assert.deepEqual(
      classifyHttpStatus(status),
      { outcome: 'permanent_failure', retryable: false },
      `status ${status} should be permanent`
    );
  }
});

test('delayBeforeAttempt: no delay for the first attempt', () => {
  const cfg = { baseDelayMs: 1000, maxDelayMs: 8000, multiplier: 2 };
  assert.equal(delayBeforeAttempt(1, cfg), 0);
});

test('delayBeforeAttempt: exponential schedule is capped at maxDelayMs', () => {
  const cfg = { baseDelayMs: 100, maxDelayMs: 1000, multiplier: 2 };
  assert.equal(delayBeforeAttempt(2, cfg), 100);
  assert.equal(delayBeforeAttempt(3, cfg), 200);
  assert.equal(delayBeforeAttempt(4, cfg), 400);
  assert.equal(delayBeforeAttempt(5, cfg), 800);
  assert.equal(delayBeforeAttempt(6, cfg), 1000); // capped
  assert.equal(delayBeforeAttempt(10, cfg), 1000); // stays capped
});

test('withJitter: returns exact delay when jitter is 0', () => {
  assert.equal(withJitter(1000, 0), 1000);
});

test('withJitter: output stays within the requested bounds', () => {
  for (let i = 0; i < 100; i += 1) {
    const d = withJitter(1000, 100);
    assert.ok(d >= 900 && d <= 1100, `jittered delay ${d} within +/-100 of 1000`);
  }
});