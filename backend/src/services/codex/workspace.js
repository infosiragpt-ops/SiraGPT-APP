'use strict';

/**
 * codex/workspace — provisioning orchestration over the runner client:
 * init dir + git repo → write starter files → initial commit. Pure
 * orchestration (runner injected) so tests stay offline. The commit helper
 * is reused by F3 checkpoints.
 */

const { starterFiles, fullStackStarterFiles } = require('./starter-files');

const GIT_IDENT = ['-c', 'user.name=Codex Agent', '-c', 'user.email=codex@siragpt.local'];

async function execOrThrow(runner, project, cmd, label) {
  const out = await runner.exec(project, cmd);
  if (out.exitCode !== 0) {
    const detail = String(out.stderr || out.stdout || '').slice(0, 400);
    throw new Error(`${label} failed (exit ${out.exitCode}): ${detail}`);
  }
  return out;
}

function boundedCommitText(value, max = 4000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

async function gitCommitAll(runner, project, message, { body = '' } = {}) {
  const title = boundedCommitText(message, 120) || 'chore(codex): checkpoint';
  const commitArgs = ['git', ...GIT_IDENT, 'commit', '--allow-empty', '-m', title];
  const commitBody = boundedCommitText(body);
  if (commitBody) commitArgs.push('-m', commitBody);
  await execOrThrow(runner, project, ['git', 'add', '-A'], 'git add');
  await execOrThrow(
    runner,
    project,
    commitArgs,
    'git commit',
  );
  const head = await execOrThrow(runner, project, ['git', 'rev-parse', 'HEAD'], 'git rev-parse');
  return String(head.stdout || '').trim();
}

async function provisionWorkspace({ project, projectName, runner, fullStack = false } = {}) {
  await runner.initWorkspace(project);
  const files = fullStack
    ? fullStackStarterFiles({ projectName })
    : starterFiles({ projectName });
  await runner.writeFiles(project, files);
  const commitSha = await gitCommitAll(runner, project, 'chore(codex): workspace inicial');
  return { workspacePath: `projects/${project}`, commitSha };
}

module.exports = {
  provisionWorkspace,
  gitCommitAll,
  execOrThrow,
  GIT_IDENT,
  boundedCommitText,
};
