#!/usr/bin/env node
'use strict';

/**
 * load-test.js — autocannon-driven load test against a local backend.
 *
 * Targets (read-only by default; auth flow is opt-in):
 *   - GET  /api/scientific-search/providers   (cached endpoint)
 *   - GET  /api/ai/models                     (cached endpoint)
 *   - POST /api/auth/login                    (full auth flow; requires creds)
 *
 * Usage:
 *   node backend/scripts/load-test.js                # default targets
 *   node backend/scripts/load-test.js --target providers
 *   node backend/scripts/load-test.js --target login \
 *        --email u@x --password pw
 *   node backend/scripts/load-test.js --url http://localhost:5000 \
 *        --connections 50 --duration 10
 *
 * Defaults: 50 connections, 10 seconds. Histogram + p50/p95/p99 printed.
 *
 * `autocannon` is a devDependency; if missing, the script prints an
 * install hint instead of crashing.
 */

let autocannon;
try {
  autocannon = require('autocannon');
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[load-test] autocannon is not installed. Run:');
  console.error('             npm i -D autocannon');
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    url: process.env.LOAD_TEST_URL || 'http://localhost:5000',
    connections: 50,
    duration: 10,
    target: 'all',
    email: process.env.LOAD_TEST_EMAIL || null,
    password: process.env.LOAD_TEST_PASSWORD || null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--url': args.url = v; i += 1; break;
      case '--connections': args.connections = Number(v); i += 1; break;
      case '--duration': args.duration = Number(v); i += 1; break;
      case '--target': args.target = v; i += 1; break;
      case '--email': args.email = v; i += 1; break;
      case '--password': args.password = v; i += 1; break;
      case '--help':
      case '-h':
        // eslint-disable-next-line no-console
        console.log(`Usage:
  node backend/scripts/load-test.js [--target all|providers|models|login]
                                    [--url http://host:port]
                                    [--connections N] [--duration SEC]
                                    [--email u --password p]`);
        process.exit(0);
        break;
      default:
        // ignore unknown flags
        break;
    }
  }
  return args;
}

function runOne(name, opts) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${name} ===`);
    const instance = autocannon(opts, (err, result) => {
      if (err) return reject(err);
      // Histogram + percentiles printed manually because the default
      // tracker prints during the run and we want a stable summary too.
      // eslint-disable-next-line no-console
      console.log(`  latency p50=${result.latency.p50}ms p95=${result.latency.p95}ms p99=${result.latency.p99}ms max=${result.latency.max}ms`);
      // eslint-disable-next-line no-console
      console.log(`  req/s   avg=${result.requests.average} stddev=${result.requests.stddev}`);
      // eslint-disable-next-line no-console
      console.log(`  errors  non2xx=${result.non2xx} timeouts=${result.timeouts}`);
      resolve(result);
    });
    autocannon.track(instance, { renderProgressBar: true });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const baseOpts = {
    url: args.url,
    connections: args.connections,
    duration: args.duration,
  };

  const targets = args.target === 'all'
    ? ['providers', 'models', 'login']
    : [args.target];

  for (const t of targets) {
    if (t === 'providers') {
      // eslint-disable-next-line no-await-in-loop
      await runOne('GET /api/scientific-search/providers', {
        ...baseOpts,
        method: 'GET',
        path: '/api/scientific-search/providers',
      });
    } else if (t === 'models') {
      // eslint-disable-next-line no-await-in-loop
      await runOne('GET /api/ai/models', {
        ...baseOpts,
        method: 'GET',
        path: '/api/ai/models',
      });
    } else if (t === 'login') {
      if (!args.email || !args.password) {
        // eslint-disable-next-line no-console
        console.log('[load-test] skipping login: --email and --password required');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await runOne('POST /api/auth/login', {
        ...baseOpts,
        method: 'POST',
        path: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: args.email, password: args.password }),
      });
    } else {
      // eslint-disable-next-line no-console
      console.error(`[load-test] unknown target: ${t}`);
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[load-test] failed:', err);
  process.exit(1);
});
