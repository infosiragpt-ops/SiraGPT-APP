'use strict';

/**
 * Detect “abre un PR en owner/repo que…” turns so /agentes can pin the
 * CONSTRUIR GitHub tools (OAuth clone → edit → PR) without a new UI.
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

const PR_NOUN_RE = /\b(pull request|pull-request|\bpr\b)\b/;
const PR_VERB_RE = /\b(abre|abrir|crea(?:r|me)?|haz(?:me)?|hacer|open|create|publica|sube|empuja|abre un|abrir un)\b/;
const OPEN_REPO_RE = /\b(abre|abrir|clona|clonar|checkout|open|delega(?:r)?)\b/;
const REPO_NOUN_RE = /\b(repo|repositorio|github)\b/;
const EDIT_RE = /\b(pr|pull|commit|cambia|arregla|implementa|anade|añade|fix|patch)\b/;
const LOCAL_RUN_RE = /\b(en local|localhost|localmente|clona|clonar|clone|delega(?:r)?|abre|abrir|open|dame la web|correr|ejecutar|run|levanta(?:r)?)\b/;
const EXPLAIN_ONLY_RE = /\b(explica|explicame|qué hace|que hace|por que falla|por qué falla|what does|why (?:does|is))\b/;

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
  return { owner, repo };
}

function extractOwnerRepo(text) {
  const stripped = String(text || '')
    .replace(/https?:\/\/(?:www\.)?github\.com\//gi, '');
  return parseOwnerRepo(stripped);
}

function isGithubPrRequest(text) {
  const n = normalize(text);
  if (!n) return false;
  const hasRepo = OWNER_REPO_RE.test(String(text || '')) || OWNER_REPO_RE.test(n);
  if (PR_NOUN_RE.test(n) && PR_VERB_RE.test(n)) return true;
  if (OPEN_REPO_RE.test(n) && REPO_NOUN_RE.test(n) && hasRepo && EDIT_RE.test(n)) return true;
  return false;
}

function hasGithubRepoRef(text) {
  return Boolean(extractOwnerRepo(text) || parseOwnerRepo(text));
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
    `Abrí **${fullName}** en un workspace aislado de Sira. Esto no es tu computadora y no levanté un servidor en localhost.`,
    htmlUrl ? `Repo: ${htmlUrl}` : '',
    `Archivos visibles${extra}:`,
    fileLines,
    '',
    'Para ver la web **en tu máquina**:',
    htmlUrl ? `1. \`git clone ${htmlUrl.replace(/\.git$/, '')}.git\`` : '1. Clona el repo con git.',
    '2. Sigue el README (por ejemplo `npm install` y `npm run dev`).',
    'Si GitHub no está conectado, ve a [/conexiones](/conexiones). Sira no inventa tokens ni un localhost que no existe.',
  ].filter((line) => line !== '').join('\n');
}

module.exports = {
  normalize,
  parseOwnerRepo,
  extractOwnerRepo,
  isGithubPrRequest,
  isGithubLocalRunRequest,
  isGithubRepoWorkRequest,
  hasGithubRepoRef,
  buildGithubLocalReadyMessage,
  OWNER_REPO_RE,
};
