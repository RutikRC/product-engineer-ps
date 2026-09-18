#!/usr/bin/env node
/**
 * CLI to inspect an event's delivery state and attempt history.
 *
 *   node inspect.js <eventId>
 *   (or: npm run inspect -- <eventId>)
 *
 * Uses the same DB_PATH as the service.
 */

import { loadConfig } from './src/config.js';
import { createStore } from './src/store.js';

const eventId = process.argv[2];
if (!eventId) {
  console.error('usage: node inspect.js <eventId>');
  process.exit(1);
}

const config = loadConfig();
const store = createStore({ dbPath: config.dbPath });
const data = store.getEventWithAttempts(eventId);

if (!data) {
  console.error(`event "${eventId}" not found in ${config.dbPath}`);
  store.close();
  process.exit(1);
}

const { event, attempts } = data;
console.log('EVENT');
console.log('  eventId      :', event.eventId);
console.log('  type         :', event.type);
console.log('  occurredAt   :', event.occurredAt);
console.log('  state        :', event.state);
console.log('  attempts     :', event.attempts);
console.log('  nextAttemptAt:', event.nextAttemptAt ?? '(none - final state)');
console.log('  lastError    :', event.lastError ?? '(none)');
console.log('  lastHttp     :', event.lastHttpStatus ?? '(n/a)');
console.log('  payload      :', JSON.stringify(event.payload));

console.log('\nDELIVERY ATTEMPTS (in order)');
if (attempts.length === 0) {
  console.log('  (no attempts yet)');
}
for (const a of attempts) {
  console.log(`  #${a.attemptNumber}  ${a.outcome.padEnd(18)} http=${a.httpStatus ?? 'ERR'.padEnd(3)}  ${a.finishedAt}  ${a.error ?? '(no error)'}`);
  if (a.responseBody) console.log(`        response body: ${a.responseBody.slice(0, 200)}`);
}

store.close();