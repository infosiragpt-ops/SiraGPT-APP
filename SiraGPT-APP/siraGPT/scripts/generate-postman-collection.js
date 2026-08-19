#!/usr/bin/env node
/**
 * generate-postman-collection.js
 *
 * Converts docs/openapi.json into docs/postman-collection.json.
 *
 * - Selects the top N endpoints (default 30) ordered by usefulness heuristic:
 *     auth/me first, then chats, ai, files, agent, search, payments, admin, …
 * - Adds a collection-level pre-request script that auto-logs in (when
 *   `bearerToken` is empty) using `{{loginEmail}}` / `{{loginPassword}}` and
 *   caches the token in a collection variable.
 * - Adds an Authorization: Bearer {{bearerToken}} header to every request.
 *
 * Usage:
 *   node scripts/generate-postman-collection.js [--limit 30] [--out docs/postman-collection.json]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OPENAPI = path.join(ROOT, 'docs', 'openapi.json');

function parseArgs(argv) {
  const out = { limit: 30, openapi: OPENAPI, output: path.join(ROOT, 'docs', 'postman-collection.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--openapi') out.openapi = argv[++i];
    else if (a === '--out') out.output = argv[++i];
  }
  return out;
}

const PRIORITY_PREFIXES = [
  '/api/auth',
  '/api/chats',
  '/api/ai',
  '/api/files',
  '/api/agent',
  '/api/rag',
  '/api/search',
  '/api/projects',
  '/api/payments',
  '/api/plan',
  '/api/cowork',
  '/api/library',
  '/api/admin/health',
  '/api/admin/stats',
];

function priorityScore(p) {
  for (let i = 0; i < PRIORITY_PREFIXES.length; i++) {
    if (p.startsWith(PRIORITY_PREFIXES[i])) return i;
  }
  return PRIORITY_PREFIXES.length + 10;
}

function pathToPostman(p) {
  // /api/chats/{id}  →  /api/chats/:id
  return p.replace(/\{([^}]+)\}/g, ':$1');
}

function buildRequest(method, urlPath, op) {
  const postmanPath = pathToPostman(urlPath);
  const pathParts = postmanPath.replace(/^\//, '').split('/');
  const variable = [];
  for (const part of pathParts) {
    if (part.startsWith(':')) variable.push({ key: part.slice(1), value: '' });
  }

  const headers = [
    { key: 'Authorization', value: 'Bearer {{bearerToken}}' },
    { key: 'Content-Type', value: 'application/json' },
    { key: 'Accept', value: 'application/json' },
  ];

  const request = {
    method: method.toUpperCase(),
    header: headers,
    url: {
      raw: `{{baseUrl}}${postmanPath}`,
      host: ['{{baseUrl}}'],
      path: pathParts,
      variable,
    },
    description:
      (op.summary || '') + (op.description ? '\n\n' + op.description : '') ||
      `${method.toUpperCase()} ${urlPath}`,
  };

  if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    request.body = {
      mode: 'raw',
      raw: '{}',
      options: { raw: { language: 'json' } },
    };
  }
  return request;
}

function preRequestScript() {
  return [
    "// Auto-login: if {{bearerToken}} is missing, POST /api/auth/login",
    "// using {{loginEmail}} / {{loginPassword}} and cache the token.",
    "const token = pm.collectionVariables.get('bearerToken');",
    "if (!token) {",
    "  const baseUrl = pm.collectionVariables.get('baseUrl');",
    "  const email = pm.collectionVariables.get('loginEmail');",
    "  const password = pm.collectionVariables.get('loginPassword');",
    "  if (baseUrl && email && password) {",
    "    pm.sendRequest({",
    "      url: baseUrl + '/api/auth/login',",
    "      method: 'POST',",
    "      header: { 'Content-Type': 'application/json' },",
    "      body: { mode: 'raw', raw: JSON.stringify({ email, password }) },",
    "    }, (err, res) => {",
    "      if (err) { console.error('login error', err); return; }",
    "      try {",
    "        const json = res.json();",
    "        if (json && json.token) {",
    "          pm.collectionVariables.set('bearerToken', json.token);",
    "          console.log('Logged in, token cached.');",
    "        }",
    "      } catch (e) { console.error('login parse error', e); }",
    "    });",
    "  }",
    "}",
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const openapi = JSON.parse(fs.readFileSync(args.openapi, 'utf8'));

  const ops = [];
  for (const [p, methods] of Object.entries(openapi.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      ops.push({ path: p, method, op });
    }
  }

  ops.sort((a, b) => {
    const pa = priorityScore(a.path);
    const pb = priorityScore(b.path);
    if (pa !== pb) return pa - pb;
    // GET first within the same group, then POST, PUT, PATCH, DELETE
    const order = ['get', 'post', 'put', 'patch', 'delete'];
    return order.indexOf(a.method) - order.indexOf(b.method);
  });

  const selected = ops.slice(0, args.limit);

  // Group selected ops by tag / first path segment for readability.
  const folders = new Map();
  for (const entry of selected) {
    const tag = (entry.op.tags && entry.op.tags[0]) || entry.path.split('/').slice(1, 3).join('/');
    const folder = folders.get(tag) ?? { name: tag, item: [] };
    folder.item.push({
      name: `${entry.method.toUpperCase()} ${entry.path}`,
      request: buildRequest(entry.method, entry.path, entry.op),
      response: [],
    });
    folders.set(tag, folder);
  }

  const collection = {
    info: {
      _postman_id: 'siragpt-' + Date.now(),
      name: openapi.info?.title || 'siraGPT API',
      description:
        (openapi.info?.description || '') +
        `\n\nAuto-generated by scripts/generate-postman-collection.js. Includes top ${selected.length} endpoints.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{bearerToken}}', type: 'string' }],
    },
    event: [
      {
        listen: 'prerequest',
        script: { type: 'text/javascript', exec: preRequestScript() },
      },
    ],
    variable: [
      { key: 'baseUrl', value: 'http://localhost:5000', type: 'string' },
      { key: 'bearerToken', value: '', type: 'string' },
      { key: 'loginEmail', value: '', type: 'string' },
      { key: 'loginPassword', value: '', type: 'string' },
    ],
    item: Array.from(folders.values()),
  };

  fs.writeFileSync(args.output, JSON.stringify(collection, null, 2) + '\n');
  console.log(`Wrote ${args.output} (${selected.length} endpoints, ${folders.size} folders)`);
}

main();
