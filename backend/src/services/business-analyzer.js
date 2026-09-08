/**
 * business-analyzer.js — P3.2 Business presence audit (company-os-master-plan).
 *
 * Audits a company's digital presence — landing page health, social networks,
 * own-software signals — and produces a prioritized gap list that feeds the
 * CEO Office (P3.3).
 *
 * Pure orchestration over INJECTED deps (never touches the network itself):
 *   analyzeBusinessPresence({
 *     company: { name, urls?: { web?, socials? } },
 *     deps: {
 *       webSearch({ query }) -> [{ title, url, snippet }],
 *       fetchPage(url)       -> { status, html },
 *     },
 *   })
 *
 * Every external call degrades gracefully: a throwing dep never aborts the
 * audit, it just downgrades the corresponding section.
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────

const SOCIAL_NETWORKS = Object.freeze([
  { id: 'x', domains: ['x.com', 'twitter.com'], searchDomain: 'x.com', missingPriority: 'baja' },
  { id: 'instagram', domains: ['instagram.com'], searchDomain: 'instagram.com', missingPriority: 'media' },
  { id: 'facebook', domains: ['facebook.com'], searchDomain: 'facebook.com', missingPriority: 'media' },
  { id: 'linkedin', domains: ['linkedin.com'], searchDomain: 'linkedin.com', missingPriority: 'media' },
  { id: 'tiktok', domains: ['tiktok.com'], searchDomain: 'tiktok.com', missingPriority: 'baja' },
]);

const ALL_SOCIAL_DOMAINS = SOCIAL_NETWORKS.flatMap((n) => n.domains);

const PRIORITY_ORDER = Object.freeze({ alta: 0, media: 1, baja: 2 });

const SUMMARY_MAX_CHARS = 600;

// Own-software heuristics: mentions of an app / login / API on the landing
// page or in search results.
const SOFTWARE_SIGNAL_PATTERNS = Object.freeze([
  { id: 'app', regex: /\b(app|aplicaci[oó]n m[oó]vil|app store|google play|descarga la app)\b/i },
  { id: 'login', regex: /\b(login|log ?in|sign ?in|iniciar sesi[oó]n|mi cuenta|portal de clientes)\b/i },
  { id: 'api', regex: /\bAPI\b/ },
  { id: 'platform', regex: /\b(plataforma|dashboard|saas)\b/i },
]);

// ── Small helpers ─────────────────────────────────────────────────────────

function hostnameOf(url) {
  try {
    const { hostname, protocol } = new URL(String(url || ''));
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function hostMatchesDomain(hostname, domain) {
  if (!hostname) return false;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isSocialUrl(url) {
  const host = hostnameOf(url);
  return ALL_SOCIAL_DOMAINS.some((domain) => hostMatchesDomain(host, domain));
}

function normalizeResults(results) {
  if (!Array.isArray(results)) return [];
  return results
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: typeof r.url === 'string' ? r.url : '',
      snippet: typeof r.snippet === 'string' ? r.snippet : '',
    }));
}

/** Run deps.webSearch defensively; a missing or throwing dep yields []. */
async function safeSearch(webSearch, query) {
  if (typeof webSearch !== 'function') return [];
  try {
    return normalizeResults(await webSearch({ query }));
  } catch {
    return [];
  }
}

// ── HTML heuristics (regex only — no new dependencies) ────────────────────

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return match ? match[1].trim() : '';
}

function findMetaContent(html, name) {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  const nameRe = new RegExp(`name\\s*=\\s*["']${name}["']`, 'i');
  for (const tag of tags) {
    if (!nameRe.test(tag)) continue;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (content && content[1].trim()) return content[1].trim();
  }
  return '';
}

/** Inspect landing HTML for title / meta description / viewport. */
function inspectLandingHtml(html) {
  return {
    hasTitle: extractTitle(html).length > 0,
    hasMetaDescription: findMetaContent(html, 'description').length > 0,
    hasViewport: findMetaContent(html, 'viewport').length > 0,
  };
}

/** Detect own-software signals in landing HTML and search result texts. */
function detectSoftwareSignals({ landingHtml = '', searchTexts = [] } = {}) {
  const signals = [];
  const seen = new Set();
  const push = (id, source, evidence) => {
    if (seen.has(id)) return;
    seen.add(id);
    signals.push({ id, source, evidence });
  };

  const landingText = stripHtmlTags(landingHtml);
  if (/type\s*=\s*["']password["']/i.test(String(landingHtml || ''))) {
    push('login', 'landing', 'password input field');
  }
  for (const { id, regex } of SOFTWARE_SIGNAL_PATTERNS) {
    const hit = regex.exec(landingText);
    if (hit) push(id, 'landing', hit[0]);
  }
  for (const text of searchTexts) {
    for (const { id, regex } of SOFTWARE_SIGNAL_PATTERNS) {
      const hit = regex.exec(String(text || ''));
      if (hit) push(id, 'search', hit[0]);
    }
  }
  return signals;
}

// ── Landing audit ─────────────────────────────────────────────────────────

async function resolveLandingUrl(company, webSearch, collectResults) {
  const provided = company.urls && typeof company.urls.web === 'string' ? company.urls.web.trim() : '';
  if (provided) return provided;

  const results = await safeSearch(webSearch, `${company.name} sitio web oficial`);
  collectResults(results);
  const candidate = results.find((r) => hostnameOf(r.url) && !isSocialUrl(r.url));
  return candidate ? candidate.url : '';
}

async function auditLanding(url, fetchPage) {
  const landing = {
    exists: Boolean(url),
    url: url || undefined,
    httpOk: false,
    hasTitle: false,
    hasMetaDescription: false,
    hasViewport: false,
  };
  if (!url) return { landing: { exists: false }, html: '' };
  if (typeof fetchPage !== 'function') return { landing, html: '' };

  let page = null;
  try {
    page = await fetchPage(url);
  } catch {
    return { landing, html: '' }; // degraded: URL known but unreachable
  }
  const status = page && typeof page === 'object' ? Number(page.status) : NaN;
  const html = page && typeof page === 'object' && typeof page.html === 'string' ? page.html : '';
  landing.httpOk = Number.isFinite(status) && status >= 200 && status < 400;
  if (landing.httpOk) Object.assign(landing, inspectLandingHtml(html));
  return { landing, html: landing.httpOk ? html : '' };
}

// ── Socials audit ─────────────────────────────────────────────────────────

async function auditSocials(company, webSearch, collectResults) {
  const provided = (company.urls && company.urls.socials && typeof company.urls.socials === 'object')
    ? company.urls.socials
    : {};
  const socials = {};

  for (const network of SOCIAL_NETWORKS) {
    const providedUrl = typeof provided[network.id] === 'string' ? provided[network.id].trim() : '';
    if (providedUrl) {
      socials[network.id] = { found: true, url: providedUrl };
      continue;
    }
    const results = await safeSearch(webSearch, `${company.name} site:${network.searchDomain}`);
    collectResults(results);
    const hit = results.find((r) => network.domains.some((d) => hostMatchesDomain(hostnameOf(r.url), d)));
    socials[network.id] = hit ? { found: true, url: hit.url } : { found: false };
  }
  return socials;
}

// ── Gap derivation ────────────────────────────────────────────────────────

function deriveGaps({ landing, socials, software }) {
  const gaps = [];

  if (!landing.exists) {
    gaps.push({
      id: 'missing-landing',
      gap: 'La empresa no tiene landing page: construir una landing profesional',
      priority: 'alta',
      suggestedDepartment: 'product-engineering',
    });
  } else if (!landing.httpOk) {
    gaps.push({
      id: 'landing-unreachable',
      gap: `La landing (${landing.url}) no responde correctamente: restaurar disponibilidad`,
      priority: 'alta',
      suggestedDepartment: 'product-engineering',
    });
  } else {
    if (!landing.hasTitle) {
      gaps.push({
        id: 'landing-missing-title',
        gap: 'La landing no tiene <title>: añadir título SEO',
        priority: 'media',
        suggestedDepartment: 'marketing',
      });
    }
    if (!landing.hasMetaDescription) {
      gaps.push({
        id: 'landing-missing-meta-description',
        gap: 'La landing no tiene meta description: añadir descripción SEO',
        priority: 'media',
        suggestedDepartment: 'marketing',
      });
    }
    if (!landing.hasViewport) {
      gaps.push({
        id: 'landing-missing-viewport',
        gap: 'La landing no tiene meta viewport: no está optimizada para móvil',
        priority: 'media',
        suggestedDepartment: 'product-engineering',
      });
    }
  }

  for (const network of SOCIAL_NETWORKS) {
    if (socials[network.id] && socials[network.id].found) continue;
    gaps.push({
      id: `social-${network.id}-missing`,
      gap: `Sin presencia detectada en ${network.id}: crear y activar el perfil`,
      priority: network.missingPriority,
      suggestedDepartment: 'marketing',
    });
  }

  if (!software.signals.length) {
    gaps.push({
      id: 'no-software-signals',
      gap: 'Sin señales de software propio (app/login/API): evaluar producto digital',
      priority: 'baja',
      suggestedDepartment: 'product-engineering',
    });
  }

  return gaps
    .map((gap, index) => ({ gap, index }))
    .sort((a, b) => (PRIORITY_ORDER[a.gap.priority] - PRIORITY_ORDER[b.gap.priority]) || (a.index - b.index))
    .map(({ gap }) => gap);
}

// ── Summary ───────────────────────────────────────────────────────────────

function buildSummary({ companyName, landing, socials, software, gaps }) {
  const parts = [`Auditoría de presencia digital de ${companyName}.`];

  if (!landing.exists) {
    parts.push('Sin landing page.');
  } else if (!landing.httpOk) {
    parts.push('Landing detectada pero inaccesible.');
  } else {
    const seoMissing = [
      !landing.hasTitle && 'title',
      !landing.hasMetaDescription && 'meta description',
      !landing.hasViewport && 'viewport',
    ].filter(Boolean);
    parts.push(seoMissing.length
      ? `Landing activa con SEO básico incompleto (falta: ${seoMissing.join(', ')}).`
      : 'Landing activa y con SEO básico correcto.');
  }

  const found = SOCIAL_NETWORKS.filter((n) => socials[n.id] && socials[n.id].found).map((n) => n.id);
  const missing = SOCIAL_NETWORKS.filter((n) => !socials[n.id] || !socials[n.id].found).map((n) => n.id);
  parts.push(found.length ? `Redes activas: ${found.join(', ')}.` : 'Sin redes sociales detectadas.');
  if (missing.length) parts.push(`Faltan: ${missing.join(', ')}.`);

  parts.push(software.signals.length
    ? `Señales de software propio: ${software.signals.map((s) => s.id).join(', ')}.`
    : 'Sin señales de software propio.');

  const alta = gaps.filter((g) => g.priority === 'alta').length;
  parts.push(`${gaps.length} gaps priorizados (${alta} de prioridad alta).`);

  const summary = parts.join(' ');
  return summary.length <= SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Audit a company's digital presence using injected deps only.
 *
 * @param {object} params
 * @param {object} params.company - { name, urls?: { web?, socials? } }
 * @param {object} [params.deps] - { webSearch, fetchPage }
 * @returns {Promise<{landing:object, socials:object, software:object, gaps:Array, summary:string}>}
 */
async function analyzeBusinessPresence({ company, deps = {} } = {}) {
  if (!company || typeof company.name !== 'string' || !company.name.trim()) {
    throw new TypeError('analyzeBusinessPresence: company.name is required');
  }
  const name = company.name.trim();
  const normalizedCompany = { ...company, name };
  const { webSearch, fetchPage } = deps;

  const allSearchResults = [];
  const collectResults = (results) => { allSearchResults.push(...results); };

  const landingUrl = await resolveLandingUrl(normalizedCompany, webSearch, collectResults);
  const { landing, html } = await auditLanding(landingUrl, fetchPage);
  const socials = await auditSocials(normalizedCompany, webSearch, collectResults);

  const software = {
    signals: detectSoftwareSignals({
      landingHtml: html,
      searchTexts: allSearchResults.map((r) => `${r.title} ${r.snippet}`),
    }),
  };

  const gaps = deriveGaps({ landing, socials, software });
  const summary = buildSummary({ companyName: name, landing, socials, software, gaps });

  return { landing, socials, software, gaps, summary };
}

module.exports = {
  analyzeBusinessPresence,
  // Exposed for unit tests
  inspectLandingHtml,
  detectSoftwareSignals,
  SOCIAL_NETWORKS,
  PRIORITY_ORDER,
  SUMMARY_MAX_CHARS,
};
