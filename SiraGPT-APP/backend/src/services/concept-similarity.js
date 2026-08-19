'use strict';

/**
 * concept-similarity.js
 *
 * Heuristic concept-similarity clustering. Maps surface-different but
 * semantically-near concepts to canonical "supernodes" so downstream
 * modules (attribution graph, drift monitor, entity unifier) can treat
 * them as the same signal.
 *
 * Examples:
 *   frontend ≡ UI ≡ interfaz ≡ ui_component   → canonical: 'ui'
 *   deploy ≡ despliegue ≡ release ≡ ship      → canonical: 'deploy'
 *   fix ≡ arregla ≡ corrige ≡ patch ≡ debug   → canonical: 'fix'
 *
 * Pure heuristic. The grouping comes from a hand-curated bilingual
 * thesaurus (the same pattern as concept-extractor's lexicon). For any
 * concept whose normalized surface isn't in the thesaurus, the canonical
 * form falls back to the normalized surface itself.
 *
 * Public API:
 *   canonical(conceptOrText)                  → canonical string
 *   cluster(concepts)                         → grouped object keyed by canonical
 *   similarityScore(a, b)                     → 0..1 (jaccard on synonym sets)
 *   GROUPS                                    → frozen synonym map (for tests)
 */

const conceptExtractor = require('./concept-extractor');

// Bilingual synonym groups. Surfaces are LOWERCASED and normalized.
const GROUPS = Object.freeze({
  ui: ['ui', 'frontend', 'front-end', 'interfaz', 'interfaces', 'componente', 'components', 'pantalla', 'screen', 'pagina', 'page', 'view', 'vista', 'dashboard', 'panel', 'design'],
  backend: ['backend', 'api', 'endpoint', 'route', 'ruta', 'server', 'servidor', 'service', 'servicio', 'middleware', 'controller', 'controlador'],
  fix: ['fix', 'arregla', 'arreglar', 'corrige', 'corregir', 'repara', 'repair', 'debug', 'depura', 'patch', 'parche', 'soluciona', 'resuelve', 'resolve'],
  create: ['create', 'crea', 'crear', 'genera', 'generar', 'build', 'construye', 'construir', 'haz', 'make', 'add', 'agrega', 'design', 'diseña'],
  modify: ['modify', 'modifica', 'edita', 'edit', 'update', 'actualiza', 'cambia', 'change', 'refactor', 'refactoriza', 'rewrite', 'reescribe', 'mejora', 'improve', 'extend'],
  delete: ['delete', 'borra', 'borrar', 'elimina', 'eliminar', 'remove', 'quita', 'descarta', 'drop'],
  deploy: ['deploy', 'despliega', 'despliegue', 'publica', 'publish', 'release', 'lanza', 'ship', 'rollout'],
  analyze: ['analyze', 'analiza', 'analizar', 'review', 'revisa', 'audit', 'audita', 'inspect', 'inspecciona', 'examina', 'examine', 'evalua'],
  explain: ['explain', 'explica', 'describe', 'detalla', 'clarify', 'aclara', 'show', 'muestra', 'enseña', 'teach'],
  search: ['search', 'busca', 'find', 'encuentra', 'lookup', 'consulta', 'query', 'investigate', 'investiga'],
  test: ['test', 'prueba', 'probar', 'verify', 'verifica', 'valida', 'validate', 'check', 'chequea', 'qa'],
  plan: ['plan', 'planea', 'planifica', 'organize', 'roadmap', 'estrategia', 'strategy'],
  summarize: ['summarize', 'resume', 'sintetiza', 'synthesize', 'tldr', 'condensa'],
  translate: ['translate', 'traduce', 'localize', 'localiza'],
  continue: ['continue', 'continua', 'continúa', 'sigue', 'proceed', 'prosigue', 'adelante', 'resume'],
  data: ['data', 'datos', 'dataset', 'database', 'tabla', 'table', 'record', 'registro'],
  code: ['code', 'codigo', 'código', 'script', 'function', 'función', 'method', 'método', 'class', 'clase', 'module', 'módulo'],
  business: ['cliente', 'client', 'customer', 'usuario', 'user', 'lead', 'venta', 'sale', 'ingreso', 'revenue'],
  ai: ['ai', 'ia', 'llm', 'agent', 'agente', 'prompt', 'model', 'modelo', 'embedding', 'rag', 'gpt', 'claude'],
  legal: ['contract', 'contrato', 'clause', 'cláusula', 'nda', 'compliance', 'regulación', 'policy', 'política'],
});

// Build the reverse index once: surface → canonical.
const REVERSE_INDEX = (() => {
  const m = new Map();
  for (const [canonical, synonyms] of Object.entries(GROUPS)) {
    for (const s of synonyms) m.set(s.toLowerCase(), canonical);
    m.set(canonical, canonical);
  }
  return m;
})();

function normalizeSurface(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim();
}

function canonical(conceptOrText) {
  if (!conceptOrText) return null;
  // Concept object → use its normalized field.
  if (typeof conceptOrText === 'object') {
    if (conceptOrText.normalized) return REVERSE_INDEX.get(normalizeSurface(conceptOrText.normalized)) || normalizeSurface(conceptOrText.normalized);
    if (conceptOrText.surface) return REVERSE_INDEX.get(normalizeSurface(conceptOrText.surface)) || normalizeSurface(conceptOrText.surface);
    return null;
  }
  const k = normalizeSurface(conceptOrText);
  if (!k) return null;
  return REVERSE_INDEX.get(k) || k;
}

function cluster(concepts = []) {
  const groups = new Map();
  for (const c of concepts) {
    const canon = canonical(c);
    if (!canon) continue;
    let slot = groups.get(canon);
    if (!slot) {
      slot = { canonical: canon, members: [], weight: 0 };
      groups.set(canon, slot);
    }
    slot.members.push(c);
    slot.weight = Math.max(slot.weight, c.weight || 0) + (c.weight || 0) * 0.2;
  }
  return [...groups.values()].sort((a, b) => b.weight - a.weight);
}

function similarityScore(a, b) {
  const canA = canonical(a);
  const canB = canonical(b);
  if (!canA || !canB) return 0;
  if (canA === canB) return 1;
  const synA = new Set([canA, ...(GROUPS[canA] || [])].map((x) => x.toLowerCase()));
  const synB = new Set([canB, ...(GROUPS[canB] || [])].map((x) => x.toLowerCase()));
  let inter = 0;
  for (const x of synA) if (synB.has(x)) inter++;
  if (!inter) return 0;
  const union = new Set([...synA, ...synB]).size;
  return inter / union;
}

/**
 * Convenience helper that runs the concept-extractor + clustering in one
 * call, returning the supernodes plus the original concept list.
 */
function extractAndCluster(text, opts = {}) {
  const { concepts, language } = conceptExtractor.extractConcepts(text, opts);
  return {
    language,
    concepts,
    clusters: cluster(concepts),
  };
}

function buildSimilarityBlock(clusters, opts = {}) {
  if (!clusters || !clusters.length) return '';
  const cap = Math.max(1, Number(opts.max) || 8);
  const lines = ['## CONCEPT SUPERNODES'];
  for (const c of clusters.slice(0, cap)) {
    const surfaces = c.members.slice(0, 4).map((m) => m.surface || m.normalized || '').filter(Boolean);
    lines.push(`- **${c.canonical}** (weight ${c.weight.toFixed(2)}): ${surfaces.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  canonical,
  cluster,
  similarityScore,
  extractAndCluster,
  buildSimilarityBlock,
  GROUPS,
};
