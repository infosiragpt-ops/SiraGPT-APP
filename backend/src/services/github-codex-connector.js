'use strict';

const path = require('path');

const DEFAULT_RECENT_ITEMS = 10;
const MAX_RECENT_ITEMS = 20;
const DEFAULT_README_PREVIEW_CHARS = 12000;
const MAX_README_PREVIEW_CHARS = 24000;
const DEFAULT_CODE_FILE_LIMIT = 40;
const MAX_CODE_FILE_LIMIT = 120;
const DEFAULT_CODE_FILE_MAX_BYTES = 60000;
const MAX_CODE_FILE_MAX_BYTES = 120000;
const CODE_FETCH_CONCURRENCY = 4;

const SKIPPED_PATH_SEGMENTS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'artifacts',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
  'uploads',
]);

const SKIPPED_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const CODE_FILE_NAMES = new Set([
  '.eslintrc',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.prettierrc',
  'Dockerfile',
  'Makefile',
  'README.md',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'package.json',
  'tsconfig.json',
]);

const CODE_FILE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cjs',
  '.cpp',
  '.css',
  '.go',
  '.graphql',
  '.h',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.prisma',
  '.py',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

class GitHubCodexConnectorError extends Error {
  constructor(code, status, message, details = {}) {
    super(message);
    this.name = 'GitHubCodexConnectorError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseGitHubRepository(input) {
  const raw = trimString(input);
  if (!raw) {
    throw new GitHubCodexConnectorError(
      'invalid_github_repository',
      400,
      'GitHub repository is required',
    );
  }

  let value = raw;
  let owner = '';
  let repo = '';
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(value);

  if (ssh) {
    owner = ssh[1];
    repo = ssh[2].replace(/\.git$/i, '');
  } else {
    if (/^https?:\/\//i.test(value)) {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new GitHubCodexConnectorError(
          'invalid_github_repository',
          400,
          'GitHub repository URL is invalid',
        );
      }
      if (url.hostname.toLowerCase() !== 'github.com') {
        throw new GitHubCodexConnectorError(
          'invalid_github_repository',
          400,
          'Only github.com repositories are supported',
        );
      }
      value = url.pathname;
    }

    value = value
      .replace(/^github\.com\//i, '')
      .replace(/^\/+|\/+$/g, '');
    const parts = value.split('/').filter(Boolean);
    owner = parts[0] || '';
    repo = (parts[1] || '').replace(/\.git$/i, '');
  }

  const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
  const repoPattern = /^[A-Za-z0-9._-]{1,100}$/;
  if (!ownerPattern.test(owner) || !repoPattern.test(repo) || repo.includes('..')) {
    throw new GitHubCodexConnectorError(
      'invalid_github_repository',
      400,
      'GitHub repository must look like owner/repo',
    );
  }

  return { owner, repo, fullName: `${owner}/${repo}` };
}

function resolveAuth(env = process.env) {
  const candidates = [
    ['GITHUB_CODEX_TOKEN', trimString(env.GITHUB_CODEX_TOKEN)],
    ['GITHUB_TOKEN', trimString(env.GITHUB_TOKEN)],
  ];
  const match = candidates.find(([, token]) => Boolean(token));
  return {
    configured: Boolean(match),
    source: match ? match[0] : null,
    token: match ? match[1] : null,
  };
}

function publicAuthStatus(auth) {
  return {
    provider: 'github',
    package: 'octokit',
    configured: auth.configured,
    mode: auth.configured ? 'server_token' : 'public_read_only',
    tokenSource: auth.source,
    tokenPlacement: 'backend_environment',
    recommendedScopes: [
      'contents:read',
      'metadata:read',
      'pull_requests:read',
      'issues:read',
      'actions:read',
    ],
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalisePosixPath(value) {
  return trimString(value).replace(/\\/g, '/').replace(/^\/+/, '');
}

function isSensitiveEnvPath(filePath) {
  const base = path.posix.basename(filePath);
  return base.startsWith('.env') && base !== '.env.example';
}

function hasSkippedSegment(filePath) {
  const segments = normalisePosixPath(filePath).split('/').filter(Boolean);
  return segments.some((segment) => SKIPPED_PATH_SEGMENTS.has(segment));
}

function isSupportedCodePath(filePath) {
  const cleanPath = normalisePosixPath(filePath);
  const base = path.posix.basename(cleanPath);
  if (!cleanPath || isSensitiveEnvPath(cleanPath) || SKIPPED_FILE_NAMES.has(base)) return false;
  if (CODE_FILE_NAMES.has(base)) return true;
  return CODE_FILE_EXTENSIONS.has(path.posix.extname(cleanPath).toLowerCase());
}

function classifyRepositoryPath(entry, { maxBytes = DEFAULT_CODE_FILE_MAX_BYTES } = {}) {
  const filePath = normalisePosixPath(entry?.path);
  if (!filePath) return { ok: false, reason: 'missing_path' };
  if (entry.type !== 'blob') return { ok: false, reason: 'not_file' };
  if (hasSkippedSegment(filePath)) return { ok: false, reason: 'skipped_directory' };
  if (!isSupportedCodePath(filePath)) return { ok: false, reason: 'unsupported_extension' };
  const size = numberOrZero(entry.size);
  if (size > maxBytes) return { ok: false, reason: 'oversized' };
  return { ok: true, reason: 'selected' };
}

function languageForPath(filePath) {
  const ext = path.posix.extname(filePath).toLowerCase();
  const base = path.posix.basename(filePath);
  if (base === 'Dockerfile') return 'dockerfile';
  if (base === 'Makefile') return 'makefile';
  const map = {
    '.c': 'c',
    '.cc': 'cpp',
    '.cjs': 'javascript',
    '.cpp': 'cpp',
    '.css': 'css',
    '.go': 'go',
    '.graphql': 'graphql',
    '.h': 'c',
    '.html': 'html',
    '.java': 'java',
    '.js': 'javascript',
    '.json': 'json',
    '.jsx': 'javascript',
    '.md': 'markdown',
    '.mdx': 'mdx',
    '.mjs': 'javascript',
    '.prisma': 'prisma',
    '.py': 'python',
    '.rs': 'rust',
    '.scss': 'scss',
    '.sh': 'shell',
    '.sql': 'sql',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.yaml': 'yaml',
    '.yml': 'yaml',
  };
  return map[ext] || 'text';
}

function repositoryPathPriority(filePath) {
  const cleanPath = normalisePosixPath(filePath);
  if (/^(README|package\.json|tsconfig\.json|next\.config\.)/i.test(cleanPath)) return 0;
  if (/^(app|backend\/src|components|lib)\//.test(cleanPath)) return 1;
  if (/^(backend\/tests|tests)\//.test(cleanPath)) return 3;
  if (/^docs\//.test(cleanPath)) return 4;
  return 2;
}

function decodeGitHubFileContent(data) {
  if (!data || Array.isArray(data) || data.type !== 'file') return null;
  if (data.encoding === 'base64' && data.content) {
    return Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
  }
  if (typeof data.content === 'string') return data.content;
  return null;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function buildGitHubRagCollection(input = {}) {
  const parsed = typeof input.repository === 'string' || typeof input.repo === 'string'
    ? parseGitHubRepository(input.repository || input.repo)
    : parseGitHubRepository(input.fullName || `${input.owner || ''}/${input.name || input.repo || ''}`);
  const branch = trimString(input.branch) || 'main';
  const safeBranch = branch.replace(/[^\w./-]+/g, '-').slice(0, 120);
  return `github:${parsed.fullName}:${safeBranch}`;
}

function buildCodeFilesForRag(files = []) {
  if (!Array.isArray(files)) return [];
  return files
    .filter((file) => file && typeof file.content === 'string' && file.content.trim())
    .map((file) => ({
      filename: file.path,
      content: file.content,
      language: file.language || languageForPath(file.path),
    }));
}

async function createDefaultOctokit({ token }) {
  const mod = await import('octokit');
  return new mod.Octokit({
    ...(token ? { auth: token } : {}),
    userAgent: 'siraGPT-codex-connector/6b',
    request: { timeout: 12000 },
  });
}

function isoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function normalizeRepository(data) {
  return {
    id: data.id,
    name: data.name,
    fullName: data.full_name,
    owner: data.owner?.login || null,
    private: Boolean(data.private),
    visibility: data.visibility || (data.private ? 'private' : 'public'),
    htmlUrl: data.html_url,
    description: data.description || '',
    defaultBranch: data.default_branch,
    language: data.language || 'Unknown',
    stargazersCount: numberOrZero(data.stargazers_count),
    forksCount: numberOrZero(data.forks_count),
    openIssuesCount: numberOrZero(data.open_issues_count),
    archived: Boolean(data.archived),
    disabled: Boolean(data.disabled),
    pushedAt: isoOrNull(data.pushed_at),
    updatedAt: isoOrNull(data.updated_at),
  };
}

function normalizePullRequest(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: Boolean(pr.draft),
    htmlUrl: pr.html_url,
    author: pr.user?.login || null,
    base: pr.base?.ref || null,
    head: pr.head?.ref || null,
    createdAt: isoOrNull(pr.created_at),
    updatedAt: isoOrNull(pr.updated_at),
  };
}

function normalizeIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    htmlUrl: issue.html_url,
    author: issue.user?.login || null,
    labels: Array.isArray(issue.labels)
      ? issue.labels.slice(0, 8).map((label) => (
        typeof label === 'string' ? label : label.name
      )).filter(Boolean)
      : [],
    createdAt: isoOrNull(issue.created_at),
    updatedAt: isoOrNull(issue.updated_at),
  };
}

function normalizeWorkflowRun(run) {
  return {
    id: run.id,
    name: run.name || run.display_title || `run-${run.run_number}`,
    displayTitle: run.display_title || run.name || '',
    status: run.status || null,
    conclusion: run.conclusion || null,
    event: run.event || null,
    htmlUrl: run.html_url,
    runNumber: run.run_number,
    branch: run.head_branch || null,
    headSha: run.head_sha ? String(run.head_sha).slice(0, 12) : null,
    actor: run.actor?.login || null,
    createdAt: isoOrNull(run.created_at),
    updatedAt: isoOrNull(run.updated_at),
  };
}

function headerValue(headers, name) {
  if (!headers) return null;
  return headers[name] || headers[name.toLowerCase()] || null;
}

function readRateLimit(headers) {
  return {
    limit: headerValue(headers, 'x-ratelimit-limit'),
    remaining: headerValue(headers, 'x-ratelimit-remaining'),
    reset: headerValue(headers, 'x-ratelimit-reset'),
    used: headerValue(headers, 'x-ratelimit-used'),
  };
}

async function fetchReadmePreview(octokit, { owner, repo, ref, readmePreviewChars }) {
  try {
    const response = await octokit.rest.repos.getReadme({ owner, repo, ref });
    const data = response.data;
    if (!data || Array.isArray(data) || !data.content) return null;
    const raw = data.encoding === 'base64'
      ? Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8')
      : String(data.content);
    return {
      name: data.name,
      path: data.path,
      htmlUrl: data.html_url,
      sha: data.sha,
      bytes: numberOrZero(data.size),
      preview: raw.slice(0, readmePreviewChars),
      truncated: raw.length > readmePreviewChars,
    };
  } catch (error) {
    if (Number(error.status) === 404) return null;
    throw error;
  }
}

function normalizeGitHubConnectorError(error) {
  if (error instanceof GitHubCodexConnectorError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(Object.keys(error.details || {}).length ? { details: error.details } : {}),
      },
    };
  }

  const githubStatus = Number(error?.status || error?.response?.status) || 500;
  const status = githubStatus >= 400 && githubStatus < 600 ? githubStatus : 500;
  const documentationUrl = error?.response?.data?.documentation_url || error?.documentation_url || null;

  let code = 'github_api_error';
  let message = 'GitHub API request failed';
  if (status === 401) {
    code = 'github_auth_failed';
    message = 'GitHub token is invalid or expired';
  } else if (status === 403) {
    code = 'github_access_denied';
    message = 'GitHub denied access or the rate limit was reached';
  } else if (status === 404) {
    code = 'github_repository_unavailable';
    message = 'GitHub repository was not found or is not accessible with the configured token';
  } else if (status === 429) {
    code = 'github_rate_limited';
    message = 'GitHub API rate limit reached';
  }

  return {
    status,
    body: {
      error: message,
      code,
      githubStatus: status,
      ...(documentationUrl ? { documentationUrl } : {}),
      rateLimit: readRateLimit(error?.response?.headers),
    },
  };
}

function warningFromError(area, error) {
  const normalized = normalizeGitHubConnectorError(error);
  return {
    area,
    code: normalized.body.code,
    status: normalized.status,
    message: normalized.body.error,
  };
}

async function resolveTreeSha(octokit, parsed, branch) {
  try {
    const branchResponse = await octokit.rest.repos.getBranch({ ...parsed, branch });
    return branchResponse.data?.commit?.commit?.tree?.sha || branchResponse.data?.commit?.sha || branch;
  } catch (error) {
    if (Number(error.status) === 404) return branch;
    throw error;
  }
}

function settledValue(result, area, warnings, fallback) {
  if (result.status === 'fulfilled') return result.value;
  warnings.push(warningFromError(area, result.reason));
  return fallback;
}

function buildCodexSummary({ repository, pullRequests, issues, workflowRuns, warnings }) {
  const failingRuns = workflowRuns.filter((run) =>
    ['failure', 'cancelled', 'timed_out', 'action_required'].includes(String(run.conclusion || '')),
  );
  const latestRun = workflowRuns[0] || null;
  const signals = [];

  signals.push(`${repository.visibility} repo · ${repository.language}`);
  if (latestRun) {
    signals.push(`latest workflow: ${latestRun.conclusion || latestRun.status || 'unknown'}`);
  } else {
    signals.push('no recent workflow runs visible');
  }
  signals.push(`${pullRequests.length} open PRs in scope`);
  signals.push(`${issues.length} open issues in scope`);
  if (warnings.length) signals.push(`${warnings.length} partial connector warnings`);

  const nextActions = [];
  if (failingRuns.length) {
    nextActions.push('Review failing GitHub Actions runs before merging code changes.');
  }
  if (pullRequests.length) {
    nextActions.push('Triage open pull requests and prefer small reversible merges.');
  }
  if (issues.length) {
    nextActions.push('Use issues as grounding context before proposing code edits.');
  }
  if (!nextActions.length) {
    nextActions.push('Repository context is ready for assisted code review and planning.');
  }

  return {
    health: failingRuns.length ? 'needs_attention' : warnings.length ? 'partial' : 'ready',
    latestWorkflowConclusion: latestRun?.conclusion || latestRun?.status || null,
    signals,
    nextActions,
  };
}

function createGitHubCodexConnector(options = {}) {
  const env = options.env || process.env;
  const octokitFactory = options.octokitFactory || createDefaultOctokit;

  return {
    getStatus() {
      return publicAuthStatus(resolveAuth(env));
    },

    async getRepositoryContext(params = {}) {
      const parsed = parseGitHubRepository(params.repository || params.repo);
      const recentItems = clampInt(params.recentItems || params.limit, DEFAULT_RECENT_ITEMS, 1, MAX_RECENT_ITEMS);
      const readmePreviewChars = clampInt(
        params.readmePreviewChars,
        DEFAULT_README_PREVIEW_CHARS,
        1000,
        MAX_README_PREVIEW_CHARS,
      );
      const auth = resolveAuth(env);
      const octokit = await octokitFactory({ token: auth.token, tokenSource: auth.source });

      const repositoryResponse = await octokit.rest.repos.get(parsed);
      const repository = normalizeRepository(repositoryResponse.data);
      const branch = trimString(params.branch) || repository.defaultBranch;

      const [pullsResult, issuesResult, workflowRunsResult, readmeResult] = await Promise.allSettled([
        octokit.rest.pulls.list({
          ...parsed,
          state: 'open',
          sort: 'updated',
          direction: 'desc',
          per_page: recentItems,
        }),
        octokit.rest.issues.listForRepo({
          ...parsed,
          state: 'open',
          sort: 'updated',
          direction: 'desc',
          per_page: Math.min(recentItems * 2, 50),
        }),
        octokit.rest.actions.listWorkflowRunsForRepo({
          ...parsed,
          branch,
          per_page: recentItems,
        }),
        fetchReadmePreview(octokit, {
          ...parsed,
          ref: branch,
          readmePreviewChars,
        }),
      ]);

      const warnings = [];
      const pullsResponse = settledValue(pullsResult, 'pull_requests', warnings, { data: [] });
      const issuesResponse = settledValue(issuesResult, 'issues', warnings, { data: [] });
      const workflowRunsResponse = settledValue(workflowRunsResult, 'actions', warnings, { data: { workflow_runs: [] } });
      const readme = settledValue(readmeResult, 'readme', warnings, null);

      const pullRequests = (pullsResponse.data || []).map(normalizePullRequest);
      const issues = (issuesResponse.data || [])
        .filter((issue) => !issue.pull_request)
        .slice(0, recentItems)
        .map(normalizeIssue);
      const workflowRuns = (workflowRunsResponse.data?.workflow_runs || []).map(normalizeWorkflowRun);

      return {
        repository,
        branch,
        auth: {
          mode: auth.configured ? 'server_token' : 'public_read_only',
          configured: auth.configured,
          tokenSource: auth.source,
        },
        pullRequests,
        issues,
        workflowRuns,
        readme,
        codexSummary: buildCodexSummary({
          repository,
          pullRequests,
          issues,
          workflowRuns,
          warnings,
        }),
        warnings,
        limits: {
          recentItems,
          readmePreviewChars,
        },
        rateLimit: readRateLimit(repositoryResponse.headers),
      };
    },

    async getRepositoryFiles(params = {}) {
      const parsed = parseGitHubRepository(params.repository || params.repo);
      const limit = clampInt(params.limit, DEFAULT_CODE_FILE_LIMIT, 1, MAX_CODE_FILE_LIMIT);
      const maxBytes = clampInt(
        params.maxBytes || params.maxFileBytes,
        DEFAULT_CODE_FILE_MAX_BYTES,
        1000,
        MAX_CODE_FILE_MAX_BYTES,
      );
      const auth = resolveAuth(env);
      const octokit = await octokitFactory({ token: auth.token, tokenSource: auth.source });

      const repositoryResponse = await octokit.rest.repos.get(parsed);
      const repository = normalizeRepository(repositoryResponse.data);
      const branch = trimString(params.branch) || repository.defaultBranch;
      const treeSha = await resolveTreeSha(octokit, parsed, branch);
      const treeResponse = await octokit.rest.git.getTree({
        ...parsed,
        tree_sha: treeSha,
        recursive: '1',
      });

      const skipped = {
        notFile: 0,
        skippedDirectory: 0,
        unsupportedExtension: 0,
        oversized: 0,
        fetchFailed: 0,
      };
      const candidates = [];
      for (const entry of treeResponse.data?.tree || []) {
        const classification = classifyRepositoryPath(entry, { maxBytes });
        if (classification.ok) {
          candidates.push(entry);
          continue;
        }
        if (classification.reason === 'not_file') skipped.notFile += 1;
        else if (classification.reason === 'skipped_directory') skipped.skippedDirectory += 1;
        else if (classification.reason === 'oversized') skipped.oversized += 1;
        else skipped.unsupportedExtension += 1;
      }

      const selected = candidates
        .sort((a, b) => (
          repositoryPathPriority(a.path) - repositoryPathPriority(b.path)
          || normalisePosixPath(a.path).localeCompare(normalisePosixPath(b.path))
        ))
        .slice(0, limit);

      const fetched = await mapLimit(selected, CODE_FETCH_CONCURRENCY, async (entry) => {
        try {
          const filePath = normalisePosixPath(entry.path);
          const response = await octokit.rest.repos.getContent({
            ...parsed,
            path: filePath,
            ref: branch,
          });
          const content = decodeGitHubFileContent(response.data);
          if (!content) return null;
          const bytes = Buffer.byteLength(content, 'utf8');
          if (bytes > maxBytes) {
            skipped.oversized += 1;
            return null;
          }
          return {
            path: filePath,
            language: languageForPath(filePath),
            bytes,
            sha: entry.sha || response.data?.sha || null,
            htmlUrl: response.data?.html_url || `https://github.com/${parsed.fullName}/blob/${encodeURIComponent(branch)}/${filePath}`,
            content,
          };
        } catch (_error) {
          skipped.fetchFailed += 1;
          return null;
        }
      });

      const files = fetched.filter(Boolean);
      return {
        repository,
        branch,
        auth: {
          mode: auth.configured ? 'server_token' : 'public_read_only',
          configured: auth.configured,
          tokenSource: auth.source,
        },
        files,
        collection: buildGitHubRagCollection({ repository: parsed.fullName, branch }),
        skipped,
        limits: {
          fileLimit: limit,
          maxFileBytes: maxBytes,
          candidates: candidates.length,
          selected: selected.length,
          treeTruncated: Boolean(treeResponse.data?.truncated),
        },
        rateLimit: readRateLimit(treeResponse.headers || repositoryResponse.headers),
      };
    },
  };
}

module.exports = {
  buildCodeFilesForRag,
  DEFAULT_RECENT_ITEMS,
  DEFAULT_README_PREVIEW_CHARS,
  DEFAULT_CODE_FILE_LIMIT,
  DEFAULT_CODE_FILE_MAX_BYTES,
  GitHubCodexConnectorError,
  buildCodexSummary,
  buildGitHubRagCollection,
  classifyRepositoryPath,
  createGitHubCodexConnector,
  languageForPath,
  normalizeGitHubConnectorError,
  parseGitHubRepository,
  resolveAuth,
};
