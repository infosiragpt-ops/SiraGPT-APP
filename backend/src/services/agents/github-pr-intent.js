'use strict';

/**
 * Detect “abre un PR en owner/repo que…” and “dame la web en local”
 * turns so /agentes can pin the right tools without a new UI.
 *
 * Local-preview uses the server chat workspace (`project_clone_repo` +
 * `project_preview_*`). Never tell the user to clone on their phone.
 */

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const OWNER_REPO_RE = /\b([A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}))\/([A-Za-z0-9._-]{1,100})\b/;
const GITHUB_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}))\/([A-Za-z0-9._-]{1,100})/i;
const PREFERRED_PORT_RE = /(?:(?:en\s+)?local(?:host)?(?:\s+en)?|puerto|port)\s*:?\s*(\d{2,5})\b|localhost:(\d{2,5})\b/i;

const PR_NOUN_RE = /\b(pull request|pull-request|\bpr\b)\b/;
const PR_VERB_RE = /\b(abre|abrir|crea(?:r|me)?|haz(?:me)?|hacer|open|create|publica|sube|empuja|abre un|abrir un)\b/;
const OPEN_REPO_RE = /\b(abre|abrir|clona|clonar|checkout|open|delega(?:r)?)\b/;
const REPO_NOUN_RE = /\b(repo|repositorio|github)\b/;
const EDIT_RE = /\b(pr|pull|commit|cambia|arregla|implementa|anade|añade|fix|patch)\b/;
const LOCAL_RUN_RE = /\b(en local|localhost|localmente|clona|clonar|clone|delega(?:r)?|abre|abrir|open|dame la web|web en local|correr|ejecutar|run|levanta(?:r)?)\b/;
const EXPLAIN_ONLY_RE = /\b(explica|explicame|qué hace|que hace|por que falla|por qué falla|what does|why (?:does|is))\b/;

function looksLikeHostnameOwner(owner) {
  return /\./.test(String(owner || ''));
}

function parseOwnerRepo(raw) {
  const s = String(raw || '').trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const m = OWNER_REPO_RE.exec(s);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  if (!owner || !repo || owner === '.' || repo === '.' || owner.includes('..') || repo.includes('..')) {
    return null;
  }
  if (owner.toLowerCase() === 'http' || owner.toLowerCase() === 'https') return null;
  if (looksLikeHostnameOwner(owner)) return null;
  return { owner, repo };
}

function extractGithubHttpsUrl(text) {
  const m = GITHUB_URL_RE.exec(String(text || ''));
  if (!m) return null;
  const parsed = parseOwnerRepo(`${m[1]}/${m[2]}`);
  if (!parsed) return null;
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    url: `https://github.com/${parsed.owner}/${parsed.repo}`,
  };
}

function extractOwnerRepo(text) {
  const fromUrl = extractGithubHttpsUrl(text);
  if (fromUrl) return { owner: fromUrl.owner, repo: fromUrl.repo };
  const stripped = String(text || '')
    .replace(/https?:\/\/(?:www\.)?[^\s/]+\/?/gi, (match) => (
      /github\.com\//i.test(match) ? '' : ' '
    ));
  return parseOwnerRepo(stripped);
}

function extractPreferredPort(text) {
  const m = PREFERRED_PORT_RE.exec(String(text || ''));
  if (!m) return null;
  const port = Number(m[1] || m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function isGithubPrRequest(text) {
  const n = normalize(text);
  if (!n) return false;
  const hasRepo = Boolean(extractOwnerRepo(text) || extractGithubHttpsUrl(text));
  if (PR_NOUN_RE.test(n) && PR_VERB_RE.test(n)) return true;
  if (OPEN_REPO_RE.test(n) && REPO_NOUN_RE.test(n) && hasRepo && EDIT_RE.test(n)) return true;
  return false;
}

function hasGithubRepoRef(text) {
  return Boolean(extractGithubHttpsUrl(text) || extractOwnerRepo(text) || parseOwnerRepo(text));
}

/**
 * Clone / open / “dame la web en local” of an existing GitHub repo.
 * H5 (explain-only) stays false so “explica este código de github.com/…”
 * does not steal CONSTRUIR.
 */
function isGithubLocalRunRequest(text) {
  const n = normalize(text);
  if (!n || !hasGithubRepoRef(text)) return false;
  if (EXPLAIN_ONLY_RE.test(n) && !LOCAL_RUN_RE.test(n)) return false;
  return LOCAL_RUN_RE.test(n);
}

function isGithubRepoWorkRequest(text) {
  return isGithubPrRequest(text) || isGithubLocalRunRequest(text);
}

function isGithubLocalPreviewRequest(text) {
  return isGithubLocalRunRequest(text) && !isGithubPrRequest(text);
}

function buildGithubLocalReadyMessage(opened) {
  const fullName = (opened && (opened.fullName || `${opened.owner || ''}/${opened.repo || ''}`)) || 'el repositorio';
  const htmlUrl = (opened && opened.htmlUrl) || (fullName.includes('/') ? `https://github.com/${fullName}` : '');
  const files = Array.isArray(opened && opened.files) ? opened.files.slice(0, 12) : [];
  const extra = Number(opened && opened.fileCount) > files.length
    ? ` (y ${Number(opened.fileCount) - files.length} más)`
    : '';
  const fileLines = files.length
    ? files.map((name) => `- \`${name}\``).join('\n')
    : '- (sin archivos de texto en el workspace)';
  return [
    `Abrí **${fullName}** en un workspace aislado de Sira (servidor, no tu teléfono ni tu laptop).`,
    htmlUrl ? `Repo: ${htmlUrl}` : '',
    `Archivos visibles${extra}:`,
    fileLines,
    '',
    'Para ver la web en local, el servidor clona el repo y llama `project_preview_start`; no clones en tu equipo.',
    'Si GitHub no está conectado y el repo es privado, ve a [/conexiones](/conexiones).',
  ].filter((line) => line !== '').join('\n');
}

function buildLocalPreviewReadyMessage({ cloned, preview, preferredPort } = {}) {
  const fullName = (cloned && cloned.repository && cloned.repository.fullName)
    || (cloned && cloned.fullName)
    || 'el repositorio';
  const webUrl = cloned && cloned.repository && cloned.repository.webUrl;
  const previewUrl = preview && preview.ok && preview.previewUrl;
  if (previewUrl) {
    const lines = [
      `Cloné **${fullName}** en el workspace del chat (servidor de Sira, no tu teléfono ni tu laptop).`,
      webUrl ? `Repo: ${webUrl}` : '',
      `Esta es tu web en local: ${previewUrl}`,
    ];
    if (preferredPort) {
      const actual = preview && Number.isInteger(preview.port) ? preview.port : null;
      if (actual && actual !== preferredPort) {
        lines.push(`Pediste el puerto ${preferredPort}; el runner asignó ${actual}. Usa el enlace de preview, no localhost:${preferredPort}.`);
      } else {
        lines.push(`Pediste el puerto ${preferredPort}. El runner asigna el puerto del sandbox; el enlace de preview es el equivalente a «en local».`);
      }
    } else {
      lines.push('El puerto lo asigna el runner; el enlace de preview es tu «web en local».');
    }
    lines.push('Si el enlace deja de responder, pide de nuevo «dame la web en local».');
    return lines.filter((line) => line !== '').join('\n');
  }
  const err = (preview && preview.message) || (cloned && cloned.message) || 'No se pudo levantar la vista previa.';
  return [
    `Cloné **${fullName}** en el servidor.`,
    `No pude levantar la vista previa: ${err}`,
    'No hace falta clonar el repo en tu teléfono. Reintenta; si el repo es privado, conecta GitHub en [/conexiones](/conexiones).',
  ].join('\n');
}

function buildLocalPreviewErrorMessage(result) {
  const message = (result && result.message) || 'No se pudo clonar el repositorio en el servidor.';
  const code = result && result.code;
  if (code === 'codex_forbidden' || code === 'github_auth_required' || code === 'no_chat_context') {
    return message;
  }
  return `${message}\nNo hace falta clonar el repo en tu teléfono. Si es privado, conecta GitHub en [/conexiones](/conexiones).`;
}

module.exports = {
  normalize,
  parseOwnerRepo,
  extractOwnerRepo,
  extractGithubHttpsUrl,
  extractPreferredPort,
  isGithubPrRequest,
  isGithubLocalRunRequest,
  isGithubLocalPreviewRequest,
  isGithubRepoWorkRequest,
  hasGithubRepoRef,
  buildGithubLocalReadyMessage,
  buildLocalPreviewReadyMessage,
  buildLocalPreviewErrorMessage,
  OWNER_REPO_RE,
};
