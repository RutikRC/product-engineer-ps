/**
 * Tiny structured logger.
 *
 * Lines are emitted as NDJSON so they can be tailed, filtered, and
 * ingested by any log pipeline. Writes go through fs.writeSync so logs
 * appear immediately even when stdout is a pipe (container/docker style
 * deployments, `node ... | beaver`, subprocess stdio). Operational
 * fields only - the event payload and response bodies are never logged,
 * so no secrets or customer data can leak into logs.
 */

import { writeSync } from 'node:fs';

export function createLogger(name = 'engine') {
  return function log(level, msg, fields = {}) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      logger: name,
      msg,
      ...fields,
    }) + '\n';
    writeSync(level === 'error' ? 2 : 1, line);
  };
}