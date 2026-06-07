/**
 * Tests for clone-project-tool and host-bash-tool
 *
 * Run: node --test backend/tests/clone-host-tools.test.js
 */

const assert = require('node:assert');
const { describe, it, before } = require('node:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

// The product-repo protection tests assume the running repo is INSIDE an
// allowed workspace root (true on a dev box at ~/Desktop/siraGPT). On CI the
// checkout lives at /home/runner/work/... which is not a default root, so we
// add the repo root via SIRAGPT_WORKSPACE_ROOTS for the duration of the test.
// This makes the repo "within workspace" (readable) everywhere, so the
// read-only protection can be asserted consistently across machines.
async function withProductRepoInWorkspace(fn) {
  const roots = require('../src/services/agents/workspace-roots');
  const prev = process.env.SIRAGPT_WORKSPACE_ROOTS;
  process.env.SIRAGPT_WORKSPACE_ROOTS = roots.selfRepoRoot();
  try {
    return await fn(roots);
  } finally {
    if (prev === undefined) delete process.env.SIRAGPT_WORKSPACE_ROOTS;
    else process.env.SIRAGPT_WORKSPACE_ROOTS = prev;
  }
}

// ── clone-project-tool ─────────────────────────────────────────────

describe('clone-project-tool', () => {
  let cloneModule;
  let internal;

  before(() => {
    cloneModule = require('../src/services/agents/clone-project-tool');
    internal = cloneModule._internal;
  });

  it('safeCloneUrl accepts https://github.com/owner/repo', () => {
    const result = internal.safeCloneUrl('https://github.com/open-webui/open-webui');
    assert.strictEqual(result, 'https://github.com/open-webui/open-webui.git');
  });

  it('safeCloneUrl accepts naked github.com/owner/repo', () => {
    const result = internal.safeCloneUrl('github.com/open-webui/open-webui');
    assert.strictEqual(result, 'https://github.com/open-webui/open-webui.git');
  });

  it('safeCloneUrl accepts git@github.com:owner/repo.git', () => {
    const result = internal.safeCloneUrl('git@github.com:open-webui/open-webui.git');
    assert.strictEqual(result, 'https://github.com/open-webui/open-webui.git');
  });

  it('safeCloneUrl accepts gitlab.com URLs', () => {
    const result = internal.safeCloneUrl('https://gitlab.com/gitlab-org/gitlab');
    assert.strictEqual(result, 'https://gitlab.com/gitlab-org/gitlab.git');
  });

  it('safeCloneUrl rejects non-allowed hosts', () => {
    assert.strictEqual(internal.safeCloneUrl('https://evil.com/repo'), null);
  });

  it('safeCloneUrl rejects empty/malformed input', () => {
    assert.strictEqual(internal.safeCloneUrl(''), null);
    assert.strictEqual(internal.safeCloneUrl('   '), null);
    assert.strictEqual(internal.safeCloneUrl('not a url'), null);
  });

  it('safeBranchName accepts normal refs and rejects option injection', () => {
    assert.strictEqual(internal.safeBranchName('main'), 'main');
    assert.strictEqual(internal.safeBranchName('feature/repo-tools'), 'feature/repo-tools');
    assert.strictEqual(internal.safeBranchName('--upload-pack=touch /tmp/pwned'), null);
    assert.strictEqual(internal.safeBranchName('feature with spaces'), null);
    assert.strictEqual(internal.safeBranchName('feature..escape'), null);
  });

  it('repoDirName extracts owner-repo from clone URL', () => {
    assert.strictEqual(internal.repoDirName('https://github.com/open-webui/open-webui.git'), 'open-webui-open-webui');
    assert.strictEqual(internal.repoDirName('https://github.com/owner/my-repo.git'), 'owner-my-repo');
    assert.strictEqual(internal.repoDirName('https://gitlab.com/group/sub-group.git'), 'group-sub-group');
  });

  it('cloneProject returns error for missing URL', async () => {
    const result = await cloneModule.cloneProject({});
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('URL'));
  });

  it('cloneProject returns error for invalid URL', async () => {
    const result = await cloneModule.cloneProject({ url: 'https://evil.com/repo' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('URL no válida'));
  });

  it('projectsDir defaults to ~/Desktop/sira-projects/', () => {
    const dir = cloneModule.projectsDir();
    assert.ok(dir.includes('sira-projects'));
  });
});

// ── host-bash-tool ─────────────────────────────────────────────────

describe('host-bash-tool', () => {
  let hostModule;
  let internal;

  before(() => {
    hostModule = require('../src/services/agents/host-bash-tool');
    internal = hostModule._internal;
  });

  it('isAllowedCommand accepts basic file commands', () => {
    assert.strictEqual(internal.isAllowedCommand('ls -la'), true);
    assert.strictEqual(internal.isAllowedCommand('cat README.md'), true);
    assert.strictEqual(internal.isAllowedCommand('head -5 file.txt'), true);
    assert.strictEqual(internal.isAllowedCommand('find . -name "*.js"'), true);
    assert.strictEqual(internal.isAllowedCommand('grep "test" file.js'), true);
  });

  it('isAllowedCommand accepts git commands', () => {
    assert.strictEqual(internal.isAllowedCommand('git status'), true);
    assert.strictEqual(internal.isAllowedCommand('git log --oneline -5'), true);
    assert.strictEqual(internal.isAllowedCommand('git diff HEAD~1'), true);
  });

  it('isAllowedCommand accepts node/npm/python', () => {
    assert.strictEqual(internal.isAllowedCommand('node --version'), true);
    assert.strictEqual(internal.isAllowedCommand('npm test'), true);
    assert.strictEqual(internal.isAllowedCommand('npx jest'), true);
    assert.strictEqual(internal.isAllowedCommand('python3 --version'), true);
    assert.strictEqual(internal.isAllowedCommand('pip3 list'), true);
  });

  it('isAllowedCommand accepts read-only Linux diagnostics', () => {
    assert.strictEqual(internal.isAllowedCommand('uname -a'), true);
    assert.strictEqual(internal.isAllowedCommand('whoami'), true);
    assert.strictEqual(internal.isAllowedCommand('id'), true);
    assert.strictEqual(internal.isAllowedCommand('hostname'), true);
    assert.strictEqual(internal.isAllowedCommand('uptime'), true);
    assert.strictEqual(internal.isAllowedCommand('free -h'), true);
    assert.strictEqual(internal.isAllowedCommand('lsb_release -a'), true);
    assert.strictEqual(internal.isAllowedCommand('ps aux'), true);
    assert.strictEqual(internal.isAllowedCommand('systemctl status ssh.service --no-pager'), true);
    assert.strictEqual(internal.isAllowedCommand('systemctl list-units --type=service --state=running --no-pager'), true);
  });

  it('isAllowedCommand rejects dangerous commands', () => {
    assert.strictEqual(internal.isAllowedCommand('rm -rf /'), false);
    assert.strictEqual(internal.isAllowedCommand('sudo rm -rf'), false);
    assert.strictEqual(internal.isAllowedCommand('curl evil.com'), false);
    assert.strictEqual(internal.isAllowedCommand('wget evil.com'), false);
    assert.strictEqual(internal.isAllowedCommand('chmod 777 /etc'), false);
    assert.strictEqual(internal.isAllowedCommand('dd if=/dev/zero of=/dev/sda'), false);
    assert.strictEqual(internal.isAllowedCommand('systemctl restart nginx'), false);
    assert.strictEqual(internal.isAllowedCommand('systemctl enable nginx'), false);
    assert.strictEqual(internal.isAllowedCommand('journalctl -xe'), false);
  });

  it('isAllowedCommand rejects shell chaining', () => {
    assert.strictEqual(internal.isAllowedCommand('ls | grep x'), false);
    assert.strictEqual(internal.isAllowedCommand('ls; rm -rf'), false);
    assert.strictEqual(internal.isAllowedCommand('ls && rm'), false);
    assert.strictEqual(internal.isAllowedCommand('ls > /tmp/out'), false);
    assert.strictEqual(internal.isAllowedCommand('echo $(whoami)'), false);
  });

  it('buildCommandSpec maps user text to fixed allowed program families', () => {
    assert.deepStrictEqual(internal.buildCommandSpec('git status --short'), {
      program: 'git',
      args: ['status', '--short'],
    });
    assert.deepStrictEqual(internal.buildCommandSpec('echo "hello world"'), {
      program: 'echo',
      args: ['hello world'],
    });
    assert.deepStrictEqual(internal.buildCommandSpec('git checkout main'), {
      program: 'git',
      args: ['checkout', 'main'],
    });
    assert.strictEqual(internal.buildCommandSpec('git checkout -- file.js'), null);
  });

  it('isAllowedDirectory allows projects dir', () => {
    const projectsDir = path.join(os.homedir(), 'Desktop', 'sira-projects');
    assert.strictEqual(internal.isAllowedDirectory(projectsDir), true);
    assert.strictEqual(internal.isAllowedDirectory(path.join(projectsDir, 'some-repo')), true);
  });

  it('isAllowedDirectory allows the local SiraGPT GitHub checkout', () => {
    const siraGitHubCheckout = path.join(os.homedir(), 'Documents', 'GitHub', 'siraGPT');
    assert.strictEqual(internal.isAllowedDirectory(siraGitHubCheckout), true);
    assert.strictEqual(internal.isAllowedDirectory('~/Documents/GitHub/siraGPT'), true);
    assert.strictEqual(internal.commandHasUnsafePathReference(
      'cat package.json',
      siraGitHubCheckout,
    ), false);
    assert.strictEqual(internal.commandHasUnsafePathReference(
      'cat package.json',
      '~/Documents/GitHub/siraGPT',
    ), false);
  });

  it('isAllowedDirectory rejects /etc and /usr', () => {
    assert.strictEqual(internal.isAllowedDirectory('/etc'), false);
    assert.strictEqual(internal.isAllowedDirectory('/usr/bin'), false);
    assert.strictEqual(internal.isAllowedDirectory('/opt'), false);
  });

  it('commandHasUnsafePathReference rejects paths outside allowed roots', () => {
    assert.strictEqual(internal.commandHasUnsafePathReference('cat /etc/passwd', os.tmpdir()), true);
    assert.strictEqual(internal.commandHasUnsafePathReference('ls ./fixture', os.tmpdir()), false);
  });

  it('hostBash returns error for empty command', async () => {
    const result = await hostModule.hostBash({ command: '' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  });

  it('hostBash returns error for disallowed command', async () => {
    const result = await hostModule.hostBash({ command: 'rm -rf /' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  });

  it('hostBash executes allowed commands successfully', async () => {
    const result = await hostModule.hostBash({
      command: 'echo "hello from siraGPT"',
      directory: os.tmpdir(),
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.stdout.includes('hello from siraGPT'));
    assert.strictEqual(result.exitCode, 0);
  });

  it('hostBash expands tilde working directories before execution', async () => {
    const projectsDir = path.join(os.homedir(), 'Desktop', 'sira-projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    const result = await hostModule.hostBash({
      command: 'pwd',
      directory: '~/Desktop/sira-projects',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stdout.trim(), projectsDir);
    assert.strictEqual(result.workingDir, projectsDir);
  });

  it('hostBash captures non-zero exit codes', async () => {
    const result = await hostModule.hostBash({
      command: 'ls ./nonexistent_dir_xyz_abc123',
      directory: os.tmpdir(),
    });
    assert.strictEqual(result.ok, false);
    assert.notStrictEqual(result.exitCode, 0);
    assert.ok(Number.isInteger(result.exitCode));
  });

  it('tool definition has correct name and parameters', () => {
    assert.strictEqual(hostModule.hostBashTool.name, 'host_bash');
    assert.ok(hostModule.hostBashTool.description);
    assert.ok(hostModule.hostBashTool.parameters.properties.command);
    assert.ok(hostModule.hostBashTool.parameters.required.includes('command'));
  });

  it('host bash capabilities expose Linux integration metadata', () => {
    const caps = hostModule.resolveHostBashCapabilities({ SIRAGPT_DESKTOP_BRIDGE_PLATFORM: 'linux' });
    assert.equal(caps.host.platform, 'linux');
    assert.ok(caps.allowedCommands.includes('systemctl'));
    assert.ok(caps.linuxReadOnlyDiagnostics.includes('free -h'));
    assert.ok(caps.restrictions.includes('systemctl is read-only only'));
  });

  // ── env hardening (secret exfiltration defense) ──────────────────
  it('buildHostBashEnv keeps system/toolchain vars but drops secrets', () => {
    const src = {
      PATH: '/usr/bin', HOME: '/Users/test', LANG: 'en_US.UTF-8',
      NVM_DIR: '/Users/test/.nvm', PYTHONPATH: '/site', SSH_AUTH_SOCK: '/tmp/agent.sock',
      OPENAI_API_KEY: 'sk-must-not-leak', CEREBRAS_API_KEY: 'csk-must-not-leak',
      DATABASE_URL: 'postgres://secret', JWT_SECRET: 'jwt-must-not-leak',
      R2_ACCESS_KEY_ID: 'r2-leak', GITHUB_TOKEN: 'ghp_leak', SESSION_SECRET: 'sess-leak',
    };
    const env = hostModule._internal.buildHostBashEnv(src);
    // Kept (system / toolchain):
    assert.strictEqual(env.PATH, '/usr/bin');
    assert.strictEqual(env.HOME, '/Users/test');
    assert.strictEqual(env.LANG, 'en_US.UTF-8');
    assert.strictEqual(env.NVM_DIR, '/Users/test/.nvm');
    assert.strictEqual(env.PYTHONPATH, '/site');
    assert.strictEqual(env.SSH_AUTH_SOCK, '/tmp/agent.sock');
    // Dropped (every app secret):
    for (const leaked of ['OPENAI_API_KEY', 'CEREBRAS_API_KEY', 'DATABASE_URL', 'JWT_SECRET', 'R2_ACCESS_KEY_ID', 'GITHUB_TOKEN', 'SESSION_SECRET']) {
      assert.strictEqual(env[leaked], undefined, `${leaked} must not be passed to host_bash child`);
    }
    // Hardening defaults forced:
    assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
    assert.ok('NODE_ENV' in env);
  });

  it('buildHostBashEnv extra passthrough works but still refuses secret-looking names', () => {
    const src = {
      PATH: '/usr/bin', MY_BUILD_FLAG: 'on', CUSTOM_API_KEY: 'leak',
      SIRAGPT_HOST_BASH_ENV_EXTRA: 'MY_BUILD_FLAG, CUSTOM_API_KEY',
    };
    const env = hostModule._internal.buildHostBashEnv(src);
    assert.strictEqual(env.MY_BUILD_FLAG, 'on');
    assert.strictEqual(env.CUSTOM_API_KEY, undefined, 'secret-looking extra var must be refused');
  });

  it('isSensitiveEnvName flags credentials and clears benign vars', () => {
    const { isSensitiveEnvName } = hostModule._internal;
    for (const n of ['OPENAI_API_KEY', 'JWT_SECRET', 'DB_PASSWORD', 'X_TOKEN', 'SESSION_SECRET', 'STRIPE_KEY']) {
      assert.strictEqual(isSensitiveEnvName(n), true, `${n} should be sensitive`);
    }
    for (const n of ['PATH', 'HOME', 'LANG', 'NVM_DIR', 'MY_BUILD_FLAG']) {
      assert.strictEqual(isSensitiveEnvName(n), false, `${n} should be benign`);
    }
  });

  it('host_bash child cannot read a real secret from process.env (end-to-end)', async () => {
    const KEY = 'OPENAI_API_KEY';
    const original = process.env[KEY];
    process.env[KEY] = 'sk-e2e-secret-should-not-leak';
    try {
      const result = await hostModule.hostBash({
        command: 'node -e "console.log(process.env.OPENAI_API_KEY)"',
        directory: os.tmpdir(),
      });
      assert.strictEqual(result.ok, true, `node should run: ${result.stderr || result.error || ''}`);
      // The child prints "undefined" because the secret was stripped from its env.
      assert.strictEqual(result.stdout.trim(), 'undefined');
      assert.ok(!result.stdout.includes('sk-e2e-secret-should-not-leak'));
    } finally {
      if (original === undefined) delete process.env[KEY];
      else process.env[KEY] = original;
    }
  });

  // ── product-repo protection (no self-modify / push to main) ──────
  it('isProtectedGitMutation blocks writes in the product repo, allows reads', () => {
    const { isProtectedGitMutation, buildCommandSpec } = hostModule._internal;
    const roots = require('../src/services/agents/workspace-roots');
    const productDir = roots.selfRepoRoot();
    const cloneDir = path.join(os.homedir(), 'Desktop', 'sira-projects', 'some-repo');
    // Mutating git inside the product repo → blocked.
    assert.strictEqual(isProtectedGitMutation(buildCommandSpec('git push origin main'), productDir), true);
    assert.strictEqual(isProtectedGitMutation(buildCommandSpec('git commit -m "x"'), productDir), true);
    assert.strictEqual(isProtectedGitMutation(buildCommandSpec('git add -A'), productDir), true);
    assert.strictEqual(isProtectedGitMutation(buildCommandSpec('git reset --hard HEAD'), productDir), true);
    // Read-only git inside the product repo → allowed.
    assert.strictEqual(isProtectedGitMutation(buildCommandSpec('git status'), productDir), false);
    assert.strictEqual(isProtectedGitMutation(buildCommandSpec('git log --oneline -5'), productDir), false);
    assert.strictEqual(isProtectedGitMutation(buildCommandSpec('git diff HEAD~1'), productDir), false);
    // Mutating git inside a normal clone → allowed.
    assert.strictEqual(isProtectedGitMutation(buildCommandSpec('git push origin main'), cloneDir), false);
    // Non-git commands are never treated as a protected git mutation.
    assert.strictEqual(isProtectedGitMutation(buildCommandSpec('ls -la'), productDir), false);
  });

  it('hostBash refuses git push/commit inside the product repo (integration)', async () => {
    await withProductRepoInWorkspace(async (roots) => {
      // Non-existent protected subdir: blocked before any spawn; a regression
      // would surface a different error and fail this test without side effects.
      const dir = path.join(roots.selfRepoRoot(), 'no-such-subdir-protection-probe');
      const result = await hostModule.hostBash({ command: 'git commit -m "probe"', directory: dir });
      assert.strictEqual(result.ok, false);
      assert.ok(/bloqueada|solo lectura|self|código fuente/i.test(result.error || ''), `unexpected error: ${result.error}`);
    });
  });
});

describe('workspace-roots protection policy', () => {
  let roots;
  before(() => { roots = require('../src/services/agents/workspace-roots'); });

  it('marks the product repo as protected (readable, not writable)', async () => {
    await withProductRepoInWorkspace((r) => {
      const productFile = path.join(r.selfRepoRoot(), 'backend', 'index.js');
      assert.strictEqual(r.isPathProtected(productFile), true);
      assert.strictEqual(r.isPathWithinWorkspace(productFile), true); // still readable
      assert.strictEqual(r.isPathWritable(productFile), false);        // but not writable
    });
  });

  it('keeps sira-projects clones fully writable', () => {
    const cloneFile = path.join(os.homedir(), 'Desktop', 'sira-projects', 'repo', 'src', 'a.js');
    assert.strictEqual(roots.isPathProtected(cloneFile), false);
    assert.strictEqual(roots.isPathWritable(cloneFile), true);
  });

  it('selfRepoRoot resolves to the running repo checkout', () => {
    assert.ok(roots.selfRepoRoot().endsWith('siraGPT'), `got ${roots.selfRepoRoot()}`);
  });
});

describe('host-file-tool protection', () => {
  let hostFileModule;
  before(() => {
    hostFileModule = require('../src/services/agents/host-file-tool');
  });

  it('refuses to write into the product repo source', async () => {
    await withProductRepoInWorkspace(async (r) => {
      const probe = path.join(r.selfRepoRoot(), '.protection-probe-should-not-be-created.tmp');
      try {
        const result = await hostFileModule.hostFile({ action: 'write', path: probe, content: 'x' });
        assert.strictEqual(result.ok, false);
        assert.ok(/solo lectura|read-only|self|código fuente/i.test(result.error || ''), `unexpected: ${result.error}`);
        assert.strictEqual(fs.existsSync(probe), false, 'protected write must not touch disk');
      } finally {
        try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch { /* noop */ }
      }
    });
  });

  it('still allows reading the product repo source', async () => {
    await withProductRepoInWorkspace(async (r) => {
      const target = path.join(r.selfRepoRoot(), 'backend', 'package.json');
      const result = await hostFileModule.hostFile({ action: 'read', path: target });
      assert.strictEqual(result.ok, true, `read should succeed: ${result.error || ''}`);
      assert.ok(result.content.includes('"name"'));
    });
  });
});
