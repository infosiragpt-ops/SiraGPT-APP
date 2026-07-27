'use strict';

const { randomBytes } = require('node:crypto');
const browserCheck = require('./browser-check');

const DEFAULT_PROJECT_ID = 'sira-runtime-canary';
const DEFAULT_BASE_PATH = '/__sira_runtime_canary__/';
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_RENDER_ATTEMPTS = 6;

class RuntimeCanaryError extends Error {
  constructor(phase, message, evidence = null) {
    super(`${phase}: ${message}`);
    this.name = 'RuntimeCanaryError';
    this.phase = phase;
    this.evidence = evidence;
  }
}

function canaryId() {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function appSource(marker) {
  return `import React from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

function App() {
  return (
    <main>
      <p>SiraGPT runtime canary</p>
      <h1>${marker}</h1>
    </main>
  )
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>,
)
`;
}

function canaryFiles(marker) {
  return [
    {
      path: '.gitignore',
      content: 'node_modules/\ndist/\n',
    },
    {
      path: 'package.json',
      content: `${JSON.stringify({
        name: 'sira-runtime-canary',
        private: true,
        version: '1.0.0',
        type: 'module',
        scripts: {
          dev: 'vite',
          build: 'vite build',
        },
        dependencies: {
          react: '^18.3.1',
          'react-dom': '^18.3.1',
        },
        devDependencies: {
          vite: '^7.0.0',
        },
      }, null, 2)}\n`,
    },
    {
      path: 'index.html',
      content: '<!doctype html><html><head><meta charset="UTF-8"><title>Sira runtime canary</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
    },
    {
      path: 'vite.config.js',
      content: `import { defineConfig } from 'vite'

const port = Number(process.env.PORT) || 5173
const base = process.env.VITE_BASE || '/'

export default defineConfig({
  base,
  server: { host: true, allowedHosts: true, port, strictPort: true },
})
`,
    },
    {
      path: 'src/main.jsx',
      content: appSource(marker),
    },
    {
      path: 'src/style.css',
      content: 'html{font-family:system-ui,sans-serif;background:#fff;color:#111}body{margin:0}main{min-height:100vh;display:grid;place-content:center;text-align:center}h1{font-size:2rem}p{color:#555}\n',
    },
  ];
}

async function checkedExec(runner, projectId, command, phase, timeoutMs = 180_000) {
  const result = await runner.exec(projectId, command, { timeoutMs });
  if (result?.exitCode !== 0) {
    throw new RuntimeCanaryError(
      phase,
      `command failed (${command.join(' ')})`,
      String(result?.stderr || result?.stdout || '').slice(0, 2_000),
    );
  }
  return result;
}

async function commitIteration(runner, projectId, label) {
  await checkedExec(runner, projectId, ['git', 'add', '-A'], `${label}.git_add`, 30_000);
  await checkedExec(
    runner,
    projectId,
    [
      'git',
      '-c',
      'user.name=SiraGPT Runtime Canary',
      '-c',
      'user.email=runtime-canary@siragpt.local',
      'commit',
      '-m',
      `test(code): runtime canary ${label}`,
    ],
    `${label}.git_commit`,
    30_000,
  );
  const head = await checkedExec(runner, projectId, ['git', 'rev-parse', 'HEAD'], `${label}.git_head`, 30_000);
  return String(head.stdout || '').trim();
}

async function buildIteration(runner, projectId, label, { install }) {
  if (install) {
    await checkedExec(runner, projectId, ['bun', 'install'], `${label}.install`);
  }
  await checkedExec(runner, projectId, ['npm', 'run', 'build'], `${label}.build`);
  const index = await runner.readFile(projectId, 'dist/index.html');
  const html = String(index?.content || '');
  if (!/id=["']root["']/.test(html) || !/<script\b/i.test(html)) {
    throw new RuntimeCanaryError(`${label}.build_artifact`, 'dist/index.html is missing the root or script entry');
  }
  return { indexBytes: Buffer.byteLength(html) };
}

async function waitForReady(runner, projectId, {
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    status = await runner.devStatus(projectId);
    if (status?.error || status?.state === 'error') {
      throw new RuntimeCanaryError('preview_start', status.error || 'runner reported an error', status);
    }
    if (status?.ready && (!status.project || status.project === projectId)) return status;
    await delay(1_000);
  }
  throw new RuntimeCanaryError('preview_start', 'preview did not become ready', status);
}

async function waitForRender({
  expectedText,
  url,
  env,
  browser = browserCheck,
  attempts = DEFAULT_RENDER_ATTEMPTS,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let view = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    view = await browser.checkApp({
      url,
      expectedText,
      env,
      settleMs: 750,
      timeoutMs: 25_000,
    });
    if (view?.ok) return view;
    if (attempt + 1 < attempts) await delay(1_000);
  }
  throw new RuntimeCanaryError(
    'browser_render',
    browser.formatReport ? browser.formatReport(view || {}, url) : 'browser render failed',
    view,
  );
}

async function runRuntimeCanary({
  runner,
  env = process.env,
  browser = browserCheck,
  projectId = env.CODEX_RUNTIME_CANARY_PROJECT || DEFAULT_PROJECT_ID,
  basePath = DEFAULT_BASE_PATH,
  idFactory = canaryId,
  delay,
} = {}) {
  if (!runner) throw new TypeError('runner is required');
  const probeId = String(idFactory());
  const firstMarker = `SIRA-CANARY-${probeId}-RUN-1`;
  const secondMarker = `SIRA-CANARY-${probeId}-RUN-2`;
  const startedAt = new Date().toISOString();
  const evidence = {
    projectId,
    probeId,
    startedAt,
    preflight: { install: false, build: false, artifact: false },
    iterations: [],
  };

  await runner.stopDev(projectId).catch(() => null);
  try {
    await runner.initWorkspace(projectId);
    await runner.writeFiles(projectId, canaryFiles(firstMarker));
    const firstBuild = await buildIteration(runner, projectId, 'run_1', { install: true });
    evidence.preflight = { install: true, build: true, artifact: true };
    const firstSha = await commitIteration(runner, projectId, 'run_1');
    const firstStart = await runner.startDev(projectId, { basePath });
    const firstStatus = await waitForReady(runner, projectId, { delay });
    const origin = browser.devUrlFor(env, firstStatus.port);
    const url = new URL(basePath, `${origin.replace(/\/+$/, '')}/`).toString();
    const firstView = await waitForRender({
      expectedText: firstMarker,
      url,
      env,
      browser,
      delay,
    });
    evidence.iterations.push({
      run: 1,
      commitSha: firstSha,
      marker: firstMarker,
      reused: Boolean(firstStart?.reused),
      port: firstStatus.port,
      build: firstBuild,
      render: { ok: true, rootChars: firstView.rootChars, expectedTextFound: true },
    });

    await runner.writeFiles(projectId, [{ path: 'src/main.jsx', content: appSource(secondMarker) }]);
    const secondBuild = await buildIteration(runner, projectId, 'run_2', { install: false });
    const secondSha = await commitIteration(runner, projectId, 'run_2');
    const secondStart = await runner.startDev(projectId, { basePath });
    const secondStatus = await waitForReady(runner, projectId, { delay });
    const secondView = await waitForRender({
      expectedText: secondMarker,
      url,
      env,
      browser,
      delay,
    });
    if (secondSha === firstSha) {
      throw new RuntimeCanaryError('run_2.continuity', 'the second iteration did not create a new commit');
    }
    evidence.iterations.push({
      run: 2,
      commitSha: secondSha,
      marker: secondMarker,
      reused: Boolean(secondStart?.reused),
      port: secondStatus.port,
      build: secondBuild,
      render: { ok: true, rootChars: secondView.rootChars, expectedTextFound: true },
    });
    return {
      ok: true,
      ...evidence,
      secondRunContinued: true,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    await runner.stopDev(projectId).catch(() => null);
  }
}

module.exports = {
  DEFAULT_BASE_PATH,
  DEFAULT_PROJECT_ID,
  RuntimeCanaryError,
  appSource,
  canaryFiles,
  runRuntimeCanary,
  waitForReady,
  waitForRender,
};
