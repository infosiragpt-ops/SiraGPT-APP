'use strict';

/**
 * GitHub integration routes — Step 2: OAuth connect / callback / disconnect
 * / status. Repository listing, clone, and git operations land in later
 * steps and mount under this same `/api/github` base.
 *
 *   GET  /api/github/status     (auth)   → { connected, login, scopes, ... }
 *   GET  /api/github/connect    (auth)   → { url }  (state = signed JWT); ?redirect=1 → 302
 *   GET  /api/github/callback   (public) → exchanges code, stores account, 302 → frontend
 *   POST /api/github/disconnect (auth)   → removes the account (cascades repos/workspaces)
 *
 * The callback is intentionally unauthenticated: GitHub redirects the browser
 * here and the user's session cookie is not guaranteed to ride along. Identity
 * is recovered from the signed `state` token minted at /connect time, which is
 * also our CSRF defence for the flow.
 */

const express = require('express');
const archiver = require('archiver');
const { Readable } = require('stream');
const { authenticateToken } = require('../middleware/auth');
const githubConfig = require('../config/github');
const oauth = require('../services/github/github-oauth.service');
const accounts = require('../repositories/GithubAccountRepository');
const githubApi = require('../services/github/github-api.service');
const connectedRepos = require('../repositories/ConnectedRepositoryRepository');
const workspaces = require('../repositories/WorkspaceRepository');
const workspaceManager = require('../services/github/workspace-manager');
const gitService = require('../services/github/git.service');
const workspaceFiles = require('../services/github/workspace-files.service');
const workspaceRunner = require('../services/github/workspace-runner.service');
const { buildUpstreamRequestHeaders, isForwardableResponseHeader } = require('../utils/proxy-headers');

const router = express.Router();

// owner / repo path-segment validator — blocks traversal + injection in params.
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
function validName(value) {
  const v = String(value || '');
  return NAME_RE.test(v) && !v.includes('..');
}

/**
 * Resolve a connected repo + its cloned workspace for the caller, or throw a
 * status-carrying error. Used by every Step 5 git operation so the
 * ownership + "is it cloned?" checks live in one place.
 */
async function loadClonedWorkspace(req) {
  const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
  if (!connection) {
    const e = new Error('Connected repository not found');
    e.status = 404;
    e.code = 'not_found';
    throw e;
  }
  const workspace = await workspaces.findByRepositoryId(connection.id);
  if (!workspace || !workspaceManager.isGitRepo(workspace.localPath)) {
    const e = new Error('Repository is not cloned yet — clone it first');
    e.status = 409;
    e.code = 'not_cloned';
    throw e;
  }
  // Keep build artifacts (node_modules/, dist/, …) out of every git view.
  workspaceManager.ensureLocalExcludes(workspace.localPath);
  return { connection, workspace, localPath: workspace.localPath };
}

/** Best-effort: keep the Workspace row's branch/sync columns fresh. */
async function touchWorkspace(repositoryId, userId, localPath, patch) {
  try {
    await workspaces.upsertForRepo({ repositoryId, userId, localPath, ...patch });
  } catch (err) {
    console.error('[github] workspace touch failed:', err.message);
  }
}

// GET /api/github/status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const account = await accounts.findByUserId(req.user.id);
    if (!account) {
      return res.json({ connected: false, configured: githubConfig.isConfigured() });
    }
    return res.json({
      connected: true,
      configured: githubConfig.isConfigured(),
      login: account.login,
      name: account.name,
      avatarUrl: account.avatarUrl,
      scopes: account.scope ? account.scope.split(/[ ,]+/).filter(Boolean) : [],
      connectedAt: account.connectedAt,
    });
  } catch (err) {
    console.error('[github] status error:', err.message);
    return res.status(500).json({ error: 'Failed to read GitHub connection status' });
  }
});

// GET /api/github/connect → consent URL
router.get('/connect', authenticateToken, async (req, res) => {
  try {
    if (!githubConfig.isConfigured()) {
      return res.status(503).json({ error: 'GitHub OAuth is not configured on the server' });
    }
    const state = oauth.signState(req.user.id);
    const url = oauth.buildAuthorizeUrl(state);
    // Default: return JSON so the SPA controls navigation. ?redirect=1 → 302.
    if (String(req.query.redirect || '') === '1') {
      return res.redirect(url);
    }
    return res.json({ url });
  } catch (err) {
    console.error('[github] connect error:', err.message);
    return res.status(500).json({ error: 'Failed to start GitHub OAuth' });
  }
});

// GET /api/github/callback → finish OAuth, persist, redirect to frontend
router.get('/callback', async (req, res) => {
  const { code, state, error: ghError } = req.query;

  if (ghError) {
    return res.redirect(githubConfig.postCallbackRedirect('denied'));
  }
  if (!code || !state) {
    return res.redirect(githubConfig.postCallbackRedirect('invalid'));
  }

  const userId = oauth.verifyState(state);
  if (!userId) {
    return res.redirect(githubConfig.postCallbackRedirect('expired'));
  }

  try {
    const tokens = await oauth.exchangeCodeForToken(String(code));
    const ghUser = await oauth.fetchGithubUser(tokens.accessToken);
    const githubUserId = String(ghUser.id);

    // A GitHub identity may only be linked to one siraGPT account.
    const existing = await accounts.findByGithubUserId(githubUserId);
    if (existing && existing.userId !== userId) {
      return res.redirect(githubConfig.postCallbackRedirect('already_linked'));
    }

    await accounts.upsertForUser(userId, {
      githubUserId,
      login: ghUser.login,
      name: ghUser.name || null,
      avatarUrl: ghUser.avatar_url || null,
      scope: tokens.scope,
      tokenType: tokens.tokenType,
      encryptedTokens: oauth.sealTokens(tokens),
    });

    return res.redirect(githubConfig.postCallbackRedirect('connected'));
  } catch (err) {
    console.error('[github] callback error:', err.message);
    return res.redirect(githubConfig.postCallbackRedirect('error'));
  }
});

// ──────────────────────────────────────────────────────────────
// Step 3 — Repository management
// ──────────────────────────────────────────────────────────────

// GET /api/github/repos → repos the authenticated user can access
router.get('/repos', authenticateToken, async (req, res) => {
  try {
    const repos = await githubApi.listRepositories(req.user.id, {
      page: req.query.page,
      perPage: req.query.per_page,
      sort: req.query.sort,
    });
    return res.json({ repos, page: Number(req.query.page) || 1, count: repos.length });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// GET /api/github/repos/search?q=... → search repositories
router.get('/repos/search', authenticateToken, async (req, res) => {
  try {
    const result = await githubApi.searchRepositories(req.user.id, req.query.q, {
      page: req.query.page,
      perPage: req.query.per_page,
      sort: req.query.sort,
      order: req.query.order,
    });
    return res.json(result);
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// GET /api/github/repos/:owner/:repo → single repository details
router.get('/repos/:owner/:repo', authenticateToken, async (req, res) => {
  const { owner, repo } = req.params;
  if (!validName(owner) || !validName(repo)) {
    return res.status(400).json({ error: 'Invalid owner or repo name', code: 'invalid_name' });
  }
  try {
    const details = await githubApi.getRepository(req.user.id, owner, repo);
    return res.json({ repo: details });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/repos/connect { owner, repo } → validate access + persist
router.post('/repos/connect', authenticateToken, async (req, res) => {
  const { owner, repo } = req.body || {};
  if (!validName(owner) || !validName(repo)) {
    return res.status(400).json({ error: 'owner and repo are required and must be valid names', code: 'invalid_name' });
  }
  try {
    // resolveUserToken doubles as the "is GitHub connected?" gate + gives us
    // the account id to attach the connection to.
    const { account } = await githubApi.octokitForUser(req.user.id);
    // getRepository validates the user actually has access (404/403 otherwise).
    const details = await githubApi.getRepository(req.user.id, owner, repo);
    const connection = await connectedRepos.upsertForUser(req.user.id, account.id, details);
    return res.status(201).json({ ok: true, connection });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/repos/create { name, description?, private? } → create a
// brand-new GitHub repo, persist the connection, ready to clone (Phase F).
router.post('/repos/create', authenticateToken, async (req, res) => {
  try {
    const { account } = await githubApi.octokitForUser(req.user.id);
    const details = await githubApi.createRepository(req.user.id, {
      name: req.body && req.body.name,
      description: req.body && req.body.description,
      private: req.body && req.body.private !== false,
    });
    const connection = await connectedRepos.upsertForUser(req.user.id, account.id, details);
    return res.status(201).json({ ok: true, connection, repo: details });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// GET /api/github/connected → list the user's connected repos
router.get('/connected', authenticateToken, async (req, res) => {
  try {
    const connections = await connectedRepos.listForUser(req.user.id);
    return res.json({ connections, count: connections.length });
  } catch (err) {
    console.error('[github] list connected error:', err.message);
    return res.status(500).json({ error: 'Failed to list connected repositories' });
  }
});

// DELETE /api/github/connected/:id → remove a connection (cascades workspace)
router.delete('/connected/:id', authenticateToken, async (req, res) => {
  try {
    const result = await connectedRepos.deleteForUser(req.params.id, req.user.id);
    if (result.count === 0) {
      return res.status(404).json({ error: 'Connection not found', code: 'not_found' });
    }
    return res.json({ ok: true, removed: result.count });
  } catch (err) {
    console.error('[github] delete connected error:', err.message);
    return res.status(500).json({ error: 'Failed to remove connected repository' });
  }
});

// ──────────────────────────────────────────────────────────────
// Step 4 — Clone repository into a per-user host workspace
// ──────────────────────────────────────────────────────────────

// POST /api/github/connected/:id/clone { branch? } → clone (or reuse) checkout
router.post('/connected/:id/clone', authenticateToken, async (req, res) => {
  try {
    const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'Connected repository not found', code: 'not_found' });
    }

    // Validates GitHub is connected + decrypts the user's token (private repos).
    const { accessToken } = await githubApi.resolveUserToken(req.user.id);

    const branch = req.body && req.body.branch ? String(req.body.branch) : connection.defaultBranch;
    const localPath = workspaceManager.workspacePathFor(req.user.id, connection.owner, connection.name);

    await workspaces.upsertForRepo({
      repositoryId: connection.id,
      userId: req.user.id,
      localPath,
      status: 'cloning',
      lastError: null,
    });

    try {
      const result = await gitService.cloneRepository({
        localPath,
        cloneUrl: connection.cloneUrl,
        token: accessToken, // injected only into the transient clone URL
        branch,
      });

      const workspace = await workspaces.upsertForRepo({
        repositoryId: connection.id,
        userId: req.user.id,
        localPath,
        status: 'ready',
        currentBranch: result.branch || branch || connection.defaultBranch,
        lastError: null,
        lastSyncAt: new Date(),
      });

      return res.status(result.alreadyCloned ? 200 : 201).json({
        ok: true,
        alreadyCloned: result.alreadyCloned,
        workspace,
      });
    } catch (cloneErr) {
      await workspaces.upsertForRepo({
        repositoryId: connection.id,
        userId: req.user.id,
        localPath,
        status: 'error',
        lastError: String(cloneErr.message || cloneErr).slice(0, 500),
      });
      const n = githubApi.normalizeError(cloneErr);
      return res.status(n.status).json(n.body);
    }
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// GET /api/github/connected/:id/workspace → workspace state for a connection
router.get('/connected/:id/workspace', authenticateToken, async (req, res) => {
  try {
    const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'Connected repository not found', code: 'not_found' });
    }
    const workspace = await workspaces.findByRepositoryId(connection.id);
    return res.json({ workspace: workspace || null });
  } catch (err) {
    console.error('[github] workspace status error:', err.message);
    return res.status(500).json({ error: 'Failed to read workspace status' });
  }
});

// DELETE /api/github/connected/:id/workspace → remove checkout from disk + db
router.delete('/connected/:id/workspace', authenticateToken, async (req, res) => {
  try {
    const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'Connected repository not found', code: 'not_found' });
    }
    const workspace = await workspaces.findByRepositoryId(connection.id);
    if (!workspace) {
      return res.status(404).json({ error: 'No workspace to remove', code: 'no_workspace' });
    }
    try {
      workspaceManager.removeWorkspace(workspace.localPath);
    } catch (rmErr) {
      console.error('[github] workspace remove error:', rmErr.message);
      return res.status(rmErr.status || 500).json({ error: rmErr.message, code: rmErr.code || 'remove_failed' });
    }
    await workspaces.deleteByRepositoryId(connection.id);
    return res.json({ ok: true, removed: true });
  } catch (err) {
    console.error('[github] workspace delete error:', err.message);
    return res.status(500).json({ error: 'Failed to remove workspace' });
  }
});

// ──────────────────────────────────────────────────────────────
// Step 4b — Workspace file CRUD (editor reads/writes the REAL clone)
// ──────────────────────────────────────────────────────────────

// GET /api/github/connected/:id/files → nested file tree (skips .git/node_modules)
router.get('/connected/:id/files', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const result = await workspaceFiles.listTree(localPath);
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'tree_failed' });
  }
});

// GET /api/github/connected/:id/files/contents → all text files (for editor hydrate)
router.get('/connected/:id/files/contents', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const result = await workspaceFiles.readAllText(localPath);
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'contents_failed' });
  }
});

// GET /api/github/connected/:id/file?path=... → single file content
router.get('/connected/:id/file', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const file = await workspaceFiles.readFile(localPath, req.query.path);
    return res.json(file);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'read_failed' });
  }
});

// PUT /api/github/connected/:id/file { path, content } → write / create file
router.put('/connected/:id/file', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const { path: relPath, content } = req.body || {};
    const result = await workspaceFiles.writeFile(localPath, relPath, content);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'write_failed' });
  }
});

// POST /api/github/connected/:id/folder { path } → create a directory
router.post('/connected/:id/folder', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const result = await workspaceFiles.createFolder(localPath, req.body && req.body.path);
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'folder_failed' });
  }
});

// POST /api/github/connected/:id/rename { from, to } → rename / move
router.post('/connected/:id/rename', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const { from, to } = req.body || {};
    const result = await workspaceFiles.rename(localPath, from, to);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'rename_failed' });
  }
});

// DELETE /api/github/connected/:id/file?path=... → delete file or directory
router.delete('/connected/:id/file', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const result = await workspaceFiles.deleteEntry(localPath, req.query.path);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'delete_failed' });
  }
});

// GET /api/github/connected/:id/download → stream the workspace as a .zip
// (excludes .git / node_modules / build output) so the user can pull all the
// code down to their local machine in one click.
router.get('/connected/:id/download', authenticateToken, async (req, res) => {
  try {
    const { connection, localPath } = await loadClonedWorkspace(req);
    const safeName = String(connection.name || 'workspace').replace(/[^A-Za-z0-9._-]/g, '-');
    res.attachment(`${safeName}.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('[github] download archive error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to build archive', code: 'zip_failed' });
      else res.destroy(err);
    });
    archive.pipe(res);
    archive.glob('**/*', {
      cwd: localPath,
      dot: true,
      ignore: ['.git/**', 'node_modules/**', '.next/**', 'dist/**', 'build/**', '.turbo/**', 'coverage/**'],
    });
    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) return res.status(err.status || 500).json({ error: err.message, code: err.code || 'download_failed' });
    return res.destroy(err);
  }
});

// ──────────────────────────────────────────────────────────────
// Step 4c — Run / live preview (Replit-style ▶ Run)
// ──────────────────────────────────────────────────────────────

// POST /api/github/connected/:id/run → start the dev server, return preview info
router.post('/connected/:id/run', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const result = await workspaceRunner.start(req.params.id, localPath);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'run_failed' });
  }
});

// POST /api/github/connected/:id/stop → stop the dev server
router.post('/connected/:id/stop', authenticateToken, async (req, res) => {
  try {
    // Ownership check still applies even when stopping.
    await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    const result = workspaceRunner.stop(req.params.id);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'stop_failed' });
  }
});

// GET /api/github/connected/:id/run/status → running / ready / preview url + log tail
router.get('/connected/:id/run/status', authenticateToken, async (req, res) => {
  try {
    const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'Connected repository not found', code: 'not_found' });
    }
    return res.json(workspaceRunner.status(req.params.id));
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'status_failed' });
  }
});

function proxiedPreviewPath(req) {
  const marker = `/api/github/connected/${encodeURIComponent(req.params.id)}/proxy`;
  const raw = req.originalUrl || req.url || '/';
  const idx = raw.indexOf(marker);
  if (idx === -1) return '/';
  const rest = raw.slice(idx + marker.length);
  return rest ? rest : '/';
}

// Same-origin authenticated proxy for workspace dev servers. This keeps the
// browser inside siragpt.com instead of trying to open the backend host's
// localhost port from the user's machine.
router.use('/connected/:id/proxy', authenticateToken, async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) {
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'Connected repository not found', code: 'not_found' });
    }
    const target = workspaceRunner.getProxyTarget(req.params.id);
    if (target.error === 'not_found') return res.status(404).json({ error: 'run_not_found' });
    if (target.error === 'not_ready') {
      return res.status(503).json({ error: 'run_not_ready', status: target.status, message: target.message });
    }

    const suffix = proxiedPreviewPath(req);
    const upstreamUrl = `http://127.0.0.1:${target.port}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
    const headers = buildUpstreamRequestHeaders(req.headers, target.port);

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(Number(process.env.SIRAGPT_WORKSPACE_RUN_PROXY_TIMEOUT_MS) || 30_000),
      });
    } catch (err) {
      return res.status(502).json({ error: 'preview_proxy_failed', message: err.message });
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!isForwardableResponseHeader(key.toLowerCase())) return;
      res.setHeader(key, value);
    });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    return Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'preview_proxy_failed' });
  }
});

// ──────────────────────────────────────────────────────────────
// Step 5 — Git operations + file change tracking (on a cloned repo)
// ──────────────────────────────────────────────────────────────

// GET /api/github/connected/:id/status → git status (branch, ahead/behind, files)
router.get('/connected/:id/status', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    return res.json({ status: await gitService.getStatus(localPath) });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// GET /api/github/connected/:id/changes → new / modified / deleted lists
router.get('/connected/:id/changes', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    return res.json({ changes: await gitService.getChanges(localPath) });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// GET /api/github/connected/:id/diff?file=&staged=1 → patch + summary
router.get('/connected/:id/diff', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const diff = await gitService.getDiff(localPath, {
      file: req.query.file,
      staged: String(req.query.staged || '') === '1',
    });
    return res.json(diff);
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/connected/:id/fetch { branch? }
router.post('/connected/:id/fetch', authenticateToken, async (req, res) => {
  try {
    const { connection, localPath } = await loadClonedWorkspace(req);
    const { accessToken } = await githubApi.resolveUserToken(req.user.id);
    const result = await gitService.fetch(localPath, {
      remoteUrl: connection.cloneUrl,
      token: accessToken,
      branch: req.body && req.body.branch,
    });
    await touchWorkspace(connection.id, req.user.id, localPath, { lastSyncAt: new Date(), status: 'ready' });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/connected/:id/pull { branch? }
router.post('/connected/:id/pull', authenticateToken, async (req, res) => {
  try {
    const { connection, localPath } = await loadClonedWorkspace(req);
    const { accessToken } = await githubApi.resolveUserToken(req.user.id);
    const result = await gitService.pull(localPath, {
      remoteUrl: connection.cloneUrl,
      token: accessToken,
      branch: req.body && req.body.branch,
    });
    await touchWorkspace(connection.id, req.user.id, localPath, { lastSyncAt: new Date(), status: 'ready' });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/connected/:id/sync → Replit-style "Sync Changes":
// fetch → (if behind) pull/merge → (if ahead) push. Uses FRESH server-side
// git state at each step so it never pushes a branch that is behind the remote
// (the "non-fast-forward" rejection).
router.post('/connected/:id/sync', authenticateToken, async (req, res) => {
  try {
    const { connection, localPath } = await loadClonedWorkspace(req);
    const { accessToken } = await githubApi.resolveUserToken(req.user.id);
    const remote = { remoteUrl: connection.cloneUrl, token: accessToken };

    // 1. Refresh remote-tracking refs so ahead/behind are accurate.
    await gitService.fetch(localPath, remote);

    // 2. Pull first if we're behind (integrate remote commits before pushing).
    let status = await gitService.getStatus(localPath);
    let pulled = false;
    if (status.behind > 0) {
      if (!status.clean) {
        return res.status(409).json({
          error: 'Tienes cambios sin confirmar — haz commit antes de sincronizar',
          code: 'dirty_tree',
        });
      }
      try {
        await gitService.pull(localPath, { ...remote, branch: status.current });
        pulled = true;
      } catch (e) {
        if (/conflict|merge|CONFLICT|fix conflicts/i.test(e.message || '')) {
          return res.status(409).json({
            error: 'Conflicto de merge — resuélvelo manualmente (o descarta) antes de volver a sincronizar',
            code: 'merge_conflict',
          });
        }
        throw e;
      }
    }

    // 3. Push if we have local commits ahead.
    status = await gitService.getStatus(localPath);
    let pushed = false;
    if (status.ahead > 0) {
      await gitService.push(localPath, {
        ...remote,
        branch: status.current,
        setUpstream: !status.tracking,
      });
      pushed = true;
    }

    await touchWorkspace(connection.id, req.user.id, localPath, { lastSyncAt: new Date(), status: 'ready' });
    return res.json({ ok: true, pulled, pushed, status: await gitService.getStatus(localPath) });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/connected/:id/add { files: [] }  (".", "-A", "all" = stage all)
router.post('/connected/:id/add', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const result = await gitService.stageFiles(localPath, req.body && req.body.files);
    return res.json({ ok: true, ...result });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/connected/:id/discard { files? }  (".", none = discard all)
router.post('/connected/:id/discard', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const result = await gitService.discardChanges(localPath, req.body && req.body.files);
    return res.json({ ok: true, ...result });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/connected/:id/commit { message }
router.post('/connected/:id/commit', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    // Derive a committer identity from the linked GitHub account so commits
    // never fail on a box without global git config, and are attributed to
    // the right person via GitHub's noreply email.
    const account = await accounts.findByUserId(req.user.id);
    const authorName = (account && (account.name || account.login)) || req.user.name || 'siraGPT user';
    const authorEmail =
      account && account.login
        ? `${account.githubUserId}+${account.login}@users.noreply.github.com`
        : req.user.email;
    const result = await gitService.commit(localPath, {
      message: req.body && req.body.message,
      authorName,
      authorEmail,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/connected/:id/push { branch?, setUpstream? }
router.post('/connected/:id/push', authenticateToken, async (req, res) => {
  try {
    const { connection, localPath } = await loadClonedWorkspace(req);
    const { accessToken } = await githubApi.resolveUserToken(req.user.id);
    const result = await gitService.push(localPath, {
      remoteUrl: connection.cloneUrl,
      token: accessToken,
      branch: req.body && req.body.branch,
      setUpstream: Boolean(req.body && req.body.setUpstream),
    });
    await touchWorkspace(connection.id, req.user.id, localPath, { lastSyncAt: new Date(), status: 'ready' });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// GET /api/github/connected/:id/branches → { current, local[], remote[] }
router.get('/connected/:id/branches', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    return res.json({ branches: await gitService.listBranches(localPath) });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// POST /api/github/connected/:id/branches { name, checkout? } → create branch
router.post('/connected/:id/branches', authenticateToken, async (req, res) => {
  try {
    const { connection, localPath } = await loadClonedWorkspace(req);
    const result = await gitService.createBranch(localPath, req.body && req.body.name, {
      checkout: req.body && req.body.checkout !== false,
    });
    if (result.checkedOut) {
      await touchWorkspace(connection.id, req.user.id, localPath, { currentBranch: result.created });
    }
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// PUT /api/github/connected/:id/branches/switch { name } → switch branch
router.put('/connected/:id/branches/switch', authenticateToken, async (req, res) => {
  try {
    const { connection, localPath } = await loadClonedWorkspace(req);
    const result = await gitService.switchBranch(localPath, req.body && req.body.name);
    await touchWorkspace(connection.id, req.user.id, localPath, { currentBranch: result.current });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// DELETE /api/github/connected/:id/branches/:name?force=1 → delete local branch
router.delete('/connected/:id/branches/:name', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const result = await gitService.deleteBranch(localPath, req.params.name, {
      force: String(req.query.force || '') === '1',
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// GET /api/github/connected/:id/commits?limit=&branch= → commit history
router.get('/connected/:id/commits', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    const commits = await gitService.commitHistory(localPath, {
      limit: req.query.limit,
      branch: req.query.branch,
    });
    return res.json({ commits, count: commits.length });
  } catch (err) {
    const n = githubApi.normalizeError(err);
    return res.status(n.status).json(n.body);
  }
});

// GET /api/github/test → dev-only, framework-free HTML harness so the OAuth
// flow can be exercised end-to-end without building any frontend. Served from
// the backend itself (same-origin → no CORS), gated out of production.
router.get('/test', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GitHub Integration — Test Harness</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; color: #111; }
  h1 { font-size: 20px; }
  input { width: 100%; padding: 8px; font-family: monospace; box-sizing: border-box; }
  button { padding: 8px 14px; margin: 6px 6px 6px 0; cursor: pointer; border: 1px solid #ccc; border-radius: 6px; background: #fafafa; }
  button.primary { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  pre { background: #0d1117; color: #c9d1d9; padding: 14px; border-radius: 8px; overflow: auto; }
  .banner { padding: 10px 14px; border-radius: 8px; margin: 10px 0; }
  .ok { background: #e6ffed; border: 1px solid #34d058; }
  .err { background: #ffeef0; border: 1px solid #d73a49; }
  small { color: #666; }
</style>
</head>
<body>
  <h1>GitHub Integration — Test Harness <small>(dev only)</small></h1>
  <p>1) Apna login JWT yahan paste karein (localStorage mein save ho jayega). 2) <b>Connect</b> dabayein → GitHub consent → wapas yahin aa jayega.</p>
  <input id="tok" placeholder="Bearer JWT (login token)" />
  <div id="state"></div>
  <div>
    <button class="primary" onclick="connect()">Connect GitHub</button>
    <button onclick="status()">Check status</button>
    <button onclick="disconnect()">Disconnect</button>
    <button onclick="saveTok()">Save token</button>
  </div>

  <hr/>
  <h2 style="font-size:16px">Step 3 — Repositories</h2>
  <div>
    <button onclick="listRepos()">List my repos</button>
    <button onclick="listConnected()">List connected</button>
  </div>
  <div style="margin-top:8px">
    <input id="q" placeholder="search query, e.g. language:js stars:>1000" style="width:60%" />
    <button onclick="searchRepos()">Search</button>
  </div>
  <div style="margin-top:8px">
    <input id="owner" placeholder="owner" style="width:28%" />
    <input id="repo" placeholder="repo" style="width:28%" />
    <button onclick="repoDetails()">Details</button>
    <button class="primary" onclick="connectRepo()">Connect this repo</button>
  </div>

  <hr/>
  <h2 style="font-size:16px">Step 4 — Clone / Workspace</h2>
  <div>
    <input id="cid" placeholder="connection id (from List connected)" style="width:50%" />
    <input id="branch" placeholder="branch (optional)" style="width:20%" />
  </div>
  <div style="margin-top:8px">
    <button class="primary" onclick="cloneRepo()">Clone</button>
    <button onclick="wsStatus()">Workspace status</button>
    <button onclick="wsDelete()">Delete workspace</button>
  </div>

  <hr/>
  <h2 style="font-size:16px">Step 5 — Git operations <small>(uses connection id + branch above)</small></h2>
  <div>
    <button onclick="gstatus()">Status</button>
    <button onclick="gchanges()">Changes</button>
    <button onclick="gdiff()">Diff</button>
    <button onclick="gfetch()">Fetch</button>
    <button onclick="gpull()">Pull</button>
    <button onclick="gbranches()">Branches</button>
    <button onclick="gcommits()">History</button>
  </div>
  <div style="margin-top:8px">
    <input id="files" placeholder='stage files (comma sep, or "." for all)' style="width:45%" />
    <button onclick="gadd()">Add</button>
  </div>
  <div style="margin-top:8px">
    <input id="msg" placeholder="commit message" style="width:45%" />
    <button onclick="gcommit()">Commit</button>
    <button class="primary" onclick="gpush()">Push</button>
  </div>
  <div style="margin-top:8px">
    <input id="bname" placeholder="branch name" style="width:30%" />
    <button onclick="gcreate()">Create branch</button>
    <button onclick="gswitch()">Switch</button>
    <button onclick="gdelbranch()">Delete branch</button>
  </div>

  <pre id="out">—</pre>
<script>
  const $ = (id) => document.getElementById(id);
  const tok = () => $('tok').value.trim();
  $('tok').value = localStorage.getItem('siragpt_jwt') || '';
  function saveTok(){ localStorage.setItem('siragpt_jwt', tok()); show('Token saved.'); }
  function show(o){ $('out').textContent = typeof o === 'string' ? o : JSON.stringify(o, null, 2); }
  function hdr(){ return { 'Authorization': 'Bearer ' + tok() }; }

  // Reflect ?github=... returned by the OAuth callback
  const q = new URLSearchParams(location.search).get('github');
  if (q) {
    const ok = q === 'connected';
    $('state').innerHTML = '<div class="banner ' + (ok?'ok':'err') + '">Callback result: <b>' + q + '</b></div>';
    if (ok) setTimeout(status, 200);
  }

  async function connect(){
    saveTok();
    try {
      const r = await fetch('/api/github/connect', { headers: hdr() });
      const j = await r.json();
      if (j.url) { location.href = j.url; } else { show(j); }
    } catch(e){ show('Error: ' + e.message); }
  }
  async function status(){
    try { show(await (await fetch('/api/github/status', { headers: hdr() })).json()); }
    catch(e){ show('Error: ' + e.message); }
  }
  async function disconnect(){
    try { show(await (await fetch('/api/github/disconnect', { method:'POST', headers: hdr() })).json()); }
    catch(e){ show('Error: ' + e.message); }
  }
  async function listRepos(){
    try { show(await (await fetch('/api/github/repos?per_page=10', { headers: hdr() })).json()); }
    catch(e){ show('Error: ' + e.message); }
  }
  async function searchRepos(){
    const q = encodeURIComponent($('q').value.trim());
    try { show(await (await fetch('/api/github/repos/search?per_page=10&q=' + q, { headers: hdr() })).json()); }
    catch(e){ show('Error: ' + e.message); }
  }
  async function repoDetails(){
    const o = encodeURIComponent($('owner').value.trim()), r = encodeURIComponent($('repo').value.trim());
    try { show(await (await fetch('/api/github/repos/' + o + '/' + r, { headers: hdr() })).json()); }
    catch(e){ show('Error: ' + e.message); }
  }
  async function connectRepo(){
    const owner = $('owner').value.trim(), repo = $('repo').value.trim();
    try {
      show(await (await fetch('/api/github/repos/connect', {
        method:'POST', headers: Object.assign({'Content-Type':'application/json'}, hdr()),
        body: JSON.stringify({ owner, repo })
      })).json());
    } catch(e){ show('Error: ' + e.message); }
  }
  async function listConnected(){
    try { show(await (await fetch('/api/github/connected', { headers: hdr() })).json()); }
    catch(e){ show('Error: ' + e.message); }
  }
  function cid(){ return encodeURIComponent($('cid').value.trim()); }
  async function cloneRepo(){
    const branch = $('branch').value.trim();
    try {
      show(await (await fetch('/api/github/connected/' + cid() + '/clone', {
        method:'POST', headers: Object.assign({'Content-Type':'application/json'}, hdr()),
        body: JSON.stringify(branch ? { branch } : {})
      })).json());
    } catch(e){ show('Error: ' + e.message); }
  }
  async function wsStatus(){
    try { show(await (await fetch('/api/github/connected/' + cid() + '/workspace', { headers: hdr() })).json()); }
    catch(e){ show('Error: ' + e.message); }
  }
  async function wsDelete(){
    try { show(await (await fetch('/api/github/connected/' + cid() + '/workspace', { method:'DELETE', headers: hdr() })).json()); }
    catch(e){ show('Error: ' + e.message); }
  }
  const jhdr = () => Object.assign({'Content-Type':'application/json'}, hdr());
  const br = () => $('branch').value.trim();
  async function api(method, path, body){
    try {
      const opt = { method, headers: body ? jhdr() : hdr() };
      if (body) opt.body = JSON.stringify(body);
      show(await (await fetch('/api/github/connected/' + cid() + path, opt)).json());
    } catch(e){ show('Error: ' + e.message); }
  }
  function gstatus(){ api('GET', '/status'); }
  function gchanges(){ api('GET', '/changes'); }
  function gdiff(){ api('GET', '/diff'); }
  function gfetch(){ api('POST', '/fetch', br() ? { branch: br() } : {}); }
  function gpull(){ api('POST', '/pull', br() ? { branch: br() } : {}); }
  function gbranches(){ api('GET', '/branches'); }
  function gcommits(){ api('GET', '/commits?limit=20'); }
  function gadd(){
    const raw = $('files').value.trim();
    const files = raw === '.' ? ['.'] : raw.split(',').map(s=>s.trim()).filter(Boolean);
    api('POST', '/add', { files });
  }
  function gcommit(){ api('POST', '/commit', { message: $('msg').value.trim() }); }
  function gpush(){ api('POST', '/push', Object.assign({ setUpstream: true }, br() ? { branch: br() } : {})); }
  function gcreate(){ api('POST', '/branches', { name: $('bname').value.trim(), checkout: true }); }
  function gswitch(){ api('PUT', '/branches/switch', { name: $('bname').value.trim() }); }
  function gdelbranch(){ api('DELETE', '/branches/' + encodeURIComponent($('bname').value.trim()) + '?force=1'); }
</script>
</body>
</html>`);
});

// POST /api/github/disconnect
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    await accounts.deleteForUser(req.user.id);
    return res.json({ ok: true, disconnected: true });
  } catch (err) {
    console.error('[github] disconnect error:', err.message);
    return res.status(500).json({ error: 'Failed to disconnect GitHub' });
  }
});

module.exports = router;
