'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const verifyLoop = require('../src/services/codex/verify-loop');

const run = { id: 'run-project-gates' };
const TS_CONFIG = '{"compilerOptions":{"jsx":"react-jsx"}}';

function eventStore() {
  const events = [];
  return {
    events,
    appendEvent: async (runId, type, data) => {
      events.push({ runId, type, data });
      return { seq: events.length };
    },
  };
}

function fakeRunner({ packageJson, extraFiles = {}, onExec }) {
  const calls = [];
  const files = {
    'package.json': JSON.stringify(packageJson),
    'tsconfig.json': TS_CONFIG,
    ...extraFiles,
  };
  return {
    calls,
    readFile: async (_projectId, path) => {
      if (Object.hasOwn(files, path)) return { content: files[path] };
      throw new Error(`not found: ${path}`);
    },
    writeFiles: async (_projectId, writes) => {
      for (const write of writes) files[write.path] = write.content;
      return { ok: true };
    },
    exec: async (projectId, command, options = {}) => {
      calls.push({ projectId, command, options });
      if (command[0] === 'bun' && command[1] === 'install') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command[0] === 'bunx' && command[1] === 'tsc') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return onExec({ projectId, command, options, callNumber: calls.length });
    },
  };
}

function verify({ runner, env = {}, llmTurn = async () => ({ text: '', toolCalls: [] }) }) {
  return verifyLoop.autoVerifyAndHeal({
    run,
    projectId: 'project-1',
    runner,
    eventStore: eventStore(),
    prisma: null,
    llmTurn,
    env: { NODE_ENV: 'test', CODEX_VERIFY_ROUNDS: '1', ...env },
  });
}

test('un test roto deja clean=false y devuelve diagnósticos estructurados para bloquear el cierre', async () => {
  const vitestJson = {
    numFailedTests: 1,
    testResults: [{
      name: '/workspace/src/order.test.ts',
      status: 'failed',
      assertionResults: [{
        ancestorTitles: ['orders'],
        title: 'rejects an invalid total',
        status: 'failed',
        location: { line: 18, column: 5 },
        failureMessages: ['expected 400, received 200'],
      }],
    }],
  };
  const runner = fakeRunner({
    packageJson: { scripts: { test: 'vitest run' } },
    onExec: ({ command }) => {
      assert.deepEqual(command, ['bunx', 'vitest', 'run', '--reporter=json']);
      return { exitCode: 1, stdout: JSON.stringify(vitestJson), stderr: '' };
    },
  });

  const result = await verify({
    runner,
    env: { CODEX_VERIFY_TEST_TIMEOUT_MS: '4321' },
  });

  assert.equal(result.clean, false);
  assert.deepEqual(result.blockingGates, ['tests']);
  assert.equal(result.gates.tests.applies, true);
  assert.equal(result.gates.tests.clean, false);
  assert.equal(result.diagnostics[0].gate, 'tests');
  assert.equal(result.diagnostics[0].file, '/workspace/src/order.test.ts');
  assert.equal(result.diagnostics[0].line, 18);
  assert.equal(result.diagnostics[0].code, 'TEST_FAILURE');
  const testCall = runner.calls.find((call) => call.command.includes('vitest'));
  assert.equal(testCall.options.timeoutMs, 4321);
});

test('un lint roto descubierto por config deja clean=false y conserva regla y ubicación', async () => {
  const eslintJson = [{
    filePath: '/workspace/src/App.tsx',
    messages: [{
      ruleId: 'no-unused-vars',
      severity: 2,
      message: "'unused' is assigned a value but never used.",
      line: 7,
      column: 9,
    }],
  }];
  const runner = fakeRunner({
    packageJson: { scripts: { dev: 'vite' } },
    extraFiles: { 'eslint.config.js': 'export default [];\n' },
    onExec: ({ command }) => {
      assert.deepEqual(command, ['bunx', 'eslint', '.', '--format', 'json']);
      return { exitCode: 1, stdout: JSON.stringify(eslintJson), stderr: '' };
    },
  });

  const result = await verify({
    runner,
    env: { CODEX_VERIFY_LINT_TIMEOUT_MS: '6789' },
  });

  assert.equal(result.clean, false);
  assert.deepEqual(result.blockingGates, ['lint']);
  assert.equal(result.gates.lint.reason, 'eslint.config.js');
  assert.equal(result.diagnostics[0].gate, 'lint');
  assert.equal(result.diagnostics[0].code, 'no-unused-vars');
  assert.equal(result.diagnostics[0].line, 7);
  const lintCall = runner.calls.find((call) => call.command.includes('eslint'));
  assert.equal(lintCall.options.timeoutMs, 6789);
});

test('sin scripts ni config de tests/lint los gates se saltan y no bloquean', async () => {
  const runner = fakeRunner({
    packageJson: { scripts: { dev: 'vite', build: 'vite build' } },
    onExec: () => {
      throw new Error('no project gate should run');
    },
  });

  const result = await verify({ runner });

  assert.deepEqual(result, { ran: true, clean: true, rounds: 1, fixes: 0 });
  assert.equal(runner.calls.some((call) => call.command.includes('vitest')), false);
  assert.equal(runner.calls.some((call) => call.command.includes('eslint')), false);
});

test('bunx ausente se clasifica como infraestructura no disponible, no como código roto', async () => {
  const runner = fakeRunner({
    packageJson: { scripts: { dev: 'vite', build: 'vite build' } },
    onExec: () => {
      throw new Error('no project gate should run');
    },
  });
  runner.exec = async (_projectId, command) => {
    if (command[0] === 'bun') return { exitCode: 1, stdout: '', stderr: 'spawnSync bun ENOENT' };
    return { exitCode: 1, stdout: '', stderr: 'spawnSync bunx ENOENT' };
  };

  const result = await verify({ runner });

  assert.deepEqual(result, { ran: true, clean: null, rounds: 1, fixes: 0 });
});

test('CODEX_VERIFY_TESTS=0 desactiva el gate aunque exista el script', async () => {
  const runner = fakeRunner({
    packageJson: { scripts: { test: 'vitest run' } },
    onExec: () => {
      throw new Error('disabled gate should not run');
    },
  });

  const result = await verify({
    runner,
    env: { CODEX_VERIFY_TESTS: '0' },
  });

  assert.deepEqual(result, { ran: true, clean: true, rounds: 1, fixes: 0 });
  assert.equal(runner.calls.some((call) => call.command.includes('vitest')), false);
});

test('el fixer recibe diagnósticos de tests y respeta CODEX_VERIFY_FIX_STEPS', async () => {
  const runner = fakeRunner({
    packageJson: { scripts: { test: 'vitest run' } },
    extraFiles: { 'src/App.tsx': 'export default function App() { return null; }\n' },
    onExec: ({ command }) => {
      assert.deepEqual(command, ['bunx', 'vitest', 'run', '--reporter=json']);
      return { exitCode: 1, stdout: 'FAIL src/App.test.tsx > renders the total', stderr: '' };
    },
  });
  let fixerTurns = 0;
  const llmTurn = async ({ messages }) => {
    fixerTurns += 1;
    assert.match(messages[1].content, /"gate": "tests"/);
    assert.match(messages[1].content, /TESTS_COMMAND_FAILED/);
    return {
      text: 'Inspecciono el componente.',
      toolCalls: [{
        id: `read-${fixerTurns}`,
        name: 'read_file',
        args: { path: 'src/App.tsx' },
      }],
    };
  };

  const result = await verify({
    runner,
    llmTurn,
    env: {
      CODEX_VERIFY_ROUNDS: '2',
      CODEX_VERIFY_FIX_STEPS: '2',
    },
  });

  assert.equal(result.clean, false);
  assert.deepEqual(result.blockingGates, ['tests']);
  assert.equal(fixerTurns, 2);
  assert.equal(result.rounds, 2);
  assert.equal(result.fixes, 0);
  assert.equal(runner.calls.filter((call) => call.command.includes('vitest')).length, 2);
});
