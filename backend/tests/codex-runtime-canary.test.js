'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RuntimeCanaryError,
  runRuntimeCanary,
} = require('../src/services/codex/runtime-canary');

function fakeRunner({ buildFails = false } = {}) {
  const calls = [];
  let commits = 0;
  let starts = 0;
  return {
    calls,
    initWorkspace: async (project) => {
      calls.push(['init', project]);
      return { ok: true };
    },
    writeFiles: async (project, files) => {
      calls.push(['write', project, files]);
      return { ok: true, written: files.length };
    },
    readFile: async (_project, path) => {
      calls.push(['read', path]);
      return { content: '<!doctype html><div id="root"></div><script src="/assets/app.js"></script>' };
    },
    exec: async (_project, command) => {
      calls.push(['exec', command]);
      if (command.join(' ') === 'npm run build' && buildFails) {
        return { exitCode: 1, stdout: '', stderr: 'build exploded' };
      }
      if (command.includes('commit')) {
        commits += 1;
        return { exitCode: 0, stdout: `[main abc] run ${commits}`, stderr: '' };
      }
      if (command.join(' ') === 'git rev-parse HEAD') {
        return { exitCode: 0, stdout: `${commits === 1 ? 'a'.repeat(40) : 'b'.repeat(40)}\n`, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    startDev: async () => {
      starts += 1;
      calls.push(['start', starts]);
      return { ok: true, port: 5173, reused: starts > 1 };
    },
    devStatus: async () => ({
      running: true,
      ready: true,
      project: 'sira-runtime-canary',
      port: 5173,
      preflight: {
        install: { status: 'passed' },
        build: { status: 'passed' },
        render: { status: 'passed' },
      },
    }),
    stopDev: async () => {
      calls.push(['stop']);
      return { ok: true };
    },
  };
}

const browser = {
  devUrlFor: (_env, port) => `http://runner:${port}`,
  checkApp: async ({ expectedText }) => ({
    ok: true,
    rendered: true,
    rootChars: expectedText.length + 20,
    expectedTextFound: true,
    errors: [],
  }),
  formatReport: () => 'render failed',
};

test('runtime canary requires build + render and proves a second iteration on the same workspace', async () => {
  const runner = fakeRunner();
  const result = await runRuntimeCanary({
    runner,
    browser,
    idFactory: () => 'fixed-probe',
    delay: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.preflight.install, true);
  assert.equal(result.preflight.build, true);
  assert.equal(result.preflight.artifact, true);
  assert.equal(result.secondRunContinued, true);
  assert.equal(result.iterations.length, 2);
  assert.notEqual(result.iterations[0].commitSha, result.iterations[1].commitSha);
  assert.equal(result.iterations[1].reused, true);
  assert.equal(
    runner.calls.filter(([name, command]) => name === 'exec' && command?.join(' ') === 'npm run build').length,
    2,
  );
  assert.equal(runner.calls.at(-1)[0], 'stop');
});

test('runtime canary fails closed on a build error and still stops its preview slot', async () => {
  const runner = fakeRunner({ buildFails: true });
  await assert.rejects(
    () => runRuntimeCanary({
      runner,
      browser,
      idFactory: () => 'failed-probe',
      delay: async () => {},
    }),
    (error) => {
      assert.ok(error instanceof RuntimeCanaryError);
      assert.equal(error.phase, 'run_1.build');
      assert.match(error.evidence, /build exploded/);
      return true;
    },
  );
  assert.equal(runner.calls.at(-1)[0], 'stop');
});

test('runtime canary fails when the second render is stale', async () => {
  const runner = fakeRunner();
  let checks = 0;
  const staleBrowser = {
    ...browser,
    checkApp: async ({ expectedText }) => {
      checks += 1;
      const stale = expectedText.endsWith('RUN-2');
      return {
        ok: !stale,
        rendered: true,
        rootChars: 20,
        expectedTextFound: !stale,
        errors: [],
      };
    },
  };
  await assert.rejects(
    () => runRuntimeCanary({
      runner,
      browser: staleBrowser,
      idFactory: () => 'stale-probe',
      delay: async () => {},
    }),
    (error) => {
      assert.equal(error.phase, 'browser_render');
      return true;
    },
  );
  assert.ok(checks > 2);
  assert.equal(runner.calls.at(-1)[0], 'stop');
});
