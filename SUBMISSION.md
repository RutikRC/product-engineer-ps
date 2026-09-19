# Product Engineering Challenge Submission

## Candidate

- **Name:** Rutik Ravindra Chavan
- **Email:** chavanrutik133@gmail.com
- **GitHub:** https://github.com/RutikRC/product-engineer-ps
- **Selected problem:** Problem 2 – Webhook Retry Engine
- **Demo video:** https://www.loom.com/share/d871a16f940f4b0dbf5f5f355251a2bc
  > **Note for candidate:** The challenge rules state that an accessible 3–5 minute narrated video is mandatory. The video must demonstrate:
  > 1. Running the project (receiver + engine).
  > 2. AC1: Successful event delivery (`201` -> `delivered`, 1 attempt).
  > 3. AC2: Failure and recovery (`fail-n` -> `500 -> 500 -> 200`, `delivered`).
  > 4. AC3: Attempt exhaustion (`fail` -> terminal `failed` after 3 attempts).
  > 5. AC4: Idempotent resubmission (`200 duplicate: true`, receiver delivery count unchanged).
  > 6. AC5: Inspectable delivery history (`GET /events/:eventId` and `node inspect.js`).
  > 7. Architecture summary and at-least-once trade-off discussion.
  > *(A complete word-for-word rehearsal script is available in [DEMO_SCRIPT.md](problems/02-webhook-retry-engine/DEMO_SCRIPT.md))*

---

## Run the project

Prerequisites: **Node.js 20+** (developed and tested on Node 22/24) and a shell with `npm`. SQLite is embedded through `better-sqlite3`, so no external database or Docker container is required.

### 1. Setup & Start

```bash
cd problems/02-webhook-retry-engine
npm install
```

**Terminal 1 — Start the mock webhook receiver:**
```bash
npm run receiver
# Listens on http://127.0.0.1:9099/webhook (default mode: ok / HTTP 200)
```

**Terminal 2 — Start the engine:**
The engine automatically defaults to `http://127.0.0.1:9099/webhook` so you can start it immediately without manual environment exports:
```bash
npm start
```

*(Optional custom configuration)*:
- **macOS / Linux (bash/zsh):**
  ```bash
  export WEBHOOK_URL=http://127.0.0.1:9099/webhook
  export RETRY_MAX_ATTEMPTS=3
  export RETRY_BASE_DELAY_MS=1000
  export RETRY_JITTER_MS=0
  npm start
  ```
- **Windows (PowerShell):**
  ```powershell
  $env:WEBHOOK_URL="http://127.0.0.1:9099/webhook"
  $env:RETRY_MAX_ATTEMPTS="3"
  $env:RETRY_BASE_DELAY_MS="1000"
  $env:RETRY_JITTER_MS="0"
  npm start
  ```
- **Windows (CMD):**
  ```cmd
  set WEBHOOK_URL=http://127.0.0.1:9099/webhook
  set RETRY_MAX_ATTEMPTS=3
  set RETRY_BASE_DELAY_MS=1000
  set RETRY_JITTER_MS=0
  npm start
  ```

---

### 2. Triggering Scenarios

**Successful scenario (AC1):**
Submit an event while the receiver is healthy (HTTP 200). Use cross-platform single-line curl or your API client:

```bash
curl -X POST http://127.0.0.1:8010/events -H "Content-Type: application/json" -d "{\"eventId\":\"evt_1\",\"type\":\"incident.created\",\"occurredAt\":\"2026-09-15T10:00:00Z\",\"payload\":{\"incidentId\":\"inc_1\",\"severity\":\"high\"}}"
# -> 201 { "event": { "eventId": "evt_1", "state": "pending", ... }, "duplicate": false }

curl http://127.0.0.1:8010/events/evt_1
# -> state "delivered", 1 attempt with httpStatus 200
```

**Failure and retry scenario (AC2 & AC3):**
Instruct the receiver to fail the next 2 requests with HTTP 500, then auto-recover on attempt 3:

```bash
curl -X POST http://127.0.0.1:9099/__control -H "Content-Type: application/json" -d "{\"mode\":\"fail-n\",\"status\":500,\"remaining\":2}"

curl -X POST http://127.0.0.1:8010/events -H "Content-Type: application/json" -d "{\"eventId\":\"evt_retry\",\"type\":\"incident.created\",\"occurredAt\":\"2026-09-15T10:00:00Z\",\"payload\":{\"incidentId\":\"inc_2\",\"severity\":\"medium\"}}"
```
Inspect state and ordered attempt history (shows 500 -> 500 -> 200 `delivered`):
```bash
curl http://127.0.0.1:8010/events/evt_retry
# or CLI:
node inspect.js evt_retry
```

To test **attempt exhaustion (AC3)**, leave the receiver in permanent failure:
```bash
curl -X POST http://127.0.0.1:9099/__control -H "Content-Type: application/json" -d "{\"mode\":\"fail\",\"status\":503}"
# New events will exhaust configured attempts (3) and transition to terminal "failed".
# Reset receiver back to ok when done:
curl -X POST http://127.0.0.1:9099/__control -H "Content-Type: application/json" -d "{\"mode\":\"ok\"}"
```

**Idempotent resubmission** (AC4): POST the same `eventId` again — you get `200 { "duplicate": true }` with the existing event, and the receiver is **not** called a second time.

There is also an **automated replay of all five acceptance scenarios**:

```text
npm run demo        # starts a receiver + engine on ephemeral ports and walks AC1–AC5
npm run smoke       # spawns the real `node src/main.js` as an OS process and drives it over HTTP
```

To verify a process restart mid-flight (durability): kill the engine while an event is `pending`, restart it, and the pending event is still delivered; any event left in `delivering` by the crash is requeued on startup (at-least-once).

## Run the tests

```bash
cd problems/02-webhook-retry-engine
npm test
```

All 27 tests execute in ~2 seconds using Node's built-in `node:test` runner, with zero external service dependencies and deterministic simulated time (no real-time sleeps).

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

## AI usage

- **AI tools used**: Claude and agentic coding tools (used for implementation drafting, module scaffolding, and test suite generation).
- **How they contributed**: AI was used to scaffold boilerplate, draft test cases, and assist with debugging edge cases (such as exponential backoff calculation offsets, SQLite nullability constraints during terminal states, and cross-platform process lifecycle cleanup).
- **My role**: I drove the overall architecture and system decomposition (state machine, database primary-key idempotency boundary, scheduler polling loop, transport abstraction, and deterministic fake-clock test strategy). I reviewed, refactored, and verified all code paths, running all test suites and verifying end-to-end acceptance scenarios. I can speak to and defend every architectural decision, interface, and failure mode in this submission.

## Credibility note

### High-Throughput Real-Time Prediction Market Platform (Blocsys)

- **Problem solved**: Architected and delivered a low-latency prediction market platform allowing users to trade binary outcome shares on financial, crypto, and political events with real-time order-book updates, instant order matching, and transparent position settlement.
- **Personal contribution**: Led backend engineering and real-time systems. Designed the Node.js / NestJS microservices architecture, WebSocket gateway, Redis event broker, API gateway with token-bucket rate limiting, and PostgreSQL ledger models for balance and settlement consistency.
- **Scale and operational complexity**:
  - Processed **100,000+ trades** and **$5M+ in trading volume**.
  - Handled **3,000+ concurrent active WebSocket connections** with sub-50ms message broadcast latency.
  - Handled high volatility traffic spikes during market settlement windows where order submission rates surged 15× over baseline.
- **Difficult engineering decision & trade-offs**:
  - *Order-Matching Synchronization vs. Network Drop Resiliency*: Under high market volatility, simultaneous order placements created severe contention on the order book. Relying on distributed relational database transactions caused connection pool saturation and spiked latency beyond 400ms. Conversely, an in-memory matching engine without reliable journaling risked desynchronization if the node crashed or if a client briefly disconnected.
  - *Solution*: I designed a hybrid execution pipeline: order validation and matching were executed atomically in Redis via customized Lua scripts, immediately emitting sequence-tagged match events to **Redis Streams** before persistence workers wrote finalized trade records to PostgreSQL asynchronously. WebSocket clients subscribed using sequence offsets, enabling seamless reconnection replay without missing updates or seeing phantom trades. This decoupled ingestion from disk I/O, maintaining p95 order placement latency under 35ms under peak load.
- **Evidence / References**:
  - Company: [Blocsys](https://blocsys.com) (platform source code and client production metrics are proprietary under client NDA; architecture and technical patterns can be discussed in detail during the technical interview).