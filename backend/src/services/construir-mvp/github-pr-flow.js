'use strict';

/**
 * Claude-Code-shaped CONSTRUIR slice (flag AGENTES_CODING_V2 not required):
 * connect GitHub OAuth → open a repo the user can access into an isolated
 * workspace → list/read/write/exec → branch + commit + open a Pull Request.
 *
 * Pattern fusion only (Git Data API + Contents, same style as github-publish).
 * Never invents tokens. Never logs secrets. Never reads the host .env.
 */

const { resolveConstruirBrand, assertNoVendorLeak } = require('./brand');
const {
  CONNECT_PATH,
  CONNECT_MESSAGE,
  connectError,
  sanitizeRepoName,
  sanitizeBranch,
} = require('./github-publish');
const {
  MAX_FILES,
  MAX_FILE_BYTES,
  createMemorySandbox,
  createSession,
  getSession,
  changedFiles,
  sessionPublicView,
  publicError,
  jailRelPath,
} = require('./github-repo-workspace');
const { parseOwnerRepo, extractOwnerRepo } = require('../agents/github-pr-intent');
const { isAgentesCodingV2Enabled } = require('../agentes-coding/flags');

const GITHUB_UA = 'siraGPT-construir';
const SKIP_DIR_RE = /(?:^|\/)(?:node_modules|\.git|\.next|dist|build|coverage|\.turbo|vendor)(?:\/|$)/;
const SKIP_EXT_RE = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|exe|dll|so|dylib|wasm|mp3|mp4|mov|bin)$/i;
const SKIP_SECRET_RE = /(?:^|\/)(?:\.env|\.env\.[^/]+|credentials\.json|id_rsa|id_ed25519)(?:\.bak)?$/i;

async function defaultResolveToken(userId) {
  const githubApi = require('../github/github-api.service');
  try {
    const resolved = await githubApi.resolveUserToken(userId);
    return resolved && resolved.accessToken
      ? { accessToken: resolved.accessToken }
      : null;
  } catch (err) {
    if (err && (err.code === 'github_not_connected' || err.code === 'github_token_invalid')) {
      return null;
    }
    throw err;
  }
}

async function defaultSaveArtifact(args) {
  const { saveArtifact } = require('../agents/task-tools');
  return saveArtifact(args);
}

function authHeaders(accessToken, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': GITHUB_UA,
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

async function gh(fetchImpl, accessToken, url, init = {}) {
  const headers = authHeaders(accessToken, {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers || {}),
  });
  const response = await fetchImpl(url, { ...init, headers });
  return readJson(response);
}

async function resolveAccessToken(opts) {
  const userId = opts.userId;
  const resolveToken = opts.resolveToken || defaultResolveToken;
  if (!userId) return { error: connectError() };
  let tokenBundle;
  try {
    tokenBundle = await resolveToken(userId);
  } catch (err) {
    if (err && (err.code === 'github_not_connected' || err.code === 'github_token_invalid' || err.status === 409)) {
      return { error: connectError() };
    }
    return { error: publicError('E_PROVIDER', 'GitHub no respondió. Reintenta o reconecta la cuenta.') };
  }
  const accessToken = tokenBundle && tokenBundle.accessToken;
  if (!accessToken) return { error: connectError() };
  return { accessToken };
}

function resolveRepoArgs(args = {}, fallbackText = '') {
  if (args.owner && args.repo && !String(args.repo).includes('/')) {
    const owner = sanitizeRepoName(args.owner);
    const repo = sanitizeRepoName(args.repo);
    if (owner && repo) return { owner, repo };
    return null;
  }
  return parseOwnerRepo(args.repo || args.fullName || args.ownerRepo || '')
    || extractOwnerRepo(fallbackText);
}

function shouldSkipPath(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.includes('..')) return true;
  if (SKIP_DIR_RE.test(p)) return true;
  if (SKIP_EXT_RE.test(p)) return true;
  if (SKIP_SECRET_RE.test(p)) return true;
  return false;
}

function decodeBlobContent(body) {
  if (!body) return '';
  if (body.encoding === 'base64' && typeof body.content === 'string') {
    return Buffer.from(body.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (typeof body.content === 'string') return body.content;
  return '';
}

function emitArtifact(onEvent, saved, extra = {}) {
  if (typeof onEvent !== 'function' || !saved) return;
  try {
    onEvent({
      type: 'file_artifact',
      artifact: {
        id: saved.id,
        filename: saved.filename,
        mime: saved.mime,
        format: saved.format,
        sizeBytes: saved.sizeBytes,
        downloadUrl: saved.downloadUrl,
        ...extra,
      },
    });
  } catch (_) { /* UI plumbing must never fail the PR */ }
}

async function openRepo(opts = {}) {
  const brand = resolveConstruirBrand(opts.modelAlias || opts.model);
  const fetchImpl = opts.fetchImpl || fetch;
  const parsed = resolveRepoArgs(opts, opts.userQuery || opts.prompt || '');
  if (!parsed) {
    return publicError('E_PARAMS', 'Indica el repositorio como owner/repo (por ejemplo luis/mi-app).');
  }
  const { owner, repo } = parsed;
  const token = await resolveAccessToken(opts);
  if (token.error) return token.error;

  try {
    const repoRes = await gh(
      fetchImpl,
      token.accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
    if (!repoRes.ok) {
      if (repoRes.status === 401 || repoRes.status === 403) return connectError({ status: repoRes.status });
      if (repoRes.status === 404) {
        return publicError(
          'E_PARAMS',
          `No encuentro ${owner}/${repo} o tu cuenta GitHub no tiene acceso. Conecta GitHub en ${CONNECT_PATH} si aún no lo hiciste.`,
          { connectPath: CONNECT_PATH },
        );
      }
      return publicError('E_PROVIDER', 'GitHub no pudo abrir el repositorio. Reintenta.');
    }

    const defaultBranch = sanitizeBranch(opts.ref || opts.branch || repoRes.body.default_branch) || 'main';
    const htmlUrl = repoRes.body.html_url || `https://github.com/${owner}/${repo}`;
    const fullName = repoRes.body.full_name || `${owner}/${repo}`;

    const refRes = await gh(
      fetchImpl,
      token.accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
    );
    if (!refRes.ok || !refRes.body.object || !refRes.body.object.sha) {
      return publicError('E_PROVIDER', 'El repositorio no tiene una rama inicial.');
    }
    const baseSha = refRes.body.object.sha;

    const treeRes = await gh(
      fetchImpl,
      token.accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(baseSha)}?recursive=1`,
    );
    if (!treeRes.ok || !Array.isArray(treeRes.body.tree)) {
      return publicError('E_PROVIDER', 'No pude leer el árbol de archivos del repositorio.');
    }

    const blobs = [];
    for (const entry of treeRes.body.tree) {
      if (!entry || entry.type !== 'blob') continue;
      const rel = String(entry.path || '').replace(/\\/g, '/');
      if (shouldSkipPath(rel)) continue;
      if (Number(entry.size) > MAX_FILE_BYTES) continue;
      const jailed = jailRelPath(rel);
      if (!jailed.ok) continue;
      blobs.push({ path: jailed.path, sha: entry.sha });
      if (blobs.length >= MAX_FILES) break;
    }

    const files = {};
    const concurrency = 6;
    let cursor = 0;
    async function worker() {
      while (cursor < blobs.length) {
        const i = cursor;
        cursor += 1;
        const item = blobs[i];
        const blobRes = await gh(
          fetchImpl,
          token.accessToken,
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(item.sha)}`,
        );
        if (!blobRes.ok) continue;
        const text = decodeBlobContent(blobRes.body);
        if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) continue;
        files[item.path] = text;
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, blobs.length || 1) }, () => worker()));

    const sandbox = opts.sandbox || createMemorySandbox(files, { execImpl: opts.execImpl });
    if (opts.sandbox && files && typeof opts.sandbox.write === 'function') {
      for (const [rel, content] of Object.entries(files)) {
        await opts.sandbox.write(rel, content);
      }
    }

    const created = createSession({
      userId: opts.userId,
      chatId: opts.chatId,
      owner,
      repo,
      fullName,
      defaultBranch,
      baseSha,
      baseTreeSha: treeRes.body.sha || null,
      htmlUrl,
      brandLabel: brand.brandLabel,
      sandbox,
      files,
      truncated: Boolean(treeRes.body.truncated) || blobs.length >= MAX_FILES,
      execImpl: opts.execImpl,
    });
    if (!created.ok) return created;

    const view = sessionPublicView(created.session);
    const result = {
      ok: true,
      ...view,
      message: `Repo ${fullName} abierto en un workspace aislado. Usa github_repo_list / github_repo_read / github_repo_write / github_repo_exec y luego github_open_pull_request (approved=true).`,
      connectPath: CONNECT_PATH,
      agentesCodingV2: isAgentesCodingV2Enabled(opts.env || process.env),
      flagRequired: false,
    };
    return assertNoVendorLeak(result);
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) return connectError({ status: err.status });
    return publicError('E_PROVIDER', 'GitHub no pudo abrir el repositorio. Reintenta.');
  }
}

async function withSession(opts, fn) {
  const found = getSession({
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    chatId: opts.chatId,
  });
  if (!found.ok) return found;
  return fn(found.session);
}

async function listRepoFiles(opts = {}) {
  return withSession(opts, async (session) => {
    const out = await session.sandbox.list(opts.path || '.');
    if (!out.ok) return out;
    return assertNoVendorLeak({
      ok: true,
      workspaceId: session.id,
      fullName: session.fullName,
      path: out.path,
      files: out.files,
      count: out.count,
      brandLabel: session.brandLabel,
      flagRequired: false,
    });
  });
}

async function readRepoFile(opts = {}) {
  return withSession(opts, async (session) => {
    const out = await session.sandbox.read(opts.path);
    if (!out.ok) return out;
    return {
      ok: true,
      workspaceId: session.id,
      fullName: session.fullName,
      path: out.path,
      content: out.content,
      brandLabel: session.brandLabel,
      flagRequired: false,
    };
  });
}

async function writeRepoFile(opts = {}) {
  return withSession(opts, async (session) => {
    const out = await session.sandbox.write(opts.path, opts.content);
    if (!out.ok) return out;
    return assertNoVendorLeak({
      ok: true,
      workspaceId: session.id,
      fullName: session.fullName,
      path: out.path,
      bytes: out.bytes,
      brandLabel: session.brandLabel,
      flagRequired: false,
    });
  });
}

async function execRepo(opts = {}) {
  return withSession(opts, async (session) => {
    const out = await session.sandbox.exec({
      command: opts.command,
      args: opts.args,
      timeoutMs: opts.timeoutMs,
    });
    if (!out.ok && out.code) return out;
    return {
      ok: out.ok !== false && (out.exitCode ?? 0) === 0,
      workspaceId: session.id,
      fullName: session.fullName,
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      brandLabel: session.brandLabel,
      flagRequired: false,
    };
  });
}

function workBranchName(requested, defaultBranch) {
  const fallback = `sira/${String(Date.now().toString(36))}`;
  const branch = sanitizeBranch(requested) || fallback;
  if (!branch) return fallback;
  if (branch === defaultBranch || branch === 'main' || branch === 'master') {
    return `sira/${branch}`;
  }
  return branch;
}

async function createBlob(fetchImpl, accessToken, owner, repo, content) {
  const out = await gh(
    fetchImpl,
    accessToken,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: Buffer.from(String(content ?? ''), 'utf8').toString('base64'),
        encoding: 'base64',
      }),
    },
  );
  if (!out.ok || !out.body.sha) {
    const err = new Error('github_blob_failed');
    err.status = out.status;
    throw err;
  }
  return out.body.sha;
}

async function openPullRequest(opts = {}) {
  if (opts.approved !== true) {
    return {
      ok: false,
      code: 'E_PLAN_GATE',
      message: 'Abrir un Pull Request requiere confirmación (approved=true).',
      connectPath: CONNECT_PATH,
    };
  }

  const found = getSession({
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    chatId: opts.chatId,
  });
  if (!found.ok) return found;
  const session = found.session;
  const changed = changedFiles(session);
  if (!Object.keys(changed).length) {
    return publicError('E_PARAMS', 'No hay cambios en el workspace para abrir un PR. Edita un archivo con github_repo_write.');
  }

  const token = await resolveAccessToken(opts);
  if (token.error) return token.error;
  const fetchImpl = opts.fetchImpl || fetch;
  const owner = session.owner;
  const repo = session.repo;
  const base = sanitizeBranch(opts.base) || session.defaultBranch || 'main';
  const head = workBranchName(opts.branch, base);
  const title = String(opts.title || `Sira: cambios en ${session.fullName}`).slice(0, 180);
  const body = String(
    opts.body
    || `Cambios desde /agentes (${session.brandLabel}).\n\nArchivos:\n${Object.keys(changed).map((p) => `- ${p}`).join('\n')}`,
  ).slice(0, 4000);

  try {
    const refRes = await gh(
      fetchImpl,
      token.accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(base)}`,
    );
    if (!refRes.ok || !refRes.body.object || !refRes.body.object.sha) {
      return publicError('E_PROVIDER', 'No pude leer la rama base del repositorio.');
    }
    const parentSha = session.baseSha || refRes.body.object.sha;
    const commitRes = await gh(
      fetchImpl,
      token.accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(parentSha)}`,
    );
    const baseTree = commitRes.ok && commitRes.body.tree ? commitRes.body.tree.sha : null;
    if (!baseTree) return publicError('E_PROVIDER', 'No pude leer el árbol git del repositorio.');

    const tree = [];
    for (const [rel, content] of Object.entries(changed)) {
      const filePath = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!filePath || filePath.includes('..') || shouldSkipPath(filePath)) continue;
      const sha = await createBlob(fetchImpl, token.accessToken, owner, repo, content);
      tree.push({ path: filePath, mode: '100644', type: 'blob', sha });
    }
    if (!tree.length) {
      return publicError('E_PARAMS', 'Los cambios no se pueden publicar (rutas omitidas o secretos).');
    }

    const treeRes = await gh(
      fetchImpl,
      token.accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
      { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) },
    );
    if (!treeRes.ok || !treeRes.body.sha) {
      return publicError('E_PROVIDER', 'No pude crear el árbol de archivos.');
    }

    const commitMessage = String(opts.message || title).slice(0, 200);
    const newCommit = await gh(
      fetchImpl,
      token.accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: commitMessage,
          tree: treeRes.body.sha,
          parents: [parentSha],
        }),
      },
    );
    if (!newCommit.ok || !newCommit.body.sha) {
      return publicError('E_PROVIDER', 'No pude crear el commit.');
    }

    const newRef = await gh(
      fetchImpl,
      token.accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${head}`,
          sha: newCommit.body.sha,
        }),
      },
    );
    if (!newRef.ok) {
      if (newRef.status === 422) {
        const patched = await gh(
          fetchImpl,
          token.accessToken,
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(head)}`,
          { method: 'PATCH', body: JSON.stringify({ sha: newCommit.body.sha, force: false }) },
        );
        if (!patched.ok) {
          return publicError('E_PROVIDER', 'No pude crear ni actualizar la rama del PR. Prueba otro nombre.');
        }
      } else if (newRef.status === 401 || newRef.status === 403) {
        return connectError({ status: newRef.status });
      } else {
        return publicError('E_PROVIDER', 'No pude crear la rama del Pull Request.');
      }
    }

    const prRes = await gh(
      fetchImpl,
      token.accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title,
          head,
          base,
          body,
        }),
      },
    );
    if (!prRes.ok) {
      if (prRes.status === 401 || prRes.status === 403) return connectError({ status: prRes.status });
      if (prRes.status === 422 && prRes.body && /already exists/i.test(String(prRes.body.message || ''))) {
        const existing = await gh(
          fetchImpl,
          token.accessToken,
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`,
        );
        const first = existing.ok && Array.isArray(existing.body) ? existing.body[0] : null;
        if (first && first.html_url) {
          return assertNoVendorLeak({
            ok: true,
            alreadyOpen: true,
            prUrl: first.html_url,
            number: first.number,
            title: first.title || title,
            branch: head,
            base,
            commitSha: newCommit.body.sha,
            fullName: session.fullName,
            brandLabel: session.brandLabel,
            flagRequired: false,
          });
        }
      }
      return publicError('E_PROVIDER', 'No pude abrir el Pull Request. Revisa el permiso repo de la conexión GitHub.');
    }

    const prUrl = prRes.body.html_url;
    const number = prRes.body.number;
    const saveArtifact = opts.saveArtifact || defaultSaveArtifact;
    let artifact = null;
    try {
      const md = [
        `# Pull Request`,
        ``,
        `**${session.fullName}** — ${title}`,
        ``,
        prUrl,
        ``,
        `Rama \`${head}\` → \`${base}\` (${session.brandLabel}).`,
      ].join('\n');
      artifact = saveArtifact({
        filename: `pr-${owner}-${repo}-${number}.md`,
        base64: Buffer.from(md, 'utf8').toString('base64'),
        mime: 'text/markdown',
        ownerUserId: opts.userId || null,
        chatId: opts.chatId || null,
        category: 'construir_pr',
        brandLabel: session.brandLabel,
        kind: 'markdown',
      });
      emitArtifact(opts.onEvent, artifact, { prUrl, number });
    } catch (_) { /* artifact is best-effort */ }

    const result = {
      ok: true,
      prUrl,
      number,
      title: prRes.body.title || title,
      branch: head,
      base,
      commitSha: newCommit.body.sha,
      fullName: session.fullName,
      htmlUrl: session.htmlUrl,
      brandLabel: session.brandLabel,
      files: Object.keys(changed),
      artifact: artifact
        ? { id: artifact.id, filename: artifact.filename, downloadUrl: artifact.downloadUrl }
        : null,
      message: `Pull Request abierto: ${prUrl}`,
      agentesCodingV2: isAgentesCodingV2Enabled(opts.env || process.env),
      flagRequired: false,
    };
    return assertNoVendorLeak(result);
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) return connectError({ status: err.status });
    return publicError('E_PROVIDER', 'GitHub no pudo abrir el Pull Request. Reintenta.');
  }
}

module.exports = {
  CONNECT_PATH,
  CONNECT_MESSAGE,
  openRepo,
  listRepoFiles,
  readRepoFile,
  writeRepoFile,
  execRepo,
  openPullRequest,
  resolveRepoArgs,
  shouldSkipPath,
  workBranchName,
};
