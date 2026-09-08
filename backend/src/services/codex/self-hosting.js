'use strict';

/**
 * Self-hosting bootstrap for repository-backed Codex projects.
 *
 * Only credential-free HTTPS URLs present in an explicit allowlist are
 * accepted. The service fetches a source branch into the isolated workspace,
 * creates run/<id>, and returns a pull-request descriptor. It intentionally has
 * no merge operation: self-improvement must leave the runner through review.
 */

const {
  isSafeBranchName,
  runBranchName,
  redactGitOutput,
} = require('./git-workflow');
const { scanBuffer } = require('../security/secret-scanner');

const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
const MAX_PR_FILES = 240;
const MAX_PR_FILE_BYTES = 1_500_000;
const MAX_PR_TITLE_CHARS = 120;
const MAX_PR_BODY_CHARS = 60_000;
const BLOCKED_PR_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.sira\/(?:sessions|tasks)(?:\/|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
];

class SelfHostingError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'SelfHostingError';
    this.code = code;
    this.details = details;
  }
}

function splitAllowlist(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function canonicalRepositoryUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new SelfHostingError('invalid_repository_url', 'repository URL is invalid');
  }
  if (url.protocol !== 'https:') {
    throw new SelfHostingError('repository_protocol_not_allowed', 'repository URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new SelfHostingError('repository_credentials_forbidden', 'repository URL must not contain credentials');
  }
  if (url.search || url.hash || (url.port && url.port !== '443')) {
    throw new SelfHostingError('invalid_repository_url', 'repository URL must not contain query, fragment, or a custom port');
  }

  const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment))) {
    throw new SelfHostingError('invalid_repository_path', 'repository URL must identify owner/repository');
  }
  const host = url.hostname.toLowerCase();
  const owner = segments[0];
  const repository = segments[1];
  return {
    host,
    owner,
    repository,
    url: `https://${host}/${owner}/${repository}.git`,
    webUrl: `https://${host}/${owner}/${repository}`,
    slug: `${host}/${owner}/${repository}`.toLowerCase(),
  };
}

function normalizedAllowedRepositories({ allowedRepositories, env = process.env } = {}) {
  const configured = splitAllowlist(
    allowedRepositories == null
      ? env.CODEX_SELF_HOST_REPOSITORIES
      : allowedRepositories,
  );
  const accepted = new Set();
  for (const item of configured) {
    try {
      accepted.add(canonicalRepositoryUrl(item).slug);
    } catch {
      // Invalid operator configuration is ignored; an empty set fails closed.
    }
  }
  return accepted;
}

function normalizedAllowedHosts({ allowedHosts, env = process.env } = {}) {
  return new Set(
    splitAllowlist(
      allowedHosts == null
        ? env.CODEX_SELF_HOST_GIT_HOSTS
        : allowedHosts,
    ).map((host) => host.toLowerCase()),
  );
}

function validateRepositoryUrl(repositoryUrl, options = {}) {
  const repository = canonicalRepositoryUrl(repositoryUrl);
  const repositories = normalizedAllowedRepositories(options);
  const hosts = normalizedAllowedHosts(options);
  const exactAllowed = repositories.has(repository.slug);
  const hostAllowed = hosts.has(repository.host);
  if (!exactAllowed && !hostAllowed) {
    throw new SelfHostingError('repository_not_allowlisted', 'repository is not present in the self-hosting allowlist');
  }
  return repository;
}

function sourceBranchName(value) {
  const branch = String(value || 'main').trim();
  if (!isSafeBranchName(branch) || branch.startsWith('run/')) {
    throw new SelfHostingError('invalid_source_branch', 'source branch is invalid');
  }
  return branch;
}

async function execGit(runner, projectId, args, opts = {}) {
  const out = await runner.exec(projectId, ['git', ...args], opts);
  if (out?.exitCode === 0) return out;
  throw new SelfHostingError(
    'git_operation_failed',
    'repository bootstrap failed',
    {
      operation: args[0],
      exitCode: Number.isInteger(out?.exitCode) ? out.exitCode : 1,
      detail: redactGitOutput(out?.stderr || out?.stdout),
    },
  );
}

function buildPullRequestDescriptor({ repository, baseBranch, workBranch, projectId }) {
  const compareBase = encodeURIComponent(baseBranch);
  const compareHead = encodeURIComponent(workBranch);
  return {
    status: 'prepared',
    provider: repository.host === 'github.com' ? 'github' : 'git',
    repository: repository.webUrl,
    base: baseBranch,
    head: workBranch,
    title: `feat(codex): mejoras autónomas ${projectId}`,
    body: [
      'Cambios preparados por SiraGPT Codex en una rama aislada.',
      '',
      '- Requiere revisión y checks verdes.',
      '- No se permite merge directo desde el agente.',
    ].join('\n'),
    compareUrl: `${repository.webUrl}/compare/${compareBase}...${compareHead}?expand=1`,
    mergePolicy: 'pull_request_only',
  };
}

async function prepareSelfHostedProject({
  runner,
  projectId,
  repositoryUrl,
  sourceBranch = 'main',
  runId = `selfhost-${projectId}`,
  allowedRepositories,
  allowedHosts,
  env = process.env,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  if (!runner || typeof runner.initWorkspace !== 'function' || typeof runner.exec !== 'function') {
    throw new TypeError('runner.initWorkspace and runner.exec are required');
  }
  const repository = validateRepositoryUrl(repositoryUrl, {
    allowedRepositories,
    allowedHosts,
    env,
  });
  const baseBranch = sourceBranchName(sourceBranch);
  const workBranch = runBranchName(runId);
  if (!workBranch) throw new SelfHostingError('invalid_run_id', 'self-hosting run id is invalid');

  await runner.initWorkspace(projectId);

  // workspace/init creates an empty repository. Fetching into it is equivalent
  // to cloning while preserving the runner's fixed project root.
  const remote = await runner.exec(projectId, ['git', 'remote', 'get-url', 'origin']);
  if (remote?.exitCode === 0) {
    await execGit(runner, projectId, ['remote', 'set-url', 'origin', repository.url]);
  } else {
    await execGit(runner, projectId, ['remote', 'add', 'origin', repository.url]);
  }
  await execGit(
    runner,
    projectId,
    ['fetch', '--depth=1', 'origin', `refs/heads/${baseBranch}`],
    { timeoutMs: Math.max(10_000, Number(fetchTimeoutMs) || DEFAULT_FETCH_TIMEOUT_MS) },
  );
  await execGit(runner, projectId, ['checkout', '-B', baseBranch, 'FETCH_HEAD']);
  await execGit(runner, projectId, ['switch', '-c', workBranch, baseBranch]);

  const head = await execGit(runner, projectId, ['rev-parse', 'HEAD']);
  return {
    ok: true,
    status: 'ready',
    workspacePath: `projects/${projectId}`,
    repository: {
      url: repository.url,
      webUrl: repository.webUrl,
      host: repository.host,
      owner: repository.owner,
      name: repository.repository,
    },
    sourceBranch: baseBranch,
    workBranch,
    commitSha: String(head.stdout || '').trim(),
    pullRequest: buildPullRequestDescriptor({
      repository,
      baseBranch,
      workBranch,
      projectId,
    }),
  };
}

function parseNullList(value) {
  return String(value || '').split('\0').map((row) => row.trim()).filter(Boolean);
}

function cleanPullRequestTitle(value, fallback) {
  const title = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PR_TITLE_CHARS);
  return title || fallback;
}

function cleanPullRequestBody(value, fallback) {
  const body = String(value || '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_PR_BODY_CHARS);
  return body || fallback;
}

async function readGitMode(runner, projectId, path) {
  const out = await execGit(runner, projectId, ['ls-files', '-s', '--', path]);
  const mode = String(out.stdout || '').trim().split(/\s+/, 1)[0];
  if (!['100644', '100755'].includes(mode)) {
    throw new SelfHostingError('unsupported_git_entry', `unsupported git mode for ${path}`);
  }
  return mode;
}

function assertPublishableFile(path, content) {
  const normalized = String(path || '').replaceAll('\\', '/');
  const envExample = /(^|\/)\.env\.example$/i.test(normalized);
  if ((!envExample && BLOCKED_PR_PATHS.some((pattern) => pattern.test(normalized)))) {
    throw new SelfHostingError('pull_request_sensitive_path', `sensitive path cannot be published: ${normalized}`);
  }
  const scan = scanBuffer(content, { maxFindings: 8 });
  if (!scan.ok) {
    throw new SelfHostingError(
      'pull_request_secret_detected',
      `secret-like content detected in ${normalized}`,
      { path: normalized, findings: scan.findings.map(({ code, line }) => ({ code, line })) },
    );
  }
}

async function collectPullRequestChanges({ runner, projectId, baseBranch, runBranch }) {
  const changedOut = await execGit(
    runner,
    projectId,
    ['diff', '--name-only', '-z', '--diff-filter=ACMRT', `${baseBranch}...${runBranch}`],
  );
  const deletedOut = await execGit(
    runner,
    projectId,
    ['diff', '--name-only', '-z', '--diff-filter=D', `${baseBranch}...${runBranch}`],
  );
  const changed = parseNullList(changedOut.stdout);
  const deleted = parseNullList(deletedOut.stdout);
  if (changed.length + deleted.length > MAX_PR_FILES) {
    throw new SelfHostingError('pull_request_too_large', `pull request exceeds ${MAX_PR_FILES} files`);
  }
  const files = [];
  for (const path of changed) {
    const read = await runner.readFile(projectId, path);
    const content = String(read?.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_PR_FILE_BYTES) {
      throw new SelfHostingError('pull_request_file_too_large', `${path} exceeds ${MAX_PR_FILE_BYTES} bytes`);
    }
    assertPublishableFile(path, content);
    files.push({ path, content, mode: await readGitMode(runner, projectId, path) });
  }
  return { files, deleted };
}

async function publishSelfHostedPullRequest({
  runner,
  projectId,
  runId,
  repositoryUrl,
  sourceBranch = 'main',
  title = null,
  body = null,
  allowedRepositories,
  allowedHosts,
  env = process.env,
  octokitFactory = null,
} = {}) {
  const repository = validateRepositoryUrl(repositoryUrl, {
    allowedRepositories,
    allowedHosts,
    env,
  });
  if (repository.host !== 'github.com') {
    throw new SelfHostingError('pull_request_provider_unsupported', 'automatic pull requests currently require GitHub');
  }
  const baseBranch = sourceBranchName(sourceBranch);
  const workBranch = runBranchName(runId);
  if (!workBranch) throw new SelfHostingError('invalid_run_id', 'run id is invalid');

  // Lazy import avoids coupling ordinary Codex projects to Octokit startup.
  // eslint-disable-next-line global-require
  const github = require('../github-codex-connector');
  const token = String(env.CODEX_SELF_HOST_GITHUB_TOKEN || '').trim();
  if (!token) {
    throw new SelfHostingError(
      'github_auth_required',
      'dedicated repository-scoped GitHub token required to publish the pull request',
    );
  }
  const createOctokit = octokitFactory || github.createDefaultOctokit;
  const octokit = await createOctokit({
    token,
    tokenSource: 'CODEX_SELF_HOST_GITHUB_TOKEN',
    env,
  });
  const repo = { owner: repository.owner, repo: repository.repository };
  const baseRef = await octokit.rest.git.getRef({ ...repo, ref: `heads/${baseBranch}` });
  const baseSha = baseRef.data?.object?.sha;
  if (!baseSha) throw new SelfHostingError('branch_base_missing', 'base branch not found');
  const baseCommit = await octokit.rest.git.getCommit({ ...repo, commit_sha: baseSha });
  const baseTreeSha = baseCommit.data?.tree?.sha;
  if (!baseTreeSha) throw new SelfHostingError('base_tree_missing', 'base tree not found');
  const localBase = await execGit(runner, projectId, ['rev-parse', baseBranch]);
  if (String(localBase.stdout || '').trim() !== baseSha) {
    throw new SelfHostingError(
      'base_branch_diverged',
      'remote base branch advanced; refresh or rebase before publishing',
    );
  }

  const changes = await collectPullRequestChanges({
    runner,
    projectId,
    baseBranch,
    runBranch: workBranch,
  });
  if (!changes.files.length && !changes.deleted.length) {
    return { ok: true, status: 'no_changes', branch: workBranch, pullRequest: null };
  }
  const fallbackTitle = `feat(codex): mejoras autónomas ${runId}`;
  const safeTitle = cleanPullRequestTitle(title, fallbackTitle);
  const safeBody = cleanPullRequestBody(body, [
    'Cambios preparados por SiraGPT Codex desde un checkpoint con gates verdes.',
    '',
    '- Rama aislada por run.',
    '- Requiere revisión y checks verdes.',
    '- Sin merge directo.',
  ].join('\n'));
  const tree = [];
  for (const file of changes.files) {
    const blob = await octokit.rest.git.createBlob({
      ...repo,
      content: Buffer.from(file.content, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.data.sha });
  }
  for (const path of changes.deleted) {
    tree.push({ path, mode: '100644', type: 'blob', sha: null });
  }
  const nextTree = await octokit.rest.git.createTree({
    ...repo,
    base_tree: baseTreeSha,
    tree,
  });
  const commit = await octokit.rest.git.createCommit({
    ...repo,
    message: safeTitle,
    tree: nextTree.data.sha,
    parents: [baseSha],
  });
  let remoteBranchExists = true;
  try {
    await octokit.rest.git.getRef({ ...repo, ref: `heads/${workBranch}` });
  } catch (error) {
    if (Number(error?.status) === 404) remoteBranchExists = false;
    else throw error;
  }
  if (remoteBranchExists) {
    await octokit.rest.git.updateRef({
      ...repo,
      ref: `heads/${workBranch}`,
      sha: commit.data.sha,
      force: false,
    });
  } else {
    await octokit.rest.git.createRef({
      ...repo,
      ref: `refs/heads/${workBranch}`,
      sha: commit.data.sha,
    });
  }
  const pull = await octokit.rest.pulls.create({
    ...repo,
    title: safeTitle,
    head: workBranch,
    base: baseBranch,
    body: safeBody,
  });
  return {
    ok: true,
    status: 'pull_request_opened',
    branch: workBranch,
    commitSha: commit.data.sha,
    files: changes.files.length,
    deleted: changes.deleted.length,
    pullRequest: {
      number: pull.data?.number || null,
      url: pull.data?.html_url || null,
      state: pull.data?.state || null,
    },
  };
}

module.exports = {
  prepareSelfHostedProject,
  publishSelfHostedPullRequest,
  collectPullRequestChanges,
  validateRepositoryUrl,
  canonicalRepositoryUrl,
  buildPullRequestDescriptor,
  sourceBranchName,
  SelfHostingError,
  MAX_PR_FILES,
  MAX_PR_FILE_BYTES,
  MAX_PR_TITLE_CHARS,
  MAX_PR_BODY_CHARS,
  BLOCKED_PR_PATHS,
  assertPublishableFile,
};
