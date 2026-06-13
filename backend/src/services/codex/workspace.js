'use strict';

/**
 * codex/workspace — provisioning orchestration over the runner client:
 * init dir + git repo → write starter files → initial commit. Pure
 * orchestration (runner injected) so tests stay offline. The commit helper
 * is reused by F3 checkpoints.
 */

const { starterFiles } = require('./starter-files');

const GIT_IDENT = ['-c', 'user.name=Codex Agent', '-c', 'user.email=codex@siragpt.local'];

async function execOrThrow(runner, project, cmd, label) {
  const out = await runner.exec(project, cmd);
  if (out.exitCode !== 0) {
    const detail = String(out.stderr || out.stdout || '').slice(0, 400);
    throw new Error(`${label} failed (exit ${out.exitCode}): ${detail}`);
  }
  return out;
}

async function gitCommitAll(runner, project, message) {
  await execOrThrow(runner, project, ['git', 'add', '-A'], 'git add');
  await execOrThrow(
    runner,
    project,
    ['git', ...GIT_IDENT, 'commit', '--allow-empty', '-m', message],
    'git commit',
  );
  const head = await execOrThrow(runner, project, ['git', 'rev-parse', 'HEAD'], 'git rev-parse');
  return String(head.stdout || '').trim();
}

async function provisionWorkspace({ project, projectName, runner }) {
  await runner.initWorkspace(project);
  await runner.writeFiles(project, starterFiles({ projectName }));
  const commitSha = await gitCommitAll(runner, project, 'chore(codex): workspace inicial');
  return { workspacePath: `projects/${project}`, commitSha };
}

module.exports = { provisionWorkspace, gitCommitAll, execOrThrow, GIT_IDENT };
