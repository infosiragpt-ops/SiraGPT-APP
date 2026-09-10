'use strict';

/**
 * CONSTRUIR / coding MVP — works with AGENTES_CODING_V2 off.
 * Scaffolds a real project, saves preview HTML + zip, optionally publishes
 * to the user's GitHub OAuth account.
 */

const { isAgentesCodingV2Enabled } = require('../agentes-coding/flags');
const { resolveConstruirBrand, assertNoVendorLeak } = require('./brand');
const { scaffoldConstruirProject } = require('./scaffold');
const { zipProjectFiles } = require('./zip');
const { publishProject, connectError, CONNECT_PATH } = require('./github-publish');

const lastByChat = new Map();

function rememberProject(chatId, project) {
  if (!chatId) return;
  lastByChat.set(String(chatId), {
    files: project.files,
    title: project.title,
    slug: project.slug,
    kind: project.kind,
    savedAt: Date.now(),
  });
}

function lastProjectForChat(chatId) {
  if (!chatId) return null;
  return lastByChat.get(String(chatId)) || null;
}

function clearProjectStore() {
  lastByChat.clear();
}

function defaultSaveArtifact(args) {
  const { saveArtifact } = require('../agents/task-tools');
  return saveArtifact(args);
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
  } catch (_) { /* UI plumbing must never fail delivery */ }
}

function buildFooter({ brandLabel, htmlArtifact, zipArtifact, github }) {
  const lines = [
    `**Proyecto listo** (${brandLabel}) — código real, no un Word.`,
  ];
  if (htmlArtifact && htmlArtifact.downloadUrl) {
    lines.push(`- [Descargar página HTML](${htmlArtifact.downloadUrl})`);
  }
  if (zipArtifact && zipArtifact.downloadUrl) {
    lines.push(`- [Descargar proyecto .zip](${zipArtifact.downloadUrl}) (servidor Node + base de datos en archivo)`);
  }
  if (github && github.ok && github.htmlUrl) {
    lines.push(`- Publicado en GitHub: ${github.htmlUrl} (\`${github.fullName}\`, rama \`${github.branch}\`)`);
  } else if (github && github.code === 'E_GITHUB_CONNECT') {
    lines.push(`- GitHub: ${github.message}`);
  } else {
    lines.push(`- Para subirlo a GitHub, conecta la cuenta en ${CONNECT_PATH} y escribe «súbelo a GitHub».`);
  }
  lines.push('- Corre local: `node server.js` → http://127.0.0.1:5173');
  return lines.join('\n');
}

async function deliverConstruirProject(opts = {}) {
  const prompt = String(opts.prompt || opts.userQuery || '').trim();
  const brand = resolveConstruirBrand(opts.modelAlias || opts.model);
  const project = scaffoldConstruirProject({
    prompt,
    title: opts.title,
    html: opts.html,
    kind: opts.kind,
  });
  rememberProject(opts.chatId, project);

  const saveArtifact = opts.saveArtifact || defaultSaveArtifact;
  const htmlSaved = saveArtifact({
    filename: `${project.slug}.html`,
    base64: Buffer.from(project.files['index.html'], 'utf8').toString('base64'),
    mime: 'text/html',
    ownerUserId: opts.userId || null,
    chatId: opts.chatId || null,
    category: 'construir_mvp',
    brandLabel: brand.brandLabel,
    kind: 'html',
  });
  emitArtifact(opts.onEvent, htmlSaved, { previewHtml: project.files['index.html'] });

  const zipBuf = await zipProjectFiles(project.files);
  const zipSaved = saveArtifact({
    filename: `${project.slug}.zip`,
    base64: zipBuf.toString('base64'),
    mime: 'application/zip',
    ownerUserId: opts.userId || null,
    chatId: opts.chatId || null,
    category: 'construir_mvp',
    brandLabel: brand.brandLabel,
    kind: 'zip',
  });
  emitArtifact(opts.onEvent, zipSaved);

  let github = {
    offered: true,
    connected: null,
    connectPath: CONNECT_PATH,
  };
  if (opts.publishGithub === true) {
    if (opts.approved !== true) {
      github = {
        ok: false,
        code: 'E_PLAN_GATE',
        message: 'Publicar en GitHub requiere confirmación (approved=true).',
        connectPath: CONNECT_PATH,
      };
    } else {
      github = await publishProject({
        userId: opts.userId,
        files: project.files,
        repoName: opts.repoName || project.slug,
        description: project.title,
        private: opts.private !== false,
        branch: opts.branch,
        fetchImpl: opts.fetchImpl,
        resolveToken: opts.resolveToken,
      });
    }
  } else if (opts.resolveToken && opts.userId) {
    try {
      const token = await opts.resolveToken(opts.userId);
      github.connected = Boolean(token && token.accessToken);
      if (!github.connected) github = { ...connectError(), offered: true };
    } catch (_) {
      github = { ...connectError(), offered: true };
    }
  }

  const footer = buildFooter({
    brandLabel: brand.brandLabel,
    htmlArtifact: htmlSaved,
    zipArtifact: zipSaved,
    github,
  });

  const result = {
    ok: true,
    brandLabel: brand.brandLabel,
    title: project.title,
    slug: project.slug,
    kind: project.kind,
    fileNames: project.fileNames,
    artifacts: {
      html: {
        id: htmlSaved.id,
        filename: htmlSaved.filename,
        downloadUrl: htmlSaved.downloadUrl,
        sizeBytes: htmlSaved.sizeBytes,
      },
      zip: {
        id: zipSaved.id,
        filename: zipSaved.filename,
        downloadUrl: zipSaved.downloadUrl,
        sizeBytes: zipSaved.sizeBytes,
      },
    },
    github,
    footer,
    howToRun: 'node server.js',
    agentesCodingV2: isAgentesCodingV2Enabled(opts.env || process.env),
    flagRequired: false,
  };
  assertNoVendorLeak({
    brandLabel: result.brandLabel,
    footer: result.footer,
    github: result.github,
  });
  return result;
}

async function publishLastProject(opts = {}) {
  const cached = lastProjectForChat(opts.chatId);
  const files = (opts.files && typeof opts.files === 'object' && Object.keys(opts.files).length)
    ? opts.files
    : (cached && cached.files);
  if (!files) {
    return {
      ok: false,
      code: 'E_PARAMS',
      message: 'No hay un proyecto reciente en este chat. Pide primero «créame una web» o «créame una app».',
    };
  }
  if (opts.approved !== true) {
    return {
      ok: false,
      code: 'E_PLAN_GATE',
      message: 'Publicar en GitHub requiere confirmación.',
      connectPath: CONNECT_PATH,
    };
  }
  return publishProject({
    userId: opts.userId,
    files,
    repoName: opts.repoName || (cached && cached.slug),
    description: opts.description || (cached && cached.title),
    private: opts.private !== false,
    branch: opts.branch,
    fetchImpl: opts.fetchImpl,
    resolveToken: opts.resolveToken,
  });
}

module.exports = {
  deliverConstruirProject,
  publishLastProject,
  lastProjectForChat,
  rememberProject,
  clearProjectStore,
  buildFooter,
  scaffoldConstruirProject,
  resolveConstruirBrand,
  publishProject,
  zipProjectFiles,
};
