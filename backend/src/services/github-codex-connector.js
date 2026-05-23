'use strict';

const path = require('path');
const createIgnore = require('ignore');

const DEFAULT_RECENT_ITEMS = 10;
const MAX_RECENT_ITEMS = 20;
const DEFAULT_README_PREVIEW_CHARS = 12000;
const MAX_README_PREVIEW_CHARS = 24000;
const DEFAULT_CODE_FILE_LIMIT = 40;
const MAX_CODE_FILE_LIMIT = 120;
const DEFAULT_CODE_FILE_MAX_BYTES = 60000;
const MAX_CODE_FILE_MAX_BYTES = 120000;
const CODE_FETCH_CONCURRENCY = 4;
const REPOSITORY_GITIGNORE_PATH = '.gitignore';
const MAX_REPOSITORY_GITIGNORE_BYTES = 128000;
const DEFAULT_ACTION_RUN_LIMIT = 10;
const MAX_ACTION_RUN_LIMIT = 30;
const DEFAULT_ACTION_LOG_BYTES = 60000;
const MAX_ACTION_LOG_BYTES = 160000;
const ACTION_LOG_FAILED_JOB_LIMIT = 3;
const DEFAULT_GITHUB_CODEX_RETRY_LIMIT = 2;
const MAX_GITHUB_CODEX_RETRY_LIMIT = 5;
const DEFAULT_GITHUB_CODEX_THROTTLE_MAX_RETRIES = 2;
const MAX_GITHUB_CODEX_THROTTLE_MAX_RETRIES = 5;
const DEFAULT_GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS = 60;
const MAX_GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS = 300;
const GITHUB_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
const GITHUB_DO_NOT_RETRY_STATUSES = Array.from({ length: 200 }, (_, index) => 400 + index)
  .filter((status) => !GITHUB_RETRYABLE_STATUSES.includes(status));

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

function publicRepositoryFilteringStatus() {
  return {
    gitignore: {
      enabled: true,
      maxBytes: MAX_REPOSITORY_GITIGNORE_BYTES,
    },
    secretFiles: '.env* except .env.example',
    skippedDirectories: Array.from(SKIPPED_PATH_SEGMENTS).sort(),
    skippedFileNames: Array.from(SKIPPED_FILE_NAMES).sort(),
    codeExtensions: Array.from(CODE_FILE_EXTENSIONS).sort(),
  };
}

function publicAuthStatus(auth, resilience) {
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
    resilience,
    repositoryFiltering: publicRepositoryFilteringStatus(),
    actionsIntelligence: {
      enabled: true,
      readOnly: true,
      runLimit: {
        default: DEFAULT_ACTION_RUN_LIMIT,
        max: MAX_ACTION_RUN_LIMIT,
      },
      logAnalysis: {
        maxBytes: MAX_ACTION_LOG_BYTES,
        failedJobLimit: ACTION_LOG_FAILED_JOB_LIMIT,
        sanitization: [
          'github_tokens',
          'authorization_headers',
          'masked_values',
          'basic_auth_urls',
          'ansi_control_sequences',
        ],
      },
    },
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampEnvInt(value, fallback, min, max) {
  const raw = trimString(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function resolveGitHubRetryConfig(env = process.env) {
  const limit = clampEnvInt(
    env.GITHUB_CODEX_RETRY_LIMIT,
    DEFAULT_GITHUB_CODEX_RETRY_LIMIT,
    0,
    MAX_GITHUB_CODEX_RETRY_LIMIT,
  );
  return {
    limit,
    retryableStatuses: GITHUB_RETRYABLE_STATUSES.slice(),
    doNotRetryStatuses: GITHUB_DO_NOT_RETRY_STATUSES.slice(),
  };
}

function resolveGitHubThrottleConfig(env = process.env) {
  return {
    maxRetries: clampEnvInt(
      env.GITHUB_CODEX_THROTTLE_MAX_RETRIES,
      DEFAULT_GITHUB_CODEX_THROTTLE_MAX_RETRIES,
      0,
      MAX_GITHUB_CODEX_THROTTLE_MAX_RETRIES,
    ),
    retryAfterSeconds: clampEnvInt(
      env.GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS,
      DEFAULT_GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS,
      1,
      MAX_GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS,
    ),
  };
}

function publicResilienceStatus(env = process.env) {
  const retry = resolveGitHubRetryConfig(env);
  const throttle = resolveGitHubThrottleConfig(env);
  return {
    retry: {
      limit: retry.limit,
      retryableStatuses: retry.retryableStatuses,
    },
    throttle: {
      maxRetries: throttle.maxRetries,
      retryAfterSeconds: throttle.retryAfterSeconds,
    },
  };
}

function shouldRetryThrottledRequest(retryAfter, retryCount, throttleConfig) {
  const delaySeconds = Number(retryAfter);
  return (
    retryCount < throttleConfig.maxRetries
    && Number.isFinite(delaySeconds)
    && delaySeconds <= throttleConfig.retryAfterSeconds
  );
}

async function createGitHubOctokitClass() {
  const [octokitMod, retryMod, throttlingMod] = await Promise.all([
    import('octokit'),
    import('@octokit/plugin-retry'),
    import('@octokit/plugin-throttling'),
  ]);
  return octokitMod.Octokit.plugin(retryMod.retry, throttlingMod.throttling);
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

function createRepositoryIgnoreMatcher(content) {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) return null;
  const matcher = createIgnore();
  matcher.add(raw);
  return matcher;
}

function isGitIgnoredPath(filePath, ignoreMatcher) {
  if (!ignoreMatcher) return false;
  const cleanPath = normalisePosixPath(filePath);
  if (!cleanPath) return false;
  try {
    return ignoreMatcher.ignores(cleanPath);
  } catch (_error) {
    return false;
  }
}

function isSupportedCodePath(filePath) {
  const cleanPath = normalisePosixPath(filePath);
  const base = path.posix.basename(cleanPath);
  if (!cleanPath || isSensitiveEnvPath(cleanPath) || SKIPPED_FILE_NAMES.has(base)) return false;
  if (CODE_FILE_NAMES.has(base)) return true;
  return CODE_FILE_EXTENSIONS.has(path.posix.extname(cleanPath).toLowerCase());
}

function classifyRepositoryPath(entry, { maxBytes = DEFAULT_CODE_FILE_MAX_BYTES, ignoreMatcher = null } = {}) {
  const filePath = normalisePosixPath(entry?.path);
  if (!filePath) return { ok: false, reason: 'missing_path' };
  if (entry.type !== 'blob') return { ok: false, reason: 'not_file' };
  if (hasSkippedSegment(filePath)) return { ok: false, reason: 'skipped_directory' };
  if (isGitIgnoredPath(filePath, ignoreMatcher)) return { ok: false, reason: 'gitignored' };
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

async function fetchRepositoryIgnoreMatcher(octokit, parsed, branch) {
  try {
    const response = await octokit.rest.repos.getContent({
      ...parsed,
      path: REPOSITORY_GITIGNORE_PATH,
      ref: branch,
    });
    const data = response.data;
    if (!data || Array.isArray(data) || data.type !== 'file') {
      return { matcher: null, source: null, warning: null };
    }

    const bytes = numberOrZero(data.size);
    const source = {
      path: data.path || REPOSITORY_GITIGNORE_PATH,
      sha: data.sha || null,
      bytes,
      htmlUrl: data.html_url || null,
    };
    if (bytes > MAX_REPOSITORY_GITIGNORE_BYTES) {
      return {
        matcher: null,
        source,
        warning: {
          area: 'gitignore',
          code: 'github_gitignore_oversized',
          status: 200,
          message: '.gitignore is too large to apply safely',
        },
      };
    }

    const content = decodeGitHubFileContent(data);
    return {
      matcher: createRepositoryIgnoreMatcher(content),
      source,
      warning: null,
    };
  } catch (error) {
    if (Number(error.status) === 404) {
      return { matcher: null, source: null, warning: null };
    }
    return { matcher: null, source: null, warning: warningFromError('gitignore', error) };
  }
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

async function createDefaultOctokit({ token, env = process.env } = {}) {
  const retryConfig = resolveGitHubRetryConfig(env);
  const throttleConfig = resolveGitHubThrottleConfig(env);
  const GitHubOctokit = await createGitHubOctokitClass();
  return new GitHubOctokit({
    ...(token ? { auth: token } : {}),
    userAgent: 'siraGPT-codex-connector/8a',
    request: { timeout: 12000 },
    retry: {
      retries: retryConfig.limit,
      doNotRetry: retryConfig.doNotRetryStatuses,
    },
    throttle: {
      fallbackSecondaryRateRetryAfter: throttleConfig.retryAfterSeconds,
      onRateLimit: (retryAfter, _options, _octokit, retryCount) =>
        shouldRetryThrottledRequest(retryAfter, retryCount, throttleConfig),
      onSecondaryRateLimit: (retryAfter, _options, _octokit, retryCount) =>
        shouldRetryThrottledRequest(retryAfter, retryCount, throttleConfig),
    },
  });
}

function isoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function positiveIntOrZero(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function durationMs(start, end) {
  if (!start || !end) return null;
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return to - from;
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
  const createdAt = isoOrNull(run.created_at);
  const updatedAt = isoOrNull(run.updated_at);
  return {
    id: run.id,
    workflowId: run.workflow_id || null,
    name: run.name || run.display_title || `run-${run.run_number}`,
    displayTitle: run.display_title || run.name || '',
    status: run.status || null,
    conclusion: run.conclusion || null,
    event: run.event || null,
    htmlUrl: run.html_url,
    runNumber: run.run_number,
    runAttempt: run.run_attempt || null,
    branch: run.head_branch || null,
    headSha: run.head_sha ? String(run.head_sha).slice(0, 12) : null,
    headShaFull: run.head_sha || null,
    actor: run.actor?.login || null,
    createdAt,
    updatedAt,
    durationMs: durationMs(createdAt, updatedAt),
    headCommit: run.head_commit ? {
      id: run.head_commit.id ? String(run.head_commit.id).slice(0, 12) : null,
      message: trimString(run.head_commit.message).slice(0, 240),
      timestamp: isoOrNull(run.head_commit.timestamp),
      author: run.head_commit.author?.name || null,
    } : null,
  };
}

function normalizeWorkflowStep(step) {
  const startedAt = isoOrNull(step.started_at);
  const completedAt = isoOrNull(step.completed_at);
  return {
    name: step.name || `step-${step.number || ''}`.trim(),
    number: numberOrZero(step.number),
    status: step.status || null,
    conclusion: step.conclusion || null,
    startedAt,
    completedAt,
    durationMs: durationMs(startedAt, completedAt),
  };
}

function normalizeWorkflowJob(job) {
  const startedAt = isoOrNull(job.started_at);
  const completedAt = isoOrNull(job.completed_at);
  return {
    id: job.id,
    runId: job.run_id || null,
    name: job.name || `job-${job.id}`,
    status: job.status || null,
    conclusion: job.conclusion || null,
    htmlUrl: job.html_url || null,
    runnerName: job.runner_name || null,
    runnerGroupName: job.runner_group_name || null,
    labels: Array.isArray(job.labels) ? job.labels.slice(0, 8) : [],
    startedAt,
    completedAt,
    durationMs: durationMs(startedAt, completedAt),
    steps: Array.isArray(job.steps) ? job.steps.map(normalizeWorkflowStep) : [],
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
    retryAfter: headerValue(headers, 'retry-after'),
  };
}

function isFailureConclusion(conclusion) {
  return ['failure', 'cancelled', 'timed_out', 'action_required'].includes(String(conclusion || ''));
}

function buildActionsSummary(runs = []) {
  const latest = runs[0] || null;
  const failing = runs.filter((run) => isFailureConclusion(run.conclusion));
  const inProgress = runs.filter((run) =>
    ['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(String(run.status || '')),
  );

  return {
    health: latest?.conclusion === 'success'
      ? 'green'
      : isFailureConclusion(latest?.conclusion)
        ? 'red'
        : inProgress.length
          ? 'running'
          : latest
            ? 'unknown'
            : 'empty',
    latestConclusion: latest?.conclusion || latest?.status || null,
    latestRunId: latest?.id || null,
    failingRuns: failing.length,
    inProgressRuns: inProgress.length,
    totalRuns: runs.length,
  };
}

function octokitDataToString(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (typeof data === 'object' && typeof data.text === 'function') {
    return '';
  }
  return String(data);
}

function sanitizeGitHubActionsText(value, maxChars = DEFAULT_ACTION_LOG_BYTES) {
  const limit = clampInt(maxChars, DEFAULT_ACTION_LOG_BYTES, 1000, MAX_ACTION_LOG_BYTES);
  const raw = octokitDataToString(value);
  const withoutAnsi = raw
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '');
  const sanitized = withoutAnsi
    .split('\n')
    .filter((line) => !/^::add-mask::/i.test(line.trim()))
    .join('\n')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-token]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi, '$1 [redacted]')
    .replace(/\b(authorization|x-github-token|github_token|token|password|secret|api[_-]?key)\s*[:=]\s*["']?[^"'\s]+["']?/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/gi, '$1[redacted]@');

  return {
    text: sanitized.slice(0, limit),
    truncated: sanitized.length > limit,
    originalBytes: Buffer.byteLength(raw, 'utf8'),
    sanitizedBytes: Buffer.byteLength(sanitized, 'utf8'),
  };
}

function extractFailureLines(text, maxLines = 8) {
  const seen = new Set();
  const lines = [];
  for (const line of String(text || '').split('\n')) {
    const clean = line.trim();
    if (!clean || clean.length < 4) continue;
    if (!/\b(?:error|failed|failure|fatal|exception|assert|typeerror|referenceerror|syntaxerror|enoent|eaddrinuse|npm err|pnpm err|yarn error|err_)\b/i.test(clean)) {
      continue;
    }
    const compact = clean.replace(/\s+/g, ' ').slice(0, 280);
    if (seen.has(compact)) continue;
    seen.add(compact);
    lines.push(compact);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function buildActionFailureAnalysis({ run, jobs, logExcerpts, warnings }) {
  const failedJobs = jobs.filter((job) => isFailureConclusion(job.conclusion));
  const failedSteps = failedJobs.flatMap((job) =>
    (job.steps || [])
      .filter((step) => isFailureConclusion(step.conclusion))
      .map((step) => `${job.name} / ${step.name}`),
  );
  const logSignals = logExcerpts.flatMap((entry) => extractFailureLines(entry.excerpt, 4));
  const rootCauseCandidates = [...new Set([...failedSteps, ...logSignals])].slice(0, 10);
  const health = run.conclusion === 'success'
    ? 'green'
    : failedJobs.length
      ? 'red'
      : run.status && run.status !== 'completed'
        ? 'running'
        : 'unknown';

  const nextActions = [];
  if (failedSteps.length) {
    nextActions.push('Abrir el job fallido y revisar el primer step marcado como failure.');
  }
  if (logSignals.length) {
    nextActions.push('Corregir primero la primera línea de error real; los errores posteriores pueden ser cascada.');
  }
  if (!failedJobs.length && health === 'running') {
    nextActions.push('Esperar a que el workflow termine antes de diagnosticar.');
  }
  if (warnings.length) {
    nextActions.push('Revisar permisos actions:read si los logs no están disponibles.');
  }
  if (!nextActions.length) {
    nextActions.push('Workflow sin fallos accionables visibles desde GitHub Actions.');
  }

  return {
    health,
    runId: run.id,
    runName: run.name,
    conclusion: run.conclusion,
    status: run.status,
    failedJobs: failedJobs.map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      htmlUrl: job.htmlUrl,
      failedSteps: (job.steps || [])
        .filter((step) => isFailureConclusion(step.conclusion))
        .map((step) => step.name),
    })),
    rootCauseCandidates,
    nextActions,
    warnings,
  };
}

async function downloadJobLogExcerpt(octokit, parsed, jobId, maxBytes) {
  if (!octokit.rest.actions.downloadJobLogsForWorkflowRun) {
    return {
      warning: {
        area: 'actions_logs',
        code: 'github_actions_logs_unavailable',
        status: 200,
        message: 'GitHub Actions job log download is not supported by this Octokit instance',
      },
      log: null,
    };
  }

  try {
    const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      ...parsed,
      job_id: Number(jobId),
    });
    const sanitized = sanitizeGitHubActionsText(response.data, maxBytes);
    return { warning: null, log: sanitized };
  } catch (error) {
    return { warning: warningFromError('actions_logs', error), log: null };
  }
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
  const rateLimit = readRateLimit(error?.response?.headers);
  const hasRateLimitSignal = Boolean(rateLimit.retryAfter) || rateLimit.remaining === '0';

  let code = 'github_api_error';
  let message = 'GitHub API request failed';
  if (status === 401) {
    code = 'github_auth_failed';
    message = 'GitHub token is invalid or expired';
  } else if (status === 403 && hasRateLimitSignal) {
    code = 'github_rate_limited';
    message = 'GitHub API rate limit reached';
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
      rateLimit,
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
      return publicAuthStatus(resolveAuth(env), publicResilienceStatus(env));
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
      const octokit = await octokitFactory({ token: auth.token, tokenSource: auth.source, env });

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

    async listActionRuns(params = {}) {
      const parsed = parseGitHubRepository(params.repository || params.repo);
      const limit = clampInt(params.limit, DEFAULT_ACTION_RUN_LIMIT, 1, MAX_ACTION_RUN_LIMIT);
      const auth = resolveAuth(env);
      const octokit = await octokitFactory({ token: auth.token, tokenSource: auth.source, env });

      const repositoryResponse = await octokit.rest.repos.get(parsed);
      const repository = normalizeRepository(repositoryResponse.data);
      const branch = trimString(params.branch) || repository.defaultBranch;
      const request = {
        ...parsed,
        per_page: limit,
      };
      if (branch) request.branch = branch;
      if (trimString(params.status)) request.status = trimString(params.status);
      if (trimString(params.event)) request.event = trimString(params.event);

      const response = await octokit.rest.actions.listWorkflowRunsForRepo(request);
      const runs = (response.data?.workflow_runs || []).map(normalizeWorkflowRun);
      return {
        repository,
        branch,
        auth: {
          mode: auth.configured ? 'server_token' : 'public_read_only',
          configured: auth.configured,
          tokenSource: auth.source,
        },
        runs,
        summary: buildActionsSummary(runs),
        limits: {
          runLimit: limit,
        },
        rateLimit: readRateLimit(response.headers || repositoryResponse.headers),
      };
    },

    async getActionRun(params = {}) {
      const parsed = parseGitHubRepository(params.repository || params.repo);
      const runId = positiveIntOrZero(params.runId || params.run_id);
      if (!runId) {
        throw new GitHubCodexConnectorError('invalid_github_actions_run', 400, 'GitHub Actions run id is required');
      }
      const auth = resolveAuth(env);
      const octokit = await octokitFactory({ token: auth.token, tokenSource: auth.source, env });

      const [repositoryResponse, runResponse] = await Promise.all([
        octokit.rest.repos.get(parsed),
        octokit.rest.actions.getWorkflowRun({
          ...parsed,
          run_id: runId,
        }),
      ]);
      const repository = normalizeRepository(repositoryResponse.data);
      const run = normalizeWorkflowRun(runResponse.data);
      return {
        repository,
        branch: run.branch || repository.defaultBranch,
        auth: {
          mode: auth.configured ? 'server_token' : 'public_read_only',
          configured: auth.configured,
          tokenSource: auth.source,
        },
        run,
        rateLimit: readRateLimit(runResponse.headers || repositoryResponse.headers),
      };
    },

    async listActionJobs(params = {}) {
      const parsed = parseGitHubRepository(params.repository || params.repo);
      const runId = positiveIntOrZero(params.runId || params.run_id);
      if (!runId) {
        throw new GitHubCodexConnectorError('invalid_github_actions_run', 400, 'GitHub Actions run id is required');
      }
      const auth = resolveAuth(env);
      const octokit = await octokitFactory({ token: auth.token, tokenSource: auth.source, env });

      const [repositoryResponse, runResponse, jobsResponse] = await Promise.all([
        octokit.rest.repos.get(parsed),
        octokit.rest.actions.getWorkflowRun({
          ...parsed,
          run_id: runId,
        }),
        octokit.rest.actions.listJobsForWorkflowRun({
          ...parsed,
          run_id: runId,
          filter: 'latest',
          per_page: 100,
        }),
      ]);
      const repository = normalizeRepository(repositoryResponse.data);
      const run = normalizeWorkflowRun(runResponse.data);
      const jobs = (jobsResponse.data?.jobs || []).map(normalizeWorkflowJob);
      return {
        repository,
        branch: run.branch || repository.defaultBranch,
        auth: {
          mode: auth.configured ? 'server_token' : 'public_read_only',
          configured: auth.configured,
          tokenSource: auth.source,
        },
        run,
        jobs,
        summary: {
          totalJobs: jobs.length,
          failedJobs: jobs.filter((job) => isFailureConclusion(job.conclusion)).length,
          completedJobs: jobs.filter((job) => job.status === 'completed').length,
        },
        rateLimit: readRateLimit(jobsResponse.headers || runResponse.headers || repositoryResponse.headers),
      };
    },

    async analyzeActionFailure(params = {}) {
      const parsed = parseGitHubRepository(params.repository || params.repo);
      const runId = positiveIntOrZero(params.runId || params.run_id);
      if (!runId) {
        throw new GitHubCodexConnectorError('invalid_github_actions_run', 400, 'GitHub Actions run id is required');
      }
      const maxLogBytes = clampInt(
        params.maxLogBytes || params.maxBytes,
        DEFAULT_ACTION_LOG_BYTES,
        1000,
        MAX_ACTION_LOG_BYTES,
      );
      const includeLogs = params.includeLogs !== false;
      const auth = resolveAuth(env);
      const octokit = await octokitFactory({ token: auth.token, tokenSource: auth.source, env });

      const [repositoryResponse, runResponse, jobsResponse] = await Promise.all([
        octokit.rest.repos.get(parsed),
        octokit.rest.actions.getWorkflowRun({
          ...parsed,
          run_id: runId,
        }),
        octokit.rest.actions.listJobsForWorkflowRun({
          ...parsed,
          run_id: runId,
          filter: 'latest',
          per_page: 100,
        }),
      ]);
      const repository = normalizeRepository(repositoryResponse.data);
      const run = normalizeWorkflowRun(runResponse.data);
      const jobs = (jobsResponse.data?.jobs || []).map(normalizeWorkflowJob);
      const failedJobs = jobs.filter((job) => isFailureConclusion(job.conclusion));
      const warnings = [];
      const logExcerpts = [];

      if (includeLogs) {
        for (const job of failedJobs.slice(0, ACTION_LOG_FAILED_JOB_LIMIT)) {
          const { warning, log } = await downloadJobLogExcerpt(octokit, parsed, job.id, maxLogBytes);
          if (warning) warnings.push(warning);
          if (log) {
            logExcerpts.push({
              jobId: job.id,
              jobName: job.name,
              excerpt: log.text,
              truncated: log.truncated,
              originalBytes: log.originalBytes,
              sanitizedBytes: log.sanitizedBytes,
            });
          }
        }
      }

      return {
        repository,
        branch: run.branch || repository.defaultBranch,
        auth: {
          mode: auth.configured ? 'server_token' : 'public_read_only',
          configured: auth.configured,
          tokenSource: auth.source,
        },
        run,
        jobs,
        analysis: buildActionFailureAnalysis({
          run,
          jobs,
          logExcerpts,
          warnings,
        }),
        logs: {
          included: includeLogs,
          maxBytes: maxLogBytes,
          failedJobLimit: ACTION_LOG_FAILED_JOB_LIMIT,
          excerpts: logExcerpts,
        },
        rateLimit: readRateLimit(jobsResponse.headers || runResponse.headers || repositoryResponse.headers),
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
      const octokit = await octokitFactory({ token: auth.token, tokenSource: auth.source, env });

      const repositoryResponse = await octokit.rest.repos.get(parsed);
      const repository = normalizeRepository(repositoryResponse.data);
      const branch = trimString(params.branch) || repository.defaultBranch;
      const treeSha = await resolveTreeSha(octokit, parsed, branch);
      const treeResponse = await octokit.rest.git.getTree({
        ...parsed,
        tree_sha: treeSha,
        recursive: '1',
      });
      const ignoreResult = await fetchRepositoryIgnoreMatcher(octokit, parsed, branch);
      const warnings = ignoreResult.warning ? [ignoreResult.warning] : [];

      const skipped = {
        notFile: 0,
        skippedDirectory: 0,
        gitignored: 0,
        unsupportedExtension: 0,
        oversized: 0,
        fetchFailed: 0,
      };
      const candidates = [];
      for (const entry of treeResponse.data?.tree || []) {
        const classification = classifyRepositoryPath(entry, {
          maxBytes,
          ignoreMatcher: ignoreResult.matcher,
        });
        if (classification.ok) {
          candidates.push(entry);
          continue;
        }
        if (classification.reason === 'not_file') skipped.notFile += 1;
        else if (classification.reason === 'skipped_directory') skipped.skippedDirectory += 1;
        else if (classification.reason === 'gitignored') skipped.gitignored += 1;
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
        filtering: {
          gitignore: {
            applied: Boolean(ignoreResult.matcher),
            source: ignoreResult.source,
          },
        },
        warnings,
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
  createRepositoryIgnoreMatcher,
  createDefaultOctokit,
  createGitHubOctokitClass,
  createGitHubCodexConnector,
  languageForPath,
  normalizeGitHubConnectorError,
  parseGitHubRepository,
  resolveAuth,
  resolveGitHubRetryConfig,
  resolveGitHubThrottleConfig,
  sanitizeGitHubActionsText,
};
