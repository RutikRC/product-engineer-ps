/**
 * Ingress / inspection HTTP API (Express).
 *
 * Routes:
 *   POST /events              accept an event (idempotent on eventId)
 *   GET  /events?state=&limit=  list events with attempt counts
 *   GET  /events/:eventId     event + ordered delivery attempt history
 *   GET  /health              liveness
 *
 * New submissions return 201 {event, duplicate:false}; submissions with
 * an already-known eventId return 200 {event, duplicate:true} and do NOT
 * schedule a second delivery job.
 */

import express from 'express';

const STATES = new Set(['pending', 'delivering', 'delivered', 'failed']);

export function createApi({ store, scheduler, config, clock, log }) {
  const app = express();
  app.disable('x-powered-by');
  // strict:false -> any valid JSON reaches the validator, which owns the
  // semantic errors (a JSON `null` is malformed as an EVENT, not as JSON).
  app.use(express.json({ limit: '64kb', strict: false }));

  app.post('/events', (req, res) => {
    const result = validateEventInput(req.body, clock);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    const info = store.ingest(result.value);
    log('info', info.inserted ? 'event.accepted' : 'event.duplicate', {
      eventId: info.event.eventId,
    });
    return res
      .status(info.inserted ? 201 : 200)
      .json({ event: info.event, duplicate: !info.inserted });
  });

  app.get('/events', (req, res) => {
    const { state, limit } = req.query;
    if (state !== undefined && !STATES.has(state)) {
      return res.status(400).json({
        error: {
          code: 'invalid_state',
          message: `state must be one of: ${[...STATES].join(', ')}`,
        },
      });
    }
    let parsedLimit = 100;
    if (limit !== undefined) {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
        return res.status(400).json({
          error: { code: 'invalid_limit', message: 'limit must be an integer between 1 and 500' },
        });
      }
    }
    const events = store.listEvents({ state, limit: parsedLimit });
    return res.json({ events });
  });

  app.get('/events/:eventId', (req, res) => {
    const data = store.getEventWithAttempts(req.params.eventId);
    if (!data) {
      return res.status(404).json({
        error: { code: 'event_not_found', message: `no event with eventId "${req.params.eventId}"` },
      });
    }
    return res.json(data);
  });

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      worker: { running: scheduler.isRunning() },
      states: store.stats(),
      now: new Date(clock.now()).toISOString(),
    });
  });

  // ---- 404 / error handlers ------------------------------------------
  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'not_found', message: `no route for ${req.method} ${req.originalUrl}` },
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({
        error: { code: 'invalid_json', message: 'request body is not valid JSON' },
      });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'payload_too_large', message: 'request body exceeds the 64kb limit' },
      });
    }
    log('error', 'api.unhandled_error', { error: err?.message ?? String(err) });
    return res.status(500).json({
      error: { code: 'internal_error', message: 'internal server error' },
    });
  });

  return app;
}

function validateEventInput(body, clock) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: { code: 'invalid_event', message: 'body must be a JSON object' } };
  }

  const { eventId, type, occurredAt, payload } = body;

  if (typeof eventId !== 'string' || eventId.trim() === '') {
    return { error: { code: 'invalid_event', message: 'eventId is required and must be a non-empty string' } };
  }
  if (eventId.length > 200) {
    return { error: { code: 'invalid_event', message: 'eventId must be at most 200 characters' } };
  }
  if (typeof type !== 'string' || type.trim() === '') {
    return { error: { code: 'invalid_event', message: 'type is required and must be a non-empty string' } };
  }

  let occurredAtIso = occurredAt;
  if (occurredAt === undefined) {
    occurredAtIso = new Date(clock.now()).toISOString();
  } else if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    return {
      error: {
        code: 'invalid_event',
        message: 'occurredAt must be a valid ISO-8601 timestamp, e.g. \"2026-09-15T10:00:00Z\"',
      },
    };
  }
  occurredAtIso = new Date(Date.parse(occurredAtIso)).toISOString();

  if (payload !== undefined && (Array.isArray(payload) || typeof payload === 'object')) {
    // any JSON structure is fine
  } else if (payload !== undefined && typeof payload !== 'string' && typeof payload !== 'number' && typeof payload !== 'boolean' && payload !== null) {
    return { error: { code: 'invalid_event', message: 'payload must be a JSON value' } };
  }

  return { value: { eventId: eventId.trim(), type: type.trim(), occurredAt: occurredAtIso, payload } };
}