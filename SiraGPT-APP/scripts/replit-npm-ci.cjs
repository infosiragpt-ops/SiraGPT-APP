#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const npmArgs = process.argv.slice(2);
if (npmArgs.length === 0) {
  console.error('Usage: node scripts/replit-npm-ci.cjs [npm args...]');
  process.exit(2);
}

const attempts = Number(process.env.REPLIT_NPM_CI_ATTEMPTS || 4);
const baseDelayMs = Number(process.env.REPLIT_NPM_CI_RETRY_DELAY_MS || 8000);

const env = {
  ...process.env,
  HUSKY: process.env.HUSKY || '0',
  npm_config_fetch_retries: process.env.npm_config_fetch_retries || '5',
  npm_config_fetch_retry_factor: process.env.npm_config_fetch_retry_factor || '2',
  npm_config_fetch_retry_mintimeout: process.env.npm_config_fetch_retry_mintimeout || '10000',
  npm_config_fetch_retry_maxtimeout: process.env.npm_config_fetch_retry_maxtimeout || '120000',
};

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let lastStatus = 1;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  console.log(`[replit-npm-ci] npm ${npmArgs.join(' ')} attempt ${attempt}/${attempts}`);
  const result = spawnSync('npm', npmArgs, {
    env,
    stdio: 'inherit',
  });

  if (result.status === 0) {
    process.exit(0);
  }

  lastStatus = result.status || 1;
  if (attempt < attempts) {
    const delayMs = baseDelayMs * attempt;
    console.error(`[replit-npm-ci] npm failed with status ${lastStatus}; retrying in ${delayMs}ms`);
    sleep(delayMs);
  }
}

console.error(`[replit-npm-ci] npm ${npmArgs.join(' ')} failed after ${attempts} attempts`);
process.exit(lastStatus);
