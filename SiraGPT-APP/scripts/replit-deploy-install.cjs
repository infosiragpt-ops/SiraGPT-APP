#!/usr/bin/env node
'use strict';

// Runs the root and backend `npm ci` installs CONCURRENTLY during the
// Replit deployment build.
//
// Why: the deploy build phase has a hard time limit (~15 min on the
// e2-standard-2 builder). Running the two cold installs sequentially
// (root ~8 min + backend ~7 min) consumed the entire budget, so
// `next build` never started and the build was killed. Running them in
// parallel collapses the install phase to ~max(root, backend) and leaves
// room for `next build`.
//
// Each install still goes through scripts/replit-npm-ci.cjs so the
// transient-failure retry behavior is preserved. Audit/fund are skipped
// (a separate security-scan phase already runs) and the npm cache is
// preferred to shave more time off.

const { spawn } = require('node:child_process');
const path = require('node:path');

const WRAPPER = path.join(__dirname, 'replit-npm-ci.cjs');
const SPEEDUP_FLAGS = ['--no-audit', '--no-fund', '--prefer-offline'];

function run(label, command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const wire = (stream, out) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) out.write(`[${label}] ${line}\n`);
      });
      stream.on('end', () => {
        if (buf) out.write(`[${label}] ${buf}\n`);
      });
    };

    wire(child.stdout, process.stdout);
    wire(child.stderr, process.stderr);

    child.on('error', (err) => {
      process.stderr.write(`[${label}] spawn error: ${err.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code == null ? 1 : code));
  });
}

async function main() {
  console.log('[replit-deploy-install] running root + backend npm ci in parallel');
  const started = Date.now();

  const [rootCode, backendCode] = await Promise.all([
    run('root', 'node', [WRAPPER, 'ci', ...SPEEDUP_FLAGS]),
    run('backend', 'node', [WRAPPER, '--prefix', 'backend', 'ci', ...SPEEDUP_FLAGS]),
  ]);

  const elapsed = Math.round((Date.now() - started) / 1000);
  if (rootCode !== 0 || backendCode !== 0) {
    console.error(
      `[replit-deploy-install] install failed after ${elapsed}s (root=${rootCode}, backend=${backendCode})`,
    );
    process.exit(rootCode || backendCode || 1);
  }
  console.log(`[replit-deploy-install] both installs completed in ${elapsed}s`);
}

if (require.main === module) {
  main();
}

module.exports = { run };
