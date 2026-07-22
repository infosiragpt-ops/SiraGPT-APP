import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';

const origin = 'http://127.0.0.1:4097';
const token = process.env.CODE_RUNNER_CONTROL_TOKEN;
const project = 'gvisor-smoke';
const fullStackProject = 'fullstack-smoke';
const fullStackBase = '/fullstack-preview/';
const fullStackUid = Number(process.env.GVISOR_SMOKE_PROJECT_UID);

assert.ok(token, 'CODE_RUNNER_CONTROL_TOKEN is required by the smoke client');
assert.ok(Number.isInteger(fullStackUid) && fullStackUid > 0, 'GVISOR_SMOKE_PROJECT_UID is required');

async function response(path, {
  method = 'GET',
  body,
  authenticated = true,
  expectedStatus = 200,
} = {}) {
  const headers = {};
  if (authenticated) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const result = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await result.json().catch(() => null);
  assert.equal(
    result.status,
    expectedStatus,
    `${method} ${path} returned ${result.status}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

async function waitForHealth() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const health = await response('/health', { authenticated: false });
      assert.equal(health.ok, true);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError || new Error('runner health timed out');
}

async function waitForProjectReady(projectId, attempts = 120) {
  let status;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    status = await response(`/status?project=${projectId}`);
    if (status.state === 'error') {
      assert.fail(`preview failed: ${status.error || 'unknown'} ${JSON.stringify(status.tail || [])}`);
    }
    if (status.ready) return status;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.fail(`preview did not become ready: ${JSON.stringify(status)}`);
}

async function previewFetch(port, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function previewJson(port, path, {
  method = 'GET',
  body,
  expectedStatus = 200,
} = {}) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  const result = await previewFetch(port, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await result.json().catch(() => null);
  assert.equal(
    result.status,
    expectedStatus,
    `${method} ${path} returned ${result.status}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

async function waitForPreviewJson(port, path, attempts = 30) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await previewJson(port, path);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error(`preview JSON timed out: ${path}`);
}

async function waitForPreviewClosed(port) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const open = await new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(true);
      }, 1_000);
      socket.once('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
    if (!open) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`preview process tree on port ${port} survived /stop`);
}

function projectProcesses(uid) {
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      const processUid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
      if (processUid !== uid) continue;
      const processName = /^Name:\s+(.+)$/m.exec(status)?.[1] || 'unknown';
      found.push({ pid: Number(name), name: processName });
    } catch {
      // Process exited between /proc enumeration and status read.
    }
  }
  return found;
}

async function waitForProjectProcessesStopped(uid) {
  let found = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    found = projectProcesses(uid);
    if (found.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`project UID ${uid} still owns processes after /stop: ${JSON.stringify(found)}`);
}

await waitForHealth();
await response('/status', { authenticated: false, expectedStatus: 401 });

const initialized = await response('/workspace/init', {
  method: 'POST',
  body: { project },
});
assert.equal(initialized.ok, true);

const packageJson = JSON.stringify({
  name: 'gvisor-runner-smoke',
  private: true,
  type: 'module',
  scripts: { dev: 'node --watch server.mjs' },
}, null, 2);

const server = `
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const database = new DatabaseSync(':memory:');
database.exec('CREATE TABLE smoke (value INTEGER NOT NULL); INSERT INTO smoke VALUES (42)');
const sqliteValue = database.prepare('SELECT value FROM smoke').get().value;
const port = Number(process.env.PORT || 5173);

createServer((_request, result) => {
  result.setHeader('content-type', 'application/json');
  result.end(JSON.stringify({
    ok: true,
    node: process.version,
    uid: process.getuid?.(),
    sqliteValue,
    controlTokenVisible: Boolean(process.env.CODE_RUNNER_CONTROL_TOKEN),
  }));
}).listen(port, '0.0.0.0');
`;

const written = await response('/workspace/write', {
  method: 'POST',
  body: {
    project,
    files: [
      { path: 'package.json', content: packageJson },
      { path: 'server.mjs', content: server },
      { path: 'README.md', content: '# gVisor runner smoke\n' },
    ],
  },
});
assert.equal(written.ok, true);
assert.equal(written.written, 3);

const readback = await response(`/workspace/file?project=${project}&path=README.md`);
assert.equal(readback.content, '# gVisor runner smoke\n');

const nodeProbe = await response('/workspace/exec', {
  method: 'POST',
  body: {
    project,
    cmd: [
      'node',
      '--input-type=module',
      '-e',
      "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (42)'); console.log(JSON.stringify({node:process.version,uid:process.getuid?.(),sqliteValue:db.prepare('SELECT v FROM t').get().v,controlTokenVisible:Boolean(process.env.CODE_RUNNER_CONTROL_TOKEN)}));",
    ],
    timeoutMs: 15_000,
  },
});
assert.equal(nodeProbe.ok, true, nodeProbe.stderr);
const nodeResult = JSON.parse(nodeProbe.stdout.trim());
assert.match(nodeResult.node, /^v22\./);
assert.ok(Number.isInteger(nodeResult.uid) && nodeResult.uid > 0, 'generated code must use a non-root uid');
assert.equal(nodeResult.sqliteValue, 42);
assert.equal(nodeResult.controlTokenVisible, false);

const started = await response('/run', {
  method: 'POST',
  body: { project },
});
assert.equal(started.ok, true);

let status;
for (let attempt = 0; attempt < 45; attempt += 1) {
  status = await response(`/status?project=${project}`);
  if (status.state === 'error') {
    assert.fail(`preview failed: ${status.error || 'unknown'} ${JSON.stringify(status.tail || [])}`);
  }
  if (status.ready) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
assert.equal(status?.ready, true, `preview did not become ready: ${JSON.stringify(status)}`);

const previewResponse = await fetch(`http://127.0.0.1:${started.port}/`);
assert.equal(previewResponse.status, 200);
const preview = await previewResponse.json();
assert.equal(preview.ok, true);
assert.match(preview.node, /^v22\./);
assert.ok(Number.isInteger(preview.uid) && preview.uid > 0);
assert.equal(preview.sqliteValue, 42);
assert.equal(preview.controlTokenVisible, false);

const exported = await response('/workspace/export', {
  method: 'POST',
  body: { project },
});
assert.equal(exported.ok, true);
assert.ok(exported.files >= 3);

const stopped = await response('/stop', {
  method: 'POST',
  body: { project },
});
assert.equal(stopped.ok, true);
assert.equal(stopped.stopped, 1);

const dependencyProbe = await response('/workspace/exec', {
  method: 'POST',
  body: {
    project: fullStackProject,
    cmd: [
      'node',
      '--input-type=module',
      '-e',
      "import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json'); for (const name of ['express', 'react', 'vite', 'concurrently']) console.log(`${name}=${require.resolve(name)}`);",
    ],
    timeoutMs: 15_000,
  },
});
assert.equal(dependencyProbe.ok, true, dependencyProbe.stderr);
for (const name of ['express', 'react', 'vite', 'concurrently']) {
  assert.match(dependencyProbe.stdout, new RegExp(`^${name}=`, 'm'));
}

const fullStackStarted = await response('/run', {
  method: 'POST',
  body: { project: fullStackProject, basePath: fullStackBase },
});
assert.equal(fullStackStarted.ok, true);
await waitForProjectReady(fullStackProject);

const htmlResponse = await previewFetch(fullStackStarted.port, fullStackBase);
assert.equal(htmlResponse.status, 200);
assert.match(htmlResponse.headers.get('content-type') || '', /text\/html/i);
const html = await htmlResponse.text();
assert.match(html, /id=["']root["']/);
assert.ok(
  html.includes(`${fullStackBase}src/main.tsx`),
  `frontend entry was not rewritten to the tokenized base: ${html.slice(0, 500)}`,
);

for (const sourcePath of ['src/main.tsx', 'src/App.tsx', 'src/index.css']) {
  const sourceResponse = await previewFetch(fullStackStarted.port, `${fullStackBase}${sourcePath}`);
  assert.equal(sourceResponse.status, 200, `${sourcePath} did not compile through Vite`);
  const compiled = await sourceResponse.text();
  assert.ok(compiled.length > 100, `${sourcePath} returned an empty transform`);
}

const health = await waitForPreviewJson(
  fullStackStarted.port,
  `${fullStackBase}api/health`,
);
assert.deepEqual(health, { ok: true });

const itemTitle = `gVisor persisted ${Date.now()}`;
const created = await previewJson(
  fullStackStarted.port,
  `${fullStackBase}api/items`,
  { method: 'POST', body: { title: itemTitle }, expectedStatus: 201 },
);
assert.ok(Number.isInteger(created.id) && created.id > 0);

let items = await previewJson(fullStackStarted.port, `${fullStackBase}api/items`);
assert.ok(items.some((item) => item.id === created.id && item.title === itemTitle));

const firstFullStackStop = await response('/stop', {
  method: 'POST',
  body: { project: fullStackProject },
});
assert.equal(firstFullStackStop.stopped, 1);
await Promise.all([
  waitForPreviewClosed(fullStackStarted.port),
  waitForPreviewClosed(fullStackStarted.port + 1000),
]);
await waitForProjectProcessesStopped(fullStackUid);
const stoppedStatus = await response(`/status?project=${fullStackProject}`);
assert.equal(stoppedStatus.running, false);

const restarted = await response('/run', {
  method: 'POST',
  body: { project: fullStackProject, basePath: fullStackBase },
});
assert.equal(restarted.ok, true);
await waitForProjectReady(fullStackProject);
assert.deepEqual(
  await waitForPreviewJson(restarted.port, `${fullStackBase}api/health`),
  { ok: true },
);

items = await previewJson(restarted.port, `${fullStackBase}api/items`);
assert.ok(
  items.some((item) => item.id === created.id && item.title === itemTitle),
  'SQLite record did not survive a complete preview stop/restart',
);

await previewJson(
  restarted.port,
  `${fullStackBase}api/items/${created.id}`,
  { method: 'PATCH', body: { done: true } },
);
items = await previewJson(restarted.port, `${fullStackBase}api/items`);
assert.equal(items.find((item) => item.id === created.id)?.done, 1);

await previewJson(
  restarted.port,
  `${fullStackBase}api/items/${created.id}`,
  { method: 'DELETE' },
);
items = await previewJson(restarted.port, `${fullStackBase}api/items`);
assert.equal(items.some((item) => item.id === created.id), false);

const finalFullStackStop = await response('/stop', {
  method: 'POST',
  body: { project: fullStackProject },
});
assert.equal(finalFullStackStop.stopped, 1);
await Promise.all([
  waitForPreviewClosed(restarted.port),
  waitForPreviewClosed(restarted.port + 1000),
]);
await waitForProjectProcessesStopped(fullStackUid);

console.log(JSON.stringify({
  ok: true,
  node: preview.node,
  uid: preview.uid,
  sqliteValue: preview.sqliteValue,
  previewPort: started.port,
  exportedFiles: exported.files,
  fullStack: {
    basePath: fullStackBase,
    dependencies: ['express', 'react', 'vite', 'concurrently'],
    health: true,
    frontendCompiled: true,
    sqliteCrudAndRestart: true,
    processTreeStopped: true,
    projectUid: fullStackUid,
  },
}));
