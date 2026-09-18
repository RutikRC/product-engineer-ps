/**
 * SQLite connection and schema.
 *
 * `events.event_id` is the PRIMARY KEY of the events table - that is the
 * idempotency guard. Two submissions with the same stable identifier
 * cannot create two rows, even when they arrive concurrently.
 *
 * `attempts` is append-only: one row per delivery attempt, linked to the
 * event, so history is never lost or overwritten.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  // WAL keeps readers moving while the worker writes (no-op on :memory:),
  // busy_timeout serializes the rare write-vs-write collision instead of
  // failing fast with SQLITE_BUSY.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id        TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      occurred_at     TEXT NOT NULL,
      payload         TEXT NOT NULL,
      state           TEXT NOT NULL
                      CHECK (state IN ('pending','delivering','delivered','failed')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error      TEXT,
      last_http_status INTEGER,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_due
      ON events (state, next_attempt_at);

    CREATE TABLE IF NOT EXISTS attempts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id       TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      started_at     TEXT NOT NULL,
      finished_at    TEXT NOT NULL,
      outcome        TEXT NOT NULL
                     CHECK (outcome IN ('success','retryable_failure','permanent_failure')),
      http_status    INTEGER,
      error          TEXT,
      response_body  TEXT,
      UNIQUE (event_id, attempt_number)
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_event
      ON attempts (event_id, attempt_number);
  `);

  return db;
}