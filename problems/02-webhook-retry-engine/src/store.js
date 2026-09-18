/**
 * Data-access layer.
 *
 * Owns the SQLite schema and every query; the rest of the codebase works
 * with plain JS event objects and never touches SQL or row shapes.
 *
 * Key guarantees implemented here:
 *  - idempotent ingest        -> INSERT OR IGNORE on the event_id primary
 *                                key; safe under concurrent submissions.
 *  - claim-for-delivery       -> atomic UPDATE that only succeeds when the
 *                                event is still pending & due, so two
 *                                workers can never claim the same row.
 *  - attempt + transition     -> written together in one transaction, so a
 *                                crash never leaves a state that has an
 *                                attempt recorded but not reflected (or
 *                                vice-versa).
 */

import { createDatabase } from './db.js';

const EVENT_COLUMNS = `
  event_id, type, occurred_at, payload, state, attempts,
  next_attempt_at, last_error, last_http_status, created_at, updated_at
`;

export function createStore({ dbPath, now = Date.now }) {
  const db = createDatabase(dbPath);

  const insertEventStmt = db.prepare(`
    INSERT OR IGNORE INTO events
      (event_id, type, occurred_at, payload, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES (@eventId, @type, @occurredAt, @payload, 'pending', 0, @nextAttemptAt, @createdAt, @updatedAt)
  `);

  const selectEventStmt = db.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE event_id = ?`
  );

  const listDueStmt = db.prepare(`
    SELECT ${EVENT_COLUMNS} FROM events
    WHERE state = 'pending' AND next_attempt_at <= ?
    ORDER BY next_attempt_at, event_id
    LIMIT ?
  `);

  const claimStmt = db.prepare(`
    UPDATE events
    SET state = 'delivering', updated_at = @updatedAt
    WHERE event_id = @eventId AND state = 'pending' AND next_attempt_at <= @nowMs
  `);

  const insertAttemptStmt = db.prepare(`
    INSERT INTO attempts
      (event_id, attempt_number, started_at, finished_at, outcome, http_status, error, response_body)
    VALUES
      (@eventId, @attemptNumber, @startedAt, @finishedAt, @outcome, @httpStatus, @error, @responseBody)
  `);

  const updateEventAfterAttemptStmt = db.prepare(`
    UPDATE events
    SET state = @state,
        attempts = @attempts,
        next_attempt_at = @nextAttemptAt,
        last_error = @lastError,
        last_http_status = @lastHttpStatus,
        updated_at = @updatedAt
    WHERE event_id = @eventId
  `);

  const requeueStuckStmt = db.prepare(`
    UPDATE events
    SET state = 'pending', next_attempt_at = @nowMs, updated_at = @updatedAt
    WHERE state = 'delivering'
  `);

  const requeueEventStmt = db.prepare(`
    UPDATE events
    SET state = 'pending', next_attempt_at = @nowMs, updated_at = @updatedAt
    WHERE event_id = @eventId AND state = 'delivering'
  `);

  const selectAttemptsStmt = db.prepare(`
    SELECT attempt_number, started_at, finished_at, outcome, http_status, error, response_body
    FROM attempts WHERE event_id = ?
    ORDER BY attempt_number
  `);

  const stateCountsStmt = db.prepare(
    `SELECT state, COUNT(*) AS count FROM events GROUP BY state`
  );

  /** Convert a raw DB row into the event object the rest of the app uses. */
  function toEvent(row) {
    if (!row) return null;
    return {
      eventId: row.event_id,
      type: row.type,
      occurredAt: row.occurred_at,
      payload: safeParse(row.payload),
      state: row.state,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at == null ? null : new Date(row.next_attempt_at).toISOString(),
      lastError: row.last_error,
      lastHttpStatus: row.last_http_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function toAttempt(row) {
    return {
      attemptNumber: row.attempt_number,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outcome: row.outcome,
      httpStatus: row.http_status,
      error: row.error,
      responseBody: row.response_body,
    };
  }

  const LIST_SELECT = `
    SELECT e.event_id, e.type, e.occurred_at, e.payload, e.state, e.attempts,
           e.next_attempt_at, e.last_error, e.last_http_status, e.created_at, e.updated_at,
           (SELECT COUNT(*) FROM attempts a WHERE a.event_id = e.event_id) AS attempt_count
    FROM events e
  `;

  return {
    close() {
      db.close();
    },

    /**
     * Insert the event unless one with the same eventId already exists.
     * `inserted` is true only for the submission that created it; every
     * other submission gets `{ inserted: false }` plus the existing row.
     */
    ingest({ eventId, type, occurredAt, payload }) {
      const ms = now();
      const createdAt = new Date(ms).toISOString();
      const info = insertEventStmt.run({
        eventId,
        type,
        occurredAt,
        payload: JSON.stringify(payload ?? null),
        nextAttemptAt: ms, // fresh events are due immediately
        createdAt,
        updatedAt: createdAt,
      });
      return { event: toEvent(selectEventStmt.get(eventId)), inserted: info.changes === 1 };
    },

    getEvent(eventId) {
      return toEvent(selectEventStmt.get(eventId));
    },

    /** List events (optionally filtered by state), newest first. */
    listEvents({ state, limit = 100 } = {}) {
      const sql = state
        ? `${LIST_SELECT} WHERE e.state = ? ORDER BY e.created_at DESC, e.event_id LIMIT ?`
        : `${LIST_SELECT} ORDER BY e.created_at DESC, e.event_id LIMIT ?`;
      const rows = (state ? db.prepare(sql).all(state, limit) : db.prepare(sql).all(limit));
      return rows.map((r) => ({ ...toEvent(r), attemptCount: r.attempt_count }));
    },

    /** Event plus its delivery attempts in chronological order. */
    getEventWithAttempts(eventId) {
      const event = toEvent(selectEventStmt.get(eventId));
      if (!event) return null;
      const attempts = selectAttemptsStmt.all(eventId).map(toAttempt);
      return { event, attempts };
    },

    /** Events that are pending and whose next_attempt_at has passed. */
    listDue(nowMs, limit = 25) {
      return listDueStmt.all(nowMs, limit).map(toEvent);
    },

    /**
     * Atomically claim one event for delivery. Returns the claimed event,
     * or null when another worker already claimed it first.
     */
    claimForDelivery(eventId, nowMs) {
      const updatedAt = new Date(nowMs).toISOString();
      const info = claimStmt.run({ eventId, nowMs, updatedAt });
      if (info.changes !== 1) return null;
      return toEvent(selectEventStmt.get(eventId));
    },

    /**
     * Persist one delivery attempt and the resulting state transition in a
     * single transaction so they can never diverge.
     */
    completeAttempt({ event, attempt }) {
      const transition = db.transaction(() => {
        insertAttemptStmt.run({
          eventId: event.eventId,
          attemptNumber: event.attempts + 1,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
          outcome: attempt.outcome,
          httpStatus: attempt.httpStatus ?? null,
          error: attempt.error ?? null,
          responseBody: attempt.responseBody ?? null,
        });
        updateEventAfterAttemptStmt.run({
          eventId: event.eventId,
          state: attempt.nextState,
          attempts: event.attempts + 1,
          nextAttemptAt: attempt.nextAttemptAtMs ?? null,
          lastError: attempt.error ?? null,
          lastHttpStatus: attempt.httpStatus ?? null,
          updatedAt: attempt.finishedAt,
        });
      });
      transition();
    },

    /**
     * Crash recovery: on startup, any event left in 'delivering' was
     * being delivered when the process died. We can never know whether
     * the receiver processed it, so at-least-once semantics require
     * requeueing it for another delivery.
     */
    requeueStuckDelivering(nowMs) {
      const updatedAt = new Date(nowMs).toISOString();
      return requeueStuckStmt.run({ nowMs, updatedAt }).changes;
    },

    /** Requeue a single event that errored outside a normal attempt outcome. */
    requeueEvent(eventId, nowMs) {
      const updatedAt = new Date(nowMs).toISOString();
      return requeueEventStmt.run({ eventId, nowMs, updatedAt }).changes;
    },

    stats() {
      return stateCountsStmt.all().reduce((acc, row) => {
        acc[row.state] = row.count;
        return acc;
      }, {});
    },
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}