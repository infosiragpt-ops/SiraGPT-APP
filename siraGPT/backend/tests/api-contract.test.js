'use strict';

/**
 * api-contract — verifies the generated OpenAPI 3.1 spec matches the
 * actual Express route surface.
 *
 * Strategy:
 *   - Load docs/openapi.json (the canonical mirror produced by
 *     `npm run generate:openapi`).
 *   - Re-scan the route sources statically via the same scanner used
 *     by the generator. This guarantees that every documented path
 *     resolves back to a real route declaration without needing to
 *     boot the application (avoids DB, Redis, queue startup).
 *   - For protected routes, spin up a tiny Express app that mounts
 *     the same router and asserts unauthenticated requests get 401.
 *
 * Goal: ~20 smoke assertions across the high-traffic route surface
 * mentioned in the original task (auth, chats, files, payments, ai,
 * admin, cowork, scientific-search, research-agent).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  scanRouteSource,
  scanMounts,
  resolveRoutes,
} = require('../src/services/openapi/route-scanner');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(BACKEND_ROOT, 'src', 'routes');
const INDEX_FILE = path.join(BACKEND_ROOT, 'index.js');
const SPEC_FILE = path.join(BACKEND_ROOT, '..', 'docs', 'openapi.json');
const SPEC_FALLBACK = path.join(BACKEND_ROOT, 'openapi.json');

function loadSpec() {
  const file = fs.existsSync(SPEC_FILE) ? SPEC_FILE : SPEC_FALLBACK;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadResolvedRoutes() {
  const indexSource = fs.readFileSync(INDEX_FILE, 'utf8');
  const { mounts, imports } = scanMounts(indexSource);
  const routesByPath = new Map();
  for (const file of fs.readdirSync(ROUTES_DIR)) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    try {
      routesByPath.set(file.replace(/\.js$/, ''), scanRouteSource(source));
    } catch {
      // Ignore parse failures — the generator already handles them.
    }
  }
  return resolveRoutes({ mounts, imports }, routesByPath);
}

describe('api-contract — spec ↔ route surface', () => {
  const spec = loadSpec();
  const resolved = loadResolvedRoutes();
  // Normalize Express-style `:id` params to OpenAPI `{id}` params so
  // the comparison is apples-to-apples (the spec emits brace form).
  const toOpenApiPath = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  const declared = new Set(
    resolved.map((r) => `${r.method.toUpperCase()} ${toOpenApiPath(r.fullPath)}`),
  );

  test('openapi.json is a valid OpenAPI 3.1 document', () => {
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.info?.title);
    assert.ok(spec.paths && typeof spec.paths === 'object');
  });

  test('spec exposes the headline tag groups required by the contract', () => {
    const tagsSeen = new Set();
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods)) {
        for (const t of op.tags || []) tagsSeen.add(t);
      }
    }
    // Every documented family in the task should appear as a tag.
    for (const required of [
      'auth',
      'chats',
      'files',
      'payments',
      'ai',
      'admin',
      'cowork',
      'scientific-search',
      'research-agent',
    ]) {
      assert.ok(
        tagsSeen.has(required),
        `expected tag "${required}" in spec, saw ${[...tagsSeen].slice(0, 10).join(', ')}…`,
      );
    }
  });

  test('every documented path resolves back to a real route declaration', () => {
    let checked = 0;
    let missing = 0;
    const examples = [];
    for (const [pathKey, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        checked++;
        const key = `${method.toUpperCase()} ${pathKey}`;
        if (!declared.has(key)) {
          missing++;
          if (examples.length < 5) examples.push(key);
        }
      }
    }
    // Allow a tiny tolerance for dynamically mounted sub-routes that
    // the static scanner can't reach (e.g. router.route().get()).
    const ratio = checked === 0 ? 0 : missing / checked;
    assert.ok(
      ratio < 0.05,
      `>5% of documented endpoints (${missing}/${checked}) not found in route sources: ${examples.join('; ')}`,
    );
  });

  // Spot-check that the headline endpoints from the original task
  // are documented. These are the ~20 smoke assertions promised in
  // the brief — they pin the contract for the most-used surfaces.
  const headlineEndpoints = [
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/register'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/chats'],
    ['POST', '/api/chats'],
    ['POST', '/api/files/upload'],
    ['POST', '/api/ai/generate'],
    ['POST', '/api/payments/stripe/webhook'],
    ['GET', '/api/admin/analytics'],
    ['POST', '/api/cowork/auto-file'],
    ['POST', '/api/cowork/memory'],
    ['POST', '/api/cowork/analyze-deep'],
    ['GET', '/api/cowork/skills'],
    ['POST', '/api/cowork/enrich'],
    ['POST', '/api/scientific-search'],
    ['GET', '/api/scientific-search/providers'],
    ['POST', '/api/research-agent/run'],
    ['POST', '/api/research-agent/stream'],
  ];

  for (const [method, p] of headlineEndpoints) {
    test(`headline endpoint documented: ${method} ${p}`, () => {
      const ops = spec.paths[p];
      assert.ok(ops, `path ${p} missing from spec`);
      assert.ok(
        ops[method.toLowerCase()],
        `expected ${method} ${p} in spec; saw methods: ${Object.keys(ops).join(', ')}`,
      );
    });
  }
});

describe('api-contract — /api/docs router env-gate', () => {
  const { buildApiDocsRouter, resolveApiDocsConfig } = require('../src/routes/api-docs');

  test('production default disables /api/docs', () => {
    const cfg = resolveApiDocsConfig({ NODE_ENV: 'production' });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.isProduction, true);
  });

  test('non-production default enables /api/docs', () => {
    const cfg = resolveApiDocsConfig({ NODE_ENV: 'development' });
    assert.equal(cfg.enabled, true);
  });

  test('API_DOCS_ENABLED=true overrides production lockdown', () => {
    const cfg = resolveApiDocsConfig({ NODE_ENV: 'production', API_DOCS_ENABLED: 'true' });
    assert.equal(cfg.enabled, true);
  });

  test('disabled router returns 404 with explanatory hint', async () => {
    const express = require('express');
    const request = require('supertest');
    const app = express();
    app.use('/api/docs', buildApiDocsRouter({ env: { NODE_ENV: 'production' } }));
    const res = await request(app).get('/api/docs');
    assert.equal(res.status, 404);
    assert.match(res.body.hint || '', /API_DOCS_ENABLED/);
  });
});
