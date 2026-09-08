'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { planConfiguration, assertUnchangedConfiguration, assertDaemonIdentity, assertProductionUnchanged,
  RUNTIME_PATH, ARCHIVE, ARCHIVE_SHA512 } = require('./install-runtime-config.cjs');

test('package URL and checksum pin a point release, not latest', () => {
  assert.match(ARCHIVE, /\/20260817\.0\/x86_64\/gvisor\.tar\.bz2$/);
  assert.match(ARCHIVE_SHA512, /^[0-9a-f]{128}$/);
});

test('absent config gets only the additional runtime and does not set a default', () => {
  const result = planConfiguration(null);
  assert.equal(result.originalHash, 'absent');
  assert.equal(result.noop, false);
  assert.deepEqual(JSON.parse(result.candidate.toString()), { runtimes: { runsc: { path: RUNTIME_PATH } } });
});

test('all existing fields and runtimes are retained exactly, including confidential fields', () => {
  const original = { 'default-runtime': 'runc', runtimes: { other: { path: '/opt/other', runtimeArgs: ['--debug'] } },
    proxies: { 'http-proxy': 'https://example.invalid/non-real-test-value' }, 'log-opts': { 'max-size': '10m' },
    features: { cdi: false }, labels: ['existing=true'] };
  const result = planConfiguration(Buffer.from(JSON.stringify(original)));
  const candidate = JSON.parse(result.candidate.toString());
  assert.deepEqual(candidate.runtimes.runsc, { path: RUNTIME_PATH });
  delete candidate.runtimes.runsc;
  assert.deepEqual(candidate, original);
});

test('matching runtime is an exact-byte no-op; different runtime is never overwritten', () => {
  const bytes = Buffer.from(JSON.stringify({ runtimes: { runsc: { path: RUNTIME_PATH } } }));
  const result = planConfiguration(bytes);
  assert.equal(result.noop, true);
  assert.deepEqual(result.candidate, bytes);
  assert.throws(() => planConfiguration(Buffer.from('{"runtimes":{"runsc":{"path":"/some/existing/runtime"}}}')), /differently/);
});

for (const invalid of ['[]', 'null', 'true', '"text"', '{"runtimes":[]}', '{"runtimes":null}', '{"runtimes":"path"}', '{']) {
  test(`reject invalid config shape ${invalid}`, () => {
    assert.throws(() => planConfiguration(Buffer.from(invalid)));
  });
}
test('size bound and input type are enforced', () => {
  assert.throws(() => planConfiguration(Buffer.alloc(1024 * 1024 + 1)), /too_large/);
  assert.throws(() => planConfiguration('{}'), /not_buffer/);
});
test('compare-and-swap detects any new file or byte change after preflight', () => {
  assertUnchangedConfiguration(null, 'absent');
  assert.throws(() => assertUnchangedConfiguration(Buffer.from('{}'), 'absent'), /changed/);
  const current = Buffer.from('{}');
  const sha = createHash('sha256').update(current).digest('hex');
  assertUnchangedConfiguration(current, sha);
  assert.throws(() => assertUnchangedConfiguration(Buffer.from('{}\n'), sha), /changed/);
  assert.throws(() => assertUnchangedConfiguration(null, sha), /changed/);
});

const daemon = { pid: 173770, comm: 'dockerd', startTicks: '7292944' };
test('signal guard rejects PID reuse, changed daemon and PID 1', () => {
  assertDaemonIdentity(daemon, { ...daemon });
  assert.throws(() => assertDaemonIdentity(daemon, { ...daemon, pid: 2 }), /changed/);
  assert.throws(() => assertDaemonIdentity(daemon, { ...daemon, startTicks: '7292945' }), /changed/);
  assert.throws(() => assertDaemonIdentity(daemon, { ...daemon, comm: 'sh' }), /invalid/);
  assert.throws(() => assertDaemonIdentity({ ...daemon, pid: 1 }, { ...daemon, pid: 1 }), /invalid/);
});

const baseline = { defaultRuntime: 'runc', daemon, containers: [{ id: 'a'.repeat(64), name: '/example-fixture', pid: 200,
  startedAt: '2026-09-04T20:31:10.391548279Z', status: 'running', health: 'healthy' }] };
test('unchanged production snapshot passes; new independent containers are allowed', () => {
  assertProductionUnchanged(baseline, structuredClone(baseline));
  const next = structuredClone(baseline);
  next.containers.push({ ...next.containers[0], id: 'b'.repeat(64), name: '/isolated-fixture', pid: 300 });
  assertProductionUnchanged(baseline, next);
});
for (const [field, value] of [['id', 'c'.repeat(64)], ['name', '/replacement'], ['pid', 201],
  ['startedAt', '2026-09-04T21:31:10Z'], ['status', 'exited'], ['health', 'unhealthy']]) {
  test(`production guard rejects changed container ${field}`, () => {
    const next = structuredClone(baseline);
    next.containers[0][field] = value;
    assert.throws(() => assertProductionUnchanged(baseline, next));
  });
}
test('production guard rejects missing containers, changed default runtime, and duplicate snapshots', () => {
  assert.throws(() => assertProductionUnchanged(baseline, { ...baseline, containers: [] }), /changed/);
  assert.throws(() => assertProductionUnchanged(baseline, { ...baseline, defaultRuntime: 'runsc' }), /default_runtime/);
  assert.throws(() => assertProductionUnchanged(baseline, { ...baseline, containers: [...baseline.containers, ...baseline.containers] }), /duplicate/);
});
