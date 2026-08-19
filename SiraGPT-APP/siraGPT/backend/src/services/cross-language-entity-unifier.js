'use strict';

/**
 * cross-language-entity-unifier.js
 *
 * Optional layer on top of `cross-turn-entity-tracker`. Recognises that
 * "el cliente Acme" (es) and "the Acme customer" (en) refer to the same
 * abstract entity even though the surface forms differ — direct mirror of
 * the multilingual / cross-language concept-feature finding in Anthropic's
 * Biology-of-LLMs paper.
 *
 * Strategy: build a stable "fingerprint" for each entity that strips
 * language-specific scaffolding (articles, common nouns like "cliente /
 * customer", "archivo / file") and keeps the discriminative core. Entities
 * with the same fingerprint are considered the same canonical entity even
 * if they were registered under different surfaces.
 */

const entityTracker = require('./cross-turn-entity-tracker');

const SCAFFOLD_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al',
  'aquel', 'aquella', 'aquellos', 'aquellas', 'este', 'esta', 'estos', 'estas',
  'ese', 'esa', 'esos', 'esas',
  'the', 'a', 'an', 'of', 'this', 'that', 'these', 'those',
  'cliente', 'clientes', 'customer', 'customers', 'usuario', 'usuarios', 'user', 'users',
  'archivo', 'archivos', 'fichero', 'ficheros', 'file', 'files', 'document', 'documento',
  'documents', 'documentos',
  'componente', 'componentes', 'component', 'components',
  'modulo', 'modulos', 'module', 'modules',
  'pagina', 'paginas', 'page', 'pages',
  'reporte', 'reportes', 'informe', 'informes', 'report', 'reports',
  'producto', 'productos', 'product', 'products',
  'proyecto', 'proyectos', 'project', 'projects',
  'servicio', 'servicios', 'service', 'services',
  'sistema', 'sistemas', 'system', 'systems',
]);

const KIND_HINTS = {
  client: ['cliente', 'clientes', 'customer', 'customers', 'usuario', 'usuarios', 'user', 'users'],
  file: ['archivo', 'archivos', 'fichero', 'ficheros', 'file', 'files', 'documento', 'documentos', 'document', 'documents'],
  ui: ['componente', 'componentes', 'component', 'components', 'pagina', 'paginas', 'page', 'pages'],
  module: ['modulo', 'modulos', 'module', 'modules'],
  report: ['reporte', 'reportes', 'informe', 'informes', 'report', 'reports'],
  product: ['producto', 'productos', 'product', 'products'],
  project: ['proyecto', 'proyectos', 'project', 'projects'],
  service: ['servicio', 'servicios', 'service', 'services'],
  system: ['sistema', 'sistemas', 'system', 'systems'],
};

function normalizeSurface(surface = '') {
  return String(surface || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]+/g, ' ')
    .trim();
}

function tokenize(surface) {
  return normalizeSurface(surface).split(/\s+/).filter(Boolean);
}

function fingerprint(surface) {
  const core = tokenize(surface).filter((t) => !SCAFFOLD_WORDS.has(t) && t.length >= 2);
  return core.slice(0, 5).sort().join('|') || normalizeSurface(surface);
}

function detectKind(surface) {
  const tokens = tokenize(surface);
  for (const [kind, words] of Object.entries(KIND_HINTS)) {
    if (tokens.some((t) => words.includes(t))) return kind;
  }
  return 'unknown';
}

function unify({ userId, chatId, limit = 50 } = {}) {
  const list = entityTracker.listEntities({ userId, chatId, limit: 200 });
  const clusters = new Map();
  for (const e of list) {
    const surfaces = new Set([e.canonicalSurface, ...(e.aliases || [])].filter(Boolean));
    for (const s of surfaces) {
      const fp = fingerprint(s);
      if (!fp) continue;
      let slot = clusters.get(fp);
      if (!slot) {
        slot = {
          fingerprint: fp,
          canonical: e.canonicalSurface,
          kind: detectKind(s),
          members: [],
          surfaces: new Set(),
          totalMentions: 0,
        };
        clusters.set(fp, slot);
      }
      slot.surfaces.add(s);
      slot.totalMentions += e.mentions || 0;
      slot.members.push({ id: e.id, canonicalSurface: e.canonicalSurface, kind: e.kind, mentions: e.mentions });
    }
  }
  return [...clusters.values()]
    .map((c) => ({
      fingerprint: c.fingerprint,
      canonical: c.canonical,
      kind: c.kind,
      surfaces: [...c.surfaces].slice(0, 8),
      members: dedupMembers(c.members).slice(0, 8),
      mentions: c.totalMentions,
      cardinality: dedupMembers(c.members).length,
    }))
    .filter((c) => c.cardinality >= 1)
    .sort((a, b) => b.mentions - a.mentions || b.cardinality - a.cardinality)
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

function dedupMembers(members) {
  const seen = new Set();
  const out = [];
  for (const m of members) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function resolve({ userId, chatId, surface = '' } = {}) {
  const fp = fingerprint(surface);
  if (!fp) return null;
  const clusters = unify({ userId, chatId });
  const match = clusters.find((c) => c.fingerprint === fp);
  if (match) return { ...match, confidence: 1.0 };

  const surfaceTokens = new Set(fp.split('|'));
  if (!surfaceTokens.size) return null;
  let best = null;
  for (const c of clusters) {
    const cTokens = new Set(c.fingerprint.split('|'));
    let inter = 0;
    for (const t of surfaceTokens) if (cTokens.has(t)) inter++;
    if (!inter) continue;
    const union = new Set([...surfaceTokens, ...cTokens]).size;
    const score = inter / Math.max(1, union);
    if (!best || score > best.confidence) best = { ...c, confidence: score };
  }
  return best;
}

function buildUnifierBlock({ userId, chatId, maxClusters = 6 } = {}) {
  const clusters = unify({ userId, chatId, limit: maxClusters });
  if (!clusters.length) return '';
  const lines = ['## CROSS-LANGUAGE ENTITY CLUSTERS'];
  for (const c of clusters) {
    lines.push(`- **${c.canonical}** [${c.kind}] — ${c.mentions} mention(s) across ${c.cardinality} surface form(s): ${c.surfaces.slice(0, 4).join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  unify,
  resolve,
  buildUnifierBlock,
  fingerprint,
  detectKind,
  SCAFFOLD_WORDS,
  KIND_HINTS,
};
