import assert from 'node:assert/strict';

const origin = 'http://127.0.0.1:4097';
const token = process.env.CODE_RUNNER_CONTROL_TOKEN;
const project = 'gvisor-smoke';

assert.ok(token, 'CODE_RUNNER_CONTROL_TOKEN is required by the smoke client');

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

console.log(JSON.stringify({
  ok: true,
  node: preview.node,
  uid: preview.uid,
  sqliteValue: preview.sqliteValue,
  previewPort: started.port,
  exportedFiles: exported.files,
}));
