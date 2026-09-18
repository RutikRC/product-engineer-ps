/**
 * Test helper: a local scripted webhook receiver.
 *
 * Tests drive responses through a responder function - statuses,
 * headers, bodies, or a socket destroy (simulating a network error).
 * No sleeps are involved: every delivery goes over real HTTP to this
 * process-local server and returns immediately.
 */

import { createServer } from 'node:http';

export async function startScriptedReceiver(initialResponder = null) {
  const hits = [];
  /** @type {function(object): Promise<{status?:number,body?:object,headers?:object,destroy?:boolean}>} */
  let responder = initialResponder ?? (async () => ({ status: 200, body: { ok: true } }));

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const hit = {
      method: req.method,
      url: req.url,
      body,
      idempotencyKey: req.headers['idempotency-key'] ?? null,
      at: new Date(),
    };
    hits.push(hit);

    let result;
    try {
      result = await responder(hit);
    } catch (err) {
      result = { status: 500, body: { error: `responder threw: ${err.message}` } };
    }
    result ??= { status: 200, body: { ok: true } };

    if (result.destroy) {
      // Close the connection without a response -> client sees a network error.
      req.socket?.destroy?.();
      return;
    }

    const { status = 200, body: responseBody = { ok: true }, headers = {} } = result;
    res.writeHead(status, {
      'content-type': 'application/json',
      connection: 'close', // the client owns connection pooling; tests must exit cleanly
      ...headers,
    });
    res.end(JSON.stringify(responseBody));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    url: `http://127.0.0.1:${port}/webhook`,
    hits,
    setResponder(fn) {
      responder = fn;
    },
    async close() {
      server.close();
    },
  };
}

/** Always respond with one HTTP status. */
export const statusResponder = (status) => async () => ({
  status,
  body: { error: `mock ${status}` },
});

/**
 * Respond with each status in order (last entry repeats). Use 'destroy'
 * as a step to simulate a network error.
 */
export function sequenceResponder(stepList) {
  let i = 0;
  return async () => {
    const step = stepList[Math.min(i, stepList.length - 1)];
    i += 1;
    if (step === 'destroy') return { destroy: true };
    return { status: step, body: { error: `mock ${step}` } };
  };
}

/** Respond with a specific status + headers + body on every request. */
export const detailedResponder = ({ status, headers = {}, body = null }) => async () => ({
  status,
  headers,
  body: body ?? { error: `mock ${status}` },
});