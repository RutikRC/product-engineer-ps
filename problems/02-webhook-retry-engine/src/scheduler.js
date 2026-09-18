/**
 * Delivery worker (scheduler).
 *
 * A single loop polls the store for due events (state=pending and
 * next_attempt_at <= now), claims them atomically so a competing worker
 * cannot claim the same row twice, delivers over the transport, records
 * the attempt, and transitions the event state.
 *
 * State transitions:
 *   pending --claim--> delivering --success----------------------> delivered
 *                                 --retryable & attempts left---> pending  (scheduled for later)
 *                                 --retryable & exhausted / permanent--> failed
 *
 * Lifespan:
 *   - start() runs the loop on an interval timer.
 *   - processDue() performs one sweep and returns the results - tests and
 *     the demo drive it directly, which is what makes them deterministic
 *     with no reliance on wall-clock sleeps.
 */

import { delayBeforeAttempt, withJitter } from './retryPolicy.js';

export function createScheduler({ store, transport, config, clock, log }) {
  let timer = null;
  let running = false;
  let ticking = false;

  /**
   * Deliver a single claimed event. Never throws: every failure mode is
   * classified into an outcome and persisted.
   */
  async function deliver(event) {
    const startedAt = new Date(clock.now()).toISOString();
    log('info', 'delivery.start', {
      eventId: event.eventId,
      attemptNumber: event.attempts + 1,
      url: config.webhookUrl,
    });

    const outcome = await transport.deliver({ url: config.webhookUrl, event });

    const attemptNumber = event.attempts + 1;
    const attemptsRemain = attemptNumber < config.maxAttempts;
    const finishedAt = new Date(clock.now()).toISOString();

    let nextState;
    let nextAttemptAtMs = null;

    if (outcome.kind === 'success') {
      nextState = 'delivered';
    } else if (outcome.kind === 'retryable_failure' && attemptsRemain) {
      // Compare against the count of a FUTURE attempt (N+1): the first
      // failure must wait before the second attempt, not before the first.
      const backoffMs = delayBeforeAttempt(attemptNumber + 1, config);
      // Honor Retry-After when the receiver asks us to wait longer.
      const retryAfterMs = outcome.retryAfterMs ?? 0;
      const waitMs = withJitter(Math.max(backoffMs, retryAfterMs), config.jitterMs);
      nextState = 'pending';
      nextAttemptAtMs = clock.now() + waitMs;
    } else {
      nextState = 'failed';
    }

    store.completeAttempt({
      event,
      attempt: {
        outcome: outcome.kind,
        httpStatus: outcome.httpStatus,
        error: outcome.error,
        responseBody: outcome.responseBody,
        startedAt,
        finishedAt,
        nextState,
        nextAttemptAtMs,
      },
    });

    log('info', 'delivery.attempt.outcome', {
      eventId: event.eventId,
      attemptNumber,
      outcome: outcome.kind,
      httpStatus: outcome.httpStatus ?? null,
      nextState,
      nextAttemptAt: nextAttemptAtMs == null ? null : new Date(nextAttemptAtMs).toISOString(),
    });

    return { eventId: event.eventId, attemptNumber, outcome: outcome.kind, state: nextState };
  }

  /** One sweep: claim every due event and attempt delivery. Returns results per event. */
  async function processDue(batchSize = config.batchSize) {
    if (!config.webhookUrl) {
      log('warn', 'worker.no_webhook_url', {
        message: 'WEBHOOK_URL is not set; due events will not be claimed.',
      });
      return [];
    }
    const due = store.listDue(clock.now(), batchSize);
    const results = [];
    for (const event of due) {
      const claimed = store.claimForDelivery(event.eventId, clock.now());
      if (!claimed) {
        // Another worker (or a previous sweep) claimed it first.
        log('warn', 'delivery.claim.skipped', { eventId: event.eventId });
        continue;
      }
      results.push(await safeDeliver(claimed));
    }
    return results;
  }

  /**
   * deliver() never *should* throw (transport outcomes are total), but if
   * something unexpected happens the event must not stay stuck in
   * 'delivering' forever - it is requeued for a later attempt.
   */
  async function safeDeliver(event) {
    try {
      return await deliver(event);
    } catch (err) {
      log('error', 'delivery.unexpected_error', {
        eventId: event.eventId,
        error: err?.message ?? String(err),
        stack: err?.stack,
      });
      store.requeueEvent(event.eventId, clock.now());
      return { eventId: event.eventId, outcome: 'unexpected_error', state: 'pending' };
    }
  }

  function start() {
    if (running) return;
    running = true;
    const loop = async () => {
      if (!running) return;
      if (!ticking) {
        ticking = true;
        try {
          await processDue();
        } catch (err) {
          log('error', 'worker.tick.failed', {
            error: err?.message ?? String(err),
            stack: err?.stack,
          });
        } finally {
          ticking = false;
        }
      }
      timer = setTimeout(loop, config.pollIntervalMs);
      timer.unref?.(); // do not keep the process alive purely for the worker
    };
    timer = setTimeout(loop, 0);
    timer.unref?.();
  }

  function stop() {
    running = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    processDue,
    start,
    stop,
    isRunning: () => running,
  };
}