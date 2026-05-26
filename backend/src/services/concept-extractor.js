'use strict';

/**
 * concept-extractor.js
 *
 * Language-agnostic "concept" extraction from user text. Inspired by
 * Anthropic's circuit-tracing work on language models, where abstract
 * features (concepts) are shown to be largely language-independent and
 * composable. We are NOT extracting model-internal features — we mimic
 * the surface shape: stable concept tokens that can be linked across
 * turns, files, and memories to build an attribution graph.
 *
 * Each extracted concept is a deterministic, hashable record:
 *   { id, type, surface, normalized, language, weight, kind, source }
 *
 * - `type`     ∈ {entity, action, property, constraint, goal, reference, modality}
 * - `kind`     finer subtype (e.g. action.create, entity.file, constraint.negation)
 * - `weight`   0..1 — base salience score (length, position, repetition)
 * - `language` 'es' | 'en' | 'mixed' | 'unknown'
 *
 * Pure heuristics + dictionary lookups. No LLM, no external deps.
 */

const crypto = require('crypto');

const MAX_TEXT_CHARS = 8000;
const MAX_CONCEPTS = 80;

// ── Bilingual lexicon (ES + EN) ────────────────────────────────────────────

const ACTIONS = {
  create: ['create', 'crea', 'crear', 'genera', 'generar', 'build', 'construye', 'construir', 'haz', 'hacer', 'make', 'add', 'agrega', 'añade', 'anade', 'design', 'diseña', 'design'],
  modify: ['modify', 'modifica', 'edita', 'edit', 'update', 'actualiza', 'cambia', 'change', 'refactor', 'refactoriza', 'rewrite', 'reescribe', 'mejora', 'improve', 'extend', 'extiende', 'tweak'],
  fix: ['fix', 'arregla', 'arreglar', 'corrige', 'corregir', 'repara', 'repair', 'debug', 'depura', 'patch', 'parche', 'soluciona', 'soluciona', 'resuelve', 'resolve'],
  delete: ['delete', 'borra', 'borrar', 'elimina', 'eliminar', 'remove', 'remueve', 'quita', 'descarta', 'discard', 'drop', 'cleanup'],
  analyze: ['analyze', 'analiza', 'analizar', 'review', 'revisa', 'revisar', 'audit', 'audita', 'inspect', 'inspecciona', 'examina', 'examine', 'study', 'estudia', 'evalua', 'evaluate'],
  explain: ['explain', 'explica', 'explicar', 'describe', 'describe', 'detalla', 'detail', 'clarify', 'aclara', 'show', 'muestra', 'enseña', 'teach'],
  search: ['search', 'busca', 'buscar', 'find', 'encuentra', 'localiza', 'locate', 'lookup', 'consulta', 'query', 'investigate', 'investiga'],
  test: ['test', 'prueba', 'probar', 'verify', 'verifica', 'valida', 'validate', 'check', 'chequea'],
  deploy: ['deploy', 'despliega', 'publica', 'publish', 'release', 'lanza', 'ship', 'rollout'],
  plan: ['plan', 'planea', 'planifica', 'organize', 'organiza', 'design', 'estructura', 'roadmap'],
  summarize: ['summarize', 'resume', 'resumir', 'sintetiza', 'synthesize', 'tldr', 'condensa'],
  translate: ['translate', 'traduce', 'traducir', 'localize', 'localiza'],
  continue: ['continue', 'continua', 'continúa', 'continuar', 'sigue', 'proceed', 'prosigue', 'adelante', 'resume', 'reanuda'],
  stop: ['stop', 'detén', 'detente', 'para', 'parar', 'cancela', 'cancel', 'abort', 'aborta', 'termina', 'end'],
  install: ['install', 'instala', 'configura', 'configure', 'setup', 'set up'],
  optimize: ['optimize', 'optimiza', 'optimizar', 'mejora rendimiento', 'speed up', 'acelera', 'performance'],
  document: ['document', 'documenta', 'documentar', 'comenta', 'comment', 'annotate'],
  refuse_unsafe: ['hackear', 'crackear', 'exploit', 'pwn', 'rootkit', 'backdoor', 'malware'],
};

const ENTITY_DOMAINS = {
  code: ['code', 'codigo', 'código', 'script', 'function', 'función', 'method', 'método', 'class', 'clase', 'module', 'módulo', 'package', 'paquete', 'library', 'librería', 'componente', 'component'],
  file: ['file', 'archivo', 'fichero', 'document', 'documento', 'pdf', 'json', 'csv', 'xml', 'yaml', 'markdown', 'spreadsheet', 'hoja'],
  repo: ['repo', 'repository', 'repositorio', 'branch', 'rama', 'commit', 'pull request', 'pr', 'merge', 'main', 'master', 'github', 'gitlab', 'codebase'],
  data: ['data', 'datos', 'dataset', 'database', 'base de datos', 'table', 'tabla', 'row', 'fila', 'column', 'columna', 'record', 'registro'],
  ui: ['ui', 'interface', 'interfaz', 'frontend', 'componente', 'pantalla', 'screen', 'page', 'página', 'view', 'vista', 'dashboard', 'panel'],
  backend: ['backend', 'api', 'endpoint', 'route', 'ruta', 'server', 'servidor', 'service', 'servicio', 'middleware', 'controller', 'controlador'],
  test: ['test', 'prueba', 'spec', 'unit test', 'integration test', 'e2e', 'tdd', 'bdd', 'fixture'],
  ci: ['ci', 'cd', 'pipeline', 'workflow', 'action', 'github actions', 'jenkins', 'gitlab ci', 'deploy', 'despliegue'],
  ai: ['ai', 'ia', 'llm', 'agent', 'agente', 'prompt', 'model', 'modelo', 'embedding', 'vector', 'rag', 'gpt', 'claude'],
  business: ['cliente', 'client', 'customer', 'usuario', 'user', 'lead', 'venta', 'sale', 'ingreso', 'revenue', 'cost', 'costo', 'budget', 'presupuesto'],
  legal: ['contract', 'contrato', 'clause', 'cláusula', 'nda', 'compliance', 'regulación', 'regulation', 'policy', 'política'],
};

const PROPERTIES = {
  quality: ['mejor', 'better', 'best', 'optimal', 'optimo', 'óptimo', 'cleaner', 'limpio', 'simple', 'robusto', 'robust', 'rapido', 'rápido', 'fast', 'lento', 'slow', 'eficiente', 'efficient'],
  size: ['big', 'grande', 'small', 'pequeño', 'large', 'tiny', 'huge', 'enorme', 'compact', 'compacto', 'minimal', 'mínimo'],
  importance: ['critical', 'crítico', 'urgent', 'urgente', 'important', 'importante', 'priority', 'prioridad', 'blocker', 'bloqueante'],
  state: ['new', 'nuevo', 'old', 'viejo', 'antiguo', 'current', 'actual', 'previous', 'anterior', 'pending', 'pendiente', 'done', 'hecho', 'completed', 'completado'],
};

const CONSTRAINTS = {
  negation: [
    /\bno\s+(?:debes|debe|quiero|quiero que|hagas|haga|toques|toque|cambies|cambie|borres|borre|modifiques|modifique|uses|use)\b/i,
    /\bdo\s+not\b/i, /\bdon'?t\b/i, /\bnever\b/i, /\bnunca\b/i,
    /\bsin\s+(?:que|tocar|romper|modificar|cambiar)\b/i, /\bwithout\s+(?:breaking|changing|modifying|touching)\b/i,
  ],
  exclusion: [
    /\bexcepto\b/i, /\bexcept\b/i, /\bsalvo\b/i, /\bexclude\b/i, /\bignore\b/i, /\bignora\b/i,
    /\bsólo\b/i, /\bsolo\b/i, /\bonly\b/i, /\bunique\s+to\b/i,
  ],
  preserve: [
    /\bpreserv\w*\b/i, /\bmantén\w*\b/i, /\bkeep\b/i, /\bno\s+rompas\b/i, /\bsin\s+romper\b/i,
    /\bdon'?t\s+break\b/i, /\bno\s+modifiques\s+la\s+ui\b/i, /\bno\s+toques\s+la\s+ui\b/i,
  ],
  budget: [
    /\b(?:max|hasta|al\s+menos|m[ií]nimo|tope|límite|limit|cap|budget)\s*[:=]?\s*\d+/i,
    /\b\d+\s*(?:tokens|chars|lines|líneas|requests|seconds|segundos|ms|minutes|minutos|hours|horas|days|días)\b/i,
  ],
  language: [
    /\ben\s+(?:español|inglés|ingles|francés|frances|alemán|aleman|portugués|portugues|japonés|japones)\b/i,
    /\bin\s+(?:english|spanish|french|german|portuguese|japanese)\b/i,
  ],
};

const REFERENCES = [
  /\b(?:esto|eso|lo\s+anterior|el\s+anterior|la\s+anterior|aquello|aquel|aquella)\b/i,
  /\b(?:this|that|the\s+previous|earlier|above|the\s+thing|it)\b/i,
  /\b(?:como\s+(?:dije|dijiste|antes|hicimos|te\s+dije)|igual\s+que\s+antes|like\s+(?:before|last\s+time|earlier))\b/i,
  /\b(?:el\s+(?:archivo|documento|código|chat|repo)\s+(?:anterior|de\s+antes|que\s+(?:te\s+)?(?:pasé|mandé|enseñé)))\b/i,
];

const GOAL_PHRASES = [
  /\b(?:quiero|necesito|me\s+gustaría|querría)\s+/i,
  /\b(?:i\s+want|i\s+need|i'?d\s+like|please)\b/i,
  /\b(?:el\s+objetivo|the\s+goal|the\s+aim|el\s+propósito|the\s+purpose)\s+(?:es|is)\b/i,
  /\b(?:para\s+que|so\s+that|in\s+order\s+to)\b/i,
];

const MODALITY = {
  question: [/\?\s*$/m, /\b(?:qué|que|cómo|como|por\s+qué|por\s+que|cuándo|cuando|dónde|donde|cuál|cual|cuáles|cuales|quién|quien)\b/i, /\b(?:what|how|why|when|where|which|who)\b/i],
  command: [/^\s*(?:por\s+favor[, ]+)?(?:crea|haz|genera|modifica|arregla|corrige|borra|elimina|escribe|implementa|implementa|deploy|test|build)/i, /^\s*(?:please[, ]+)?(?:create|make|build|fix|edit|delete|remove|implement|deploy|test|run)\b/i],
  confirmation: [/\b(?:s[ií]|ok|okay|yes|correct|correcto|exacto|exactly|de\s+acuerdo|sounds\s+good)\b/i],
  rejection: [/\b(?:no|nope|nah|incorrecto|incorrect|equivocado|wrong|mal|bad|not\s+(?:that|this))\b/i],
};

// ── Helpers ────────────────────────────────────────────────────────────────

function safeText(input) {
  return String(input == null ? '' : input).slice(0, MAX_TEXT_CHARS).replace(/ /g, '');
}

function tokenize(text) {
  return safeText(text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_\s.-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 32);
}

function fingerprint(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function detectLanguage(text) {
  const t = safeText(text).toLowerCase();
  if (!t.trim()) return 'unknown';
  const esHits = (t.match(/\b(?:el|la|los|las|de|que|para|por|con|sin|pero|aunque|también|ademas|además|mejor|haz|genera|necesito|quiero|cómo|como)\b/g) || []).length;
  const enHits = (t.match(/\b(?:the|of|and|to|for|with|without|but|also|better|make|generate|need|want|how|what)\b/g) || []).length;
  if (esHits >= 3 && enHits >= 3) return 'mixed';
  if (esHits > enHits) return 'es';
  if (enHits > esHits) return 'en';
  return 'unknown';
}

function makeConcept({ type, kind, surface, normalized, language, weight, source }) {
  const id = fingerprint([type, kind, normalized || surface]);
  return {
    id,
    type,
    kind: kind || type,
    surface: String(surface || '').slice(0, 120),
    normalized: String(normalized || surface || '').toLowerCase().slice(0, 120),
    language: language || 'unknown',
    weight: Math.max(0, Math.min(1, Number(weight) || 0.3)),
    source: source || 'inline',
  };
}

// ── Extractors ─────────────────────────────────────────────────────────────

function extractActions(text, opts = {}) {
  const lang = opts.language || detectLanguage(text);
  const tokens = new Set(tokenize(text));
  const out = [];
  for (const [kind, words] of Object.entries(ACTIONS)) {
    let hits = 0;
    let surface = null;
    for (const w of words) {
      const tok = w.toLowerCase().split(' ').join('-');
      if (tokens.has(tok) || tokens.has(w.toLowerCase())) {
        hits++;
        surface = surface || w;
      } else if (w.includes(' ') && safeText(text).toLowerCase().includes(w.toLowerCase())) {
        hits++;
        surface = surface || w;
      }
    }
    if (hits > 0) {
      out.push(makeConcept({
        type: 'action',
        kind: `action.${kind}`,
        surface,
        normalized: kind,
        language: lang,
        weight: Math.min(1, 0.4 + hits * 0.15),
        source: opts.source,
      }));
    }
  }
  return out;
}

function extractEntities(text, opts = {}) {
  const lang = opts.language || detectLanguage(text);
  const lower = safeText(text).toLowerCase();
  const out = [];
  for (const [domain, words] of Object.entries(ENTITY_DOMAINS)) {
    let hits = 0;
    let surface = null;
    for (const w of words) {
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(lower)) {
        hits++;
        surface = surface || w;
      }
    }
    if (hits > 0) {
      out.push(makeConcept({
        type: 'entity',
        kind: `entity.${domain}`,
        surface,
        normalized: domain,
        language: lang,
        weight: Math.min(1, 0.35 + hits * 0.12),
        source: opts.source,
      }));
    }
  }

  // Named-entity-ish heuristics: capitalised multi-word phrases & quoted names.
  const named = safeText(text).match(/\b([A-Z][a-zA-Z0-9_-]{2,}(?:\s+[A-Z][a-zA-Z0-9_-]+){0,3})\b/g) || [];
  for (const n of named.slice(0, 12)) {
    out.push(makeConcept({
      type: 'entity',
      kind: 'entity.named',
      surface: n,
      normalized: n.toLowerCase(),
      language: lang,
      weight: 0.5,
      source: opts.source,
    }));
  }

  // Filenames / paths.
  const paths = safeText(text).match(/\b[\w.-]+\.(?:js|ts|tsx|jsx|json|md|py|java|go|rb|css|html|yml|yaml|sh|sql|csv|xml)\b/g) || [];
  for (const p of paths.slice(0, 12)) {
    out.push(makeConcept({
      type: 'entity',
      kind: 'entity.path',
      surface: p,
      normalized: p.toLowerCase(),
      language: lang,
      weight: 0.6,
      source: opts.source,
    }));
  }

  return out;
}

function extractProperties(text, opts = {}) {
  const lang = opts.language || detectLanguage(text);
  const tokens = new Set(tokenize(text));
  const out = [];
  for (const [kind, words] of Object.entries(PROPERTIES)) {
    let hits = 0;
    let surface = null;
    for (const w of words) {
      if (tokens.has(w.toLowerCase())) {
        hits++;
        surface = surface || w;
      }
    }
    if (hits > 0) {
      out.push(makeConcept({
        type: 'property',
        kind: `property.${kind}`,
        surface,
        normalized: kind,
        language: lang,
        weight: Math.min(1, 0.3 + hits * 0.1),
        source: opts.source,
      }));
    }
  }
  return out;
}

function extractConstraints(text, opts = {}) {
  const lang = opts.language || detectLanguage(text);
  const safe = safeText(text);
  const out = [];
  for (const [kind, patterns] of Object.entries(CONSTRAINTS)) {
    for (const p of patterns) {
      const m = safe.match(p);
      if (m) {
        out.push(makeConcept({
          type: 'constraint',
          kind: `constraint.${kind}`,
          surface: m[0].slice(0, 80),
          normalized: kind,
          language: lang,
          weight: 0.7,
          source: opts.source,
        }));
      }
    }
  }
  return out;
}

function extractReferences(text, opts = {}) {
  const lang = opts.language || detectLanguage(text);
  const safe = safeText(text);
  const out = [];
  for (const re of REFERENCES) {
    const m = safe.match(re);
    if (m) {
      out.push(makeConcept({
        type: 'reference',
        kind: 'reference.anaphora',
        surface: m[0],
        normalized: 'prior_turn_or_artifact',
        language: lang,
        weight: 0.8,
        source: opts.source,
      }));
    }
  }
  return out;
}

function extractGoals(text, opts = {}) {
  const lang = opts.language || detectLanguage(text);
  const safe = safeText(text);
  const out = [];
  for (const re of GOAL_PHRASES) {
    const m = safe.match(re);
    if (m) {
      const after = safe.slice(safe.indexOf(m[0]) + m[0].length, safe.indexOf(m[0]) + m[0].length + 140).trim();
      if (after) {
        out.push(makeConcept({
          type: 'goal',
          kind: 'goal.explicit',
          surface: `${m[0]} ${after}`.slice(0, 140),
          normalized: after.toLowerCase().slice(0, 80),
          language: lang,
          weight: 0.75,
          source: opts.source,
        }));
      }
    }
  }
  return out;
}

function extractModality(text, opts = {}) {
  const lang = opts.language || detectLanguage(text);
  const safe = safeText(text);
  const out = [];
  for (const [kind, patterns] of Object.entries(MODALITY)) {
    if (patterns.some((p) => p.test(safe))) {
      out.push(makeConcept({
        type: 'modality',
        kind: `modality.${kind}`,
        surface: kind,
        normalized: kind,
        language: lang,
        weight: 0.45,
        source: opts.source,
      }));
    }
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────

function extractConcepts(text, opts = {}) {
  const safe = safeText(text);
  if (!safe.trim()) {
    return { concepts: [], language: 'unknown', tokenCount: 0 };
  }
  const language = opts.language || detectLanguage(safe);
  const source = opts.source || 'inline';
  const all = [
    ...extractActions(safe, { language, source }),
    ...extractEntities(safe, { language, source }),
    ...extractProperties(safe, { language, source }),
    ...extractConstraints(safe, { language, source }),
    ...extractReferences(safe, { language, source }),
    ...extractGoals(safe, { language, source }),
    ...extractModality(safe, { language, source }),
  ];
  const deduped = dedupConcepts(all).slice(0, MAX_CONCEPTS);
  return {
    concepts: deduped,
    language,
    tokenCount: tokenize(safe).length,
  };
}

function dedupConcepts(list) {
  const byId = new Map();
  for (const c of list) {
    const prev = byId.get(c.id);
    if (!prev) {
      byId.set(c.id, { ...c });
      continue;
    }
    prev.weight = Math.min(1, Math.max(prev.weight, c.weight) + 0.05);
    if (prev.surface.length < c.surface.length) prev.surface = c.surface;
  }
  return [...byId.values()].sort((a, b) => b.weight - a.weight);
}

function mergeConcepts(...arrays) {
  return dedupConcepts(arrays.flat().filter(Boolean));
}

function conceptKey(concept) {
  if (!concept) return '';
  if (typeof concept === 'string') return concept;
  return concept.id || fingerprint([concept.type, concept.normalized || concept.surface || '']);
}

function conceptDistance(a, b) {
  const setA = new Set((Array.isArray(a) ? a : []).map((c) => c.id));
  const setB = new Set((Array.isArray(b) ? b : []).map((c) => c.id));
  if (!setA.size && !setB.size) return 0;
  const intersect = [...setA].filter((id) => setB.has(id)).length;
  const union = new Set([...setA, ...setB]).size;
  return 1 - intersect / Math.max(1, union);
}

function describeConcept(concept) {
  if (!concept) return '';
  const w = `${Math.round((concept.weight || 0) * 100)}%`;
  return `[${concept.type}/${concept.kind}] ${concept.surface} (${w})`;
}

module.exports = {
  extractConcepts,
  extractActions,
  extractEntities,
  extractProperties,
  extractConstraints,
  extractReferences,
  extractGoals,
  extractModality,
  detectLanguage,
  dedupConcepts,
  mergeConcepts,
  conceptKey,
  conceptDistance,
  describeConcept,
  ACTIONS,
  ENTITY_DOMAINS,
  PROPERTIES,
  CONSTRAINTS,
  REFERENCES,
  GOAL_PHRASES,
  MODALITY,
};
