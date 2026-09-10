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
const OPEN_REPO_RE = /\b(abre|abrir|clona|clonar|checkout|open)\b/;
const REPO_NOUN_RE = /\b(repo|repositorio|github)\b/;
const EDIT_RE = /\b(pr|pull|commit|cambia|arregla|implementa|anade|añade|fix|patch)\b/;

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

module.exports = {
  normalize,
  parseOwnerRepo,
  extractOwnerRepo,
  isGithubPrRequest,
  OWNER_REPO_RE,
};
