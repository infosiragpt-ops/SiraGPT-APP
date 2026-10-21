'use strict';

/**
 * install_sandbox_package in the chat: the document agent's executor
 * (curated list + vetting of any other PyPI distribution) runs against THIS
 * chat's sandbox volume, so python_exec / bash_exec import the package in
 * later calls. A failed import in python_exec / bash_exec says whether the
 * install is possible, in the document agent's exact wording.
 *
 * Offline: createSandbox, the vetter and the capability ledger are stubbed.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-install-'));

const runner = require('../src/services/agents/isolated-code-runner');
const docSandbox = require('../src/services/doc-agent/sandbox');
const vetting = require('../src/services/agent-runner/sandbox-packages/vetting');
const ledger = require('../src/services/capability-ledger');
const { INTERNAL } = require('../src/services/agents/task-tools');

const ENV_KEYS = ['SIRAGPT_CODE_SANDBOX', 'SIRAGPT_SANDBOX_PIP', 'SIRAGPT_SANDBOX_PIP_MAX_PER_TURN'];
const saved = {
  env: Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])),
  createSandbox: docSandbox.createSandbox,
  sharedVetter: vetting.sharedVetter,
  recordGap: ledger.recordCapabilityGap,
  recordInstall: ledger.recordCapabilityInstall,
  runIsolated: runner.runIsolated,
};
let boxes;
let ledgerCalls;

function fakeBox(installResult) {
  const box = {
    persistKey: null,
    installs: [],
    files: new Map(),
    destroyed: 0,
    driver: 'remote',
    async installPythonPackages(opts) {
      box.installs.push(opts);
      return typeof installResult === 'function' ? installResult(opts) : installResult;
    },
    async readFile(rel) { if (!box.files.has(rel)) throw new Error('ENOENT'); return Buffer.from(box.files.get(rel)); },
    async writeFile(rel, content) { box.files.set(rel, String(content)); },
    async exec() { return { exitCode: 0, stdout: '', stderr: '' }; },
    async destroy() { box.destroyed += 1; },
  };
  return box;
}
const installed = (...pairs) => ({ ok: true, code: 'ok', installed: pairs.map(([name, version]) => ({ name, version })), notAllowed: [], notFound: [], bytes: 2048, durationMs: 30, detail: '' });

beforeEach(() => {
  boxes = [];
  ledgerCalls = { gaps: [], installs: [] };
  process.env.SIRAGPT_CODE_SANDBOX = 'isolated';
  process.env.SIRAGPT_SANDBOX_PIP = '1';
  process.env.SIRAGPT_SANDBOX_PIP_MAX_PER_TURN = '2';
  ledger.recordCapabilityGap = async (gap) => { ledgerCalls.gaps.push(gap); };
  ledger.recordCapabilityInstall = async (info) => { ledgerCalls.installs.push(info); };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved.env[key] === undefined) delete process.env[key];
    else process.env[key] = saved.env[key];
  }
  docSandbox.createSandbox = saved.createSandbox;
  vetting.sharedVetter = saved.sharedVetter;
  ledger.recordCapabilityGap = saved.recordGap;
  ledger.recordCapabilityInstall = saved.recordInstall;
  runner.runIsolated = saved.runIsolated;
});

function useBoxes(installResult) {
  docSandbox.createSandbox = async (opts) => {
    const box = fakeBox(installResult);
    box.persistKey = opts.persistKey;
    boxes.push(box);
    return box;
  };
}

test('installs into THIS chat volume through the document agent executor, once per call, with a per-turn budget', async () => {
  useBoxes(installed(['seaborn', '0.13.2']));
  const ctx = { userId: 'u1', chatId: 'chat-pip', onEvent: () => {} };
  const first = await INTERNAL.installSandboxPackage.execute({ packages: ['seaborn'], reason: 'ModuleNotFoundError: seaborn' }, ctx);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.match(first.result, /^Installed into the sandbox: seaborn 0\.13\.2\. Import them normally in python_exec/);
  assert.equal(boxes[0].persistKey, 'chat-pip', 'the packages land in the chat workspace volume');
  assert.deepEqual(boxes[0].installs[0].requirements, ['seaborn']);
  assert.ok(boxes[0].files.has('.sira-packages/.sira/manifest.json') || [...boxes[0].files.keys()].some((k) => k.includes('manifest')), 'the install manifest is recorded in the workspace');
  assert.equal(boxes[0].destroyed, 1, 'the installer session is released');
  assert.deepEqual(ledgerCalls.installs[0].requested, ['seaborn']);
  assert.equal(ledgerCalls.installs[0].chatId, 'chat-pip');

  const second = await INTERNAL.installSandboxPackage.execute({ packages: ['seaborn'] }, ctx);
  assert.equal(second.ok, true);
  const third = await INTERNAL.installSandboxPackage.execute({ packages: ['seaborn'] }, ctx);
  assert.equal(third.ok, false);
  assert.match(third.error, /install budget for this turn is exhausted \(2 calls\)/);
  assert.equal(boxes.length, 2, 'no sandbox is opened once the budget is spent');
});

test('a name outside the curated list is vetted before it can reach the installer', async () => {
  useBoxes(installed(['lifelines', '0.30.0']));
  const vetted = [];
  vetting.sharedVetter = () => ({
    async vet(entries) {
      vetted.push(entries.map((e) => e.name));
      return entries.map((e) => ({ ok: true, name: e.name, reason: 'vetted', detail: '', evidence: { ageDays: 4000, monthlyDownloads: 1_500_000 } }));
    },
  });
  const r = await INTERNAL.installSandboxPackage.execute({ packages: ['lifelines'] }, { userId: 'u1', chatId: 'chat-vet' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(vetted, [['lifelines']]);
  assert.ok(JSON.parse(boxes[0].installs[0].allowJson).includes('lifelines'));
  assert.match(r.result, /Outside the curated list, vetted: lifelines/);

  vetting.sharedVetter = () => ({
    async vet(entries) {
      return entries.map((e) => ({ ok: false, name: e.name, reason: 'possible_typosquat', detail: 'its name imitates «requests»; if that is the library you meant, install «requests»' }));
    },
  });
  const refused = await INTERNAL.installSandboxPackage.execute({ packages: ['reqeusts'] }, { userId: 'u1', chatId: 'chat-vet-2' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Refused by the package vetting: «reqeusts»: its name imitates «requests»/);
  assert.equal(boxes[1].installs.length, 0, 'a refused name never reaches the installer');
  assert.equal(ledgerCalls.gaps[0].name, 'reqeusts');
  assert.equal(ledgerCalls.gaps[0].source, 'chat');
});

test('refuses honestly outside the isolated sandbox, without a saved chat, or with the policy off', async () => {
  useBoxes(installed());
  process.env.SIRAGPT_CODE_SANDBOX = 'host';
  assert.match((await INTERNAL.installSandboxPackage.execute({ packages: ['seaborn'] }, { chatId: 'c' })).error, /only exists in the isolated sandbox/);
  process.env.SIRAGPT_CODE_SANDBOX = 'isolated';
  assert.match((await INTERNAL.installSandboxPackage.execute({ packages: ['seaborn'] }, {})).error, /needs a saved conversation/);
  process.env.SIRAGPT_SANDBOX_PIP = '0';
  assert.match((await INTERNAL.installSandboxPackage.execute({ packages: ['seaborn'] }, { chatId: 'c' })).error, /disabled on this server/);
  assert.equal(boxes.length, 0);
  docSandbox.createSandbox = async () => { throw new Error('at capacity'); };
  process.env.SIRAGPT_SANDBOX_PIP = '1';
  const down = await INTERNAL.installSandboxPackage.execute({ packages: ['seaborn'] }, { chatId: 'c' });
  assert.equal(down.code, 'E_SANDBOX_UNAVAILABLE');
});

test('a failed import in python_exec / bash_exec says whether install_sandbox_package can add it', async () => {
  runner.runIsolated = async (opts) => ({
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: opts.language === 'bash'
      ? 'Traceback (most recent call last):\n  File "x.py", line 1\nModuleNotFoundError: No module named \'cv2\''
      : "Traceback (most recent call last):\nModuleNotFoundError: No module named 'lifelines'",
    outbox: { files: [], skipped: [] },
  });
  const py = await INTERNAL.pythonExec.execute({ source: 'import lifelines' }, { chatId: 'c1' });
  assert.equal(py.ok, false);
  assert.match(py.recovery, /\[Capability recovery: missing_dependency\]/);
  assert.match(py.recovery, /«lifelines» is not on the curated list, but the server can vet it/);
  const sh = await INTERNAL.bashExec.execute({ source: 'python3 x.py' }, { chatId: 'c1' });
  assert.match(sh.recovery, /«opencv-python-headless» is on the APPROVED list: call install_sandbox_package/);

  runner.runIsolated = async () => ({ ok: false, exitCode: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'sira_charts'", outbox: { files: [], skipped: [] } });
  const helper = await INTERNAL.pythonExec.execute({ source: 'import sira_charts' }, { chatId: 'c1' });
  assert.match(helper.recovery, /internal helper of the document agent, not a library/);

  runner.runIsolated = async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'ZeroDivisionError: division by zero', outbox: { files: [], skipped: [] } });
  const other = await INTERNAL.pythonExec.execute({ source: '1/0' }, { chatId: 'c1' });
  assert.equal(other.recovery, undefined, 'only a missing dependency gets install guidance');
});

test('the chat offers the tool only in the isolated sandbox with the package policy on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentic-chat-stream.js'), 'utf8');
  assert.match(src, /sandboxInstallOffered\(\) \? taskTools\.installSandboxPackage : null/);
  assert.match(src, /resolveCodeExecutionMode\(process\.env\) !== 'isolated'\) return false;/);
  assert.match(INTERNAL.installPackageDescription({ NODE_ENV: 'production' }), /any other PyPI distribution is vetted first/);
  assert.match(INTERNAL.installPackageDescription({ NODE_ENV: 'production', SIRAGPT_SANDBOX_PIP: 'allowlist' }), /Only packages on the approved list/);
  assert.deepEqual(INTERNAL.installSandboxPackage.parameters.required, ['packages']);
});
