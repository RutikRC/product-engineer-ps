/**
 * HTTP delivery transport.
 *
 * Delivers an event to the configured webhook URL with the platform
 * fetch (undici). The event is sent as JSON POST with:
 *   - idempotency-key: <eventId>  (so a receiver can deduplicate us)
 *   - the full event contract     (eventId, type, occurredAt, payload)
 *
 * Outcome contract returned by deliver():
 *   { kind: 'success',             httpStatus, responseBody, retryAfterMs, error: null }
 *   { kind: 'retryable_failure',   httpStatus | null, responseBody, retryAfterMs, error }
 *   { kind: 'permanent_failure',   httpStatus, responseBody, retryAfterMs, error }
 *
 * httpStatus is null only for network-level failures (timeout, refused,
 * DNS), which are always classified as retryable.
 */

import { classifyHttpStatus } from './retryPolicy.js';

export function createHttpTransport({
  fetchImpl = globalThis.fetch,
  timeoutMs,
  maxBodyBytes,
  followRedirects = false,
}) {
  return {
    async deliver({ url, event }) {
      let response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort(new Error(`delivery timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();

        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': event.eventId,
          },
          body: JSON.stringify({
            eventId: event.eventId,
            type: event.type,
            occurredAt: event.occurredAt,
            payload: event.payload,
          }),
          signal: controller.signal,
          redirect: followRedirects ? 'follow' : 'manual',
        });
      } catch (error) {
        return {
          kind: 'retryable_failure',
          httpStatus: null,
          responseBody: null,
          retryAfterMs: null,
          error: describeNetworkError(error, timeoutMs),
        };
      }

      const status = response.status;
      const classification = classifyHttpStatus(status);
      const body = await readBody(response, maxBodyBytes);
      const retryAfterMs = parseRetryAfter(response);

      return {
        kind: classification.outcome,
        httpStatus: status,
        responseBody: body.excerpt,
        retryAfterMs,
        error: classification.outcome === 'success'
          ? null
          : `HTTP ${status}${body.truncated ? ' (body truncated)' : ''}`,
      };
    },
  };
}

function describeNetworkError(error, timeoutMs) {
  const name = error?.name ?? 'Error';
  const message = error?.message ?? String(error);
  if (name === 'TimeoutError' || /timed out/i.test(message)) {
    return `request timed out after ${timeoutMs}ms`;
  }
  if (/fetch failed|connect|refused|socket|ECONN|ENOTFOUND|network/i.test(message)) {
    return `network error: ${message}`;
  }
  return `${name}: ${message}`;
}

async function readBody(response, maxBytes) {
  try {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      return {
        excerpt: `${text.slice(0, maxBytes)}… (${bytes} bytes total, truncated)`,
        truncated: true,
      };
    }
    return { excerpt: text, truncated: false };
  } catch {
    return { excerpt: null, truncated: false };
  }
}

/** Honor Retry-After (seconds) when a retryable receiver asks us to wait. */
function parseRetryAfter(response) {
  const value = response.headers?.get?.('retry-after');
  if (value == null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}