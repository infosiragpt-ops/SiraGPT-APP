'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  workspaceFilePatch,
  buildExecutiveSummary,
} = require('../src/services/codex/agent-loop');

test('workspaceFilePatch returns the bounded git diff for a changed file', async () => {
  const runner = {
    async exec(_projectId, args) {
      assert.deepEqual(args, ['git', 'diff', '--no-ext-diff', '--unified=3', '--', 'src/App.tsx']);
      return { exitCode: 0, stdout: 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new' };
    },
  };
  const patch = await workspaceFilePatch({ runner, projectId: 'p1', path: 'src/App.tsx' });
  assert.equal(patch.path, 'src/App.tsx');
  assert.match(patch.patch, /\+new/);
  assert.equal(patch.truncated, false);
});

test('workspaceFilePatch builds evidence for a new untracked file', async () => {
  const runner = {
    async exec(_projectId, args) {
      if (args[1] === 'diff') return { exitCode: 0, stdout: '' };
      return { exitCode: 0, stdout: 'src/new.ts\n' };
    },
    async readFile() {
      return { content: 'export const ready = true\n' };
    },
  };
  const patch = await workspaceFilePatch({ runner, projectId: 'p1', path: 'src/new.ts' });
  assert.match(patch.patch, /new file mode/);
  assert.match(patch.patch, /\+export const ready = true/);
});

test('workspaceFilePatch blocks sensitive paths and redacts detected credentials', async () => {
  let calls = 0;
  const blocked = await workspaceFilePatch({
    runner: { exec: async () => { calls += 1; return { stdout: '' }; } },
    projectId: 'p1',
    path: '.env.production',
  });
  assert.equal(blocked, null);
  assert.equal(calls, 0);

  const runner = {
    async exec() {
      return {
        exitCode: 0,
        stdout: 'diff --git a/src/config.ts b/src/config.ts\n@@ -1 +1 @@\n-old\n+const key = "sk-EXAMPLE_1234567890abcdef"',
      };
    },
  };
  const redacted = await workspaceFilePatch({ runner, projectId: 'p1', path: 'src/config.ts' });
  assert.ok(redacted);
  assert.doesNotMatch(redacted.patch, /sk-EXAMPLE_/);
  assert.match(redacted.patch, /redacted/i);
});

test('buildExecutiveSummary reports passed and failed gates without inventing output', () => {
  const passed = buildExecutiveSummary({
    outcome: 'passed',
    proactiveMeta: { department: 'CEO Office', title: 'Mejorar onboarding' },
    checkpoint: { commitSha: 'abc1234' },
    diffstat: { filesChanged: 2, additions: 10, deletions: 1 },
    projectGateVerification: { gates: { typeCheck: { ran: true, ok: true } } },
  });
  assert.equal(passed.status, 'passed');
  assert.match(passed.impact, /2 archivo/);
  assert.match(passed.audioText, /Trabajo completado/);
  assert.equal(passed.checkpointSha, 'abc1234');

  const failed = buildExecutiveSummary({
    outcome: 'failed',
    sourcePrompt: 'Implementar pagos',
    diffstat: { filesChanged: 1 },
    projectGateVerification: { blockingGates: ['browser_check'] },
  });
  assert.equal(failed.status, 'failed');
  assert.match(failed.risks[0], /browser_check/);
  assert.match(failed.nextActions[0], /debugger/);
});
