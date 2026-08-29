#!/usr/bin/env node
'use strict';

// Ensures root dependencies exist and installs backend production dependencies
// during the Replit deployment build.
//
// Replit's GCE builder currently runs a root `npm install` before this custom
// build command. Re-running `npm ci` for the root creates a second multi-GB
// dependency layer; deleting node_modules in a later layer does not reclaim
// those bytes and can push the final image over Replit's 8 GiB limit.
//
// Reuse the hosting-installed root tree when the packages required by the
// build are present. Keep a cold-build fallback so this script remains usable
// if the hosting preinstall is skipped in another environment.
//
// Each install still goes through scripts/replit-npm-ci.cjs so the
// transient-failure retry behavior is preserved. Audit/fund are skipped
// (a separate security-scan phase already runs) and the npm cache is
// preferred to shave more time off.

const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const WRAPPER = path.join(__dirname, 'replit-npm-ci.cjs');
const SPEEDUP_FLAGS = ['--no-audit', '--no-fund', '--prefer-offline'];
const ROOT = path.join(__dirname, '..');

function rootDependenciesReady(root = ROOT) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const expectedNext = lock.packages?.['node_modules/next']?.version;
    const installedNext = JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules', 'next', 'package.json'), 'utf8'),
    ).version;
    if (!expectedNext || installedNext !== expectedNext) return false;

    const result = spawnSync(
      'npm',
      ['ls', '--depth=0', '--include=dev', '--json'],
      {
        cwd: root,
        env: process.env,
        stdio: 'ignore',
      },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

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
  const reuseRoot = rootDependenciesReady();
  console.log(
    reuseRoot
      ? '[replit-deploy-install] reusing hosting-installed root dependencies; installing backend production dependencies'
      : '[replit-deploy-install] root dependencies missing; running root + backend installs in parallel',
  );
  const started = Date.now();

  const [rootCode, backendCode] = await Promise.all([
    reuseRoot
      ? Promise.resolve(0)
      : run('root', 'node', [WRAPPER, 'ci', ...SPEEDUP_FLAGS]),
    run('backend', 'node', [
      WRAPPER,
      '--prefix',
      'backend',
      'ci',
      '--omit=dev',
      ...SPEEDUP_FLAGS,
    ]),
  ]);

  const elapsed = Math.round((Date.now() - started) / 1000);
  if (rootCode !== 0 || backendCode !== 0) {
    console.error(
      `[replit-deploy-install] install failed after ${elapsed}s (root=${rootCode}, backend=${backendCode})`,
    );
    process.exit(rootCode || backendCode || 1);
  }
  console.log(`[replit-deploy-install] dependency setup completed in ${elapsed}s`);
}

if (require.main === module) {
  main();
}

module.exports = { rootDependenciesReady, run };
