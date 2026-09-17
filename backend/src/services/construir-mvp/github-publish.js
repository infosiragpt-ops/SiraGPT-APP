'use strict';

/**
 * Publish a CONSTRUIR file map to the user's GitHub account.
 * Uses the stored OAuth token. Never invents credentials.
 */

const CONNECT_PATH = '/conexiones';
const CONNECT_MESSAGE =
  'GitHub no está conectado. Ve a Conexiones (/conexiones) y conecta tu cuenta para crear el repositorio o empujar una rama. Sira no inventa tokens.';

const GITHUB_UA = 'siraGPT-construir';

function connectError(extra = {}) {
  return {
    ok: false,
    code: 'E_GITHUB_CONNECT',
    message: CONNECT_MESSAGE,
    connectPath: CONNECT_PATH,
    ...extra,
  };
}

function publicError(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function sanitizeRepoName(name) {
  const raw = String(name || '').trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(raw) || raw.includes('..')) return null;
  return raw;
}

function sanitizeBranch(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'main';
  if (!/^[A-Za-z0-9._\/-]{1,80}$/.test(raw) || raw.includes('..')) return null;
  return raw;
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
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

async function gh(fetchImpl, accessToken, url, init = {}) {
  const headers = authHeaders(accessToken, {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers || {}),
  });
  const response = await fetchImpl(url, { ...init, headers });
  return readJson(response);
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

async function publishProject(opts = {}) {
  const userId = opts.userId;
  const files = opts.files && typeof opts.files === 'object' ? opts.files : {};
  const fetchImpl = opts.fetchImpl || fetch;
  const resolveToken = opts.resolveToken || defaultResolveToken;

  if (!userId) return connectError();
  if (!Object.keys(files).length) {
    return publicError('E_PARAMS', 'No hay archivos para publicar.');
  }

  let tokenBundle;
  try {
    tokenBundle = await resolveToken(userId);
  } catch (err) {
    if (err && (err.code === 'github_not_connected' || err.code === 'github_token_invalid' || err.status === 409)) {
      return connectError();
    }
    return publicError('E_PROVIDER', 'GitHub no respondió. Reintenta o reconecta la cuenta.');
  }
  const accessToken = tokenBundle && tokenBundle.accessToken;
  if (!accessToken) return connectError();

  const repoName = sanitizeRepoName(opts.repoName);
  if (!repoName) {
    return publicError('E_PARAMS', 'El nombre del repositorio no es válido.');
  }
  const branch = sanitizeBranch(opts.branch);
  if (!branch) {
    return publicError('E_PARAMS', 'El nombre de la rama no es válido.');
  }

  try {
    const me = await gh(fetchImpl, accessToken, 'https://api.github.com/user');
    if (!me.ok || !me.body.login) {
      if (me.status === 401 || me.status === 403) return connectError({ status: me.status });
      return publicError('E_PROVIDER', 'No pude leer la cuenta de GitHub conectada.');
    }
    const owner = String(me.body.login);

    let repo = await gh(
      fetchImpl,
      accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
    );
    let created = false;
    if (!repo.ok) {
      const createdRepo = await gh(fetchImpl, accessToken, 'https://api.github.com/user/repos', {
        method: 'POST',
        body: JSON.stringify({
          name: repoName,
          description: String(opts.description || '').slice(0, 350) || undefined,
          private: opts.private !== false,
          auto_init: true,
        }),
      });
      if (!createdRepo.ok) {
        if (createdRepo.status === 401 || createdRepo.status === 403) {
          return connectError({ status: createdRepo.status });
        }
        return publicError(
          'E_PROVIDER',
          'No pude crear el repositorio. Revisa el permiso repo de la conexión GitHub.',
          { status: createdRepo.status },
        );
      }
      repo = createdRepo;
      created = true;
    }

    const defaultBranch = repo.body.default_branch || 'main';
    const htmlUrl = repo.body.html_url || `https://github.com/${owner}/${repoName}`;
    const fullName = repo.body.full_name || `${owner}/${repoName}`;

    const refName = created || !opts.branch ? defaultBranch : branch;
    const refRes = await gh(
      fetchImpl,
      accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
    );
    if (!refRes.ok || !refRes.body.object || !refRes.body.object.sha) {
      return publicError('E_PROVIDER', 'El repositorio no tiene una rama inicial.');
    }
    const baseSha = refRes.body.object.sha;
    const commitRes = await gh(
      fetchImpl,
      accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/commits/${encodeURIComponent(baseSha)}`,
    );
    const baseTree = commitRes.ok && commitRes.body.tree ? commitRes.body.tree.sha : null;
    if (!baseTree) return publicError('E_PROVIDER', 'No pude leer el árbol git del repositorio.');

    const tree = [];
    for (const [rel, content] of Object.entries(files)) {
      const filePath = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!filePath || filePath.includes('..')) continue;
      const sha = await createBlob(fetchImpl, accessToken, owner, repoName, content);
      tree.push({ path: filePath, mode: '100644', type: 'blob', sha });
    }

    const treeRes = await gh(
      fetchImpl,
      accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTree, tree }),
      },
    );
    if (!treeRes.ok || !treeRes.body.sha) {
      return publicError('E_PROVIDER', 'No pude crear el árbol de archivos.');
    }

    const commitMessage = String(opts.message || `Sira CONSTRUIR: ${repoName}`).slice(0, 200);
    const newCommit = await gh(
      fetchImpl,
      accessToken,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: commitMessage,
          tree: treeRes.body.sha,
          parents: [baseSha],
        }),
      },
    );
    if (!newCommit.ok || !newCommit.body.sha) {
      return publicError('E_PROVIDER', 'No pude crear el commit.');
    }

    if (!created && opts.branch && refName !== defaultBranch) {
      const newRef = await gh(
        fetchImpl,
        accessToken,
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs`,
        {
          method: 'POST',
          body: JSON.stringify({
            ref: `refs/heads/${refName}`,
            sha: newCommit.body.sha,
          }),
        },
      );
      if (!newRef.ok) {
        return publicError('E_PROVIDER', 'No pude crear la rama. Prueba otro nombre.');
      }
    } else {
      const updated = await gh(
        fetchImpl,
        accessToken,
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs/heads/${encodeURIComponent(refName)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sha: newCommit.body.sha }),
        },
      );
      if (!updated.ok) {
        return publicError('E_PROVIDER', 'No pude actualizar la rama del repositorio.');
      }
    }

    return {
      ok: true,
      created,
      owner,
      repo: repoName,
      fullName,
      htmlUrl,
      branch: refName,
      commitSha: newCommit.body.sha,
    };
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) return connectError({ status: err.status });
    return publicError('E_PROVIDER', 'GitHub no pudo publicar el proyecto. Reintenta.');
  }
}

module.exports = {
  CONNECT_PATH,
  CONNECT_MESSAGE,
  connectError,
  publishProject,
  sanitizeRepoName,
  sanitizeBranch,
};
