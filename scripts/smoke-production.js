#!/usr/bin/env node
'use strict';

const dns = require('node:dns').promises;

const DEFAULT_FRONTEND = process.env.FRONTEND_URL || 'https://siragpt.com';
const DEFAULT_API = process.env.API_URL || 'https://api.siragpt.com';

function parseArgs(argv) {
  const args = {
    frontendUrl: DEFAULT_FRONTEND,
    apiUrl: DEFAULT_API,
    timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS || 10_000),
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--frontend-url') args.frontendUrl = argv[++i];
    else if (arg === '--api-url') args.apiUrl = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/smoke-production.js [options]

Black-box production smoke test for SiraGPT.

Options:
  --frontend-url <url>  Frontend origin (default: ${DEFAULT_FRONTEND})
  --api-url <url>       API origin (default: ${DEFAULT_API})
  --timeout-ms <ms>     Timeout per request (default: 10000)
  --json                Print machine-readable JSON
`);
}

async function withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProbe(name, url, options = {}) {
  const started = Date.now();
  try {
    const response = await withTimeout(
      (signal) => fetch(url, {
        method: options.method || 'GET',
        redirect: options.redirect || 'follow',
        signal,
      }),
      options.timeoutMs,
    );

    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : null;
    const ok = options.expect
      ? options.expect(response, body)
      : response.status >= 200 && response.status < 500;

    return {
      status: ok ? 'pass' : 'fail',
      name,
      message: `${response.status} ${response.statusText}`.trim(),
      latency_ms: Date.now() - started,
      url,
      http_status: response.status,
      body_status: body && typeof body === 'object' ? body.status : undefined,
    };
  } catch (error) {
    return {
      status: 'fail',
      name,
      message: error && error.name === 'AbortError' ? 'timeout' : String(error && error.message || error),
      latency_ms: Date.now() - started,
      url,
    };
  }
}

async function dnsProbe(name, hostname) {
  const started = Date.now();
  try {
    const addresses = await dns.resolve4(hostname);
    return {
      status: addresses.length > 0 ? 'pass' : 'fail',
      name,
      message: addresses.length > 0 ? addresses.join(', ') : 'no A records',
      latency_ms: Date.now() - started,
      hostname,
    };
  } catch (error) {
    return {
      status: 'fail',
      name,
      message: error && error.message ? error.message : String(error),
      latency_ms: Date.now() - started,
      hostname,
    };
  }
}

function originUrl(raw) {
  const url = new URL(raw);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function joinUrl(base, path) {
  const url = new URL(base);
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function runSmoke(options) {
  const frontend = originUrl(options.frontendUrl);
  const api = originUrl(options.apiUrl);
  const frontendHost = new URL(frontend).hostname;
  const apiHost = new URL(api).hostname;

  const checks = [];
  checks.push(await dnsProbe('dns:frontend', frontendHost));
  checks.push(await dnsProbe('dns:api', apiHost));
  checks.push(await fetchProbe('web:/', joinUrl(frontend, '/'), { timeoutMs: options.timeoutMs }));
  checks.push(await fetchProbe('web:/chat', joinUrl(frontend, '/chat'), { timeoutMs: options.timeoutMs }));
  checks.push(await fetchProbe('web:/api/health/live', joinUrl(frontend, '/api/health/live'), {
    timeoutMs: options.timeoutMs,
    expect: (response, body) => response.status === 200 && body && body.status,
  }));
  checks.push(await fetchProbe('api:/health/live', joinUrl(api, '/health/live'), {
    timeoutMs: options.timeoutMs,
    expect: (response, body) => response.status === 200 && body && body.status,
  }));
  checks.push(await fetchProbe('api:/health/ready', joinUrl(api, '/health/ready'), {
    timeoutMs: options.timeoutMs,
    expect: (response, body) => response.status < 500 && body && body.status,
  }));
  checks.push(await fetchProbe('api:/health', joinUrl(api, '/health'), {
    timeoutMs: options.timeoutMs,
    expect: (response, body) => response.status === 200 && body && body.status,
  }));
  checks.push(await fetchProbe('api:auth-gate', joinUrl(api, '/api/auth/me'), {
    timeoutMs: options.timeoutMs,
    expect: (response) => [401, 403, 429].includes(response.status),
  }));

  const failures = checks.filter((check) => check.status === 'fail').length;
  return {
    ok: failures === 0,
    frontend,
    api,
    timestamp: new Date().toISOString(),
    failures,
    checks,
  };
}

function printReport(report) {
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'ok' : 'fail';
    const latency = Number.isFinite(check.latency_ms) ? ` (${check.latency_ms}ms)` : '';
    console.log(`[${mark}] ${check.name}: ${check.message}${latency}`);
  }
  console.log(`\nproduction smoke: ${report.ok ? 'ok' : 'failed'} (${report.failures} failure(s))`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const report = await runSmoke(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (!report.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[smoke-production] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runSmoke,
};
