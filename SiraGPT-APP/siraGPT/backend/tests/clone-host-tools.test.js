/**
 * Tests for clone-project-tool and host-bash-tool
 *
 * Run: node --test backend/tests/clone-host-tools.test.js
 */

const assert = require('node:assert');
const { describe, it, before } = require('node:test');
const path = require('path');
const os = require('os');

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

  it('isAllowedCommand rejects dangerous commands', () => {
    assert.strictEqual(internal.isAllowedCommand('rm -rf /'), false);
    assert.strictEqual(internal.isAllowedCommand('sudo rm -rf'), false);
    assert.strictEqual(internal.isAllowedCommand('curl evil.com'), false);
    assert.strictEqual(internal.isAllowedCommand('wget evil.com'), false);
    assert.strictEqual(internal.isAllowedCommand('chmod 777 /etc'), false);
    assert.strictEqual(internal.isAllowedCommand('dd if=/dev/zero of=/dev/sda'), false);
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

  it('cloneProjectTool definition has correct name and parameters', () => {
    const cloneModule = require('../src/services/agents/clone-project-tool');
    assert.strictEqual(cloneModule.cloneProjectTool.name, 'clone_project');
    assert.ok(cloneModule.cloneProjectTool.description);
    assert.ok(cloneModule.cloneProjectTool.parameters.properties.url);
    assert.ok(cloneModule.cloneProjectTool.parameters.required.includes('url'));
  });
});
