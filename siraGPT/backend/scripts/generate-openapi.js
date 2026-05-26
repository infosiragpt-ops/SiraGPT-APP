#!/usr/bin/env node
'use strict';

/**
 * generate-openapi — produces `backend/openapi.json` by scanning the
 * Express routes statically. Safe to run in CI without booting the
 * application.
 *
 * Usage:
 *   node scripts/generate-openapi.js                     # writes openapi.json
 *   node scripts/generate-openapi.js --check             # exit 1 if file is stale
 *   node scripts/generate-openapi.js --validate-with-swagger-cli
 */

const fs = require('fs');
const path = require('path');

const {
  scanRouteSource,
  scanMounts,
  resolveRoutes,
  buildOpenApiDocument,
  validateOpenApiDocument,
} = require('../src/services/openapi/route-scanner');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const ROUTES_DIR = path.join(BACKEND_ROOT, 'src', 'routes');
const INDEX_FILE = path.join(BACKEND_ROOT, 'index.js');
const OUTPUT_FILE = path.join(BACKEND_ROOT, 'openapi.json');
// Mirror copy under the repo-level `docs/` folder so external tooling
// (Postman imports, the docs site, contract tests in tests/) can pick
// up the spec without a backend-relative path traversal.
const DOCS_OUTPUT_FILE = path.join(REPO_ROOT, 'docs', 'openapi.json');

function generate() {
  const indexSource = fs.readFileSync(INDEX_FILE, 'utf8');
  const { mounts, imports } = scanMounts(indexSource);

  const routesByPath = new Map();
  for (const file of fs.readdirSync(ROUTES_DIR)) {
    if (!file.endsWith('.js')) continue;
    const full = path.join(ROUTES_DIR, file);
    const source = fs.readFileSync(full, 'utf8');
    let routes = [];
    try {
      routes = scanRouteSource(source);
    } catch (err) {
      // A parse failure on one file shouldn't sink the whole spec —
      // emit a warning and continue. Operators can re-run with
      // `node --check` to surface the syntax error.
      // eslint-disable-next-line no-console
      console.warn(`[openapi] skipped ${file}: ${err.message}`);
      continue;
    }
    routesByPath.set(file.replace(/\.js$/, ''), routes);
  }

  const resolved = resolveRoutes({ mounts, imports }, routesByPath);
  const doc = buildOpenApiDocument(resolved, {
    title: 'siraGPT Backend API',
    version: process.env.SIRAGPT_API_VERSION || '1.0.0',
  });

  const { valid, errors } = validateOpenApiDocument(doc);
  if (!valid) {
    // eslint-disable-next-line no-console
    console.error('[openapi] structural validation failed:', errors);
    process.exit(2);
  }

  return { doc, resolved };
}

async function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');
  const swaggerMode = args.includes('--validate-with-swagger-cli');

  const { doc, resolved } = generate();
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;

  if (checkMode) {
    const current = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf8') : '';
    const docsCurrent = fs.existsSync(DOCS_OUTPUT_FILE) ? fs.readFileSync(DOCS_OUTPUT_FILE, 'utf8') : '';
    if (current !== serialized || docsCurrent !== serialized) {
      // eslint-disable-next-line no-console
      console.error('[openapi] openapi.json is stale; run scripts/generate-openapi.js');
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(`[openapi] up-to-date (${resolved.length} routes)`);
    return;
  }

  fs.writeFileSync(OUTPUT_FILE, serialized);
  try {
    fs.mkdirSync(path.dirname(DOCS_OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(DOCS_OUTPUT_FILE, serialized);
  } catch (err) {
    // Mirror failure shouldn't break the primary write — log and
    // continue. Operators can investigate why the docs/ directory
    // isn't writable separately.
    // eslint-disable-next-line no-console
    console.warn(`[openapi] could not write docs/openapi.json: ${err.message}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[openapi] wrote ${path.relative(BACKEND_ROOT, OUTPUT_FILE)} (${resolved.length} routes)`);

  if (swaggerMode) {
    // Lazy require so the script remains usable when swagger-cli is
    // not installed locally.
    let validator;
    try {
      validator = require('@apidevtools/swagger-parser');
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[openapi] swagger-parser not installed; skipping external validation');
      return;
    }
    try {
      await validator.validate(OUTPUT_FILE);
      // eslint-disable-next-line no-console
      console.log('[openapi] swagger-parser validation passed');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[openapi] swagger-parser validation failed:', err.message);
      process.exit(3);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(99);
  });
}

module.exports = { generate };
