'use strict';

// Prod 2026-09-27: /api/search/agentic sent nothing for ~70 s while the LLM
// re-ranked; the edge proxy cut the idle stream at ~100 s and the user saw
// «Búsqueda fallida: network error» while the run went on.
process.env.SIRAGPT_AGENTIC_HEARTBEAT_MS = '300';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const src = path.join(__dirname, '..', 'src');
function stub(rel, exports) {
  const file = require.resolve(path.join(src, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

let run = null;
stub('middleware/auth', { authenticateToken: (req, _res, next) => { req.user = { id: 'user-1' }; next(); } });
stub('services/searchBrain/agenticBatch', {
  DEFAULT_PROVIDERS: ['openalex'],
  async *runAgenticBatch({ signal }) {
    run = { signal, release: null };
    yield { type: 'start' };
    // A silent phase (LLM re-ranking) until the test releases it or the client leaves.
    await new Promise((resolve) => {
      run.release = resolve;
      signal.addEventListener('abort', resolve, { once: true });
    });
    if (signal.aborted) return;
    yield { type: 'summary', markdown: '## Resultado' };
  },
});
const router = require('../src/routes/search-agentic');

async function listen(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/search', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

function post(port, onData) {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/search/agentic',
    headers: { 'content-type': 'application/json' } });
  const done = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; onData(body, req); });
      res.on('end', () => resolve(body));
      res.on('error', () => resolve(body));
    });
    req.on('error', (error) => (error.code === 'ECONNRESET' ? resolve('') : reject(error)));
  });
  req.end(JSON.stringify({ query: 'noticias de hoy en Lima' }));
  return done;
}

test('a silent phase keeps the stream alive with SSE comments until the report arrives', async (t) => {
  const port = await listen(t);
  const body = await post(port, (sofar) => {
    if ((sofar.match(/^: ping$/gm) || []).length >= 2) run.release();
  });
  assert.ok((body.match(/^: ping$/gm) || []).length >= 2, 'heartbeat comments during the quiet phase');
  assert.match(body, /"type":"summary"/);
  assert.match(body, /"type":"saved"/);
});

test('a client that leaves aborts the run instead of letting it finish unseen', async (t) => {
  const port = await listen(t);
  await post(port, (sofar, req) => {
    if (sofar.includes('"type":"start"')) req.destroy();
  });
  for (let i = 0; i < 50 && !run.signal.aborted; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(run.signal.aborted, true);
});
