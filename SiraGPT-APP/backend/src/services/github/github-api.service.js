'use strict';

/**
 * GitHub API service — per-user, OAuth-token-scoped REST access.
 *
 * Every call resolves the caller's stored GitHub account, decrypts their
 * access token via the OAuth service, and drives an Octokit client. We reuse
 * the connector's `createDefaultOctokit` factory so the retry + throttling
 * plugins (and their env tuning) stay in one place instead of being
 * re-implemented here.
 *
 * SRP: this module only reads from GitHub. Persisting a chosen repo lives in
 * ConnectedRepositoryRepository; HTTP wiring lives in routes/github.js.
 */

const accounts = require('../../repositories/GithubAccountRepository');
const oauth = require('./github-oauth.service');
const connector = require('../github-codex-connector');

/** Error helper that carries an HTTP status + machine code through to the route. */
function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Resolve the caller's decrypted access token + account row.
 * Throws a 409 when GitHub isn't connected or the stored blob is unusable.
 */
async function resolveUserToken(userId) {
  const account = await accounts.findByUserId(userId);
  if (!account) {
    throw httpError(409, 'github_not_connected', 'GitHub is not connected for this user');
  }
  const tokens = oauth.openTokens(account.encryptedTokens);
  if (!tokens || !tokens.accessToken) {
    throw httpError(409, 'github_token_invalid', 'Stored GitHub token is invalid — please reconnect GitHub');
  }
  return { account, accessToken: tokens.accessToken };
}

/** Build a per-user authenticated Octokit client. */
async function octokitForUser(userId) {
  const { account, accessToken } = await resolveUserToken(userId);
  const octokit = await connector.createDefaultOctokit({ token: accessToken });
  return { octokit, account };
}

/** Normalise a GitHub repo object into the stable shape the app stores/returns. */
function toRepoDTO(r) {
  return {
    repoId: String(r.id),
    fullName: r.full_name,
    owner: r.owner ? r.owner.login : r.full_name?.split('/')[0] || null,
    name: r.name,
    private: Boolean(r.private),
    defaultBranch: r.default_branch || 'main',
    cloneUrl: r.clone_url,
    htmlUrl: r.html_url || null,
    description: r.description || null,
    language: r.language || null,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    openIssues: r.open_issues_count ?? 0,
    archived: Boolean(r.archived),
    fork: Boolean(r.fork),
    updatedAt: r.updated_at || null,
    pushedAt: r.pushed_at || null,
  };
}

function clampPerPage(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(100, Math.max(1, n));
}

function clampPage(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/** List repositories the authenticated user can access (owner + collaborator + org). */
async function listRepositories(userId, { page, perPage, sort = 'updated' } = {}) {
  const { octokit } = await octokitForUser(userId);
  const res = await octokit.rest.repos.listForAuthenticatedUser({
    per_page: clampPerPage(perPage),
    page: clampPage(page),
    sort: ['created', 'updated', 'pushed', 'full_name'].includes(sort) ? sort : 'updated',
    affiliation: 'owner,collaborator,organization_member',
    visibility: 'all',
  });
  return res.data.map(toRepoDTO);
}

/** Search repositories via GitHub's search API (scoped by the user's token). */
async function searchRepositories(userId, query, { page, perPage, sort, order = 'desc' } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    throw httpError(400, 'missing_query', 'A non-empty search query is required');
  }
  const { octokit } = await octokitForUser(userId);
  const res = await octokit.rest.search.repos({
    q,
    per_page: clampPerPage(perPage),
    page: clampPage(page),
    ...(sort && ['stars', 'forks', 'help-wanted-issues', 'updated'].includes(sort) ? { sort } : {}),
    order: order === 'asc' ? 'asc' : 'desc',
  });
  return {
    total: res.data.total_count,
    incompleteResults: Boolean(res.data.incomplete_results),
    items: res.data.items.map(toRepoDTO),
  };
}

/** Fetch full details for a single repository (also validates the user's access). */
async function getRepository(userId, owner, repo) {
  const { octokit } = await octokitForUser(userId);
  const res = await octokit.rest.repos.get({ owner, repo });
  return toRepoDTO(res.data);
}

/**
 * Create a brand-new repository under the authenticated user (Phase F —
 * "Create Remote"). `autoInit` seeds an initial commit so it can be cloned
 * immediately into a workspace.
 */
async function createRepository(userId, { name, description, private: isPrivate = true, autoInit = true } = {}) {
  const repoName = String(name || '').trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName) || repoName.includes('..')) {
    const e = new Error('Invalid repository name');
    e.status = 400;
    e.code = 'invalid_name';
    throw e;
  }
  const { octokit } = await octokitForUser(userId);
  const res = await octokit.rest.repos.createForAuthenticatedUser({
    name: repoName,
    description: description ? String(description).slice(0, 350) : undefined,
    private: Boolean(isPrivate),
    auto_init: Boolean(autoInit),
  });
  return toRepoDTO(res.data);
}

/**
 * Map an Octokit/own error into a { status, body } response envelope so the
 * route layer stays terse and never leaks raw errors or tokens.
 */
function normalizeError(err) {
  if (err && err.code && err.status) {
    return { status: err.status, body: { error: err.message, code: err.code } };
  }
  const status = (err && err.status) || 500;
  switch (status) {
    case 401:
      return { status: 401, body: { error: 'GitHub token rejected — please reconnect GitHub', code: 'github_unauthorized' } };
    case 403:
      return { status: 403, body: { error: 'GitHub access forbidden or rate limit exceeded', code: 'github_forbidden' } };
    case 404:
      return { status: 404, body: { error: 'Repository not found or not accessible', code: 'github_not_found' } };
    case 422:
      return { status: 422, body: { error: 'Invalid GitHub request (check the search query / parameters)', code: 'github_unprocessable' } };
    default:
      return { status: status >= 400 ? status : 500, body: { error: (err && err.message) || 'GitHub request failed', code: 'github_error' } };
  }
}

module.exports = {
  resolveUserToken,
  octokitForUser,
  listRepositories,
  searchRepositories,
  getRepository,
  createRepository,
  toRepoDTO,
  normalizeError,
};
