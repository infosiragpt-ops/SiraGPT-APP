'use strict';

// install_sandbox_package in the document agent: a ModuleNotFoundError turns
// into «approved → install once and retry» or «not approved → reported to
// the administrator», the install is budgeted per turn, every sandbox
// command sees the installed tree through PYTHONUSERBASE, and the runner /
// prompt wiring is pinned by source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../src/services/agent-runner/tools');
const { resolvePolicy } = require('../src/services/agent-runner/sandbox-packages/policy');
const { buildAgentRunnerPrompt } = require('../src/services/agent-runner/prompt');

const ON = resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1', SIRAGPT_SANDBOX_PIP_MAX_PER_TURN: '2' });
const OFF = resolvePolicy({ NODE_ENV: 'test' });
const read = (relative) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agent-runner', relative), 'utf8');

function fakeSandbox({ installResult, execResult } = {}) {
  const files = new Map();
  const calls = { exec: [], install: [] };
  return {
    driver: 'docker',
    calls,
    files,
    async exec(cmd) { calls.exec.push(cmd); return execResult || { exitCode: 0, stdout: 'ok', stderr: '' }; },
    async installPythonPackages(opts) {
      calls.install.push(opts);
      return typeof installResult === 'function' ? installResult(opts) : (installResult || { ok: true, code: 'ok', installed: [{ name: 'seaborn', version: '0.13.2' }], notAllowed: [], notFound: [], bytes: 1000, durationMs: 50, detail: '' });
    },
    async readFile(rel) { if (!files.has(rel)) throw new Error('ENOENT'); return Buffer.from(files.get(rel)); },
    async writeFile(rel, content) { files.set(rel, String(content)); },
  };
}

test('a failed import names the approved distribution and the tool; the gap is reported once per distribution', async () => {
  const gaps = [];
  const sandbox = fakeSandbox({ execResult: { exitCode: 1, stderr: "Traceback…\nModuleNotFoundError: No module named 'cv2'" } });
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy: ON, onGap: (g) => gaps.push(g) } });
  const out = await executors.execute_python({ code: 'import cv2' });
  assert.match(out, /^ERROR: python failed/);
  assert.match(out, /\[Capability recovery: missing_dependency\]/);
  assert.match(out, /«opencv-python-headless» is on the APPROVED list: call install_sandbox_package\(\{"packages":\["opencv-python-headless"\]\}\)/);
  assert.doesNotMatch(out, /sandbox is offline/);
  await executors.execute_python({ code: 'import cv2.data' });
  assert.deepEqual(gaps, [{ kind: 'python_package', name: 'cv2', package: 'opencv-python-headless', allowed: true, tool: 'execute_python' }], 'one gap per distribution per turn');
  // Not approved: honest, reported, never installed.
  const denied = [];
  const sb2 = fakeSandbox({ execResult: { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'torch'" } });
  const ex2 = tools.makeToolExecutors(sb2, { capability: { policy: ON, onGap: (g) => denied.push(g) } });
  const out2 = await ex2.execute_python({ code: 'import torch' });
  assert.match(out2, /«torch» is NOT on the approved package list: it was reported to the administrator/);
  assert.equal(denied[0].allowed, false);
  // A missing binary in execute_bash is a gap of kind binary.
  const bin = [];
  const sb3 = fakeSandbox({ execResult: { exitCode: 127, stderr: 'bash: line 1: ocrmypdf: command not found' } });
  const ex3 = tools.makeToolExecutors(sb3, { capability: { policy: ON, onGap: (g) => bin.push(g) } });
  await ex3.execute_bash({ command: 'ocrmypdf a.pdf b.pdf' });
  assert.deepEqual(bin, [{ kind: 'binary', name: 'ocrmypdf', package: null, allowed: false, tool: 'execute_bash' }]);
  // Policy off: the old offline wording, gap still reported (allowed:false).
  const offGaps = [];
  const sb4 = fakeSandbox({ execResult: { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'cv2'" } });
  const ex4 = tools.makeToolExecutors(sb4, { capability: { policy: OFF, onGap: (g) => offGaps.push(g) } });
  assert.match(await ex4.execute_python({ code: 'import cv2' }), /sandbox is offline/);
  assert.equal(offGaps[0].allowed, false);
});

test('install_sandbox_package: validates, refuses unapproved names (reported), honours the per-turn budget and records the manifest', async () => {
  const gaps = [];
  const installs = [];
  const sandbox = fakeSandbox();
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy: ON, onGap: (g) => gaps.push(g), onInstall: (i) => installs.push(i) } });
  assert.match(await executors.install_sandbox_package({}), /ERROR: nothing was installed\. Pass packages/);
  assert.match(await executors.install_sandbox_package({ packages: ['git+https://x', 'seaborn'] }), /Invalid specs .*git\+https:\/\/x/);
  const denied = await executors.install_sandbox_package({ packages: ['torch', 'seaborn'] });
  assert.match(denied, /Not on the approved package list \(reported to the administrator; do not retry them\): torch/);
  assert.deepEqual(gaps, [{ kind: 'python_package', name: 'torch', package: 'torch', allowed: false, tool: 'install_sandbox_package' }]);
  assert.equal(sandbox.calls.install.length, 0, 'a refused batch never reaches the installer');
  const ok = await executors.install_sandbox_package({ packages: ['Seaborn==0.13.2'], reason: 'import seaborn failed' });
  assert.match(ok, /^Installed into the sandbox: seaborn 0\.13\.2\. Import them normally in execute_python/);
  const sent = sandbox.calls.install[0];
  assert.deepEqual(sent.requirements, ['seaborn==0.13.2']);
  assert.ok(JSON.parse(sent.allowJson).includes('seaborn'));
  assert.deepEqual([sent.network, sent.timeoutMs, sent.maxBytes, sent.tmpSize], [ON.network, ON.timeoutMs, ON.maxBytes, ON.tmpSize]);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].code, 'ok');
  assert.deepEqual(installs[0].requested, ['seaborn==0.13.2']);
  assert.equal(installs[0].driver, 'docker');
  const manifest = JSON.parse(sandbox.files.get(tools.MANIFEST_REL));
  assert.equal(manifest.packages.seaborn.version, '0.13.2');
  assert.deepEqual(manifest.requested, ['seaborn==0.13.2']);
  // Already available → honest, no manifest growth beyond requested.
  sandbox.calls.install.length = 0;
  const sb2 = fakeSandbox({ installResult: { ok: true, code: 'ok', installed: [], bytes: 0, durationMs: 1, detail: '' } });
  const ex2 = tools.makeToolExecutors(sb2, { capability: { policy: ON } });
  assert.match(await ex2.install_sandbox_package({ packages: ['numpy'] }), /^Already available: numpy/);
  // Budget: the policy allows 2 calls per turn.
  await executors.install_sandbox_package({ packages: ['pandas'] });
  const over = await executors.install_sandbox_package({ packages: ['scipy'] });
  assert.match(over, /install budget for this turn is exhausted \(2 calls\)/);
  assert.equal(sandbox.calls.install.length, 1, 'the third call never reaches the installer');
});

test('install failures are explained honestly per code and unapproved resolved dependencies are reported as gaps', async () => {
  const cases = [
    [{ code: 'not_allowed', notAllowed: ['nvidia-cublas'] }, /outside the approved list \(nvidia-cublas\); nothing was installed and the gap was reported/],
    [{ code: 'not_found', notFound: ['foo==9'] }, /no binary wheel exists for foo==9/],
    [{ code: 'network' }, /package index could not be reached/],
    [{ code: 'timeout' }, /exceeded \d+ s; nothing was installed/],
    [{ code: 'too_large' }, /exceed the \d+ MB sandbox cap/],
    [{ code: 'aborted' }, /cancelled/],
    [{ code: 'disk' }, /no space left/],
    [{ code: 'conflict' }, /already installed in this conversation; their versions are preserved/],
    [{ code: 'commit_failed' }, /previous environment was preserved/],
    [{ code: 'environment_invalid' }, /existing package environment could not be verified/],
    [{ code: 'environment_changed' }, /another installation changed the environment/],
    [{ code: 'commit_unknown' }, /result is unknown: do not claim success/],
    [{ code: 'extract_failed', detail: 'tar: broken' }, /install failed \(extract_failed\): tar: broken/],
  ];
  for (const [result, expected] of cases) {
    const gaps = [];
    const sandbox = fakeSandbox({ installResult: { ok: false, installed: [], notAllowed: [], notFound: [], bytes: 0, durationMs: 1, detail: '', ...result } });
    const executors = tools.makeToolExecutors(sandbox, { capability: { policy: ON, onGap: (g) => gaps.push(g) } });
    const out = await executors.install_sandbox_package({ packages: ['numpy'] });
    assert.match(out, /^ERROR: /, result.code);
    assert.match(out, expected, result.code);
    if (result.code === 'not_allowed') assert.deepEqual(gaps.map((g) => g.name), ['nvidia-cublas']);
    assert.equal(sandbox.files.has(tools.MANIFEST_REL), false, 'no manifest on failure');
  }
  // An installer that throws is still an honest failure, never a crash.
  const throwing = fakeSandbox({ installResult: () => { throw new Error('docker daemon down'); } });
  const ex = tools.makeToolExecutors(throwing, { capability: { policy: ON } });
  assert.match(await ex.install_sandbox_package({ packages: ['numpy'] }), /install failed \(install_failed\): docker daemon down/);
  // Disabled policy / driver without installer.
  const off = tools.makeToolExecutors(fakeSandbox(), { capability: { policy: OFF } });
  assert.match(await off.install_sandbox_package({ packages: ['numpy'] }), /disabled on this server/);
  const noDriver = tools.makeToolExecutors({ async exec() { return { exitCode: 0 }; } }, { capability: { policy: ON } });
  assert.match(await noDriver.install_sandbox_package({ packages: ['numpy'] }), /cannot install packages/);
});

test('the sandbox drivers (not the tools) export PYTHONUSERBASE and PATH, so installed packages and their scripts work in every command', async () => {
  const sandboxModule = require('../src/services/doc-agent/sandbox');
  // Tool layer: plain commands (fake sandboxes in other tests keep matching them).
  const sandbox = fakeSandbox();
  const executors = tools.makeToolExecutors(sandbox);
  await executors.execute_python({ code: 'import seaborn' });
  await executors.execute_bash({ command: 'pdf2image --version' });
  assert.match(sandbox.calls.exec[0], /^python3 -c "/);
  assert.match(sandbox.calls.exec[0], /sys\.path\.insert\(0, '\/workspace\/tmp'\)/, 'the staged helpers stay importable');
  assert.match(sandbox.calls.exec[0], /<<'PY'\nimport seaborn\nPY$/);
  assert.equal(sandbox.calls.exec[1], 'pdf2image --version');
  // Docker driver: docker exec -e PYTHONUSERBASE + PATH export inside bash -c.
  const calls = [];
  const processRunner = async (command, args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '' }; };
  const docker = await sandboxModule._createDockerSandbox({ processRunner, availableRuntimes: ['runsc'], env: { NODE_ENV: 'test' } });
  await docker.exec('python3 -c "import seaborn"');
  const exec = calls.find((a) => a[0] === 'exec' && a.includes('bash'));
  assert.ok(exec, 'docker exec issued');
  assert.deepEqual(exec.slice(0, 5), ['exec', '-w', '/workspace', '-e', `PYTHONUSERBASE=${tools.PACKAGES_DIR}`]);
  assert.equal(exec.at(-1), `${sandboxModule.PACKAGES_PATH_EXPORT}python3 -c "import seaborn"`);
  assert.equal(sandboxModule.PACKAGES_PATH_EXPORT, 'export PATH=/workspace/.sira-packages/bin:"$PATH"; ');
  assert.equal(tools.PACKAGES_DIR, '/workspace/.sira-packages');
  await docker.destroy();
  // Local driver: the scrubbed env carries both, pointing inside its root.
  const local = await sandboxModule._createLocalSandbox({});
  const r = await local.exec('printf "%s|%s" "$PYTHONUSERBASE" "$PATH"');
  const [userBase, pathValue] = String(r.stdout).split('|');
  assert.equal(userBase, require('node:path').join(local.root, '.sira-packages'));
  assert.ok(pathValue.startsWith(require('node:path').join(local.root, '.sira-packages', 'bin')), pathValue.slice(0, 80));
  await local.destroy();
  // Microservice mirror.
  const service = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'sandbox', 'lib', 'docker-sandbox.js'), 'utf8');
  assert.match(service, /'-e', 'PYTHONUSERBASE=\/workspace\/\.sira-packages', name, 'bash', '-c', `export PATH=\/workspace\/\.sira-packages\/bin:"\$PATH"; \$\{String\(command\)\}`/);
});

test('wrong submodules, SiraGPT helpers and bash tracebacks are classified before anything is offered for install', async () => {
  const run = async (tool, execResult, args) => {
    const gaps = [];
    const sandbox = fakeSandbox({ execResult });
    const ex = tools.makeToolExecutors(sandbox, { capability: { policy: ON, onGap: (g) => gaps.push(g) } });
    return { out: await ex[tool](args), gaps, sandbox };
  };
  // «pptx.util2»: pptx IS installed, the submodule does not exist — an API mistake.
  const sub = await run('execute_python', { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'pptx.util2'" }, { code: 'import pptx.util2' });
  assert.match(sub.out, /\[Capability recovery: missing_submodule\]/);
  assert.match(sub.out, /Do not install anything/);
  assert.doesNotMatch(sub.out, /install_sandbox_package/);
  assert.deepEqual(sub.gaps, [], 'not a capability gap');
  // A staged SiraGPT helper is a staging problem, never a PyPI distribution.
  const helper = await run('execute_python', { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'sira_charts'" }, { code: 'import sira_charts' });
  assert.match(helper.out, /\[Capability recovery: missing_helper\]/);
  assert.match(helper.out, /\/workspace\/tmp/);
  assert.deepEqual(helper.gaps, []);
  // A namespace root names the distribution by its second component.
  const ns = await run('execute_python', { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'google.protobuf'" }, { code: 'import google.protobuf' });
  assert.match(ns.out, /\[Capability recovery: missing_dependency\]/);
  assert.match(ns.out, /«protobuf» is NOT on the approved package list/);
  assert.equal(ns.gaps[0].package, 'protobuf');
  // `python3 script.py` through execute_bash fails with a traceback (exit 1):
  // still read as the Python failure it is.
  const bash = await run('execute_bash', { exitCode: 1, stderr: "Traceback (most recent call last):\n  File \"/workspace/s.py\", line 1\nModuleNotFoundError: No module named 'seaborn'" }, { command: 'python3 s.py' });
  assert.match(bash.out, /«seaborn» is on the APPROVED list/);
  assert.deepEqual(bash.gaps.map((g) => [g.kind, g.package, g.allowed, g.tool]), [['python_package', 'seaborn', true, 'execute_bash']]);
});

test('conflicts with the image and a failed commit are explained without inviting a retry loop', async () => {
  for (const [code, re] of [
    ['conflict', /conflicts with libraries in the sandbox image or already installed in this conversation/],
    ['commit_failed', /could not be activated; the previous environment was preserved/],
  ]) {
    const sandbox = fakeSandbox({ installResult: { ok: false, code, installed: [], notAllowed: [], notFound: [], bytes: 0, durationMs: 1, detail: '' } });
    const ex = tools.makeToolExecutors(sandbox, { capability: { policy: ON } });
    const out = await ex.install_sandbox_package({ packages: ['seaborn'] });
    assert.match(out, /^ERROR: /, code);
    assert.match(out, re, code);
  }
});

test('installed packages stay out of glob/grep and workspace listings unless asked for explicitly', async () => {
  const sandbox = fakeSandbox({ execResult: { exitCode: 0, stdout: './outputs/a.docx', stderr: '' } });
  const ex = tools.makeToolExecutors(sandbox, { capability: { policy: ON } });
  await ex.glob({ pattern: '**/*.py' });
  await ex.glob({ pattern: '.sira-packages/lib/**/*.py' });
  await ex.grep({ pattern: 'Document', path: '.' });
  await ex.grep({ pattern: 'Document', path: '.sira-packages/lib' });
  const [globAll, globPkgs, grepAll, grepPkgs] = sandbox.calls.exec;
  assert.match(globAll, /find \. -name '\.sira-packages\*' -prune -o -type f/);
  assert.doesNotMatch(globPkgs, /-prune/);
  assert.match(grepAll, /--exclude-dir='\.sira-packages\*'/);
  assert.doesNotMatch(grepPkgs, /--exclude-dir/);
  // Local driver: the walk skips the package tree (and its staging dirs).
  const sandboxModule = require('../src/services/doc-agent/sandbox');
  const local = await sandboxModule._createLocalSandbox({});
  try {
    await local.writeFile('outputs/a.docx', 'x');
    await local.writeFile('.sira-packages/lib/python3.12/site-packages/seaborn/__init__.py', 'x');
    await local.writeFile('.sira-packages.staging-1/lib/x.py', 'x');
    const listed = (await local.listFiles('.')).map((f) => f.path);
    assert.ok(listed.includes(path.join('outputs', 'a.docx')));
    assert.ok(!listed.some((p) => p.startsWith('.sira-packages')), listed.join(','));
    const inside = (await local.listFiles('.sira-packages')).map((f) => f.path);
    assert.ok(inside.some((p) => p.endsWith(path.join('seaborn', '__init__.py'))), 'asked for explicitly → listed');
  } finally {
    await local.destroy?.();
  }
});

test('the tool is offered exactly when the policy is on, and the runner + prompt are wired to it', () => {
  const names = (env) => tools.buildToolDefinitions(env).map((d) => d.function.name);
  assert.ok(!names({ NODE_ENV: 'test' }).includes('install_sandbox_package'));
  assert.ok(names({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1' }).includes('install_sandbox_package'));
  assert.ok(!names({ NODE_ENV: 'production', SIRAGPT_SANDBOX_PIP: '0' }).includes('install_sandbox_package'));
  assert.ok(names({ NODE_ENV: 'production' }).includes('install_sandbox_package'));
  assert.deepEqual(tools.INSTALL_TOOL_DEFINITION.function.parameters.required, ['packages']);
  assert.match(tools.BASE_TOOL_DEFINITIONS.find((d) => d.function.name === 'execute_python').function.description, /install_sandbox_package/);
  const index = read('index.js');
  // Prompt, tool list and executor follow the same decision (the tool list is
  // the process snapshot; the policy is read per turn).
  assert.match(index, /const livePolicy = sandboxPackages\.resolvePolicy\(\);/);
  assert.match(index, /TOOL_DEFINITIONS\.some\(\(d\) => d && d\.function && d\.function\.name === 'install_sandbox_package'\)/);
  assert.match(index, /const packagePolicy = installerOffered \? livePolicy : \{ \.\.\.livePolicy, enabled: false \};/);
  assert.match(index, /packageInstaller: \{ enabled: packagePolicy\.enabled \}/);
  assert.match(index, /capability: \{ policy: packagePolicy, onGap: onCapabilityGap, onInstall: onCapabilityInstall \}/);
  assert.match(index, /step: 'capability_gap'/);
  assert.match(index, /step: 'capability_install'/);
  assert.match(index, /capabilityLedger\.recordCapabilityGap\(/);
  assert.match(index, /capabilityLedger\.recordCapabilityInstall\(/);
  const on = buildAgentRunnerPrompt({ fileNames: ['a.docx'], packageInstaller: { enabled: true } });
  assert.match(on, /call install_sandbox_package\(\{"packages":\["<distribution>"\]\}\) ONCE and retry/);
  assert.match(on, /- install_sandbox_package: install APPROVED Python packages/);
  const off = buildAgentRunnerPrompt({ fileNames: ['a.docx'] });
  assert.doesNotMatch(off, /install_sandbox_package/);
  assert.match(off, /New dependencies must enter the reviewed sandbox image/);
  assert.match(read('trace.js'), /install_sandbox_package: 'Instalando una librería aprobada en el sandbox'/);
});
