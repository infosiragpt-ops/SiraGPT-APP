'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-msw-handlers');
const { extractMswHandlers, buildMswHandlersForFiles, renderMswHandlersBlock, _internal } = engine;
const { classifyVersion } = _internal;

const MSW_V1_FIXTURE = `import { rest } from 'msw';
import { setupServer } from 'msw/node';

export const handlers = [
  rest.get('/api/users', (req, res, ctx) => {
    return res(ctx.status(200), ctx.json([{ id: 1 }]));
  }),
  rest.post('/api/login', (req, res, ctx) => {
    return res(ctx.delay(100), ctx.json({ token: 'x' }));
  }),
];

export const server = setupServer(...handlers);
`;

const MSW_V2_FIXTURE = `import { http, HttpResponse, graphql } from 'msw';
import { setupWorker } from 'msw/browser';

export const handlers = [
  http.get('/api/posts', () => HttpResponse.json([{ id: 1 }])),
  http.post('/api/checkout', async () => {
    return HttpResponse.json({ ok: true });
  }),
  graphql.query('GetUser', () => HttpResponse.json({ data: { user: {} } })),
  graphql.mutation('Login', () => passthrough()),
];

export const worker = setupWorker(...handlers);
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractMswHandlers('').total, 0);
  assert.equal(extractMswHandlers(null).total, 0);
});

test('non-MSW text returns empty', () => {
  const r = extractMswHandlers('Just regular text mentioning http or rest');
  assert.equal(r.total, 0);
});

test('classifyVersion: v1 / v2 / null', () => {
  assert.equal(classifyVersion('rest.get("/", () => res(ctx.json({})))'), 'v1');
  assert.equal(classifyVersion('http.get("/", () => HttpResponse.json({}))'), 'v2');
  assert.equal(classifyVersion('nothing here'), null);
});

test('detects v1 rest handlers', () => {
  const r = extractMswHandlers(MSW_V1_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'rest' && e.method === 'GET'));
  assert.ok(r.entries.some((e) => e.kind === 'rest' && e.method === 'POST'));
});

test('detects v2 http handlers', () => {
  const r = extractMswHandlers(MSW_V2_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'http' && e.method === 'GET'));
  assert.ok(r.entries.some((e) => e.kind === 'http' && e.method === 'POST'));
});

test('detects GraphQL handlers', () => {
  const r = extractMswHandlers(MSW_V2_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'graphql' && e.method === 'query'));
  assert.ok(r.entries.some((e) => e.kind === 'graphql' && e.method === 'mutation'));
});

test('detects setupServer / setupWorker', () => {
  const r1 = extractMswHandlers(MSW_V1_FIXTURE);
  assert.ok(r1.entries.some((e) => e.kind === 'setup' && e.method === 'setupServer'));

  const r2 = extractMswHandlers(MSW_V2_FIXTURE);
  assert.ok(r2.entries.some((e) => e.kind === 'setup' && e.method === 'setupWorker'));
});

test('detects HttpResponse.json (v2)', () => {
  const r = extractMswHandlers(MSW_V2_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'response' && /HttpResponse\.json/.test(e.method)));
});

test('detects ctx.json / ctx.status (v1)', () => {
  const r = extractMswHandlers(MSW_V1_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'response' && /ctx\.json|ctx\.status/.test(e.method)));
});

test('detects passthrough() / bypass()', () => {
  const r = extractMswHandlers(MSW_V2_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'passthrough' && e.method === 'passthrough'));
});

test('captures URL path patterns', () => {
  const r = extractMswHandlers('import {http} from "msw"; http.get("/api/users/:id", h);');
  assert.ok(r.entries.some((e) => e.path === '/api/users/:id'));
});

test('dedupes identical handlers', () => {
  const r = extractMswHandlers('http.get("/api/x", h); http.get("/api/x", h2);');
  assert.equal(r.entries.filter((e) => e.kind === 'http' && e.path === '/api/x').length, 1);
});

test('caps entries per file', () => {
  let text = 'import {http} from "msw"; ';
  for (let i = 0; i < 40; i++) text += `http.get("/api/r${i}", h); `;
  const r = extractMswHandlers(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractMswHandlers(MSW_V2_FIXTURE);
  assert.ok(r.totals.http >= 2);
  assert.ok(r.totals.graphql >= 2);
});

test('identifies version v1 in entries', () => {
  const r = extractMswHandlers(MSW_V1_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'version' && e.method === 'v1'));
});

test('identifies version v2 in entries', () => {
  const r = extractMswHandlers(MSW_V2_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'version' && e.method === 'v2'));
});

test('buildMswHandlersForFiles aggregates across batch', () => {
  const files = [
    { name: 'handlers-v1.js', extractedText: MSW_V1_FIXTURE },
    { name: 'handlers-v2.js', extractedText: MSW_V2_FIXTURE },
  ];
  const r = buildMswHandlersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMswHandlersBlock returns markdown when entries exist', () => {
  const files = [{ name: 'handlers.js', extractedText: MSW_V2_FIXTURE }];
  const r = buildMswHandlersForFiles(files);
  const md = renderMswHandlersBlock(r);
  assert.match(md, /^## MSW/);
});

test('renderMswHandlersBlock empty when nothing surfaces', () => {
  assert.equal(renderMswHandlersBlock({ perFile: [] }), '');
  assert.equal(renderMswHandlersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMswHandlersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: MSW_V2_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
