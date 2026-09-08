'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cp = require('../src/services/codex/checkpoint-service');

// Is git on this host? If not, skip the real-git integration entirely.
let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

// A runner-client implemented against the LOCAL filesystem + real git, so we
// validate the actual git sequence checkpoint-service drives (commit → rollback
// → byte-identical restore). Mirrors the production runner's contract.
function localRunner(root) {
  const dirFor = (project) => path.join(root, 'projects', project);
  return {
    exec: async (project, cmd) => {
      const cwd = dirFor(project);
      try {
        const stdout = execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8' });
        return { exitCode: 0, stdout, stderr: '' };
      } catch (err) {
        return { exitCode: err.status ?? 1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || String(err.message) };
      }
    },
    writeFiles: async (project, files) => {
      for (const f of files) {
        const full = path.join(dirFor(project), f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content);
      }
      return { ok: true, written: files.length };
    },
    readFile: async (project, p) => ({ content: fs.readFileSync(path.join(dirFor(project), p), 'utf8') }),
    devStatus: async () => ({ running: false }),
    stopDev: async () => ({ ok: true }),
    startDev: async () => ({ ok: true }),
  };
}

function memCheckpointDb() {
  let id = 0;
  const rows = [];
  return {
    rows,
    codexCheckpoint: {
      async create({ data }) { const r = { id: `cp-${++id}`, createdAt: new Date(), ...data }; rows.push(r); return r; },
      async findFirst({ where }) { return rows.find((r) => r.id === where.id) || null; },
    },
  };
}

let root;
before(() => {
  if (!gitAvailable) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cp-'));
  const proj = path.join(root, 'projects', 'p1');
  fs.mkdirSync(proj, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: proj });
  execFileSync('git', ['config', 'user.email', 'codex@siragpt.local'], { cwd: proj });
  execFileSync('git', ['config', 'user.name', 'Codex Agent'], { cwd: proj });
  // Keep bytes identical across commit/checkout on Windows (no CRLF rewriting).
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: proj });
  fs.writeFileSync(path.join(proj, 'app.js'), 'const v = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: proj });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: proj });
});
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('merge lock serializes integrations for the same project', async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = cp.withProjectMergeLock(null, 'p1', async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
  });
  const second = cp.withProjectMergeLock(null, 'p1', async () => {
    order.push('second:start');
    order.push('second:end');
  });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('git-real: commit → modify → rollback restores files byte-for-byte', { skip: !gitAvailable }, async () => {
  const runner = localRunner(root);
  const db = memCheckpointDb();
  const eventStore = { appendEvent: async () => {} };

  // Build 1: change app.js → checkpoint A.
  await runner.writeFiles('p1', [{ path: 'app.js', content: 'const v = 2;\n' }, { path: 'feature.js', content: 'export const f = () => 42;\n' }]);
  const a = await cp.createCheckpoint({ run: { id: 'run-a' }, project: { id: 'p1' }, deps: { runner, prisma: db, eventStore, llmTurn: null } });
  assert.ok(a && cp.isValidSha(a.commitSha));

  const stateAtA = fs.readFileSync(path.join(root, 'projects', 'p1', 'app.js'), 'utf8');

  // Build 2: change again → checkpoint B.
  await runner.writeFiles('p1', [{ path: 'app.js', content: 'const v = 999;\n' }]);
  const b = await cp.createCheckpoint({ run: { id: 'run-b' }, project: { id: 'p1' }, deps: { runner, prisma: db, eventStore, llmTurn: null } });
  assert.ok(b && b.commitSha !== a.commitSha);
  assert.equal(fs.readFileSync(path.join(root, 'projects', 'p1', 'app.js'), 'utf8'), 'const v = 999;\n');

  // Rollback to A → app.js restored byte-for-byte, feature.js still present.
  const rb = await cp.rollbackCheckpoint({ checkpointId: a.id, userId: undefined, deps: { runner, prisma: db } });
  // ownership: findFirst ignores the project filter in this minimal fake, so it resolves.
  assert.equal(rb.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'projects', 'p1', 'app.js'), 'utf8'), stateAtA);
  assert.ok(fs.existsSync(path.join(root, 'projects', 'p1', 'feature.js')));
});

test('git-real: diff of a checkpoint shows the change + shortstat', { skip: !gitAvailable }, async () => {
  const runner = localRunner(root);
  const db = memCheckpointDb();
  await runner.writeFiles('p1', [{ path: 'app.js', content: 'const v = 7;\n// nuevo\n' }]);
  const c = await cp.createCheckpoint({ run: { id: 'run-c' }, project: { id: 'p1' }, deps: { runner, prisma: db, eventStore: { appendEvent: async () => {} }, llmTurn: null } });
  const diff = await cp.getCheckpointDiff({ checkpointId: c.id, userId: undefined, deps: { runner, prisma: db } });
  assert.equal(diff.ok, true);
  assert.match(diff.diff, /app\.js/);
  assert.ok(diff.additions >= 1);
});

test('git-real: rollback preserves a dirty tree and explicit recovery restores it byte-for-byte', { skip: !gitAvailable }, async (t) => {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
  t.after(() => fs.rmSync(isolatedRoot, { recursive: true, force: true }));
  const projectDir = path.join(isolatedRoot, 'projects', 'p1');
  fs.mkdirSync(projectDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.email', 'codex@siragpt.local'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.name', 'Codex Agent'], { cwd: projectDir });
  fs.writeFileSync(path.join(projectDir, 'app.js'), 'const v = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: projectDir });
  execFileSync('git', ['commit', '-m', 'checkpoint-a'], { cwd: projectDir });
  const checkpointSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim();

  fs.writeFileSync(path.join(projectDir, 'app.js'), 'const v = 2;\n');
  execFileSync('git', ['add', '-A'], { cwd: projectDir });
  execFileSync('git', ['commit', '-m', 'run-two'], { cwd: projectDir });
  const runTwoSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim();

  fs.writeFileSync(path.join(projectDir, 'prior-draft.txt'), 'pre-existing stash remains untouched\n');
  execFileSync('git', ['stash', 'push', '--include-untracked', '--message', 'pre-existing-user-stash'], { cwd: projectDir });
  const preExistingStash = execFileSync('git', ['rev-parse', 'stash@{0}'], { cwd: projectDir, encoding: 'utf8' }).trim();

  fs.writeFileSync(path.join(projectDir, 'app.js'), 'const v = 3; // unsaved\n');
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'customer draft stays local\n');

  const runner = localRunner(isolatedRoot);
  const db = memCheckpointDb();
  db.rows.push({
    id: 'cp-a',
    projectId: 'p1',
    runId: 'run-a',
    commitSha: checkpointSha,
    title: 'checkpoint A',
  });

  const rolledBack = await cp.rollbackCheckpoint({
    checkpointId: 'cp-a',
    userId: undefined,
    deps: { runner, prisma: db },
  });
  assert.equal(rolledBack.ok, true);
  assert.ok(cp.isValidRecoveryRef(rolledBack.recovery?.ref));
  assert.equal(
    execFileSync('git', ['rev-parse', 'stash@{0}'], { cwd: projectDir, encoding: 'utf8' }).trim(),
    preExistingStash,
  );
  assert.equal(fs.readFileSync(path.join(projectDir, 'app.js'), 'utf8'), 'const v = 1;\n');
  assert.equal(fs.existsSync(path.join(projectDir, 'notes.txt')), false);

  const recovered = await cp.recoverWorkspaceChanges({
    runner,
    projectId: 'p1',
    recoveryRef: rolledBack.recovery.ref,
  });
  assert.equal(recovered.ok, true);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim(), runTwoSha);
  assert.equal(fs.readFileSync(path.join(projectDir, 'app.js'), 'utf8'), 'const v = 3; // unsaved\n');
  assert.equal(fs.readFileSync(path.join(projectDir, 'notes.txt'), 'utf8'), 'customer draft stays local\n');
  assert.equal(
    execFileSync('git', ['rev-parse', 'stash@{0}'], { cwd: projectDir, encoding: 'utf8' }).trim(),
    preExistingStash,
  );
  assert.match(execFileSync('git', ['status', '--short'], { cwd: projectDir, encoding: 'utf8' }), /notes\.txt/);
  assert.throws(
    () => execFileSync('git', ['rev-parse', '--verify', rolledBack.recovery.ref], { cwd: projectDir, stdio: 'pipe' }),
  );
});
