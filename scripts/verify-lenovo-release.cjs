#!/usr/bin/env node
'use strict';

const ORIGIN = 'https://siragpt.com';

async function verifyRelease(sha, { fetchImpl = globalThis.fetch } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('A full lowercase commit SHA is required');
  const get = async (pathname) => {
    const response = await fetchImpl(`${ORIGIN}${pathname}`, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    });
    if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}`);
    return response.json();
  };
  const [version, ready] = await Promise.all([get('/api/version'), get('/api/health/ready')]);
  if (version?.commit !== sha) throw new Error('Live release commit does not match the approved target');
  if (ready?.status !== 'healthy' || !Array.isArray(ready.checks)) throw new Error('Live readiness is not healthy');
  for (const name of ['database', 'redis', 'migrations']) {
    const checks = ready.checks.filter((item) => item.name === name);
    if (checks.length !== 1 || checks[0].status !== 'healthy') throw new Error(`Readiness check ${name} is not healthy`);
  }
  if (ready.checks.some((item) => item.critical && item.status !== 'healthy')) {
    throw new Error('A critical readiness check is not healthy');
  }
  return { commit: sha, status: 'healthy' };
}

if (require.main === module) {
  verifyRelease(process.argv[2]).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    // Never include raw HTTP bodies, headers, environment or credentials.
    console.error(`[release-verify] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { verifyRelease };
