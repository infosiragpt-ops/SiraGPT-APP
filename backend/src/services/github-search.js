'use strict';

/**
 * github-search.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified search over the public GitHub REST API (api.github.com). Covers the
 * four search corpora — repositories, code, issues/PRs and users/orgs — plus
 * topic discovery and README retrieval, so the agent can mine open-source
 * projects from anywhere in the world for code, libraries and prior art.
 *
 * Design mirrors scientific-search.js exactly so the two discovery subsystems
 * behave identically:
 *   - Zero external deps beyond stdlib + global fetch (Node 18+).
 *   - Every upstream call is timeout-bounded (default 8s) and returns [] on
 *     failure, with the error captured separately so the caller can surface
 *     partial results.
 *   - Polite, descriptive User-Agent. GitHub *requires* a User-Agent header and
 *     rejects anonymous-looking traffic.
 *   - Optional token (SIRAGPT_GITHUB_TOKEN || GITHUB_TOKEN) lifts the rate limit
 *     from 10 → 30 search req/min and unlocks the code-search corpus (which is
 *     token-only). Everything degrades gracefully without one.
 *   - Results are normalised into canonical shapes and ranked deterministically.
 *
 * Canonical shapes:
 *   repository → {
 *     type:'repository', id, fullName, name, owner, description, url, htmlUrl,
 *     homepage, stars, forks, watchers, openIssues, language, topics[], license,
 *     createdAt, updatedAt, pushedAt, archived, isFork, defaultBranch, sizeKb,
 *   }
 *   code → { type:'code', name, path, repository, htmlUrl, url, sha }
 *   issue → {
 *     type:'issue'|'pull_request', number, title, state, htmlUrl, repository,
 *     user, comments, createdAt, updatedAt, labels[], bodyPreview,
 *   }
 *   user → { type:'user'|'organization', login, id, htmlUrl, avatarUrl, score }
 *   topic → { type:'topic', name, displayName, description, shortDescription, featured, curated }
 *
 * Public API:
 *   search(query, opts)            — dispatch by opts.type (default 'repositories')
 *   searchAll(query, opts)         — fan out to repositories + code + issues + users
 *   searchRepositories(query, opts)
 *   searchCode(query, opts)
 *   searchIssues(query, opts)
 *   searchUsers(query, opts)
 *   searchTopics(query, opts)
 *   getRepo(owner, repo, opts)
 *   getReadme(owner, repo, opts)
 *   rateLimit(opts)                — current REST rate-limit snapshot
 *   TYPES, PROVIDERS, _internal
 */

const githubCache = require('./github-search-cache');
const { withRetry } = require('../utils/retry-with-backoff');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT_PREFIX = 'SiraGPT-GitHubSearch/1.0';

const TYPES = ['repositories', 'code', 'issues', 'users', 'topics'];
// Alias used by the /providers-style health endpoint for symmetry with
// scientific-search.PROVIDERS.
const PROVIDERS = TYPES.slice();

const VALID_REPO_SORTS = new Set(['stars', 'forks', 'help-wanted-issues', 'updated', 'best-match']);
const VALID_CODE_SORTS = new Set(['indexed', 'best-match']);
const VALID_ISSUE_SORTS = new Set(['comments', 'reactions', 'created', 'updated', 'best-match']);
const VALID_USER_SORTS = new Set(['followers', 'repositories', 'joined', 'best-match']);

function githubToken() {
  return process.env.SIRAGPT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
}

function hasToken() {
  return !!githubToken();
}

function userAgent() {
  const contact = process.env.SIRAGPT_RESEARCH_EMAIL || '';
  return contact ? `${USER_AGENT_PREFIX} (mailto:${contact})` : USER_AGENT_PREFIX;
}

function baseHeaders(extra = {}) {
  const token = githubToken();
  return {
    'User-Agent': userAgent(),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label || 'request'} timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

class GitHubHttpError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.name = 'GitHubHttpError';
    this.status = status;
    this.retryAfter = retryAfter || null;
  }
}

async function ghJsonOnce(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: baseHeaders(opts.headers),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  // GitHub signals primary/secondary rate limiting with 403/429 + headers.
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    const retryAfter = res.headers?.get?.('retry-after');
    const reason = remaining === '0' ? 'rate limit exhausted' : 'forbidden / secondary rate limit';
    throw new GitHubHttpError(res.status, `GitHub ${res.status}: ${reason}`, retryAfter);
  }
  if (!res.ok) {
    throw new GitHubHttpError(res.status, `GitHub HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

// Retry policy: GitHub's API has transient failure modes (502/503 during
// deploys, 429 secondary rate limits, occasional network blips) that resolve on
// a second try. We retry ONLY those, never client errors (4xx incl. 403 quota
// exhaustion, which a retry would only make worse). Tunable / disable-able via
// env so operators can dial it back without a deploy.
function classifyGitHubError(err) {
  const status = err && Number(err.status);
  if (status === 429 || (Number.isFinite(status) && status >= 500)) {
    return { retryable: true, reason: `http_${status}` };
  }
  if (Number.isFinite(status) && status >= 400) {
    return { retryable: false, reason: `http_${status}` };
  }
  const msg = String((err && err.message) || '').toLowerCase();
  if (/timed out|timeout/.test(msg)) return { retryable: true, reason: 'timeout' };
  if (/network|enotfound|econnreset|econnrefused|eai_again|fetch failed|getaddrinfo/.test(msg)) {
    return { retryable: true, reason: 'network' };
  }
  return { retryable: false, reason: 'unknown' };
}

function retryConfig(opts = {}) {
  const disabled = String(process.env.GITHUB_SEARCH_RETRY_DISABLED || '').toLowerCase();
  if (disabled === '1' || disabled === 'true' || disabled === 'yes') return { maxRetries: 0 };
  const o = opts.retry || {};
  const envRetries = Number.parseInt(process.env.GITHUB_SEARCH_MAX_RETRIES, 10);
  const envBase = Number.parseInt(process.env.GITHUB_SEARCH_RETRY_BASE_MS, 10);
  const maxRetries = Number.isFinite(Number(o.maxRetries)) ? Number(o.maxRetries)
    : (Number.isFinite(envRetries) && envRetries >= 0 ? envRetries : 1);
  const baseDelayMs = Number.isFinite(Number(o.baseDelayMs)) ? Number(o.baseDelayMs)
    : (Number.isFinite(envBase) && envBase > 0 ? envBase : 250);
  return { maxRetries: Math.max(0, Math.min(maxRetries, 4)), baseDelayMs };
}

function ghJson(path, opts = {}) {
  const cfg = retryConfig(opts);
  if (!cfg.maxRetries) return ghJsonOnce(path, opts);
  return withRetry(() => ghJsonOnce(path, opts), {
    maxRetries: cfg.maxRetries,
    baseDelayMs: cfg.baseDelayMs,
    maxDelayMs: 2000,
    classifyError: classifyGitHubError,
    ...(typeof opts.sleep === 'function' ? { sleep: opts.sleep } : {}),
  });
}

function clampLimit(n) {
  const parsed = Number.parseInt(n, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, parsed);
}

function pickSort(value, valid) {
  const v = String(value || '').trim();
  return valid.has(v) && v !== 'best-match' ? v : null;
}

function pickOrder(value) {
  return String(value || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
}

// ── Repositories ────────────────────────────────────────────────────────
// https://api.github.com/search/repositories — no token required (10 req/min).
function buildRepoQuery(query, opts = {}) {
  let q = String(query || '').trim();
  if (opts.language) q += ` language:${String(opts.language).trim()}`;
  if (opts.minStars != null && Number.isFinite(Number(opts.minStars))) {
    q += ` stars:>=${Number(opts.minStars)}`;
  }
  if (opts.topic) q += ` topic:${String(opts.topic).trim()}`;
  return q.trim();
}

function normaliseRepo(r) {
  return {
    type: 'repository',
    id: r.id,
    fullName: r.full_name || null,
    name: r.name || null,
    owner: r.owner?.login || null,
    description: r.description || null,
    url: r.html_url || null,
    htmlUrl: r.html_url || null,
    homepage: r.homepage || null,
    stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : null,
    forks: typeof r.forks_count === 'number' ? r.forks_count : null,
    watchers: typeof r.watchers_count === 'number' ? r.watchers_count : null,
    openIssues: typeof r.open_issues_count === 'number' ? r.open_issues_count : null,
    language: r.language || null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    license: r.license?.spdx_id || r.license?.key || null,
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
    pushedAt: r.pushed_at || null,
    archived: !!r.archived,
    isFork: !!r.fork,
    defaultBranch: r.default_branch || null,
    sizeKb: typeof r.size === 'number' ? r.size : null,
  };
}

async function searchRepositories(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({
    q: buildRepoQuery(query, opts),
    per_page: String(limit),
    order: pickOrder(opts.order),
  });
  const sort = pickSort(opts.sort, VALID_REPO_SORTS);
  if (sort) params.set('sort', sort);
  if (opts.topic) {
    // topic search needs the mercy preview media type for `topics` to be populated
    opts._extraHeaders = { Accept: 'application/vnd.github.mercy-preview+json' };
  }
  const json = await withTimeout(
    ghJson(`/search/repositories?${params.toString()}`, {
      signal: opts.signal,
      headers: opts._extraHeaders,
    }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    'github:repositories',
  );
  const items = Array.isArray(json?.items) ? json.items : [];
  // Skip malformed entries (null / primitive) instead of letting normaliseRepo
  // throw on the whole batch — one bad item must not nuke an otherwise-valid
  // result set.
  return items.filter((r) => r && typeof r === 'object').map(normaliseRepo);
}

// ── Code ────────────────────────────────────────────────────────────────
// https://api.github.com/search/code — REQUIRES authentication.
async function searchCode(query, opts = {}) {
  if (!hasToken()) {
    throw new GitHubHttpError(401, 'GitHub code search requires a token (set GITHUB_TOKEN)');
  }
  const limit = clampLimit(opts.limit);
  let q = String(query || '').trim();
  if (opts.language) q += ` language:${String(opts.language).trim()}`;
  if (opts.repo) q += ` repo:${String(opts.repo).trim()}`;
  if (opts.filename) q += ` filename:${String(opts.filename).trim()}`;
  const params = new URLSearchParams({ q: q.trim(), per_page: String(limit) });
  const json = await withTimeout(
    ghJson(`/search/code?${params.toString()}`, {
      signal: opts.signal,
      headers: { Accept: 'application/vnd.github.text-match+json' },
    }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    'github:code',
  );
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.filter((c) => c && typeof c === 'object').map((c) => ({
    type: 'code',
    name: c.name || null,
    path: c.path || null,
    repository: c.repository?.full_name || null,
    htmlUrl: c.html_url || null,
    url: c.html_url || null,
    sha: c.sha || null,
  }));
}

// ── Issues + PRs ────────────────────────────────────────────────────────
// https://api.github.com/search/issues — no token required.
async function searchIssues(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  let q = String(query || '').trim();
  if (opts.repo) q += ` repo:${String(opts.repo).trim()}`;
  if (opts.state === 'open' || opts.state === 'closed') q += ` state:${opts.state}`;
  if (opts.kind === 'pr') q += ' is:pr';
  else if (opts.kind === 'issue') q += ' is:issue';
  const params = new URLSearchParams({
    q: q.trim(),
    per_page: String(limit),
    order: pickOrder(opts.order),
  });
  const sort = pickSort(opts.sort, VALID_ISSUE_SORTS);
  if (sort) params.set('sort', sort);
  const json = await withTimeout(
    ghJson(`/search/issues?${params.toString()}`, { signal: opts.signal }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    'github:issues',
  );
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.filter((i) => i && typeof i === 'object').map((i) => ({
    type: i.pull_request ? 'pull_request' : 'issue',
    number: i.number,
    title: i.title || '',
    state: i.state || null,
    htmlUrl: i.html_url || null,
    repository: extractRepoFromIssueUrl(i.repository_url),
    user: i.user?.login || null,
    comments: typeof i.comments === 'number' ? i.comments : null,
    createdAt: i.created_at || null,
    updatedAt: i.updated_at || null,
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    bodyPreview: i.body ? String(i.body).replace(/\s+/g, ' ').trim().slice(0, 400) : null,
  }));
}

function extractRepoFromIssueUrl(url) {
  if (!url) return null;
  const m = String(url).match(/repos\/([^/]+\/[^/]+)$/);
  return m ? m[1] : null;
}

// ── Users + Orgs ────────────────────────────────────────────────────────
// https://api.github.com/search/users — no token required.
async function searchUsers(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({
    q: String(query || '').trim(),
    per_page: String(limit),
    order: pickOrder(opts.order),
  });
  const sort = pickSort(opts.sort, VALID_USER_SORTS);
  if (sort) params.set('sort', sort);
  const json = await withTimeout(
    ghJson(`/search/users?${params.toString()}`, { signal: opts.signal }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    'github:users',
  );
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.filter((u) => u && typeof u === 'object').map((u) => ({
    type: u.type === 'Organization' ? 'organization' : 'user',
    login: u.login || null,
    id: u.id,
    htmlUrl: u.html_url || null,
    avatarUrl: u.avatar_url || null,
    score: typeof u.score === 'number' ? u.score : null,
  }));
}

// ── Topics ──────────────────────────────────────────────────────────────
// https://api.github.com/search/topics — needs the mercy preview media type.
async function searchTopics(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({ q: String(query || '').trim(), per_page: String(limit) });
  const json = await withTimeout(
    ghJson(`/search/topics?${params.toString()}`, {
      signal: opts.signal,
      headers: { Accept: 'application/vnd.github.mercy-preview+json' },
    }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    'github:topics',
  );
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.filter((t) => t && typeof t === 'object').map((t) => ({
    type: 'topic',
    name: t.name || null,
    displayName: t.display_name || t.name || null,
    description: t.description || null,
    shortDescription: t.short_description || null,
    featured: !!t.featured,
    curated: !!t.curated,
  }));
}

// ── Single-repo helpers ─────────────────────────────────────────────────
async function getRepo(owner, repo, opts = {}) {
  if (!owner || !repo) throw new Error('getRepo requires owner and repo');
  const json = await withTimeout(
    ghJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { signal: opts.signal }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    'github:repo',
  );
  return normaliseRepo(json);
}

async function getReadme(owner, repo, opts = {}) {
  if (!owner || !repo) throw new Error('getReadme requires owner and repo');
  const json = await withTimeout(
    ghJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`, { signal: opts.signal }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    'github:readme',
  );
  let content = null;
  if (json && json.content && json.encoding === 'base64') {
    try {
      content = Buffer.from(json.content, 'base64').toString('utf8');
    } catch (_) {
      content = null;
    }
  }
  const maxChars = Math.max(500, Math.min(Number(opts.maxChars) || 12000, 50000));
  return {
    repository: `${owner}/${repo}`,
    path: json?.path || 'README.md',
    htmlUrl: json?.html_url || null,
    content: content ? content.slice(0, maxChars) : null,
    truncated: !!(content && content.length > maxChars),
  };
}

async function rateLimit(opts = {}) {
  const json = await withTimeout(
    ghJson('/rate_limit', { signal: opts.signal }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    'github:rate_limit',
  );
  const search = json?.resources?.search || null;
  return {
    authenticated: hasToken(),
    search,
    core: json?.resources?.core || null,
  };
}

// ── Ranking ─────────────────────────────────────────────────────────────
// Repositories ranked by relevance proxies: stars desc → recent push desc.
// (GitHub already best-match orders, but when the caller pins sort=stars we
//  re-rank for determinism; for mixed result sets stars is the stable key.)
function rankRepos(repos) {
  // Resilience: a malformed upstream payload (or a buggy mapper) can hand us a
  // non-array, or an array with null/primitive entries. Ranking runs OUTSIDE
  // the per-corpus try/catch in searchAll(), so a throw here would reject the
  // whole fan-out and lose every other category's results. Coerce to an array
  // of plain objects first, and read fields defensively so .sort() can never
  // dereference a null/undefined entry.
  const safe = (Array.isArray(repos) ? repos : []).filter(
    (r) => r && typeof r === 'object',
  );
  return safe.sort((a, b) => {
    const sa = typeof a.stars === 'number' ? a.stars : 0;
    const sb = typeof b.stars === 'number' ? b.stars : 0;
    if (sa !== sb) return sb - sa;
    const pa = a.pushedAt ? Date.parse(a.pushedAt) || 0 : 0;
    const pb = b.pushedAt ? Date.parse(b.pushedAt) || 0 : 0;
    return pb - pa;
  });
}

const TYPE_FUNCS = {
  repositories: searchRepositories,
  code: searchCode,
  issues: searchIssues,
  users: searchUsers,
  topics: searchTopics,
};

/**
 * Dispatch a single-corpus search by opts.type (default 'repositories').
 * Returns { items, type, count, errors, _cache? }.
 */
async function search(query, opts = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    return { items: [], type: opts.type || 'repositories', count: 0, errors: [{ source: 'input', message: 'query is empty' }] };
  }
  const type = TYPE_FUNCS[opts.type] ? opts.type : 'repositories';
  const cached = githubCache.get(query, { ...opts, type });
  if (cached) return cached;

  const errors = [];
  let items = [];
  try {
    items = await TYPE_FUNCS[type](query, opts);
    if (type === 'repositories') items = rankRepos(items);
  } catch (err) {
    errors.push({ source: `github:${type}`, message: err.message, status: err.status || null });
  }
  const result = { items, type, count: items.length, errors, authenticated: hasToken() };
  if (!errors.length) githubCache.set(query, { ...opts, type }, result);
  return result;
}

/**
 * Fan out to multiple corpora in parallel (default: repositories + code +
 * issues + users), merge into one payload. Code search is silently skipped
 * when no token is configured (it is token-only).
 */
async function searchAll(query, opts = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    return { repositories: [], code: [], issues: [], users: [], errors: [{ source: 'input', message: 'query is empty' }] };
  }
  let corpora = Array.isArray(opts.types) && opts.types.length
    ? opts.types.filter((t) => TYPE_FUNCS[t] && t !== 'topics')
    : ['repositories', 'code', 'issues', 'users'];
  // Drop code search when unauthenticated rather than emitting a guaranteed error.
  if (!hasToken()) corpora = corpora.filter((t) => t !== 'code');

  const settled = await Promise.allSettled(corpora.map((t) => TYPE_FUNCS[t](query, opts)));
  const out = { repositories: [], code: [], issues: [], users: [], topics: [], errors: [], authenticated: hasToken() };
  settled.forEach((r, idx) => {
    const t = corpora[idx];
    if (r.status === 'fulfilled') {
      // r.value should be an array of normalised entries, but guard against a
      // malformed mapper returning a non-array. rankRepos already coerces; for
      // the other corpora coerce here so the payload shape stays consistent.
      const value = Array.isArray(r.value) ? r.value : [];
      out[t] = t === 'repositories' ? rankRepos(value) : value;
    } else {
      out.errors.push({ source: `github:${t}`, message: r.reason?.message || String(r.reason), status: r.reason?.status || null });
    }
  });
  return out;
}

module.exports = {
  search,
  searchAll,
  searchRepositories,
  searchCode,
  searchIssues,
  searchUsers,
  searchTopics,
  getRepo,
  getReadme,
  rateLimit,
  hasToken,
  TYPES,
  PROVIDERS,
  GitHubHttpError,
  _internal: {
    normaliseRepo,
    rankRepos,
    buildRepoQuery,
    extractRepoFromIssueUrl,
    clampLimit,
    pickSort,
    pickOrder,
    userAgent,
    baseHeaders,
    classifyGitHubError,
    retryConfig,
    VALID_REPO_SORTS,
    VALID_ISSUE_SORTS,
    VALID_USER_SORTS,
    VALID_CODE_SORTS,
  },
};
