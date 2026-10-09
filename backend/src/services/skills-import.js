'use strict';

/**
 * skills-import — install Agent Skills into the user's Biblioteca from a
 * marketplace or a repository, by reference, with the same SSRF posture as
 * `web_fetch`. Native rewrite of the OpenClaw (MIT) ClawHub install flow;
 * no OpenClaw code is copied.
 *
 * Sources (`classifySource`):
 *   - ClawHub (https://clawhub.ai): `clawhub:<slug>`, a bare slug, or a
 *     https://clawhub.ai/skills/<slug> page URL → verify (security verdict)
 *     → install resolution (archive download or commit-pinned GitHub) →
 *     SKILL.md. `CLAWHUB_URL` / `CLAWHUB_TOKEN` are optional.
 *   - GitHub: `github:owner/repo[/path][@ref]`, `owner/repo[/path][@ref]`,
 *     or a github.com tree/blob URL → raw.githubusercontent.com SKILL.md.
 *   - URL: any https URL ending in .md (the SKILL.md itself) or .zip/.skill
 *     (an archive containing SKILL.md).
 *
 * Every fetch: hostname-only public http(s) targets (`assertSafeUrl`), DNS
 * re-validated per hop (anti-rebinding), manual redirects (≤ 3), byte caps
 * (SKILL.md 256 KB, archives `SIRAGPT_SKILL_IMPORT_MAX_BYTES`, default 2 MB).
 * Archives are read in memory with pizzip — nothing is extracted to disk.
 * The parsed SKILL.md goes through the same `createUserSkill` validation as
 * an upload, and the provenance is recorded in the user's skills state
 * (`imports` map) so Ajustes → Skills can show where a skill came from.
 *
 * Injectable for offline tests: `fetchImpl`, `dnsCheck`, `env`, `now`,
 * `persist`/`root` (skills store).
 */

const crypto = require('node:crypto');
const { Agent, fetch: undiciFetch } = require('undici');
const { assertSafeUrl, createPinnedDispatcher } = require('./agent-harness/tools/web-fetch-tool');
const chatSkills = require('./chat-skills');

const DEFAULT_CLAWHUB_URL = 'https://clawhub.ai';
const MAX_MARKDOWN_BYTES = 256 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const SEARCH_LIMIT_MAX = 20;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GITHUB_REF_RE = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^@\s]+)?)(?:@([A-Za-z0-9_.\-/]+))?$/;
const BLOCKED_VERDICTS = new Set(['fail', 'blocked', 'quarantined', 'revoked', 'malicious', 'removed', 'suspended']);

class SkillImportError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'SkillImportError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

function envOf(env) {
  return env || process.env;
}

function hubBaseUrl(env) {
  const raw = String(envOf(env).CLAWHUB_URL || DEFAULT_CLAWHUB_URL).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return DEFAULT_CLAWHUB_URL;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return DEFAULT_CLAWHUB_URL;
  }
}

function maxArchiveBytes(env) {
  const n = Number.parseInt(String(envOf(env).SIRAGPT_SKILL_IMPORT_MAX_BYTES || ''), 10);
  return Number.isFinite(n) && n >= 64 * 1024 ? Math.min(n, 32 * 1024 * 1024) : DEFAULT_MAX_ARCHIVE_BYTES;
}

function isDisabled(env) {
  return String(envOf(env).SIRAGPT_SKILL_IMPORT_DISABLED || '') === '1';
}

// ─── Source classification ──────────────────────────────────────────────────

/**
 * @returns {{ kind:'clawhub'|'github'|'url', ref:string, slug?:string, owner?:string, repo?:string, path?:string, gitRef?:string, url?:string }}
 */
function classifySource(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new SkillImportError('skill_source_required', 'Indica qué skill importar: un slug de ClawHub, «owner/repo» de GitHub o la URL de un SKILL.md.', 400);
  if (raw.length > 500) throw new SkillImportError('skill_source_invalid', 'La referencia es demasiado larga.', 400);
  const lower = raw.toLowerCase();
  if (lower.startsWith('clawhub:')) {
    const slug = lower.slice('clawhub:'.length).trim();
    if (!SLUG_RE.test(slug)) throw new SkillImportError('skill_source_invalid', 'El slug de ClawHub no es válido (letras minúsculas, números, guiones).', 400);
    return { kind: 'clawhub', ref: slug, slug };
  }
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch { throw new SkillImportError('skill_source_invalid', 'La URL no es válida.', 400); }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'clawhub.ai') {
      const m = /^\/(?:skills?|s)\/([a-z0-9][a-z0-9_-]{0,63})\/?$/i.exec(parsed.pathname);
      if (m) return { kind: 'clawhub', ref: m[1].toLowerCase(), slug: m[1].toLowerCase() };
      throw new SkillImportError('skill_source_invalid', 'No reconozco esa página de ClawHub; usa https://clawhub.ai/skills/<slug>.', 400);
    }
    if (host === 'github.com') {
      const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length < 2) throw new SkillImportError('skill_source_invalid', 'La URL de GitHub debe apuntar a un repositorio.', 400);
      const [owner, repoRaw, mode, gitRef, ...rest] = parts;
      const repo = repoRaw.replace(/\.git$/i, '');
      let path = '';
      let file = null;
      if (mode === 'tree' || mode === 'blob') {
        const tail = rest.join('/');
        if (mode === 'blob' && /\.md$/i.test(tail)) {
          file = tail;
          path = tail.split('/').slice(0, -1).join('/');
        } else {
          path = tail;
        }
      }
      return { kind: 'github', ref: raw, owner, repo, path, gitRef: gitRef || null, file };
    }
    if (/\.(zip|skill)(\?|$)/i.test(parsed.pathname) || /\.md(\?|$)/i.test(parsed.pathname)) {
      return { kind: 'url', ref: raw, url: raw };
    }
    throw new SkillImportError('skill_source_invalid', 'Una URL debe apuntar a un SKILL.md o a un paquete .zip/.skill (o a GitHub / ClawHub).', 400);
  }
  if (lower.startsWith('github:') || raw.includes('/')) {
    const m = GITHUB_REF_RE.exec(raw);
    if (!m) throw new SkillImportError('skill_source_invalid', 'Usa «owner/repo», «owner/repo/ruta@rama» o una URL de GitHub.', 400);
    return { kind: 'github', ref: raw, owner: m[1], repo: m[2].replace(/\.git$/i, ''), path: (m[3] || '').replace(/^\/+|\/+$/g, ''), gitRef: m[4] || null, file: null };
  }
  if (SLUG_RE.test(lower)) return { kind: 'clawhub', ref: lower, slug: lower };
  throw new SkillImportError('skill_source_invalid', 'No reconozco esa referencia. Usa un slug de ClawHub, «owner/repo» o una URL.', 400);
}

// ─── Guarded HTTP ───────────────────────────────────────────────────────────

function defaultDnsCheck(hostname) {
  // DNS anti-rebinding: every A/AAAA must be public (connectors/web-fetch).
  const { resolveAndAssertSafe } = require('./connectors/web-fetch');
  return resolveAndAssertSafe(hostname);
}

async function readCapped(response, maxBytes, label) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw new SkillImportError('skill_too_large', `${label} supera el máximo de ${Math.round(maxBytes / 1024)} KB.`, 413);
    return buf;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new SkillImportError('skill_too_large', `${label} supera el máximo de ${Math.round(maxBytes / 1024)} KB.`, 413);
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks);
}

/**
 * GET with the web_fetch posture. Returns { status, contentType, buffer, finalUrl }.
 * Non-2xx statuses are returned (not thrown) unless `okOnly`.
 */
async function guardedGet(url, {
  accept = '*/*',
  headers = {},
  maxBytes = MAX_MARKDOWN_BYTES,
  label = 'La descarga',
  fetchImpl = null,
  dnsCheck = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  okOnly = true,
  allowStatuses = [],
} = {}) {
  const doFetch = fetchImpl || undiciFetch;
  const checkDns = dnsCheck || defaultDnsCheck;
  let current = assertSafeUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dispatchers = [];
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const addresses = await checkDns(current.hostname);
      const dispatcher = fetchImpl ? null : createPinnedDispatcher(current.hostname, addresses);
      if (dispatcher) dispatchers.push(dispatcher);
      let res;
      try {
        res = await doFetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': 'siraGPT-skills-import/1.0 (+https://siragpt.com)', accept, ...headers },
          ...(dispatcher ? { dispatcher } : {}),
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw new SkillImportError('skill_fetch_timeout', `La descarga de ${current.hostname} tardó demasiado.`, 504);
        throw new SkillImportError('skill_fetch_failed', `No pude conectar con ${current.hostname}.`, 502);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* ignore */ }
        if (!location || hop === MAX_REDIRECTS) throw new SkillImportError('skill_fetch_failed', 'Demasiadas redirecciones.', 502);
        // Redirects are re-validated: a public host cannot bounce into a private one.
        current = assertSafeUrl(new URL(location, current).toString());
        // Never forward credentials across hosts.
        if (headers.authorization) delete headers.authorization;
        continue;
      }
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      if (okOnly && !(res.status >= 200 && res.status < 300) && !allowStatuses.includes(res.status)) {
        try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* ignore */ }
        if (res.status === 404) throw new SkillImportError('skill_not_found', `No encontré el recurso en ${current.hostname} (404).`, 404);
        if (res.status === 401 || res.status === 403) throw new SkillImportError('skill_fetch_forbidden', `${current.hostname} rechazó la descarga (${res.status}).`, 403);
        throw new SkillImportError('skill_fetch_failed', `${current.hostname} respondió ${res.status}.`, 502);
      }
      const buffer = await readCapped(res, maxBytes, label);
      return { status: res.status, contentType, buffer, finalUrl: current.toString() };
    }
    throw new SkillImportError('skill_fetch_failed', 'Demasiadas redirecciones.', 502);
  } finally {
    clearTimeout(timer);
    await Promise.all(dispatchers.map((d) => Promise.resolve(d.close()).catch(() => {})));
  }
}

function parseJsonBuffer(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new SkillImportError('skill_fetch_failed', `${label} devolvió una respuesta que no es JSON.`, 502);
  }
}

// ─── Archive → SKILL.md ─────────────────────────────────────────────────────

function skillMarkdownFromZip(buffer, { label = 'El paquete' } = {}) {
  let zip;
  try {
    const PizZip = require('pizzip');
    zip = new PizZip(buffer);
  } catch {
    throw new SkillImportError('skill_archive_invalid', `${label} no es un .zip válido.`, 400);
  }
  const candidates = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && /(^|\/)skill\.md$/i.test(name) && !/(^|\/)(__MACOSX|\.)/.test(name))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (!candidates.length) throw new SkillImportError('skill_archive_no_skill_md', `${label} no contiene un SKILL.md.`, 400);
  const entry = candidates[0];
  const text = zip.file(entry).asText();
  const folder = entry.split('/').slice(-2, -1)[0] || '';
  return { content: text, entry, folder };
}

function contentIsMarkdownLike(contentType, text) {
  if (/text\/html/.test(contentType)) return false;
  if (/^\s*<!doctype html|^\s*<html/i.test(text)) return false;
  return true;
}

// ─── ClawHub ────────────────────────────────────────────────────────────────

function hubHeaders(env) {
  const token = String(envOf(env).CLAWHUB_TOKEN || '').trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function hubJson(path, { env, search = null, deps = {}, allowStatuses = [], tolerate404 = false } = {}) {
  const base = hubBaseUrl(env);
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(search || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
  let res;
  try {
    res = await guardedGet(url.toString(), {
      accept: 'application/json',
      headers: hubHeaders(env),
      maxBytes: MAX_JSON_BYTES,
      label: 'La respuesta de ClawHub',
      fetchImpl: deps.fetchImpl,
      dnsCheck: deps.dnsCheck,
      allowStatuses,
    });
  } catch (err) {
    if (tolerate404 && err && err.code === 'skill_not_found') return null;
    if (err instanceof SkillImportError) {
      throw new SkillImportError(err.code === 'skill_not_found' ? 'skill_not_found' : 'marketplace_unavailable',
        err.code === 'skill_not_found' ? 'ClawHub no tiene esa skill.' : `ClawHub no está disponible ahora (${err.message}).`,
        err.code === 'skill_not_found' ? 404 : 502);
    }
    throw err;
  }
  return parseJsonBuffer(res.buffer, 'ClawHub');
}

function normaliseSearchRow(row, base) {
  if (!row || typeof row !== 'object') return null;
  const slug = String(row.slug || row.name || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  const publisher = row.publisher && typeof row.publisher === 'object' ? row.publisher.handle : (row.ownerHandle || row.owner || null);
  const install = row.install && typeof row.install === 'object' ? row.install : null;
  return {
    slug,
    name: String(row.displayName || row.title || slug).slice(0, 120),
    summary: String(row.summary || row.description || '').slice(0, 400),
    publisher: publisher ? String(publisher).slice(0, 80) : null,
    official: Boolean(row.official || row.isOfficial),
    source: String((install && install.kind) || row.source || 'clawhub').slice(0, 40),
    installRef: `clawhub:${slug}`,
    url: `${base}/skills/${encodeURIComponent(slug)}`,
    ...(row.metrics && typeof row.metrics === 'object' && Number.isFinite(Number(row.metrics.installs)) ? { installs: Number(row.metrics.installs) } : {}),
  };
}

/** Search the ClawHub marketplace. Returns [] for an empty query. */
async function searchMarketplace(query, { limit = 10, env = null, fetchImpl = null, dnsCheck = null } = {}) {
  if (isDisabled(env)) throw new SkillImportError('skill_import_disabled', 'La importación de skills está desactivada en este servidor.', 503);
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { query: q, results: [], source: hubBaseUrl(env) };
  const n = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Number(limit) || 10));
  const data = await hubJson('/api/v1/search', { env, search: { q, limit: n }, deps: { fetchImpl, dnsCheck } });
  const rows = Array.isArray(data) ? data : (Array.isArray(data && data.results) ? data.results : (Array.isArray(data && data.items) ? data.items : []));
  const base = hubBaseUrl(env);
  const results = rows.map((row) => normaliseSearchRow(row, base)).filter(Boolean).slice(0, n);
  return { query: q, results, source: base };
}

function verdictBlocks(verify) {
  if (!verify || typeof verify !== 'object') return null;
  const decision = String(verify.decision || '').toLowerCase();
  if (verify.ok === false || BLOCKED_VERDICTS.has(decision)) {
    const reasons = Array.isArray(verify.reasons) ? verify.reasons.map((r) => String(r).slice(0, 200)).slice(0, 6) : [];
    return reasons.length ? reasons : [decision || 'rechazada por ClawHub'];
  }
  return null;
}

async function resolveClawHub(source, { env, deps }) {
  const slug = source.slug;
  const base = hubBaseUrl(env);
  // 1. Security verdict (OpenClaw-style verify before install). A missing
  //    verify endpoint is tolerated; a failing verdict is not.
  const verify = await hubJson(`/api/v1/skills/${encodeURIComponent(slug)}/verify`, { env, deps, tolerate404: true });
  const blocked = verdictBlocks(verify);
  if (blocked) {
    throw new SkillImportError('skill_blocked', `ClawHub marca «${slug}» como no segura: ${blocked.join('; ')}.`, 409, { reasons: blocked });
  }
  // 2. Install resolution: archive download or commit-pinned GitHub source.
  const install = await hubJson(`/api/v1/skills/${encodeURIComponent(slug)}/install`, {
    env, deps, tolerate404: true, allowStatuses: [403, 409, 410, 423],
  });
  if (install && install.ok === false) {
    throw new SkillImportError('skill_blocked', `ClawHub no permite instalar «${slug}»: ${String(install.message || install.reason || 'bloqueada').slice(0, 300)}.`, 409, { reason: install.reason || null });
  }
  const displayName = (verify && verify.displayName) || (install && install.displayName) || null;
  const publisher = (verify && verify.publisherHandle) || null;
  if (install && install.installKind === 'github' && install.github && install.github.repo) {
    const gh = install.github;
    const commit = String(gh.commit || '').trim();
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new SkillImportError('skill_source_invalid', 'ClawHub devolvió un origen de GitHub sin commit fijado.', 502);
    const path = String(gh.path || '').replace(/^\/+|\/+$/g, '');
    const content = await fetchGitHubSkillMarkdown({ owner: gh.repo.split('/')[0], repo: gh.repo.split('/')[1], gitRef: commit, path, file: null }, { env, deps });
    return { content: content.content, version: commit.slice(0, 12), url: gh.sourceUrl || content.url, displayName, publisher, via: 'clawhub+github' };
  }
  let downloadUrl = install && install.installKind === 'archive' && install.archive && install.archive.downloadUrl
    ? new URL(String(install.archive.downloadUrl), `${base}/`).toString()
    : `${base}/api/v1/download?slug=${encodeURIComponent(slug)}`;
  const version = (install && install.archive && install.archive.version) || null;
  const archive = await guardedGet(downloadUrl, {
    accept: 'application/zip,application/octet-stream;q=0.9,*/*;q=0.5',
    headers: new URL(downloadUrl).origin === new URL(base).origin ? hubHeaders(env) : {},
    maxBytes: maxArchiveBytes(env),
    label: 'El paquete de la skill',
    fetchImpl: deps.fetchImpl,
    dnsCheck: deps.dnsCheck,
  });
  const unpacked = skillMarkdownFromZip(archive.buffer, { label: `El paquete de «${slug}»` });
  return { content: unpacked.content, version, url: `${base}/skills/${encodeURIComponent(slug)}`, displayName, publisher, via: 'clawhub' };
}

// ─── GitHub ─────────────────────────────────────────────────────────────────

function githubHeaders(env) {
  const token = String(envOf(env).SIRAGPT_GITHUB_TOKEN || envOf(env).GITHUB_TOKEN || '').trim();
  return token ? { authorization: `token ${token}` } : {};
}

async function fetchGitHubSkillMarkdown(source, { env, deps }) {
  const owner = String(source.owner || '').trim();
  const repo = String(source.repo || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new SkillImportError('skill_source_invalid', 'Referencia de GitHub inválida.', 400);
  }
  const ref = source.gitRef ? String(source.gitRef).replace(/^\/+|\/+$/g, '') : 'HEAD';
  if (!/^[A-Za-z0-9_.\-/]{1,200}$/.test(ref)) throw new SkillImportError('skill_source_invalid', 'Referencia git inválida.', 400);
  const dir = String(source.path || '').replace(/^\/+|\/+$/g, '');
  if (/\.\./.test(dir)) throw new SkillImportError('skill_source_invalid', 'Ruta inválida.', 400);
  const file = source.file ? String(source.file).replace(/^\/+/, '') : (dir ? `${dir}/SKILL.md` : 'SKILL.md');
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${ref.split('/').map(encodeURIComponent).join('/')}/${file.split('/').map(encodeURIComponent).join('/')}`;
  const res = await guardedGet(url, {
    accept: 'text/plain,text/markdown;q=0.9,*/*;q=0.5',
    headers: githubHeaders(env),
    maxBytes: MAX_MARKDOWN_BYTES,
    label: 'El SKILL.md',
    fetchImpl: deps.fetchImpl,
    dnsCheck: deps.dnsCheck,
  });
  const content = res.buffer.toString('utf8');
  if (!contentIsMarkdownLike(res.contentType, content)) throw new SkillImportError('skill_not_markdown', 'GitHub devolvió una página, no un SKILL.md.', 400);
  return { content, url: `https://github.com/${owner}/${repo}${dir ? `/tree/${ref}/${dir}` : ''}`, version: ref === 'HEAD' ? null : ref, via: 'github' };
}

// ─── Plain URL ──────────────────────────────────────────────────────────────

async function fetchUrlSkill(source, { env, deps }) {
  const url = source.url;
  const isArchive = /\.(zip|skill)(\?|$)/i.test(new URL(url).pathname);
  const res = await guardedGet(url, {
    accept: isArchive ? 'application/zip,application/octet-stream;q=0.9,*/*;q=0.5' : 'text/markdown,text/plain;q=0.9,*/*;q=0.5',
    maxBytes: isArchive ? maxArchiveBytes(env) : MAX_MARKDOWN_BYTES,
    label: isArchive ? 'El paquete' : 'El SKILL.md',
    fetchImpl: deps.fetchImpl,
    dnsCheck: deps.dnsCheck,
  });
  if (isArchive) {
    const unpacked = skillMarkdownFromZip(res.buffer);
    return { content: unpacked.content, url, version: null, via: 'url', folder: unpacked.folder };
  }
  const content = res.buffer.toString('utf8');
  if (!contentIsMarkdownLike(res.contentType, content)) throw new SkillImportError('skill_not_markdown', 'La URL devolvió una página web, no un SKILL.md.', 400);
  return { content, url, version: null, via: 'url' };
}

// ─── Import ─────────────────────────────────────────────────────────────────

function fallbackNameFor(source, fetched) {
  if (source.kind === 'clawhub') return source.slug;
  if (source.kind === 'github') {
    const dir = String(source.path || '').split('/').filter(Boolean).pop();
    return dir || source.repo;
  }
  if (fetched && fetched.folder) return fetched.folder;
  const last = String(new URL(source.url).pathname).split('/').filter(Boolean).pop() || '';
  return last.replace(/\.(md|zip|skill)$/i, '').replace(/^skill$/i, '');
}

function pickName(parsedName, override) {
  const wanted = override ? chatSkills.normalizeSkillName(override) : null;
  if (override && !wanted) throw new SkillImportError('skill_name_invalid', 'El nombre debe tener letras minúsculas, números, guiones o guion bajo (máx. 64).', 400);
  let name = wanted || parsedName;
  // A marketplace skill may share a name with a SiraGPT built-in; keep it
  // installable without shadowing the built-in.
  if (!wanted && chatSkills.reservedSkillName(name)) name = `${name}-importada`.slice(0, 64);
  return name;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function recordImport({ userId, name, provenance, persist, root }) {
  try {
    const state = chatSkills.getSkillState({ userId, persist, root });
    const imports = { ...((state.raw && state.raw.imports) || {}), [name]: provenance };
    chatSkills.saveSkillState({ userId, persist, root, state: { ...state.raw, imports } });
    return true;
  } catch {
    return false;
  }
}

function forgetImport({ userId, name, persist, root }) {
  try {
    const state = chatSkills.getSkillState({ userId, persist, root });
    const imports = { ...((state.raw && state.raw.imports) || {}) };
    if (!imports[name]) return false;
    delete imports[name];
    chatSkills.saveSkillState({ userId, persist, root, state: { ...state.raw, imports } });
    return true;
  } catch {
    return false;
  }
}

function listImports({ userId, persist = null, root = undefined } = {}) {
  try {
    const state = chatSkills.getSkillState({ userId, persist, root });
    return { ...((state.raw && state.raw.imports) || {}) };
  } catch {
    return {};
  }
}

/**
 * Import a skill into the user's Biblioteca.
 * @returns {Promise<{ skill:object, provenance:object, replaced:boolean }>}
 */
async function importSkill({
  userId,
  source,
  name = null,
  overwrite = false,
  persist = null,
  root = undefined,
  env = null,
  fetchImpl = null,
  dnsCheck = null,
  now = new Date(),
} = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new SkillImportError('auth_required', 'Inicia sesión para importar skills.', 401);
  if (isDisabled(env)) throw new SkillImportError('skill_import_disabled', 'La importación de skills está desactivada en este servidor.', 503);
  const classified = classifySource(source);
  const deps = { fetchImpl, dnsCheck };
  let fetched;
  if (classified.kind === 'clawhub') fetched = await resolveClawHub(classified, { env, deps });
  else if (classified.kind === 'github') fetched = await fetchGitHubSkillMarkdown(classified, { env, deps });
  else fetched = await fetchUrlSkill(classified, { env, deps });

  let parsed;
  try {
    parsed = chatSkills.parseUploadedSkill(fetched.content, fallbackNameFor(classified, fetched));
  } catch (err) {
    throw new SkillImportError(err && err.code ? String(err.code) : 'skill_invalid', err && err.message ? err.message : 'El SKILL.md no es válido.', Number(err && err.status) || 400);
  }
  const finalName = pickName(parsed.name, name);
  const existingImports = listImports({ userId: uid, persist, root });
  const previouslyImported = Boolean(existingImports[finalName]);
  let skill;
  try {
    skill = chatSkills.createUserSkill({
      userId: uid,
      name: finalName,
      description: parsed.description || (fetched.displayName ? String(fetched.displayName) : ''),
      body: parsed.body,
      // Re-importing a skill we imported before updates it in place.
      overwrite: Boolean(overwrite) || previouslyImported,
      persist,
      root,
    });
  } catch (err) {
    const code = err && err.code ? String(err.code) : 'skill_save_failed';
    const status = Number(err && err.status) || 500;
    const message = err && err.message ? err.message : 'No se pudo guardar la skill.';
    throw new SkillImportError(code, code === 'name_taken' ? `${message} Repite con overwrite: true para reemplazarla, o indica otro nombre.` : message, status);
  }
  const provenance = {
    source: classified.kind,
    ref: String(classified.ref).slice(0, 400),
    url: String(fetched.url || '').slice(0, 400),
    ...(fetched.version ? { version: String(fetched.version).slice(0, 100) } : {}),
    ...(fetched.displayName ? { displayName: String(fetched.displayName).slice(0, 120) } : {}),
    sha256: sha256(fetched.content),
    importedAt: now.toISOString(),
  };
  recordImport({ userId: uid, name: finalName, provenance, persist, root });
  return {
    skill,
    provenance: { ...provenance, via: fetched.via, publisher: fetched.publisher || null },
    replaced: previouslyImported || Boolean(overwrite),
    renamed: finalName !== parsed.name ? parsed.name : null,
  };
}

module.exports = {
  SkillImportError,
  DEFAULT_CLAWHUB_URL,
  MAX_MARKDOWN_BYTES,
  DEFAULT_MAX_ARCHIVE_BYTES,
  classifySource,
  guardedGet,
  skillMarkdownFromZip,
  searchMarketplace,
  importSkill,
  listImports,
  forgetImport,
  hubBaseUrl,
  maxArchiveBytes,
  _internals: { normaliseSearchRow, verdictBlocks, pickName, fallbackNameFor, resolveClawHub, fetchGitHubSkillMarkdown },
};
