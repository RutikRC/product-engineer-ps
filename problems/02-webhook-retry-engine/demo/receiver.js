#!/usr/bin/env node
/**
 * Mock webhook receiver used for demos.
 *
 *   npm run receiver            (or: node demo/receiver.js [port])
 *
 * Endpoints:
 *   POST /webhook  -> the delivery target. Behaviours:
 *                       ok      -> 200
 *                       fail    -> status (default 500)
 *                       fail-n  -> fail the next `remaining` requests, then ok
 *                       down    -> destroy the socket (client sees network error)
 *   POST /__control {"mode":"ok"|"fail"|"fail-n"|"down","status":500,"remaining":2}
 *                       switch behaviour live
 *   GET  /__state   -> mode + webhook hit log
 *   POST /__reset   -> clear hit log and reset to "ok"
 *
 * It also works as a library (createReceiver) used by the automated demo.
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const METHODS = ['GET', 'POST'];

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(new Error('request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** JSON response with connection: close so clients own pooling. */
function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify(body));
}

export function createReceiver({ port = 0, log = console.log } = {}) {
  const state = {
    mode: 'ok', // 'ok' | 'fail' | 'fail-n' | 'down'
    status: 500, // status used by 'fail' and 'fail-n'
    remainingFailures: 0,
    webhookHits: [], // { at, eventId, status, idempotencyKey, body }
    controlHits: [],
  };

  const server = createServer(async (req, res) => {
    if (!METHODS.includes(req.method)) {
      respond(res, 405, { error: 'method not allowed' });
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/webhook') {
      const body = safeParse(await readBody(req));
      const eventId = body?.eventId ?? null;
      const idempotencyKey = req.headers['idempotency-key'] ?? null;
      state.webhookHits.push({
        at: new Date().toISOString(),
        eventId,
        idempotencyKey,
        body: body ?? null,
      });
      const status = webhookStatus(state);
      if (status.destroy) {
        req.socket?.destroy?.(); // client sees a network error
        return;
      }
      respond(res, status.status, { ok: status.status === 200, eventId, mode: state.mode });
      return;
    }

    if (url.pathname === '/__control' && req.method === 'POST') {
      const control = safeParse(await readBody(req)) ?? {};
      if (!['ok', 'fail', 'fail-n', 'down'].includes(control.mode)) {
        respond(res, 400, { error: 'mode must be ok|fail|fail-n|down' });
        return;
      }
      state.mode = control.mode;
      if (control.status) state.status = control.status;
      if (typeof control.remaining === 'number') state.remainingFailures = control.remaining;
      state.controlHits.push({ at: new Date().toISOString(), control });
      respond(res, 200, { ok: true, state: publicState(state) });
      return;
    }

    if (url.pathname === '/__state' && req.method === 'GET') {
      respond(res, 200, publicState(state));
      return;
    }

    if (url.pathname === '/__reset' && req.method === 'POST') {
      state.mode = 'ok';
      state.status = 500;
      state.remainingFailures = 0;
      state.webhookHits = [];
      respond(res, 200, { ok: true });
      return;
    }

    respond(res, 404, { error: 'not found' });
  });

  server.on('error', (err) => log(`[receiver] error: ${err.message}`));

  const listen = () =>
    new Promise((resolve) => {
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });

  const close = () => {
    // Responses already use connection: close, so this resolves quickly;
    // do NOT also call closeIdleConnections() (double close crashes uv
    // on Windows).
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    listen,
    close,
    url: () => `http://127.0.0.1:${server.address().port}/webhook`,
    state: () => publicState(state),
    setControl: (control) => {
      state.mode = control.mode;
      if (control.status) state.status = control.status;
      if (typeof control.remaining === 'number') state.remainingFailures = control.remaining;
    },
  };
}

function webhookStatus(state) {
  switch (state.mode) {
    case 'fail':
      return { status: state.status };
    case 'fail-n': {
      if (state.remainingFailures > 0) {
        state.remainingFailures -= 1;
        return { status: state.status };
      }
      return { status: 200 };
    }
    case 'down':
      return { destroy: true };
    default:
      return { status: 200 };
  }
}

function publicState(state) {
  return {
    mode: state.mode,
    status: state.status,
    remainingFailures: state.remainingFailures,
    webhookHits: state.webhookHits,
    controlHits: state.controlHits,
  };
}

// Run as a standalone script: `node demo/receiver.js [port]`
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const portArg = process.argv[2] ? Number(process.argv[2]) : Number(process.env.RECEIVER_PORT || 9099);
  const receiver = createReceiver({ port: portArg });
  receiver.listen().then((port) => {
    console.log(`[receiver] listening on http://127.0.0.1:${port}/webhook (mode: ok)`);
    console.log('[receiver] toggle with: curl -X POST http://127.0.0.1:PORT/__control -H "content-type: application/json" -d \'{"mode":"fail","status":500}\'');
  });
}