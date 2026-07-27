'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  scanRouteSource,
  scanMounts,
  resolveRoutes,
  buildOpenApiDocument,
  validateOpenApiDocument,
  expressPathToOpenApi,
  joinPaths,
  normalizeRequirePath,
} = require('../src/services/openapi/route-scanner');
const { generate } = require('../scripts/generate-openapi');

test('scanRouteSource extracts router.METHOD calls with literal paths', () => {
  const src = `
    const express = require('express');
    const router = express.Router();
    router.get('/items', handler);
    router.post('/items', authenticateToken, createItem);
    router.put('/items/:id', updateItem);
    module.exports = router;
  `;
  const routes = scanRouteSource(src);
  assert.equal(routes.length, 3);
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.path}`),
    ['GET /items', 'POST /items', 'PUT /items/:id'],
  );
  const post = routes.find((r) => r.method === 'POST');
  assert.equal(post.hasAuth, true, 'authenticateToken handler should mark hasAuth');
});

test('scanRouteSource ignores non-router method calls', () => {
  const src = `
    const arr = [];
    arr.get = function() {};
    arr.get('/nope');
    const router = require('express').Router();
    router.get('/yes', h);
  `;
  const routes = scanRouteSource(src);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/yes');
});

test('scanRouteSource picks up leading JSDoc comment as summary', () => {
  const src = `
    const router = require('express').Router();
    /**
     * List all items.
     * Used by the dashboard.
     */
    router.get('/items', handler);
  `;
  const [route] = scanRouteSource(src);
  assert.match(route.summary, /List all items/);
});

test('scanMounts extracts app.use mount declarations and require imports', () => {
  const src = `
    const authRoutes = require('./src/routes/auth');
    const chatRoutes = require('./src/routes/chats');
    const { router: cuRoutes } = require('./src/routes/computer-use');
    app.use('/api/auth', authRoutes);
    app.use('/api/chats', chatRoutes);
    app.use('/api/computer-use', cuRoutes);
    app.use('/api/', someMiddlewareCall());
  `;
  const { mounts, imports } = scanMounts(src);
  assert.equal(imports.get('authRoutes'), './src/routes/auth');
  assert.equal(imports.get('cuRoutes'), './src/routes/computer-use');
  assert.equal(mounts.length, 3);
  assert.deepEqual(
    mounts.map((m) => m.mountPath),
    ['/api/auth', '/api/chats', '/api/computer-use'],
  );
});

test('resolveRoutes joins mount paths with router paths and dedupes', () => {
  const mounts = [
    { mountPath: '/api/auth', identifier: 'authRoutes', line: 1 },
    { mountPath: '/api/chats', identifier: 'chatRoutes', line: 2 },
  ];
  const imports = new Map([
    ['authRoutes', './src/routes/auth'],
    ['chatRoutes', './src/routes/chats'],
  ]);
  const routesByPath = new Map([
    ['auth', [{ method: 'POST', path: '/login', line: 10, summary: null, hasAuth: false }]],
    ['chats', [{ method: 'GET', path: '/', line: 5, summary: null, hasAuth: true }]],
  ]);
  const resolved = resolveRoutes({ mounts, imports }, routesByPath);
  assert.equal(resolved.length, 2);
  assert.deepEqual(
    resolved.map((r) => `${r.method} ${r.fullPath}`),
    ['POST /api/auth/login', 'GET /api/chats'],
  );
});

test('expressPathToOpenApi converts :param to {param} and lists params', () => {
  const { path: oas, params } = expressPathToOpenApi('/projects/:projectId/documents/:docId?');
  assert.equal(oas, '/projects/{projectId}/documents/{docId}');
  assert.deepEqual(params, [
    { name: 'projectId', required: true },
    { name: 'docId', required: false },
  ]);
});

test('joinPaths normalizes slashes', () => {
  assert.equal(joinPaths('/api/chats', '/'), '/api/chats');
  assert.equal(joinPaths('/api/chats/', '/items'), '/api/chats/items');
  assert.equal(joinPaths('/api/agent', 'batch'), '/api/agent/batch');
});

test('normalizeRequirePath extracts the route module name', () => {
  assert.equal(normalizeRequirePath('./src/routes/auth'), 'auth');
  assert.equal(normalizeRequirePath('./src/routes/agent-batch.js'), 'agent-batch');
});

test('buildOpenApiDocument produces a valid 3.1 document', () => {
  const routes = [
    {
      method: 'GET',
      fullPath: '/api/items/:id',
      mountPath: '/api/items',
      source: 'items',
      summary: 'Fetch one item',
      hasAuth: true,
    },
    {
      method: 'POST',
      fullPath: '/api/items',
      mountPath: '/api/items',
      source: 'items',
      summary: null,
      hasAuth: false,
    },
  ];
  const doc = buildOpenApiDocument(routes, { title: 'Test', version: '0.1.0' });
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.title, 'Test');
  const itemPath = doc.paths['/api/items/{id}'];
  assert.ok(itemPath.get, 'GET /api/items/{id} should exist');
  assert.equal(itemPath.get.summary, 'Fetch one item');
  assert.deepEqual(itemPath.get.security, [{ bearerAuth: [] }]);
  assert.equal(itemPath.get.parameters[0].name, 'id');
  assert.equal(itemPath.get.parameters[0].in, 'path');
  assert.ok(doc.paths['/api/items'].post);
  assert.equal(doc.components.securitySchemes.bearerAuth.type, 'http');
  const { valid, errors } = validateOpenApiDocument(doc);
  assert.equal(valid, true, `validation errors: ${errors.join(', ')}`);
});

test('validateOpenApiDocument flags structural problems', () => {
  const bad = { openapi: '3.0.0', info: {}, paths: { 'no-leading-slash': {} } };
  const { valid, errors } = validateOpenApiDocument(bad);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /openapi must be/.test(e)));
  assert.ok(errors.some((e) => /must start with/.test(e)));
  assert.ok(errors.some((e) => /info\.title/.test(e)));
});

test('generated openapi.json is present, structurally valid, and covers known routes', () => {
  const specPath = path.resolve(__dirname, '..', 'openapi.json');
  if (!fs.existsSync(specPath)) {
    // The spec is regenerated by `node scripts/generate-openapi.js`.
    // Skip rather than fail a fresh checkout.
    return;
  }
  const doc = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const { valid, errors } = validateOpenApiDocument(doc);
  assert.equal(valid, true, `errors: ${errors.join(', ')}`);
  assert.equal(doc.openapi, '3.1.0');
  // Sanity: a couple of well-known routes from index.js should appear.
  assert.ok(Object.keys(doc.paths).some((p) => p.startsWith('/api/auth')));
  assert.ok(Object.keys(doc.paths).some((p) => p.startsWith('/api/agent')));
});

test('end-to-end: scanning the live backend produces 100+ routes', () => {
  const backendRoot = path.resolve(__dirname, '..');
  const indexSrc = fs.readFileSync(path.join(backendRoot, 'index.js'), 'utf8');
  const { mounts, imports } = scanMounts(indexSrc);
  assert.ok(mounts.length > 10, `expected many mounts, got ${mounts.length}`);

  const routesByPath = new Map();
  const routesDir = path.join(backendRoot, 'src', 'routes');
  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    routesByPath.set(file.replace(/\.js$/, ''), scanRouteSource(src));
  }

  const resolved = resolveRoutes({ mounts, imports }, routesByPath);
  assert.ok(resolved.length > 100, `expected >100 resolved routes, got ${resolved.length}`);
  const doc = buildOpenApiDocument(resolved);
  const { valid, errors } = validateOpenApiDocument(doc);
  assert.equal(valid, true, `errors: ${errors.join(', ')}`);
});

test('generated SE-agent metrics operation documents the shared protected policy', () => {
  const { doc } = generate();
  const operation = doc.paths['/api/se-agents/metrics']?.get;

  assert.ok(operation, 'missing GET /api/se-agents/metrics');
  assert.match(operation.summary, /socket-peer loopback/i);
  assert.match(operation.summary, /METRICS_TOKEN/);
  assert.match(operation.summary, /super-admin/i);
  assert.match(operation.summary, /API keys are denied/i);
  assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
});
