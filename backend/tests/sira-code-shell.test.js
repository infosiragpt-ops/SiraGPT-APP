'use strict';

/**
 * SiraCode sandboxed bash/shell — allowlist, jail, plan vs construir.
 * Offline workspace. No sidecar, no network, no secrets.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../src/services/sira-code/workspace');
const { executeTool } = require('../src/services/sira-code/tools');
const {
  classifyCommand,
  authorizeShellCommand,
  ERRORS,
  clampTimeoutMs,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} = require('../src/services/sira-code/shell-sandbox');

function session(agentId, workspace, extra = {}) {
  return { agentId, workspace, permission: 'default', ...extra };
}

async function bash(agentId, workspace, args, ctx = {}) {
  return executeTool(session(agentId, workspace), 'bash', args, ctx);
}

test('echo and pwd are allowlisted reads in construir', async () => {
  const workspace = await createWorkspace('sc-sh-echo');
  try {
    const echoed = await bash('construir', workspace, { command: 'echo hola-sira' });
    assert.equal(echoed.ok, true, echoed.error);
    assert.match(echoed.content, /hola-sira/);
    const pwd = await bash('construir', workspace, { command: 'pwd' });
    assert.equal(pwd.ok, true, pwd.error);
    assert.equal(pwd.content.includes(workspace.root), true);
  } finally {
    await workspace.destroy();
  }
});

test('shell alias runs the same allowlisted contract', async () => {
  const workspace = await createWorkspace('sc-sh-alias');
  try {
    const result = await executeTool(session('construir', workspace), 'shell', {
      command: 'echo alias-ok',
    });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /alias-ok/);
    assert.equal(result.permission.tool, 'bash');
  } finally {
    await workspace.destroy();
  }
});

test('empty command returns a Spanish validation error', async () => {
  const workspace = await createWorkspace('sc-sh-empty');
  try {
    const result = await bash('construir', workspace, { command: '   ' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'validation');
    assert.match(result.error, /obligatorio/);
  } finally {
    await workspace.destroy();
  }
});

test('unknown binaries are not allowlisted', async () => {
  const workspace = await createWorkspace('sc-sh-unknown');
  try {
    const result = await bash('construir', workspace, { command: 'totally-unknown-bin --help' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_allowlisted');
    assert.match(result.error, /lista permitida/);
  } finally {
    await workspace.destroy();
  }
});

test('dangerous commands are denied with Spanish copy', async () => {
  const workspace = await createWorkspace('sc-sh-danger');
  try {
    for (const command of ['sudo id', 'eval echo x', 'bash -c "echo x"', 'python -c "print(1)"']) {
      const result = await bash('construir', workspace, { command });
      assert.equal(result.ok, false, command);
      assert.ok(['command_denied', 'command_substitution', 'not_allowlisted'].includes(result.code), result.code);
      assert.match(String(result.error), /no permitid|lista permitida|sustitución/i);
    }
  } finally {
    await workspace.destroy();
  }
});

test('rm -rf / is a path escape, not an execution', async () => {
  const workspace = await createWorkspace('sc-sh-rmroot');
  try {
    const result = await bash('construir', workspace, { command: 'rm -rf /' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'path_escape');
    assert.match(result.error, /fuera del workspace/);
  } finally {
    await workspace.destroy();
  }
});

test('curl and wget are blocked unless allowNetwork on construir', async () => {
  const workspace = await createWorkspace('sc-sh-net');
  try {
    const curl = await bash('construir', workspace, { command: 'curl https://example.com' });
    assert.equal(curl.ok, false);
    assert.equal(curl.code, 'network_blocked');
    assert.match(curl.error, /red está bloqueada/);
    const wget = await bash('construir', workspace, { command: 'wget https://example.com' });
    assert.equal(wget.ok, false);
    assert.equal(wget.code, 'network_blocked');
    const allowed = authorizeShellCommand('curl https://example.com', {
      agentId: 'construir',
      allowNetwork: true,
      workspaceRoot: workspace.root,
    });
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(allowed.className, 'network');
    const planNet = await bash('planificar', workspace, {
      command: 'curl https://example.com',
    }, { approved: true });
    assert.equal(planNet.ok, false);
    assert.equal(planNet.code, 'network_blocked');
  } finally {
    await workspace.destroy();
  }
});

test('git clone is network; git status is read', () => {
  const clone = classifyCommand('git clone https://example.com/repo.git');
  assert.equal(clone.ok, true);
  assert.equal(clone.className, 'network');
  const status = classifyCommand('git status');
  assert.equal(status.ok, true);
  assert.equal(status.className, 'read');
});

test('path escape via .. and /etc is denied', async () => {
  const workspace = await createWorkspace('sc-sh-escape');
  try {
    const parent = await bash('construir', workspace, { command: 'cat ../secret.txt' });
    assert.equal(parent.ok, false);
    assert.equal(parent.code, 'path_escape');
    const etc = await bash('construir', workspace, { command: 'cat /etc/passwd' });
    assert.equal(etc.ok, false);
    assert.equal(etc.code, 'path_escape');
    const home = await bash('construir', workspace, { command: 'ls ~' });
    assert.equal(home.ok, false);
    assert.equal(home.code, 'path_escape');
  } finally {
    await workspace.destroy();
  }
});

test('command substitution and backticks are denied', async () => {
  const workspace = await createWorkspace('sc-sh-sub');
  try {
    const sub = await bash('construir', workspace, { command: 'echo $(whoami)' });
    assert.equal(sub.ok, false);
    assert.equal(sub.code, 'command_substitution');
    assert.match(sub.error, /sustitución/);
    const ticks = await bash('construir', workspace, { command: 'echo `whoami`' });
    assert.equal(ticks.ok, false);
    assert.equal(ticks.code, 'command_substitution');
  } finally {
    await workspace.destroy();
  }
});

test('variable expansion and /dev/tcp are denied', async () => {
  const workspace = await createWorkspace('sc-sh-exp');
  try {
    const exp = await bash('construir', workspace, { command: 'echo $HOME' });
    assert.equal(exp.ok, false);
    assert.equal(exp.code, 'expansion');
    const tcp = await bash('construir', workspace, { command: 'echo >/dev/tcp/example.com/80' });
    assert.equal(tcp.ok, false);
    assert.ok(['network_blocked', 'command_denied'].includes(tcp.code), tcp.code);
  } finally {
    await workspace.destroy();
  }
});

test('find -exec is dangerous; plain find is read', () => {
  const exec = authorizeShellCommand('find . -exec rm {} +', { agentId: 'construir' });
  assert.equal(exec.ok, false);
  assert.equal(exec.className, 'dangerous');
  const plain = classifyCommand('find . -name "*.js"');
  assert.equal(plain.ok, true);
  assert.equal(plain.className, 'read');
});

test('timeout kills a long sleep and reports Spanish error', async () => {
  const workspace = await createWorkspace('sc-sh-to');
  try {
    const started = Date.now();
    const result = await bash('construir', workspace, { command: 'sleep 8', timeoutMs: 250 });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'timeout');
    assert.match(result.error, /tiempo límite/);
    assert.ok(elapsed < 4000, `timeout took too long: ${elapsed}ms`);
  } finally {
    await workspace.destroy();
  }
});

test('clampTimeoutMs bounds caller timeouts', () => {
  assert.equal(clampTimeoutMs(0), DEFAULT_TIMEOUT_MS);
  assert.equal(clampTimeoutMs(-5), DEFAULT_TIMEOUT_MS);
  assert.equal(clampTimeoutMs(50), 200);
  assert.equal(clampTimeoutMs(999999), MAX_TIMEOUT_MS);
  assert.equal(clampTimeoutMs(1500), 1500);
});

test('output size cap annotates Spanish truncation', async () => {
  const workspace = await createWorkspace('sc-sh-cap');
  try {
    const fat = `${'x'.repeat(4_000)}\n`.repeat(12);
    await workspace.writeFile('fat.txt', fat);
    const result = await bash('construir', workspace, { command: 'cat fat.txt' });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /truncad/i);
  } finally {
    await workspace.destroy();
  }
});

test('read pipe stays allowlisted', async () => {
  const workspace = await createWorkspace('sc-sh-pipe');
  try {
    const result = await bash('construir', workspace, { command: 'echo hola | wc -c' });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /\d+/);
  } finally {
    await workspace.destroy();
  }
});

test('planificar without approval still needs permission', async () => {
  const workspace = await createWorkspace('sc-sh-ask');
  try {
    const result = await bash('planificar', workspace, { command: 'echo plan' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'permission_required');
    assert.match(result.error, /permiso/);
  } finally {
    await workspace.destroy();
  }
});

test('planificar may run allowlisted reads after approval', async () => {
  const workspace = await createWorkspace('sc-sh-plan-read');
  try {
    const result = await bash('planificar', workspace, { command: 'echo permiso-ok' }, { approved: true });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /permiso-ok/);
  } finally {
    await workspace.destroy();
  }
});

test('planificar never gets shell write power after approval', async () => {
  const workspace = await createWorkspace('sc-sh-plan-write');
  try {
    await workspace.writeFile('keep.txt', 'safe');
    const mkdir = await bash('planificar', workspace, { command: 'mkdir nuevo' }, { approved: true });
    assert.equal(mkdir.ok, false);
    assert.equal(mkdir.code, 'plan_read_only');
    assert.match(mkdir.error, /no puede escribir/);
    const rm = await bash('planificar', workspace, { command: 'rm keep.txt' }, { approved: true });
    assert.equal(rm.ok, false);
    assert.equal(rm.code, 'plan_read_only');
    const redirect = await bash('planificar', workspace, { command: 'echo x > leak.txt' }, { approved: true });
    assert.equal(redirect.ok, false);
    assert.equal(redirect.code, 'plan_read_only');
    assert.equal(await workspace.readFile('keep.txt'), 'safe');
    await assert.rejects(() => workspace.readFile('leak.txt'));
  } finally {
    await workspace.destroy();
  }
});

test('construir may write with allowlisted commands under the jail', async () => {
  const workspace = await createWorkspace('sc-sh-build-write');
  try {
    const made = await bash('construir', workspace, { command: 'mkdir sub && echo hola > sub/a.txt' });
    assert.equal(made.ok, true, made.error);
    assert.equal(await workspace.readFile('sub/a.txt'), 'hola\n');
  } finally {
    await workspace.destroy();
  }
});

test('composer Solo lectura still blocks bash even in construir', async () => {
  const workspace = await createWorkspace('sc-sh-readonly');
  try {
    const result = await executeTool(
      session('construir', workspace, { permission: 'read' }),
      'bash',
      { command: 'echo no' },
      { approved: true },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'composer_read_only');
    assert.match(result.error, /Solo lectura/);
  } finally {
    await workspace.destroy();
  }
});

test('general agent cannot run shell', async () => {
  const workspace = await createWorkspace('sc-sh-gen');
  try {
    const result = await bash('general', workspace, { command: 'echo x' });
    assert.equal(result.ok, false);
    assert.equal(result.permission.denied, true);
  } finally {
    await workspace.destroy();
  }
});

test('relative cat inside the workspace is allowed', async () => {
  const workspace = await createWorkspace('sc-sh-cat');
  try {
    await workspace.writeFile('nota.txt', 'contenido-ok');
    const result = await bash('construir', workspace, { command: 'cat nota.txt' });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /contenido-ok/);
  } finally {
    await workspace.destroy();
  }
});

test('background ampersand is denied', async () => {
  const workspace = await createWorkspace('sc-sh-bg');
  try {
    const result = await bash('construir', workspace, { command: 'sleep 1 &' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'command_denied');
    assert.match(result.error, /segundo plano|no permitido/);
  } finally {
    await workspace.destroy();
  }
});

test('newlines in the command string are rejected', () => {
  const result = classifyCommand('echo a\nrm -rf /');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'newline');
  assert.match(result.error, /saltos de línea/);
});

test('authorizeShellCommand keeps planificar on read class only', () => {
  const read = authorizeShellCommand('ls', { agentId: 'planificar' });
  assert.equal(read.ok, true);
  const write = authorizeShellCommand('mkdir x', { agentId: 'planificar' });
  assert.equal(write.ok, false);
  assert.equal(write.code, 'plan_read_only');
  const build = authorizeShellCommand('mkdir x', { agentId: 'construir' });
  assert.equal(build.ok, true);
  assert.equal(build.className, 'write');
});

test('errors stay Spanish and leak-free', async () => {
  const workspace = await createWorkspace('sc-sh-es');
  try {
    const result = await bash('construir', workspace, { command: 'sudo id' });
    const blob = JSON.stringify(result);
    assert.match(result.error, /[áéíóúñ]|permitid|bloquead|obligatorio|límite|fuera/i);
    assert.doesNotMatch(blob, /deepseek|openrouter|model_id|sk-[A-Za-z0-9]{8}/i);
  } finally {
    await workspace.destroy();
  }
});

test('node --version is a safe read; node -e is denied', async () => {
  const workspace = await createWorkspace('sc-sh-node');
  try {
    const version = await bash('construir', workspace, { command: 'node --version' });
    assert.equal(version.ok, true, version.error);
    assert.match(version.content, /v?\d+/);
    const evaled = await bash('construir', workspace, { command: 'node -e "console.log(1)"' });
    assert.equal(evaled.ok, false);
    assert.equal(evaled.code, 'command_denied');
  } finally {
    await workspace.destroy();
  }
});

test('chmod 777 and setuid modes are dangerous', () => {
  const mode = authorizeShellCommand('chmod 777 file.txt', { agentId: 'construir' });
  assert.equal(mode.ok, false);
  const setuid = authorizeShellCommand('chmod u+s file.txt', { agentId: 'construir' });
  assert.equal(setuid.ok, false);
});

test('ls of a workspace file does not require a path jail miss', async () => {
  const workspace = await createWorkspace('sc-sh-ls');
  try {
    await workspace.writeFile('a.txt', '1');
    const result = await bash('construir', workspace, { command: 'ls' });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /a\.txt/);
  } finally {
    await workspace.destroy();
  }
});

test('destroyed workspace reports a Spanish missing-root error', async () => {
  const workspace = await createWorkspace('sc-sh-gone');
  await workspace.destroy();
  const { execInWorkspace } = require('../src/services/sira-code/workspace');
  const result = await execInWorkspace(workspace.root, 'echo x');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /workspace/);
});
