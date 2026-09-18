# Product Engineering Challenge Submission

## Candidate

- **Name:** Rutik Ravindra Chavan
- **Email:** chavanrutik133@gmail.com
- **GitHub:** _(to fill in)_
- **Selected problem:** Problem 2 – Webhook Retry Engine
- **Demo video:** _(link to Loom/YouTube/Drive ~3–5 min video; see "Demo checklist" below for what it shows)_

---

## Run the project

Prerequisites: **Node.js 20+** (developed and tested on Node 24) and a shell with `npm`. SQLite is embedded through `better-sqlite3`, so no server/database install is needed.

```text
cd problems/02-webhook-retry-engine
npm install

# Terminal 1 – mock webhook receiver (default port 9099, mode "ok")
npm run receiver

# Terminal 2 – the engine (accepts events, retries deliveries)
set WEBHOOK_URL=http://127.0.0.1:9099/webhook
set RETRY_MAX_ATTEMPTS=3
set RETRY_BASE_DELAY_MS=1000
set RETRY_JITTER_MS=0
npm start
```

**Successful scenario** (AC1):

```text
curl -X POST http://127.0.0.1:8010/events ^
  -H "content-type: application/json" ^
  -d "{\"eventId\":\"evt_1\",\"type\":\"incident.created\",\"occurredAt\":\"2026-09-15T10:00:00Z\",\"payload\":{\"incidentId\":\"inc_1\",\"severity\":\"high\"}}"
# -> 201 { "event": { "eventId": "evt_1", "state": "pending", ... }, "duplicate": false }

curl http://127.0.0.1:8010/events/evt_1
# -> state "delivered", one attempt with httpStatus 200
```

**Failure + retry scenario** (AC2, AC3): make the receiver fail, submit an event, watch it retry, then make the receiver healthy again.

```text
curl -X POST http://127.0.0.1:9099/__control -H "content-type: application/json" -d "{\"mode\":\"fail-n\",\"status\":500,\"remaining\":2}"
# now POST another event (it fails twice, then succeeds once the receiver is "ok" again)
curl -X POST http://127.0.0.1:9099/__control -H "content-type: application/json" -d "{\"mode\":\"ok\"}"

# permanent failure / exhaustion: leave mode at {"mode":"fail","status":503} so all attempts fail
curl http://127.0.0.1:8010/events/<eventId>   # inspect state and ordered attempt history
node inspect.js <eventId>                     # or the CLI (same data)
```

**Idempotent resubmission** (AC4): POST the same `eventId` again — you get `200 { "duplicate": true }` with the existing event, and the receiver is **not** called a second time.

There is also an **automated replay of all five acceptance scenarios**:

```text
npm run demo        # starts a receiver + engine on ephemeral ports and walks AC1–AC5
npm run smoke       # spawns the real `node src/main.js` as an OS process and drives it over HTTP
```

To verify a process restart mid-flight (durability): kill the engine while an event is `pending`, restart it, and the pending event is still delivered; any event left in `delivering` by the crash is requeued on startup (at-least-once).

## Run the tests

```text
npm test            # node --test, 27 tests, ~1–2 s, no external services, no real-time sleeps
```

| Tests | What they cover |
| --- | --- |
| `test/retry-policy.test.js` | HTTP-status classification table + exponential backoff schedule (pure logic) |
| `test/delivery.test.js` | AC1 success; AC2 temporary failure → recorded → scheduled → retried; AC3 attempt exhaustion; permanent (400) stop; `Retry-After` honoring; network-error recovery; two workers cannot double-deliver; no-URL worker safety |
| `test/ingestion.test.js` | AC4 sequential + 8-way **concurrent** duplicate ingestion → exactly one event, one delivery; request validation (400s) |
| `test/durability.test.js` | events survive an engine restart; startup sweep requeues events stuck in `delivering`; attempt history survives a restart |
| `test/api.test.js` | AC5 state + ordered attempt history over HTTP; listing + state filter; 404s; health |

Tests are **deterministic**: the worker is driven with an injectable clock and `processDue()`, so no test sleeps or depends on wall-clock timing.
## Architecture and data flow

```
POST /events (Express API)          GET /events, GET /events/:eventId, GET /health
        │                                  ▲
        ▼                                  │
┌────────────────────────────────────────────────────────────┐
│ store (SQLite, WAL)              events + attempts tables   │
│  • event_id PRIMARY KEY = idempotency guard (unique insert) │
│  • atomic claim: pending → delivering (UPDATE ... WHERE)    │
│  • attempt row + state transition persist in ONE transaction│
└────────────────────────────────────────────────────────────┘
        ▲                                  │
        │ listDue(now) / claim              │ completeAttempt(...)
        │                                  ▼
   scheduler (worker loop) ── deliver() ──► transport (HTTP fetch)
        │     polls every WORKER_POLL_INTERVAL_MS,
        │     classifies outcome, computes backoff, schedules next_attempt_at
```

1. **Ingestion** – `POST /events` validates the contract and calls `store.ingest`, which uses `INSERT OR IGNORE` on the `event_id` primary key. Concurrent duplicate submissions therefore cannot create two events (SQLite serializes the write; the loser receives the existing row).
2. **Scheduling** – the worker repeatedly selects events where `state = 'pending' AND next_attempt_at <= now`, then **atomically claims** each (`UPDATE events SET state='delivering' WHERE state='pending'`), so a second worker can never deliver the same event twice.
3. **Delivery** – the transport POSTs the event JSON with an `idempotency-key: <eventId>` header. A 2xx → success; documented temporary failures/network errors → retryable; other 4xx/3xx → permanent failure.
4. **Recording** – the attempt row and the resulting state transition are written **in one SQLite transaction**: `delivering → delivered | pending(next_attempt_at) | failed`.
5. **Inspection** – `GET /events/:eventId` returns the event plus its attempts ordered by attempt number (`startedAt/finishedAt`, attempt number, outcome, HTTP status, error, capped response body). The CLI `inspect.js` prints the same data.

## Technology choices

- **Node.js + JavaScript (ESM)** – the whole system, including storage, is one language; the platform `fetch` covers delivery; the built-in `node --test` runner means tests need zero extra tooling. It also made the injectable-clock design natural, which is what keeps the tests deterministic.
- **SQLite via `better-sqlite3`** – gives real durability and a *real* primary key, which turns concurrent idempotency from an application dance into a database guarantee. WAL + `busy_timeout` make concurrent writers safe. A JSON-file or in-memory store would have been simpler but weaker for the "concurrent duplicate" and "restart" scenarios.
- **Express 5** – minimal, standard HTTP surface for ingestion/inspection; no framework opinions forced on the rest of the design.
- Alternatives considered: a real queue (Redis/Postgres) would be the production answer but is infrastructure the brief explicitly doesn't require; the local SQLite table *is* the durable queue here. TypeScript was attractive for types but adds a build step for no behavioral gain at this size; JSDoc keeps the key contracts documented.

## Important decisions

1. **Database primary key is the idempotency boundary.** Duplicate handling lives in ingestion *and* storage (not only in application code), so concurrent submissions of the same `eventId` collapse into one logical event — AC4 under `Promise.all(...)` is tested directly. The engine still also sends `idempotency-key` so receivers can deduplicate the delivery-side duplicates that at-least-once semantics can still produce.
2. **An injectable clock + explicit state transitions = a testable scheduler.** The worker never sleeps; it schedules `pending` events for `next_attempt_at = now + backoff` and only works when they are due. Tests drive `processDue()` under a fake clock, so the entire retry lifecycle (AC2, AC3, `Retry-After`, recovery) is verified in milliseconds with no sleeps. Time is the classic hidden input in retry systems; making it an explicit dependency is what makes the suite deterministic.
3. **at-least-once is a first-class, documented choice.** The engine acknowledges the unavoidable window: a crash *after* the receiver processed the request but *before* the attempt is recorded leaves the event requeued, so receivers may see a duplicate and must dedupe on `eventId`. Everything else makes that window as narrow and observable as possible: attempt + transition commit atomically, and events stuck in `delivering` after a crash are requeued on startup rather than silently left forever.

## Assumptions and limitations

- **Delivery guarantee: at-least-once.** Exactly-once across an external HTTP boundary is impossible without receiver cooperation.
- One configured webhook endpoint per worker (per the brief). No per-event URL, no multi-endpoint fan-out.
- Single-process/single-database-file deployment is the supported topology; multi-worker operation is described in "Production and scale" but not implemented here.
- The mock receiver and the local HTTP transport are the only tested delivery targets; no TLS/mTLS/request-signing (out of scope).
- No auth, no dashboard, no rate limiting (all explicitly out of scope).
- Attempt response bodies are retained up to `ATTEMPT_BODY_MAX_BYTES` and truncated; payloads and response bodies are never written to logs.
### Decisions the brief requires documenting

- **Retryable**: HTTP `408, 425, 429, 500, 502, 503, 504` and any network error (timeout, connection refused, DNS, reset). **Not retryable**: all other `4xx` and any `3xx` (we do not follow redirects for webhook endpoints — the configured URL is expected to be exact). Classified table-driven in `src/retryPolicy.js`.
- **Backoff**: exponential with jitter, `delay before attempt N = min(base * multiplier^(N-2), maxDelayMs)` (defaults 1s, 2×, 60s cap, ±100 ms jitter); a receiver `Retry-After` header is honored as a floor. All knobs are env-configurable; tests/demo shrink them.
- **Delivery guarantee**: at-least-once. Receivers should treat `eventId` as the deduplication key (header or body).
- **Concurrent duplicate submissions**: one row per `eventId` (DB primary key + `INSERT OR IGNORE`); exactly one delivery job; every duplicate request gets the existing event with `duplicate: true`.
- **Attempt retention**: one `attempts` row per attempt — attempt number, `startedAt`/`finishedAt`, outcome (`success | retryable_failure | permanent_failure`), HTTP status, normalized error, truncated response body. History is append-only and never overwritten.

## Production and scale

- **Multi-worker / many processes**: the atomic `pending → delivering` claim already makes workers safe against double-delivery, but restarting workers would need a **claim lease** (e.g., `claimed_at` + heartbeat, with the startup requeue sweeping only expired leases) instead of the current "requeue all `delivering` on startup."
- **One failing endpoint consuming capacity**: with a single endpoint this is bounded by `batchSize` and backoff. In production I would add per-endpoint concurrency limits, a circuit breaker keyed on recent failure rate, and a dead-letter table + manual replay route for retried-out events.
- **Scalability**: swap the local SQLite queue for Postgres (same schema semantics) or a queue like Redis Streams; move `listDue` to `SKIP LOCKED`-style claims. The store/scheduler/transport boundaries exist precisely so this is a storage replacement, not a rewrite.
- **Operational changes first**: (1) structured metrics — accepted vs. duplicated events, delivered/failed, per-attempt latency, retry backlog depth; (2) alerts — backlog growth, exhaustion rate, p95 delivery latency; (3) secrets management and TLS for delivery; (4) the ingestion API behind a load balancer sharing one DB.

### Answers to the brief's questions

- **What could still cause a receiver to observe a duplicate delivery?** The crash window between the receiver processing a request and the engine committing the attempt record/state (the at-least-once gap), plus any retry after a temporary failure whose response was actually applied. Receivers must dedupe on `eventId`.
- **How would you operate this with many workers?** All workers share the durable DB; the atomic claim prevents double-delivery today. Production would add claim leases + heartbeat sweeping and keep one worker type (claim/deliver) so backpressure is global rather than per-process.
- **How would you prevent one failing endpoint from consuming all capacity?** Cooperative locking already scopes claims per event, but I would add a per-endpoint failure-rate circuit breaker and a separate worker pool for retries so a stuck endpoint cannot starve new events.
- **What metrics and alerts would you add in production?** Accepted vs. duplicated ingestion rate; delivered vs. failed per event type; attempt latency; retry backlog depth and oldest `next_attempt_at`; timeout/`Retry-After` counts; alert on backlog growth, a spike in exhaustion, or delivery p95 over threshold.

## Demo checklist

The 3–5 minute demo video walks through, using a screen recording with narration:

1. `npm install`, then the **mock receiver** and **engine** starting in two terminals (config/responsibilities explained — receiver has a `GET /__state` control API).
2. **AC1** — POST an event → receiver receives it → `GET /events/:eventId` shows `delivered` with one recorded attempt.
3. **AC2** — `__control {mode:"fail-n",status:500,remaining:2}` → new event fails twice (visible in the attempt list and NDJSON logs) → receiver back to `ok` → third attempt succeeds; history shows `500 → 500 → 200`.
4. **AC3** — `__control {mode:"fail",status:503}` → event exhausts `RETRY_MAX_ATTEMPTS=3` → final state `failed`, no 4th attempt.
5. **AC4** — resubmitting the first event's `eventId` → `200 duplicate:true`, receiver delivery count unchanged.
6. **AC5 / architecture** — `GET /events` + `node inspect.js` show ordered attempt history; a short architecture walkthrough and the at-least-once trade-off explanation (why duplicates can still reach a receiver and how `eventId` deduplication handles it).

## AI usage

- **AI tools used**: Claude (as this coding agent, "Cline") for the majority of implementation drafting, debugging, and test writing.
- **How they contributed**: I used the assistant to scaffold the architecture, write modules and the test suite, and — notably — to diagnose real bugs it caught (a backoff off-by-one, `next_attempt_at NOT NULL` conflicting with terminal `NULL`, `loadConfig(env)` ignoring the passed environment, and a Windows libuv teardown crash in tests).
- **My role**: I specified the design (state machine, storage boundaries, retry policy, test strategy), reviewed every module, and validated all behaviour by running the suite, the process smoke test, and the full demo. I can explain every part of the code and would be glad to walk through it.

## Credibility note

_(Describe one product or system you previously helped ship: the problem it solved, your personal contribution, the scale/operational complexity, one difficult engineering or product decision, and a public link or other evidence when available. Anonymize what you need to; approximate figures are fine.)_