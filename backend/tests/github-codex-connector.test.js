const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createGitHubCodexConnector,
  normalizeGitHubConnectorError,
  parseGitHubRepository,
  resolveAuth,
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
});
