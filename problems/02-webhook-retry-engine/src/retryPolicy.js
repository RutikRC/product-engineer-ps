/**
 * Delivery retry policy.
 *
 * Classification is intentionally explicit: the engine retries only
 * errors that suggest the receiver *may not have processed* the request,
 * and gives up immediately on responses that will not change without a
 * human fixing the integration.
 *
 * Retryable statuses: 408 (request timeout), 425 (too early), 429 (rate
 * limited) and 5xx 500/502/503/504 (receiver-side outage). Network
 * errors - timeouts, connection refused, DNS failures - are classified
 * as retryable in the transport layer.
 *
 * Not retryable: other 4xx (400, 401, 403, 404, 422, ...) indicate the
 * request or integration is wrong; 3xx is not followed for webhook
 * delivery and is recorded as a permanent failure (the configured
 * endpoint is expected to be exact).
 */

export const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Classify an HTTP response status into a delivery outcome.
 *
 * @returns {{ outcome: 'success'|'retryable_failure'|'permanent_failure', retryable: boolean }}
 */
export function classifyHttpStatus(status) {
  if (status >= 200 && status < 300) {
    return { outcome: 'success', retryable: false };
  }
  if (RETRYABLE_STATUSES.has(status)) {
    return { outcome: 'retryable_failure', retryable: true };
  }
  return { outcome: 'permanent_failure', retryable: false };
}

/**
 * Delay in milliseconds scheduled before `attemptNumber` (attempt #1 is
 * the initial delivery and is never delayed):
 *
 *   delay(1) = 0
 *   delay(N) = min(baseDelayMs * multiplier^(N-2), maxDelayMs)
 */
export function delayBeforeAttempt(attemptNumber, { baseDelayMs, maxDelayMs, multiplier }) {
  if (attemptNumber <= 1) return 0;
  const raw = baseDelayMs * Math.pow(multiplier, attemptNumber - 2);
  return Math.min(maxDelayMs, Math.round(raw));
}

/**
 * Apply optional +/-jitterMs random noise around a deterministic delay.
 */
export function withJitter(delayMs, jitterMs) {
  if (!jitterMs) return delayMs;
  const noise = (Math.random() - 0.5) * 2 * jitterMs;
  return Math.max(0, Math.round(delayMs + noise));
}