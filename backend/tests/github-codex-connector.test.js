const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCodeFilesForRag,
  buildGitHubRagCollection,
  classifyRepositoryPath,
  createDefaultOctokit,
  createGitHubCodexConnector,
  languageForPath,
  normalizeGitHubConnectorError,
  parseGitHubRepository,
  resolveAuth,
  resolveGitHubRetryConfig,
  resolveGitHubThrottleConfig,
} = require('../src/services/github-codex-connector');

function baseRepoData() {
  return {
    id: 1,
    name: 'siraGPT',
    full_name: 'SiraGPT-ORg/siraGPT',
    owner: { login: 'SiraGPT-ORg' },
    private: false,
    visibility: 'public',
    html_url: 'https://github.com/SiraGPT-ORg/siraGPT',
    description: 'AI product ecosystem',
    default_branch: 'main',
    language: 'TypeScript',
    stargazers_count: 10,
    forks_count: 2,
    open_issues_count: 7,
    archived: false,
    disabled: false,
    pushed_at: '2026-04-30T12:00:00Z',
    updated_at: '2026-04-30T12:30:00Z',
  };
}

function createFakeOctokit({ actionsError } = {}) {
  const calls = [];
  return {
    calls,
    rest: {
      repos: {
        get: async (params) => {
          calls.push(['repos.get', params]);
          return {
            data: baseRepoData(),
            headers: {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '4999',
            },
          };
        },
        getReadme: async (params) => {
          calls.push(['repos.getReadme', params]);
          return {
            data: {
              name: 'README.md',
              path: 'README.md',
              html_url: 'https://github.com/SiraGPT-ORg/siraGPT/blob/main/README.md',
              sha: 'abc123',
              size: 18,
              encoding: 'base64',
              content: Buffer.from('# SiraGPT\n\nCore docs').toString('base64'),
            },
          };
        },
        getBranch: async (params) => {
          calls.push(['repos.getBranch', params]);
          return {
            data: {
              name: params.branch,
              commit: {
                sha: 'commit-sha',
                commit: {
                  tree: { sha: 'tree-sha' },
                },
              },
            },
          };
        },
        getContent: async (params) => {
          calls.push(['repos.getContent', params]);
          const fixtures = {
            'package.json': '{"name":"siragpt"}',
            'app/page.tsx': 'export default function Page() { return <main>Sira</main> }',
            'backend/src/index.js': 'module.exports = function boot() { return true; }',
            'docs/phase.md': '# Phase',
          };
          const content = fixtures[params.path] || 'export const value = true';
          return {
            data: {
              type: 'file',
              path: params.path,
              sha: `sha-${params.path}`,
              html_url: `https://github.com/SiraGPT-ORg/siraGPT/blob/main/${params.path}`,
              encoding: 'base64',
              content: Buffer.from(content).toString('base64'),
            },
          };
        },
      },
      pulls: {
        list: async (params) => {
          calls.push(['pulls.list', params]);
          return {
            data: [
              {
                number: 42,
                title: 'Improve chat streaming',
                state: 'open',
                draft: false,
                html_url: 'https://github.com/SiraGPT-ORg/siraGPT/pull/42',
                user: { login: 'dev' },
                base: { ref: 'main' },
                head: { ref: 'streaming' },
                created_at: '2026-04-29T10:00:00Z',
                updated_at: '2026-04-30T10:00:00Z',
              },
            ],
          };
        },
      },
      issues: {
        listForRepo: async (params) => {
          calls.push(['issues.listForRepo', params]);
          return {
            data: [
              {
                number: 12,
                title: 'Document renderer polish',
                state: 'open',
                html_url: 'https://github.com/SiraGPT-ORg/siraGPT/issues/12',
                user: { login: 'qa' },
                labels: [{ name: 'documents' }],
                created_at: '2026-04-29T11:00:00Z',
                updated_at: '2026-04-30T11:00:00Z',
              },
              {
                number: 42,
                title: 'PR mirror issue',
                pull_request: { url: 'https://api.github.com/repos/x/y/pulls/42' },
              },
            ],
          };
        },
      },
      actions: {
        listWorkflowRunsForRepo: async (params) => {
          calls.push(['actions.listWorkflowRunsForRepo', params]);
          if (actionsError) throw actionsError;
          return {
            data: {
              workflow_runs: [
                {
                  id: 77,
                  name: 'CI',
                  display_title: 'main',
                  status: 'completed',
                  conclusion: 'success',
                  event: 'push',
                  html_url: 'https://github.com/SiraGPT-ORg/siraGPT/actions/runs/77',
                  run_number: 77,
                  head_branch: 'main',
                  head_sha: '1234567890abcdef',
                  actor: { login: 'builder' },
                  created_at: '2026-04-30T12:00:00Z',
                  updated_at: '2026-04-30T12:04:00Z',
                },
              ],
            },
          };
        },
      },
      git: {
        getTree: async (params) => {
          calls.push(['git.getTree', params]);
          return {
            data: {
              truncated: false,
              tree: [
                { path: 'package.json', type: 'blob', size: 18, sha: 'pkg' },
                { path: 'app/page.tsx', type: 'blob', size: 60, sha: 'page' },
                { path: 'backend/src/index.js', type: 'blob', size: 48, sha: 'backend' },
                { path: 'docs/phase.md', type: 'blob', size: 8, sha: 'docs' },
                { path: 'package-lock.json', type: 'blob', size: 100, sha: 'lock' },
                { path: '.env.local', type: 'blob', size: 20, sha: 'env' },
                { path: 'node_modules/x/index.js', type: 'blob', size: 10, sha: 'vendor' },
                { path: 'public/logo.png', type: 'blob', size: 10, sha: 'binary' },
                { path: 'app', type: 'tree', sha: 'tree' },
              ],
            },
            headers: {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '4990',
            },
          };
        },
      },
    },
  };
}

describe('GitHub Codex connector repository parsing', () => {
  test('accepts owner/repo, HTTPS and SSH repository forms', () => {
    assert.deepEqual(parseGitHubRepository('SiraGPT-ORg/siraGPT'), {
      owner: 'SiraGPT-ORg',
      repo: 'siraGPT',
      fullName: 'SiraGPT-ORg/siraGPT',
    });
    assert.deepEqual(parseGitHubRepository('https://github.com/SiraGPT-ORg/siraGPT.git'), {
      owner: 'SiraGPT-ORg',
      repo: 'siraGPT',
      fullName: 'SiraGPT-ORg/siraGPT',
    });
    assert.deepEqual(parseGitHubRepository('git@github.com:SiraGPT-ORg/siraGPT.git'), {
      owner: 'SiraGPT-ORg',
      repo: 'siraGPT',
      fullName: 'SiraGPT-ORg/siraGPT',
    });
  });

  test('rejects non-GitHub and malformed repository values', () => {
    assert.throws(() => parseGitHubRepository('https://gitlab.com/a/b'), /Only github\.com/);
    assert.throws(() => parseGitHubRepository('../secret'), /owner\/repo/);
  });
});

describe('GitHub Codex connector auth status', () => {
  test('resolves retry and throttle hardening config with safe defaults and clamps', () => {
    const retryDefaults = resolveGitHubRetryConfig({});
    assert.equal(retryDefaults.limit, 2);
    assert.deepEqual(retryDefaults.retryableStatuses, [429, 500, 502, 503, 504]);
    assert.equal(retryDefaults.doNotRetryStatuses.includes(401), true);
    assert.equal(retryDefaults.doNotRetryStatuses.includes(403), true);
    assert.equal(retryDefaults.doNotRetryStatuses.includes(422), true);
    assert.equal(retryDefaults.doNotRetryStatuses.includes(500), false);

    assert.equal(resolveGitHubRetryConfig({ GITHUB_CODEX_RETRY_LIMIT: 'bad' }).limit, 2);
    assert.equal(resolveGitHubRetryConfig({ GITHUB_CODEX_RETRY_LIMIT: '-1' }).limit, 0);
    assert.equal(resolveGitHubRetryConfig({ GITHUB_CODEX_RETRY_LIMIT: '99' }).limit, 5);

    const throttleDefaults = resolveGitHubThrottleConfig({});
    assert.deepEqual(throttleDefaults, { maxRetries: 2, retryAfterSeconds: 60 });
    assert.deepEqual(resolveGitHubThrottleConfig({
      GITHUB_CODEX_THROTTLE_MAX_RETRIES: '-3',
      GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS: '0',
    }), { maxRetries: 0, retryAfterSeconds: 1 });
    assert.deepEqual(resolveGitHubThrottleConfig({
      GITHUB_CODEX_THROTTLE_MAX_RETRIES: '99',
      GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS: '999',
    }), { maxRetries: 5, retryAfterSeconds: 300 });
    assert.deepEqual(resolveGitHubThrottleConfig({
      GITHUB_CODEX_THROTTLE_MAX_RETRIES: '2.5',
      GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS: 'later',
    }), { maxRetries: 2, retryAfterSeconds: 60 });
  });

  test('redacts backend tokens from public status', () => {
    const auth = resolveAuth({ GITHUB_CODEX_TOKEN: 'ghp_secret' });
    assert.equal(auth.configured, true);
    assert.equal(auth.source, 'GITHUB_CODEX_TOKEN');

    const connector = createGitHubCodexConnector({
      env: { GITHUB_CODEX_TOKEN: 'ghp_secret' },
      octokitFactory: async () => createFakeOctokit(),
    });
    const status = connector.getStatus();
    assert.equal(status.configured, true);
    assert.equal(status.tokenSource, 'GITHUB_CODEX_TOKEN');
    assert.equal(status.resilience.retry.limit, 2);
    assert.deepEqual(status.resilience.throttle, { maxRetries: 2, retryAfterSeconds: 60 });
    assert.equal(JSON.stringify(status).includes('ghp_secret'), false);
  });

  test('creates default Octokit with server-side token without exposing it in status', async () => {
    const octokit = await createDefaultOctokit({
      token: 'ghp_secret',
      env: {
        GITHUB_CODEX_RETRY_LIMIT: '1',
        GITHUB_CODEX_THROTTLE_MAX_RETRIES: '1',
        GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS: '30',
      },
    });
    const auth = await octokit.auth();
    assert.equal(auth.type, 'token');
    assert.equal(auth.token, 'ghp_secret');

    const connector = createGitHubCodexConnector({
      env: {
        GITHUB_CODEX_TOKEN: 'ghp_secret',
        GITHUB_CODEX_RETRY_LIMIT: '1',
        GITHUB_CODEX_THROTTLE_MAX_RETRIES: '1',
        GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS: '30',
      },
      octokitFactory: async () => createFakeOctokit(),
    });
    const status = connector.getStatus();
    assert.deepEqual(status.resilience, {
      retry: { limit: 1, retryableStatuses: [429, 500, 502, 503, 504] },
      throttle: { maxRetries: 1, retryAfterSeconds: 30 },
    });
    assert.equal(JSON.stringify(status).includes('ghp_secret'), false);
  });
});

describe('GitHub Codex connector context aggregation', () => {
  test('aggregates repository, PR, issue, action and README context without leaking token', async () => {
    let receivedFactoryOptions;
    const fake = createFakeOctokit();
    const connector = createGitHubCodexConnector({
      env: { GITHUB_CODEX_TOKEN: 'ghp_secret' },
      octokitFactory: async (options) => {
        receivedFactoryOptions = options;
        return fake;
      },
    });

    const context = await connector.getRepositoryContext({
      repository: 'https://github.com/SiraGPT-ORg/siraGPT/tree/main',
      branch: 'main',
      limit: 5,
    });

    assert.equal(receivedFactoryOptions.token, 'ghp_secret');
    assert.equal(context.repository.fullName, 'SiraGPT-ORg/siraGPT');
    assert.equal(context.branch, 'main');
    assert.equal(context.auth.mode, 'server_token');
    assert.equal(context.pullRequests.length, 1);
    assert.equal(context.issues.length, 1);
    assert.equal(context.workflowRuns[0].conclusion, 'success');
    assert.match(context.readme.preview, /SiraGPT/);
    assert.equal(context.codexSummary.health, 'ready');
    assert.equal(JSON.stringify(context).includes('ghp_secret'), false);
    assert.deepEqual(fake.calls.find(([name]) => name === 'actions.listWorkflowRunsForRepo')[1].branch, 'main');
  });

  test('keeps repository context when optional GitHub surfaces fail', async () => {
    const err = new Error('Resource not accessible by integration');
    err.status = 403;
    err.response = { headers: { 'x-ratelimit-remaining': '42' } };
    const connector = createGitHubCodexConnector({
      env: {},
      octokitFactory: async () => createFakeOctokit({ actionsError: err }),
    });

    const context = await connector.getRepositoryContext({ repository: 'SiraGPT-ORg/siraGPT' });
    assert.equal(context.auth.mode, 'public_read_only');
    assert.equal(context.workflowRuns.length, 0);
    assert.equal(context.warnings.length, 1);
    assert.equal(context.warnings[0].area, 'actions');
    assert.equal(context.codexSummary.health, 'partial');
  });

  test('normalizes GitHub API errors for HTTP routes', () => {
    const err = new Error('Bad credentials');
    err.status = 401;
    const normalized = normalizeGitHubConnectorError(err);
    assert.equal(normalized.status, 401);
    assert.equal(normalized.body.code, 'github_auth_failed');
    assert.equal(JSON.stringify(normalized).includes('Bad credentials'), false);
  });

  test('normalizes rate-limit and transient GitHub errors without leaking raw headers or messages', () => {
    const forbidden = new Error('API rate limit exceeded for token ghp_secret');
    forbidden.status = 403;
    forbidden.response = {
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1770000000',
        'x-ratelimit-used': '5000',
        'retry-after': '45',
        authorization: 'token ghp_secret',
      },
    };
    const forbiddenNormalized = normalizeGitHubConnectorError(forbidden);
    assert.equal(forbiddenNormalized.status, 403);
    assert.equal(forbiddenNormalized.body.code, 'github_rate_limited');
    assert.deepEqual(forbiddenNormalized.body.rateLimit, {
      limit: '5000',
      remaining: '0',
      reset: '1770000000',
      used: '5000',
      retryAfter: '45',
    });
    assert.equal(JSON.stringify(forbiddenNormalized).includes('authorization'), false);
    assert.equal(JSON.stringify(forbiddenNormalized).includes('ghp_secret'), false);

    const tooManyRequests = new Error('secondary rate limit');
    tooManyRequests.status = 429;
    tooManyRequests.response = { headers: { 'retry-after': '10' } };
    const tooManyRequestsNormalized = normalizeGitHubConnectorError(tooManyRequests);
    assert.equal(tooManyRequestsNormalized.status, 429);
    assert.equal(tooManyRequestsNormalized.body.code, 'github_rate_limited');
    assert.equal(tooManyRequestsNormalized.body.rateLimit.retryAfter, '10');

    const unavailable = new Error('GitHub 503 token ghp_secret');
    unavailable.status = 503;
    unavailable.response = { headers: {} };
    const unavailableNormalized = normalizeGitHubConnectorError(unavailable);
    assert.equal(unavailableNormalized.status, 503);
    assert.equal(unavailableNormalized.body.code, 'github_api_error');
    assert.equal(unavailableNormalized.body.error, 'GitHub API request failed');
    assert.equal(JSON.stringify(unavailableNormalized).includes('ghp_secret'), false);
  });
});

describe('GitHub Codex repository RAG file selection', () => {
  test('classifies commercial-safe code paths and skips secrets, lockfiles and vendor files', () => {
    assert.equal(classifyRepositoryPath({ path: 'app/page.tsx', type: 'blob', size: 100 }).ok, true);
    assert.equal(classifyRepositoryPath({ path: '.env.local', type: 'blob', size: 10 }).reason, 'unsupported_extension');
    assert.equal(classifyRepositoryPath({ path: 'package-lock.json', type: 'blob', size: 10 }).reason, 'unsupported_extension');
    assert.equal(classifyRepositoryPath({ path: 'node_modules/a/index.js', type: 'blob', size: 10 }).reason, 'skipped_directory');
    assert.equal(classifyRepositoryPath({ path: 'large.ts', type: 'blob', size: 5000 }, { maxBytes: 1000 }).reason, 'oversized');
    assert.equal(languageForPath('components/button.tsx'), 'typescript');
  });

  test('fetches a bounded set of GitHub files ready for code RAG ingestion', async () => {
    const fake = createFakeOctokit();
    const connector = createGitHubCodexConnector({
      env: { GITHUB_CODEX_TOKEN: 'ghp_secret' },
      octokitFactory: async () => fake,
    });

    const fileSet = await connector.getRepositoryFiles({
      repository: 'SiraGPT-ORg/siraGPT',
      branch: 'main',
      limit: 3,
      maxBytes: 1000,
    });

    assert.equal(fileSet.repository.fullName, 'SiraGPT-ORg/siraGPT');
    assert.equal(fileSet.branch, 'main');
    assert.equal(fileSet.files.length, 3);
    assert.deepEqual(fileSet.files.map((file) => file.path), [
      'package.json',
      'app/page.tsx',
      'backend/src/index.js',
    ]);
    assert.equal(fileSet.files[1].language, 'typescript');
    assert.equal(fileSet.skipped.skippedDirectory, 1);
    assert.ok(fileSet.skipped.unsupportedExtension >= 3);
    assert.equal(JSON.stringify(fileSet).includes('ghp_secret'), false);

    const ragFiles = buildCodeFilesForRag(fileSet.files);
    assert.deepEqual(ragFiles.map((file) => file.filename), [
      'package.json',
      'app/page.tsx',
      'backend/src/index.js',
    ]);
    assert.equal(ragFiles[1].language, 'typescript');
    assert.equal(
      buildGitHubRagCollection({ repository: 'SiraGPT-ORg/siraGPT', branch: 'feature/test branch' }),
      'github:SiraGPT-ORg/siraGPT:feature/test-branch',
    );
    assert.ok(fake.calls.some(([name]) => name === 'git.getTree'));
    assert.equal(fake.calls.filter(([name]) => name === 'repos.getContent').length, 3);
  });
});
