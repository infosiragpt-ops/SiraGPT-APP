#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const DEFAULT_ENDPOINTS = [
  { name: 'api_live', url: '/health/live', expect: 200, critical: true },
  { name: 'api_ready', url: '/health/ready', expect: 200, critical: true },
  { name: 'api_health', url: '/health', expect: 200, critical: true },
];

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.DOCTOR_BASE_URL || 'https://api.siragpt.com',
    timeoutMs: Number(process.env.DOCTOR_TIMEOUT_MS || 5000),
    skipNetwork: false,
    json: false,
    strict: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--skip-network') args.skipNetwork = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/doctor-production.js [options]

Checks production readiness without printing secret values.

Options:
  --base-url <url>     API origin to probe (default: https://api.siragpt.com)
  --timeout-ms <ms>    Network timeout per probe (default: 5000)
  --skip-network       Run only local/static checks
  --json               Print JSON report
  --strict             Exit non-zero on warnings as well as failures
`);
}

function checkCommand(name) {
  const result = spawnSync('bash', ['-lc', `command -v ${name}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function runCommand(command, args, opts = {}) {
  return spawnSync(command, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || 5000,
  });
}

function hasExecutableBit(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function maskUrlForHost(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.hostname;
  } catch {
    return '';
  }
}

function isLocalhostUrl(raw) {
  const host = maskUrlForHost(raw);
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host);
}

function add(report, status, name, message, meta = {}) {
  report.checks.push({ status, name, message, ...meta });
}

function collectStaticChecks(env = process.env, root = ROOT) {
  const report = { ok: true, warnings: 0, failures: 0, checks: [] };
  const requiredFiles = [
    'scripts/deploy-with-rollback.sh',
    'scripts/deploy-production.sh',
    'scripts/smoke-deployment.sh',
    '.github/workflows/deploy.yml',
    '.github/workflows/inspect-logs.yml',
  ];

  for (const rel of requiredFiles) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) add(report, 'pass', `file:${rel}`, 'required operations file exists');
    else add(report, 'fail', `file:${rel}`, 'required operations file is missing');
  }

  for (const rel of ['scripts/deploy-with-rollback.sh', 'scripts/deploy-production.sh']) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    if (hasExecutableBit(full)) add(report, 'pass', `exec:${rel}`, 'script is executable');
    else add(report, 'warn', `exec:${rel}`, 'script is not executable; deploy workflow chmods it, but local ops may fail');
  }

  for (const cmd of ['git', 'node', 'npm', 'curl']) {
    if (checkCommand(cmd)) add(report, 'pass', `cmd:${cmd}`, 'command is available');
    else add(report, 'fail', `cmd:${cmd}`, 'command is missing from PATH');
  }

  const pm2Default = env.PM2_APP || 'siraGPT-api';
  if (pm2Default === 'siraGPT-api') {
    add(report, 'pass', 'pm2:default-name', 'PM2 default matches backend ecosystem config');
  } else {
    add(report, 'warn', 'pm2:default-name', `PM2_APP is ${pm2Default}; expected siraGPT-api unless intentionally overridden`);
  }

  const dbUrl = env.PRISMA_DATABASE_URL || env.DATABASE_URL || '';
  if (!dbUrl) {
    add(report, 'warn', 'env:database-url', 'database URL is not present in current environment');
  } else if (isLocalhostUrl(dbUrl) && env.DATABASE_URL_LOCALHOST_POLICY === 'block') {
    add(report, 'fail', 'env:database-url', 'localhost database URL is configured while DATABASE_URL_LOCALHOST_POLICY=block');
  } else if (isLocalhostUrl(dbUrl)) {
    add(report, 'warn', 'env:database-url', 'database URL points to localhost; valid for same-host Postgres/sidecar only');
  } else {
    add(report, 'pass', 'env:database-url', `database URL host is non-local (${maskUrlForHost(dbUrl)})`);
  }

  finalize(report);
  return report;
}

async function probeEndpoint(endpoint, baseUrl, timeoutMs) {
  const url = endpoint.url.startsWith('http') ? endpoint.url : `${baseUrl.replace(/\/$/, '')}${endpoint.url}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      status: response.status === endpoint.expect ? 'pass' : (endpoint.critical ? 'fail' : 'warn'),
      name: `http:${endpoint.name}`,
      message: `${url} returned ${response.status}`,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      status: endpoint.critical ? 'fail' : 'warn',
      name: `http:${endpoint.name}`,
      message: `${url} failed: ${error.name === 'AbortError' ? 'timeout' : error.message}`,
      latency_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runDoctor(options = {}) {
  const args = {
    baseUrl: options.baseUrl || 'https://api.siragpt.com',
    timeoutMs: options.timeoutMs || 5000,
    skipNetwork: Boolean(options.skipNetwork),
    env: options.env || process.env,
    root: options.root || ROOT,
  };
  const report = collectStaticChecks(args.env, args.root);

  if (!args.skipNetwork) {
    for (const endpoint of DEFAULT_ENDPOINTS) {
      report.checks.push(await probeEndpoint(endpoint, args.baseUrl, args.timeoutMs));
    }
  }

  finalize(report);
  return report;
}

function finalize(report) {
  report.failures = report.checks.filter((check) => check.status === 'fail').length;
  report.warnings = report.checks.filter((check) => check.status === 'warn').length;
  report.ok = report.failures === 0;
  return report;
}

function printReport(report) {
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'ok' : check.status;
    const latency = Number.isFinite(check.latency_ms) ? ` (${check.latency_ms}ms)` : '';
    console.log(`[${mark}] ${check.name}: ${check.message}${latency}`);
  }
  console.log(`\nproduction doctor: ${report.ok ? 'ok' : 'failed'} (${report.failures} failure(s), ${report.warnings} warning(s))`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const report = await runDoctor(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (!report.ok || (args.strict && report.warnings > 0)) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[production-doctor] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  collectStaticChecks,
  isLocalhostUrl,
  parseArgs,
  runDoctor,
};
