'use strict';

/**
 * Chaos: Prisma / DB timeout.
 *
 * Verifies a route-style handler wrapped around a Prisma-like client returns
 * 503 (Service Unavailable) when the underlying query times out, instead of
 * hanging the request socket or surfacing a raw 500 with a stack trace.
 *
 * We don't need a real Express app — Node's `http` is enough to verify the
 * status + body. The "Prisma client" here is a stub whose `findMany` waits
 * past the route's deadline, so the AsyncGuard timeout fires.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const http = require('node:http');

const { AsyncGuard, GuardError } = require('../../src/utils/async-guard');

function makeSlowDb({ delayMs = 50 } = {}) {
  return {
    user: {
      findMany: () => new Promise((resolve) => setTimeout(() => resolve([]), delayMs)),
    },
  };
}

function routeWithDbDeadline(db, deadlineMs) {
  return async (req, res) => {
    const guard = new AsyncGuard({ defaultTimeoutMs: deadlineMs });
    try {
      const users = await guard.run(db.user.findMany(), { label: 'db.findMany' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ users }));
    } catch (err) {
      if (err instanceof GuardError) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'database_timeout', guardId: err.guardId }));
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  };
}

async function fetchOnce(server, path) {
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const { port } = server.address();
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  });
}

describe('chaos: DB timeout', () => {
  it('returns 503 when query exceeds the route deadline', async () => {
    const db = makeSlowDb({ delayMs: 200 });
    const handler = routeWithDbDeadline(db, 25);
    const server = http.createServer(handler);
    try {
      const { status, body } = await fetchOnce(server, '/users');
      assert.equal(status, 503);
      const parsed = JSON.parse(body);
      assert.equal(parsed.error, 'database_timeout');
      assert.ok(parsed.guardId, 'response should include guardId for tracing');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 200 when DB responds within the deadline', async () => {
    const db = makeSlowDb({ delayMs: 5 });
    const handler = routeWithDbDeadline(db, 100);
    const server = http.createServer(handler);
    try {
      const { status, body } = await fetchOnce(server, '/users');
      assert.equal(status, 200);
      assert.deepEqual(JSON.parse(body), { users: [] });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('treats a disconnect (rejected promise) as a 5xx-class error', async () => {
    const db = {
      user: {
        findMany: () => Promise.reject(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })),
      },
    };
    const handler = routeWithDbDeadline(db, 200);
    const server = http.createServer(handler);
    try {
      const { status } = await fetchOnce(server, '/users');
      // not a GuardError -> falls through to 500 branch. Documenting that
      // distinction is the point of the test: a hard reject is NOT a timeout.
      assert.equal(status, 500);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
