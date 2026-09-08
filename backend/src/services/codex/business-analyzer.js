'use strict';

const { mutateProjectBrief } = require('./project-brief-store');

const BUSINESS_AUDIT_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCES = 20;
const SOCIAL_HOSTS = Object.freeze([
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'tiktok.com',
  'x.com',
  'twitter.com',
  'youtube.com',
]);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function bounded(value, max = 600) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.port) return null;
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function hostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isSocialUrl(value) {
  const host = hostname(value);
  return SOCIAL_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

function defaultSearch(query, options = {}) {
  return require('../agents/web-search').search(query, {
    maxResults: options.maxResults || 8,
    timeoutMs: options.timeoutMs || 8_000,
    includeScientific: false,
  });
}

function defaultWebFetch({ url, maxChars = 30_000 }) {
  return require('../agent-harness/tools/web-fetch-tool').executeAgentWebFetch({
    url,
    maxChars,
  });
}

function readinessArea(readiness, id) {
  return (Array.isArray(readiness?.areas) ? readiness.areas : [])
    .find((area) => area?.id === id) || null;
}

function normalizeSource(value) {
  const url = canonicalUrl(value?.url);
  if (!url) return null;
  return {
    kind: bounded(value?.kind, 40) || 'search',
    title: bounded(value?.title, 240) || null,
    url,
    snippet: bounded(value?.snippet, 600) || null,
    provider: bounded(value?.provider || value?.source, 80) || null,
  };
}

function normalizeSources(input) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(input) ? input : []) {
    const source = normalizeSource(value);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
    if (result.length >= MAX_SOURCES) break;
  }
  return result;
}

function signal(id, label, status, evidence, sources = []) {
  return {
    id,
    label,
    status,
    evidence: bounded(evidence, 1_000),
    sources: normalizeSources(sources).map((item) => item.url),
  };
}

function signalScore(status) {
  if (status === 'ready') return 25;
  if (status === 'observed') return 16;
  if (status === 'needs_attention') return 6;
  return 0;
}

function priorityGap({ id, status, workspaceReady, websiteUrl }) {
  if (status === 'ready') return null;
  if (id === 'software') {
    return {
      id: 'software',
      priority: 'P0',
      score: 100,
      departmentId: 'product-engineering',
      title: 'Establecer software propio ejecutable',
      action: workspaceReady
        ? 'Auditar el producto existente, corregir el cuello de botella principal y cerrar con pruebas.'
        : 'Crear o recuperar un workspace aislado y entregar una primera version ejecutable.',
    };
  }
  if (id === 'landing') {
    return {
      id: 'landing',
      priority: 'P0',
      score: 95,
      departmentId: 'product-engineering',
      title: websiteUrl ? 'Mejorar la landing existente' : 'Construir la landing principal',
      action: websiteUrl
        ? 'Abrir la landing en el workspace, mejorar conversion y accesibilidad, y verificarla en navegador.'
        : 'Construir una landing Vite con propuesta de valor, CTA, SEO basico, pruebas y preview.',
    };
  }
  if (id === 'seo') {
    return {
      id: 'seo',
      priority: 'P1',
      score: 75,
      departmentId: 'marketing',
      title: 'Corregir presencia e indexacion SEO',
      action: 'Definir title, contenido indexable, metadata, sitemap y medicion; verificar la URL publicada.',
    };
  }
  return {
    id: 'social',
    priority: 'P1',
    score: 70,
    departmentId: 'marketing',
    title: 'Activar presencia social verificable',
    action: 'Conectar cuentas reales, preparar calendario y mantener publicaciones bajo la politica de revision.',
  };
}

function normalizeAudit(value) {
  const source = asRecord(value);
  if (Number(source.version) !== BUSINESS_AUDIT_VERSION) return null;
  const signals = Array.isArray(source.signals)
    ? source.signals
      .map((item) => signal(
        bounded(item?.id, 40),
        bounded(item?.label, 120),
        ['ready', 'observed', 'needs_attention', 'blocked'].includes(item?.status)
          ? item.status
          : 'needs_attention',
        item?.evidence,
        (Array.isArray(item?.sources) ? item.sources : []).map((url) => ({ url })),
      ))
      .filter((item) => item.id)
      .slice(0, 8)
    : [];
  const gaps = (Array.isArray(source.gaps) ? source.gaps : [])
    .map((item) => ({
      id: bounded(item?.id, 60),
      priority: ['P0', 'P1', 'P2'].includes(item?.priority) ? item.priority : 'P2',
      score: Math.max(0, Math.min(100, Number(item?.score) || 0)),
      departmentId: bounded(item?.departmentId, 100) || 'ceo-office',
      title: bounded(item?.title, 180),
      action: bounded(item?.action, 700),
      evidence: bounded(item?.evidence, 1_000) || null,
    }))
    .filter((item) => item.id && item.title)
    .slice(0, 12);
  return {
    version: BUSINESS_AUDIT_VERSION,
    generatedAt: bounded(source.generatedAt, 40) || new Date(0).toISOString(),
    projectId: bounded(source.projectId, 180) || null,
    companyName: bounded(source.companyName, 180) || 'Empresa',
    status: gaps.length ? 'gaps_detected' : 'healthy',
    score: Math.max(0, Math.min(100, Number(source.score) || 0)),
    networkUsed: source.networkUsed === true,
    websiteUrl: canonicalUrl(source.websiteUrl),
    signals,
    gaps,
    sources: normalizeSources(source.sources),
  };
}

function readBusinessAudit(project) {
  return normalizeAudit(asRecord(project?.brief).businessAudit);
}

function isAuditFresh(audit, now = new Date(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const normalized = normalizeAudit(audit);
  const generatedAt = normalized ? Date.parse(normalized.generatedAt) : NaN;
  return Number.isFinite(generatedAt)
    && now.getTime() - generatedAt >= 0
    && now.getTime() - generatedAt <= Math.max(60_000, Number(maxAgeMs) || DEFAULT_MAX_AGE_MS);
}

async function collectSearchSources({ companyName, webSearch }) {
  const queries = [
    `"${companyName}" sitio oficial software`,
    `"${companyName}" LinkedIn Facebook Instagram X`,
  ];
  const settled = await Promise.allSettled(
    queries.map((query) => webSearch(query, { maxResults: 8, timeoutMs: 8_000 })),
  );
  const sources = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const row of Array.isArray(result.value?.results) ? result.value.results : []) {
      sources.push({
        kind: isSocialUrl(row?.url) ? 'social' : 'search',
        title: row?.title,
        url: row?.url,
        snippet: row?.snippet,
        provider: result.value?.provider || row?.source,
      });
    }
  }
  return normalizeSources(sources);
}

function selectWebsiteUrl({ profile, readiness, sources }) {
  const explicit = canonicalUrl(
    readiness?.evidence?.publishedUrl
      || profile?.websiteUrl,
  );
  if (explicit) return explicit;
  return sources.find((source) => !isSocialUrl(source.url))?.url || null;
}

async function analyzeBusiness({
  project,
  companyContext,
  webSearch = defaultSearch,
  webFetch = defaultWebFetch,
  browserAudit = null,
  networkEnabled = true,
  now = () => new Date(),
} = {}) {
  const profile = asRecord(companyContext?.profile);
  const readiness = asRecord(companyContext?.readiness);
  const companyName = bounded(profile.companyName || project?.name, 180) || 'Empresa';
  let sources = [];
  if (networkEnabled && typeof webSearch === 'function') {
    sources = await collectSearchSources({ companyName, webSearch });
  }
  const websiteUrl = selectWebsiteUrl({ profile, readiness, sources });
  let page = null;
  if (networkEnabled && websiteUrl && typeof webFetch === 'function') {
    try {
      const fetched = await webFetch({ url: websiteUrl, maxChars: 30_000 });
      if (fetched && Number(fetched.status) > 0) {
        page = {
          url: canonicalUrl(fetched.finalUrl || fetched.url || websiteUrl) || websiteUrl,
          status: Number(fetched.status),
          title: bounded(fetched.title, 240) || null,
          text: bounded(fetched.text, 30_000),
          contentType: bounded(fetched.contentType, 160) || null,
        };
        sources = normalizeSources([
          ...sources,
          {
            kind: 'website',
            title: page.title,
            url: page.url,
            snippet: page.text.slice(0, 600),
          },
        ]);
      }
    } catch {
      page = null;
    }
  }
  let browser = null;
  if (page && page.status < 400 && typeof browserAudit === 'function') {
    try {
      const result = await browserAudit({ url: page.url });
      browser = {
        rendered: result?.rendered === true || result?.ok === true,
        title: bounded(result?.title, 240) || null,
        rootChars: Math.max(0, Number(result?.rootChars) || 0),
        errors: Array.isArray(result?.errors)
          ? result.errors.map((item) => bounded(item, 240)).filter(Boolean).slice(0, 8)
          : [],
      };
    } catch {
      browser = null;
    }
  }

  const workspaceReady = readiness?.evidence?.workspaceReady === true
    || readinessArea(readiness, 'software')?.status === 'ready';
  const pageHealthy = Boolean(page && page.status >= 200 && page.status < 400 && page.text.length >= 120);
  const browserHealthy = browser ? browser.rendered && browser.errors.length === 0 : null;
  const landingReady = pageHealthy && browserHealthy !== false;
  const socialConnections = Array.isArray(readiness?.evidence?.socialConnections)
    ? readiness.evidence.socialConnections
    : [];
  const socialSources = sources.filter((source) => isSocialUrl(source.url));
  const indexedWebsite = websiteUrl
    ? sources.some((source) => (
      source.kind === 'search'
      && hostname(source.url) === hostname(websiteUrl)
    ))
    : false;
  const pageMentionsProduct = /\b(app|aplicaci[oó]n|software|plataforma|producto|dashboard|iniciar sesi[oó]n|login)\b/i
    .test(page?.text || '');
  const titleReady = Boolean(page?.title && page.title.length >= 8);
  const contentReady = Boolean(page?.text && page.text.length >= 500);

  const signals = [
    signal(
      'software',
      'Software propio',
      workspaceReady || pageMentionsProduct ? 'ready' : 'blocked',
      workspaceReady
        ? 'Existe un workspace ejecutable y aislado.'
        : pageMentionsProduct
          ? 'La presencia publica describe un producto o software propio.'
          : 'No hay evidencia de un producto ejecutable ni de software propio.',
      sources.filter((source) => source.kind === 'website'),
    ),
    signal(
      'landing',
      'Landing publica',
      landingReady ? 'ready' : websiteUrl ? 'needs_attention' : 'blocked',
      landingReady
        ? `La URL responde y contiene contenido legible${browser ? ' verificado en navegador' : ''}.`
        : websiteUrl
          ? 'Existe una URL declarada, pero no se pudo verificar una landing saludable.'
          : 'No se encontro ni se declaro una landing publica.',
      sources.filter((source) => source.kind === 'website' || source.url === websiteUrl),
    ),
    signal(
      'social',
      'Redes activas',
      socialConnections.length ? 'ready' : socialSources.length ? 'observed' : 'needs_attention',
      socialConnections.length
        ? `Hay ${socialConnections.length} cuenta(s) OAuth conectada(s).`
        : socialSources.length
          ? `Se observaron ${socialSources.length} perfil(es) publicos; aun no estan conectados para operar.`
          : 'No hay cuentas conectadas ni perfiles publicos verificables en los resultados.',
      socialSources,
    ),
    signal(
      'seo',
      'SEO e indexacion',
      landingReady && titleReady && contentReady && indexedWebsite
        ? 'ready'
        : landingReady && titleReady && contentReady
          ? 'observed'
          : 'needs_attention',
      landingReady
        ? `Titulo ${titleReady ? 'presente' : 'insuficiente'}, contenido ${contentReady ? 'indexable' : 'escaso'} e indexacion ${indexedWebsite ? 'observada' : 'no confirmada'}.`
        : 'Sin una landing verificable no se puede confirmar SEO tecnico ni contenido indexable.',
      sources.filter((source) => source.kind === 'search' && !isSocialUrl(source.url)),
    ),
  ];
  const gaps = signals
    .map((item) => {
      const gap = priorityGap({
        id: item.id,
        status: item.status,
        workspaceReady,
        websiteUrl,
      });
      return gap ? { ...gap, evidence: item.evidence } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return normalizeAudit({
    version: BUSINESS_AUDIT_VERSION,
    generatedAt: now().toISOString(),
    projectId: project?.id || null,
    companyName,
    status: gaps.length ? 'gaps_detected' : 'healthy',
    score: signals.reduce((total, item) => total + signalScore(item.status), 0),
    networkUsed: networkEnabled,
    websiteUrl: page?.url || websiteUrl,
    signals,
    gaps,
    sources,
  });
}

async function persistBusinessAudit({ prisma, project, audit }) {
  const normalized = normalizeAudit(audit);
  if (!normalized || !project?.id || !prisma?.codexProject) return null;
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => ({ ...brief, businessAudit: normalized }),
  });
  return normalized;
}

function formatBusinessAudit(audit) {
  const normalized = normalizeAudit(audit);
  if (!normalized) return '';
  const lines = [
    `AUDITORIA DE PRESENCIA (${normalized.generatedAt}, ${normalized.score}%):`,
    ...normalized.signals.map((item) => `- [${item.status}] ${item.label}: ${item.evidence}`),
  ];
  if (normalized.gaps.length) {
    lines.push('BRECHAS PRIORIZADAS:');
    for (const gap of normalized.gaps.slice(0, 8)) {
      lines.push(`- ${gap.priority} ${gap.title} -> ${gap.departmentId}: ${gap.action}`);
    }
  }
  return lines.join('\n').slice(0, 7_000);
}

module.exports = {
  BUSINESS_AUDIT_VERSION,
  DEFAULT_MAX_AGE_MS,
  analyzeBusiness,
  canonicalUrl,
  formatBusinessAudit,
  isAuditFresh,
  normalizeAudit,
  persistBusinessAudit,
  readBusinessAudit,
};
