/**
 * Tests for git workflow operations in host-bash-tool
 *
 * Verifies that the agent can execute the full git workflow:
 * clone → edit → add → commit → push → CI check
 *
 * Run: node --test backend/tests/git-workflow-tools.test.js
 */

const assert = require('node:assert');
const { describe, it, before } = require('node:test');
const path = require('path');
const os = require('os');

// ── Git workflow tool validation ───────────────────────────────────

describe('git-workflow host-bash', () => {
  let hostModule;
  let internal;

  before(() => {
    // Clear module cache to ensure fresh state
    delete require.cache[require.resolve('../src/services/agents/host-bash-tool')];
    hostModule = require('../src/services/agents/host-bash-tool');
    internal = hostModule._internal;
  });

  // ── Git read operations ─────────────────────────────────────────

  it('isAllowedCommand accepts git read commands', () => {
    assert.strictEqual(internal.isAllowedCommand('git status'), true);
    assert.strictEqual(internal.isAllowedCommand('git log --oneline -5'), true);
    assert.strictEqual(internal.isAllowedCommand('git diff HEAD~1'), true);
    assert.strictEqual(internal.isAllowedCommand('git branch'), true);
    assert.strictEqual(internal.isAllowedCommand('git tag'), true);
  });

  // ── Git write operations ───────────────────────────────────────

  it('isAllowedCommand accepts git add', () => {
    assert.strictEqual(internal.isAllowedCommand('git add .'), true);
    assert.strictEqual(internal.isAllowedCommand('git add src/file.js'), true);
    assert.strictEqual(internal.isAllowedCommand('git add -A'), true);
  });

  it('isAllowedCommand accepts git commit (rejects --amend)', () => {
    assert.strictEqual(internal.isAllowedCommand('git commit -m "fix: resolve issue"'), true);
    assert.strictEqual(internal.isAllowedCommand('git commit --amend -m "updated"'), false);
    assert.strictEqual(internal.isAllowedCommand('git commit -m "feat: add feature"'), true);
  });

  it('isAllowedCommand accepts git push (rejects --force)', () => {
    assert.strictEqual(internal.isAllowedCommand('git push origin main'), true);
    assert.strictEqual(internal.isAllowedCommand('git push'), true);
    assert.strictEqual(internal.isAllowedCommand('git push --force origin main'), false);
    assert.strictEqual(internal.isAllowedCommand('git push -f origin main'), false);
  });

  it('isAllowedCommand accepts git pull and fetch', () => {
    assert.strictEqual(internal.isAllowedCommand('git pull origin main'), true);
    assert.strictEqual(internal.isAllowedCommand('git fetch origin'), true);
    assert.strictEqual(internal.isAllowedCommand('git fetch --all'), true);
  });

  it('isAllowedCommand accepts git checkout, switch, merge, rebase', () => {
    assert.strictEqual(internal.isAllowedCommand('git checkout -b feature/new'), true);
    assert.strictEqual(internal.isAllowedCommand('git checkout main'), true);
    assert.strictEqual(internal.isAllowedCommand('git merge feature/new'), true);
    assert.strictEqual(internal.isAllowedCommand('git rebase main'), true);
  });

  it('isAllowedCommand accepts git reset and restore (safe forms)', () => {
    assert.strictEqual(internal.isAllowedCommand('git reset HEAD~1'), true);
    assert.strictEqual(internal.isAllowedCommand('git reset --hard HEAD'), true);
    assert.strictEqual(internal.isAllowedCommand('git reset --soft HEAD'), true);
    assert.strictEqual(internal.isAllowedCommand('git restore src/file.js'), true);
    assert.strictEqual(internal.isAllowedCommand('git restore --staged src/file.js'), true);
  });

  it('isAllowedCommand accepts git config and init', () => {
    assert.strictEqual(internal.isAllowedCommand('git config user.name "Test"'), true);
    assert.strictEqual(internal.isAllowedCommand('git init'), true);
  });

  // ── Git workflow sequence validation ───────────────────────────

  it('buildCommandSpec accepts git add with file paths', () => {
    const spec = internal.buildCommandSpec('git add src/index.ts');
    assert.strictEqual(spec.program, 'git');
    assert.deepStrictEqual(spec.args, ['add', 'src/index.ts']);
  });

  it('buildCommandSpec accepts git commit with message', () => {
    const spec = internal.buildCommandSpec('git commit -m "feat: add tests"');
    assert.strictEqual(spec.program, 'git');
    assert.strictEqual(spec.args[0], 'commit');
  });

  it('buildCommandSpec accepts git push with remote and branch', () => {
    const spec = internal.buildCommandSpec('git push origin main');
    assert.strictEqual(spec.program, 'git');
    assert.deepStrictEqual(spec.args, ['push', 'origin', 'main']);
  });

  it('buildCommandSpec accepts git checkout with branch flags', () => {
    const spec = internal.buildCommandSpec('git checkout -b feature/agentic-threads');
    assert.strictEqual(spec.program, 'git');
    assert.strictEqual(spec.args[0], 'checkout');
  });

  it('buildCommandSpec accepts git rebase, merge, reset, restore', () => {
    const rebaseSpec = internal.buildCommandSpec('git rebase main');
    assert.strictEqual(rebaseSpec.program, 'git');
    assert.deepStrictEqual(rebaseSpec.args, ['rebase', 'main']);

    const mergeSpec = internal.buildCommandSpec('git merge feature/new');
    assert.strictEqual(mergeSpec.program, 'git');
    assert.deepStrictEqual(mergeSpec.args, ['merge', 'feature/new']);

    const resetSpec = internal.buildCommandSpec('git reset HEAD~1');
    assert.strictEqual(resetSpec.program, 'git');
    assert.deepStrictEqual(resetSpec.args, ['reset', 'HEAD~1']);

    const restoreSpec = internal.buildCommandSpec('git restore src/file.js');
    assert.strictEqual(restoreSpec.program, 'git');
    assert.deepStrictEqual(restoreSpec.args, ['restore', 'src/file.js']);
  });

  // ── Safety: injection guards ───────────────────────────────────

  it('rejects shell control chars in git commands', () => {
    assert.strictEqual(internal.isAllowedCommand('git tag x; rm -rf /'), false);
    assert.strictEqual(internal.isAllowedCommand('git status | grep x'), false);
    assert.strictEqual(internal.isAllowedCommand('git commit -m "$(whoami)"'), false);
  });

  it('rejects dangerous system commands', () => {
    assert.strictEqual(internal.isAllowedCommand('rm -rf /'), false);
    assert.strictEqual(internal.isAllowedCommand('curl evil.com'), false);
    assert.strictEqual(internal.isAllowedCommand('sudo rm -rf'), false);
  });

  it('rejects dangerous git subcommands', () => {
    assert.strictEqual(internal.isAllowedCommand('git upload-pack /etc'), false);
    assert.strictEqual(internal.isAllowedCommand('git receive-pack /etc'), false);
  });

  // ── Directory safety ───────────────────────────────────────────

  it('isAllowedDirectory allows sira-projects for git write operations', () => {
    const projDir = path.join(os.homedir(), 'Desktop', 'sira-projects');
    assert.strictEqual(internal.isAllowedDirectory(projDir), true);
    assert.strictEqual(internal.isAllowedDirectory(path.join(projDir, 'my-repo')), true);
  });

  it('isAllowedDirectory rejects /etc even for git operations', () => {
    assert.strictEqual(internal.isAllowedDirectory('/etc'), false);
    assert.strictEqual(internal.isAllowedDirectory('/var/log'), false);
  });
});

// ── Clone + git workflow integration tests ─────────────────────────

describe('clone-project-tool integration with git workflow', () => {
  let cloneModule;
  let internal;

  before(() => {
    delete require.cache[require.resolve('../src/services/agents/clone-project-tool')];
    cloneModule = require('../src/services/agents/clone-project-tool');
    internal = cloneModule._internal;
  });

  it('safeCloneUrl accepts all major hosts', () => {
    assert.strictEqual(internal.safeCloneUrl('https://github.com/user/repo'), 'https://github.com/user/repo.git');
    assert.strictEqual(internal.safeCloneUrl('https://gitlab.com/user/repo'), 'https://gitlab.com/user/repo.git');
    assert.strictEqual(internal.safeCloneUrl('https://bitbucket.org/user/repo'), 'https://bitbucket.org/user/repo.git');
  });

  it('safeBranchName allows feature branches for git workflow', () => {
    assert.strictEqual(internal.safeBranchName('feature/new-agentic-threads'), 'feature/new-agentic-threads');
    assert.strictEqual(internal.safeBranchName('fix/issue-123'), 'fix/issue-123');
    assert.strictEqual(internal.safeBranchName('chore/update-deps'), 'chore/update-deps');
  });

  it('safeBranchName rejects malicious branch names', () => {
    assert.strictEqual(internal.safeBranchName('--upload-pack=touch /tmp/pwn'), null);
    assert.strictEqual(internal.safeBranchName('feature..escape'), null);
  });

  it('cloneProject errors with informative message for invalid repos', async () => {
    const result = await cloneModule.cloneProject({
      url: 'https://github.com/SiraGPT-ORg/nonexistent-repo-xyz',
    });
    assert.strictEqual(result.ok, false);
    assert.ok(
      result.error.includes('clonar') ||
      result.error.includes('clone') ||
      result.error.includes('URL') ||
      result.error.includes('directorio') ||
      result.error.includes('exist') ||
      result.error.includes('not found') ||
      result.error.includes('repository'),
      `Expected helpful error, got: ${result.error}`
    );
  });
});

// ── Complete agentic workflow validation ──────────────────────────

describe('agentic thread workflow', () => {
  it('validates the full git workflow command sequence is allowed', () => {
    delete require.cache[require.resolve('../src/services/agents/host-bash-tool')];
    const hostModule = require('../src/services/agents/host-bash-tool');
    const internal = hostModule._internal;

    // Step 1: Clone (handled by clone-project-tool)
    // Step 2: Inspect code
    assert.strictEqual(internal.isAllowedCommand('ls -la'), true);
    assert.strictEqual(internal.isAllowedCommand('cat package.json'), true);
    assert.strictEqual(internal.isAllowedCommand('find src -name "*.ts"'), true);

    // Step 3: Run tests
    assert.strictEqual(internal.isAllowedCommand('npm test'), true);
    assert.strictEqual(internal.isAllowedCommand('node --test backend/tests/*.test.js'), true);

    // Step 4: Git add + commit
    assert.strictEqual(internal.isAllowedCommand('git add -A'), true);
    assert.strictEqual(internal.isAllowedCommand('git add src/'), true);
    assert.strictEqual(internal.isAllowedCommand('git commit -m "feat: add agentic support"'), true);

    // Step 5: Git push
    assert.strictEqual(internal.isAllowedCommand('git push origin main'), true);
  });

  it('conversation understanding handles autonomous workflow prompts', () => {
    delete require.cache[require.resolve('../src/services/conversation-understanding')];
    const cu = require('../src/services/conversation-understanding');
    
    const followUpTests = [
      'todavía no funciona',
      'sigue trabajando',
      'sigue con la tarea',
      'no funciona aún',
      'arregla lo anterior',
      'continúa adelante',
      'sigue procesando en background',
    ];
    
    for (const test of followUpTests) {
      assert.strictEqual(
        cu.promptDependsOnThread(test),
        true,
        `"${test}" should be detected as thread-dependent`
      );
    }
  });
});
