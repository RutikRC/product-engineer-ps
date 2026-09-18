/**
 * Central configuration for the webhook retry engine.
 *
 * Every value can be overridden through environment variables so that
 * tests and demonstrations can shrink retry delays, lower attempt
 * limits, or point at a different receiver without touching code.
 */

function envNumber(env, name, fallback, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a number`);
  }
  if (value < min) {
    throw new Error(`Invalid ${name}: must be >= ${min}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  return {
    /** Ingress HTTP API port. Use 0 to bind an ephemeral port. */
    port: envNumber(env, 'PORT', 8010, { min: 0 }),

    /** SQLite database file. ':memory:' is supported for tests. */
    dbPath: env.DB_PATH || './data/webhook-retry-engine.db',

    /**
     * The single configured webhook endpoint. Workers without a
     * WEBHOOK_URL do not claim events so nothing is burned pointlessly.
     */
    webhookUrl: env.WEBHOOK_URL || null,

    // ---- Retry policy -------------------------------------------------
    /** Maximum delivery attempts per event (including the first). */
    maxAttempts: envNumber(env, 'RETRY_MAX_ATTEMPTS', 5, { min: 1 }),

    /**
     * Exponential backoff, capped at maxDelayMs:
     *   delay before attempt N = min(base * multiplier^(N-2), maxDelayMs)
     */
    baseDelayMs: envNumber(env, 'RETRY_BASE_DELAY_MS', 1000),
    maxDelayMs: envNumber(env, 'RETRY_MAX_DELAY_MS', 60_000),
    multiplier: envNumber(env, 'RETRY_BACKOFF_MULTIPLIER', 2, { min: 1 }),

    /**
     * Add up to +/-jitterMs random noise to each computed delay so many
     * events failing at once do not all retry in lockstep.
     */
    jitterMs: envNumber(env, 'RETRY_JITTER_MS', 100),

    // ---- Delivery transport ------------------------------------------
    deliveryTimeoutMs: envNumber(env, 'DELIVERY_TIMEOUT_MS', 10_000),
    /** Cap retained response-body length per attempt (audit trail). */
    attemptBodyMaxBytes: envNumber(env, 'ATTEMPT_BODY_MAX_BYTES', 1024),
    /** Webhook endpoints are exact; 3xx responses are recorded, not followed. */
    followRedirects: false,

    // ---- Worker -------------------------------------------------------
    pollIntervalMs: envNumber(env, 'WORKER_POLL_INTERVAL_MS', 500),
    batchSize: envNumber(env, 'WORKER_BATCH_SIZE', 25),
  };
}