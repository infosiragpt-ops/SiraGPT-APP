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

function featureEnabled(env, key) {
  return /^(1|true|on|yes)$/i.test(String(env?.[key] ?? '').trim());
}

function isolationRunId(probeId, suffix) {
  const safeProbe = String(probeId || 'probe')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'probe';
  return `canary-${safeProbe}-${suffix}`;
}

async function runWorktreeIsolationCanary({
  runner,
  projectId,
  probeId,
  baseBranch = 'main',
  env = process.env,
} = {}) {
  if (!featureEnabled(env, 'CODEX_RUN_WORKTREES')) {
    return { enabled: false, isolated: false, skipped: 'feature_disabled' };
  }
  if (
    typeof runner?.createWorktree !== 'function'
    || typeof runner?.forRun !== 'function'
    || typeof runner?.removeWorktree !== 'function'
  ) {
    throw new RuntimeCanaryError(
      'worktree_isolation',
      'runner does not expose the run-worktree contract',
    );
  }

  const runIds = [
    isolationRunId(probeId, 'a'),
    isolationRunId(probeId, 'b'),
  ];
  const markers = [
    `SIRA-WORKTREE-${probeId}-A`,
    `SIRA-WORKTREE-${probeId}-B`,
  ];
  const initialized = new Set();
  let primaryError = null;
  let result = null;

  try {
    const baseBefore = await runner.readFile(projectId, 'src/main.jsx');
    const initResults = await Promise.allSettled(runIds.map((run) => (
      runner.createWorktree(projectId, run, baseBranch)
    )));
    initResults.forEach((entry, index) => {
      if (entry.status === 'fulfilled' && entry.value?.ok !== false) initialized.add(runIds[index]);
    });
    const initFailure = initResults.find((entry) => (
      entry.status === 'rejected' || entry.value?.ok === false
    ));
    if (initFailure) {
      const detail = initFailure.status === 'rejected'
        ? initFailure.reason?.message || initFailure.reason
        : initFailure.value;
      throw new RuntimeCanaryError(
        'worktree_isolation.init',
        'one of the isolated run worktrees could not be created',
        String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2_000),
      );
    }

    const scoped = runIds.map((run) => runner.forRun(run, projectId));
    await Promise.all(scoped.map((runRunner, index) => (
      runRunner.writeFiles(projectId, [{
        path: 'src/main.jsx',
        content: appSource(markers[index]),
      }])
    )));
    const [viewA, viewB, baseAfter, statusA, statusB, baseStatus] = await Promise.all([
      scoped[0].readFile(projectId, 'src/main.jsx'),
      scoped[1].readFile(projectId, 'src/main.jsx'),
      runner.readFile(projectId, 'src/main.jsx'),
      checkedExec(scoped[0], projectId, ['git', 'status', '--porcelain'], 'worktree_isolation.status_a', 30_000),
      checkedExec(scoped[1], projectId, ['git', 'status', '--porcelain'], 'worktree_isolation.status_b', 30_000),
      checkedExec(runner, projectId, ['git', 'status', '--porcelain'], 'worktree_isolation.base_status', 30_000),
    ]);
    const textA = String(viewA?.content || '');
    const textB = String(viewB?.content || '');
    const baseTextBefore = String(baseBefore?.content || '');
    const baseTextAfter = String(baseAfter?.content || '');
    if (
      !textA.includes(markers[0])
      || textA.includes(markers[1])
      || !textB.includes(markers[1])
      || textB.includes(markers[0])
    ) {
      throw new RuntimeCanaryError(
        'worktree_isolation.content',
        'isolated run content crossed workspace boundaries',
      );
    }
    if (
      baseTextAfter !== baseTextBefore
      || baseTextAfter.includes(markers[0])
      || baseTextAfter.includes(markers[1])
      || String(baseStatus.stdout || '').trim()
    ) {
      throw new RuntimeCanaryError(
        'worktree_isolation.base',
        'the project base checkout changed during isolated writes',
        String(baseStatus.stdout || '').slice(0, 2_000),
      );
    }
    if (!String(statusA.stdout || '').trim() || !String(statusB.stdout || '').trim()) {
      throw new RuntimeCanaryError(
        'worktree_isolation.status',
        'isolated writes were not visible in both run worktrees',
      );
    }
    result = {
      enabled: true,
      isolated: true,
      basePreserved: true,
      runs: runIds,
      markers,
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanup = await Promise.allSettled([...initialized].map(async (runId) => {
    const scoped = runner.forRun(runId, projectId);
    await checkedExec(
      scoped,
      projectId,
      ['git', 'reset', '--hard', 'HEAD'],
      'worktree_isolation.reset',
      30_000,
    );
    return runner.removeWorktree(projectId, runId);
  }));
  const cleanupFailed = cleanup.some((entry) => (
    entry.status === 'rejected'
    || entry.value?.ok === false
    || entry.value?.removed === false
  ));
  if (primaryError) throw primaryError;
  if (cleanupFailed || initialized.size !== runIds.length) {
    throw new RuntimeCanaryError(
      'worktree_isolation.cleanup',
      'isolated canary worktrees were not cleaned completely',
    );
  }
  return {
    ...result,
    cleaned: true,
  };
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
    evidence.worktreeIsolation = await runWorktreeIsolationCanary({
      runner,
      projectId,
      probeId,
      baseBranch: env.CODEX_RUNTIME_CANARY_BASE_BRANCH || 'main',
      env,
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
  runWorktreeIsolationCanary,
  runRuntimeCanary,
  waitForReady,
  waitForRender,
};
