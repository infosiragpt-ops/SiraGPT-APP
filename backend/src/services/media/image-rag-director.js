'use strict';

/**
 * image-rag-director — Two-Tier Retrieval-Augmented Visual Generation &
 * Continuity Engine ("el RAG de imágenes") for SiraGPT.
 *
 * Bridges SiraGPT's RAG stack with both canonical image lanes:
 *   1. `POST /api/ai/generate-image` (composer Imágenes chip lane)
 *   2. `generate_image` / `edit_image` (`services/agents/visual-media-tools.js`)
 *
 * Four pillars:
 *   - Tier 1 (Document, Project & Chat RAG Grounding):
 *       Retrieves factual visual attributes (brand hex colors, materials,
 *       product/scene descriptions, titles, metrics) from indexed RAG
 *       collections (`chat:<chatId>`, `project:<id>`, `gpt:<id>`, `default`)
 *       via hybrid semantic + BM25 RRF (`rag-service`) with instant `<2ms`
 *       lexical BM25 fallback (`document-retrieval`) over `rag-store` chunks
 *       and attached/chat `File.extractedText`.
 *   - Cross-Turn Visual Continuity ("hilación" / Visual Bible):
 *       Detects `none | style | strict` continuity cues across multi-image
 *       series in the same chat while incurring ZERO DB reads on standalone
 *       prompts (`calls.reads === 0` invariant).
 *   - Tier 2 (Curated Visual Direction RAG Corpus):
 *       Retrieves domain-specialized optics, lighting rigs, surface craft,
 *       aspect-ratio composition, quoted typography precision, and anti-artifact
 *       guardrails from `image-rag-corpus.js`.
 *   - Policy & Security Hardening (AGENTS.md):
 *       - §10.3: Neutralizes named-artist imitation into objective visual
 *         movement, brushwork, lighting, and palette descriptors.
 *       - §12: Redacts any secret/token/vendor slug from retrieved text.
 *       - §17: Strips prompt-injection directives so retrieved documents act
 *         strictly as descriptive visual data, never instructions.
 */

const ragStore = require('../rag-store');
const ragService = require('../rag-service');
const {
  documentTokens,
  searchDocumentLexical,
  diversifyDocumentSources,
  queryFocusedExcerpt,
} = require('../rag/document-retrieval');
const { searchVisualDirectionCorpus } = require('./image-rag-corpus');

const MAX_GROUNDING_CHARS = 480;
const MAX_CONTINUITY_CHARS = 300;
const MAX_PROVIDER_PROMPT_CHARS = 3800;
const SEMANTIC_RETRIEVE_BUDGET_MS = 1000;

// ── Text Normalization Helpers ────────────────────────────────────────────

function normalizePlain(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseSpaces(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

// ── Idempotent Direction Stripping ────────────────────────────────────────

const DIRECTION_TAIL_RE = /\s*(?:Reference visual attributes:|Series visual continuity:|Visual direction:|\n\nReference visual attributes:|\n\nSeries visual continuity:|\n\nVisual direction:)[\s\S]*$/i;

/**
 * Strip any previously appended Image RAG enrichment so re-directing a prompt
 * is 100% idempotent and never stacks duplicate blocks.
 */
function stripPreviousImageDirection(prompt) {
  if (typeof prompt !== 'string' || !prompt) return '';
  return prompt.replace(DIRECTION_TAIL_RE, '').trim();
}

// ── AGENTS.md §17 & §12: Prompt-Injection & Secret Sanitizer ──────────────

const SECRET_REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9._-]{8,}['"]?/gi,
];

const PROMPT_INJECTION_SENTENCE_RE = new RegExp([
  'ignore\\s+(?:(?:all|any|previous|prior|above|earlier)\\s+)*instructions?',
  'disregard\\s+(?:(?:all|any|previous|prior|above|earlier)\\s+)*(?:instructions?|rules?)',
  'ignora\\s+(?:(?:todas?|cualquier|las|los|anteriores|previas)\\s+)*(?:instrucciones|reglas)',
  'olvida\\s+(?:(?:todas?|las|los|anteriores|previas)\\s+)*(?:instrucciones|reglas)',
  'system\\s*prompt\\s*:',
  'developer\\s*(?:message|prompt)\\s*:',
  '<\\|(?:im_start|im_end|system|user|assistant|endoftext)\\|>',
  '\\[\\s*(?:INST|/INST|SYSTEM)\\s*\\]',
  'you\\s+are\\s+now\\s+(?:a|an|in)\\b',
  'actua\\s+como\\s+(?:un|una)?\\s*(?:sistema|administrador|hacker|root)',
  'do\\s+not\\s+generate\\s+(?:the\\s+)?image',
  'reveal\\s+(?:your\\s+|the\\s+)?(?:system|secret|api|key|prompt)',
  'execute\\s+(?:tool|command|shell|bash)',
].join('|'), 'i');

/**
 * Sanitize retrieved document or chat text so it contains ONLY safe descriptive
 * visual facts — never executable prompt instructions or secrets (AGENTS.md §12, §17).
 */
function sanitizeRetrievedVisualData(rawText, maxChars = MAX_GROUNDING_CHARS) {
  if (typeof rawText !== 'string' || !rawText.trim()) return '';
  let text = rawText;

  // Strip fenced code/script blocks & HTML tags that add noise or injection vectors.
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]{1,160}>/g, ' ');

  for (const re of SECRET_REDACT_PATTERNS) {
    text = text.replace(re, '[REDACTED]');
  }

  // Split into sentence/line clauses and drop any clause carrying prompt-injection imperatives.
  const clauses = text.split(/(?:\r?\n|(?<=[.!?])\s+)/);
  const safeClauses = clauses
    .map((clause) => clause.trim())
    .filter((clause) => {
      if (!clause) return false;
      const normClause = normalizePlain(clause);
      return !PROMPT_INJECTION_SENTENCE_RE.test(normClause) && !PROMPT_INJECTION_SENTENCE_RE.test(clause);
    });

  const joined = collapseSpaces(safeClauses.join(' '))
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!joined) return '';
  return joined.length <= maxChars ? joined : `${joined.slice(0, Math.max(40, maxChars - 1)).trim()}…`;
}

// ── AGENTS.md §10.3: Named Artist Imitation Guard ─────────────────────────

// Generic movements, mediums, eras, aesthetics, and self-references that are
// legitimate styles — NEVER personal artist names.
const ALLOWED_STYLE_TERMS = new Set([
  'anime', 'manga', 'cartoon', 'caricatura', 'comic', 'historieta', 'pixar',
  'realista', 'realistic', 'fotorrealista', 'photorealistic', 'hiperrealista',
  'fotografico', 'photographic', 'documental', 'documentary', 'editorial',
  'cinematografico', 'cinematic', 'cine', 'pelicula', 'film', 'anamorfico',
  'acuarela', 'watercolor', 'oleo', 'oil', 'oil painting', 'acrilico', 'acrylic',
  'gouache', 'tinta', 'ink', 'boceto', 'sketch', 'lapiz', 'carboncillo', 'charcoal',
  'pastel', 'grabado', 'woodcut', 'linocut', 'serigrafia', 'risografia', 'risograph',
  'minimalista', 'minimalist', 'maximalista', 'flat', 'vector', 'vectorial',
  'isometrico', 'isometric', '3d', 'render', 'clay', 'claymation', 'origami',
  'pixel', 'pixel art', 'voxel', 'low poly', 'bauhaus', 'art deco', 'art nouveau',
  'barroco', 'baroque', 'renacentista', 'renaissance', 'impresionista', 'impressionist',
  'impresionismo', 'expresionista', 'expressionist', 'surrealista', 'surrealist',
  'surrealismo', 'cubista', 'cubist', 'pop art', 'vaporwave', 'synthwave',
  'cyberpunk', 'ciberpunk', 'steampunk', 'solarpunk', 'retro', 'vintage',
  'polaroid', 'kodak', '35mm', 'analogico', 'analog', 'noir', 'blancoynegro',
  'monocromatico', 'corporativo', 'corporate', 'escandinavo', 'nordico', 'japones',
  'ukiyo', 'ukiyo-e', 'botanico', 'cientifico', 'infografico', 'arquitectonico',
  'foto', 'fotografia', 'imagen', 'dibujo', 'pintura', 'ilustracion', 'logo',
  'marca', 'documento', 'manual', 'portada', 'cartel', 'poster', 'referencia',
  'photo', 'photograph', 'image', 'picture', 'drawing', 'painting', 'brand',
  'esta foto', 'esta imagen', 'la imagen anterior', 'la foto anterior', 'la marca',
  'mi marca', 'el documento', 'el manual', 'este logo',
  'this photo', 'this image', 'the previous image', 'the brand', 'our brand',
]);

const ARTIST_ATTRIBUTION_PATTERNS = [
  // ES: "al estilo de Frida Kahlo", "en el estilo de Salvador Dalí", "pintado por Fernando Botero"
  {
    re: /\b(?:al\s+estilo\s+de|en\s+el\s+estilo\s+de|pintad[oa]\s+por|ilustrad[oa]\s+por|fotografiad[oa]\s+por|dibujad[oa]\s+por|inspirad[oa]\s+en\s+la\s+obra\s+de)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ][\p{L}.'\-]*(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ][\p{L}.'\-]*){0,3})/gu,
    replacement: 'con dirección artística autoral original, técnica refinada, paleta cromática expresiva y composición de galería',
  },
  // EN: "in the style of Wes Anderson", "art by Greg Rutkowski", "painted by Van Gogh", "photographed by Annie Leibovitz"
  {
    re: /\b(?:in\s+the\s+style\s+of|art\s+by|artwork\s+by|painted\s+by|illustrated\s+by|photographed\s+by|drawn\s+by|styled\s+after)\s+([A-Z][\p{L}.'\-]*(?:\s+[A-Za-z][\p{L}.'\-]*){0,3})/gu,
    replacement: 'with original auteur art direction, refined medium craft, cohesive color harmony, and gallery-grade composition',
  },
  // Compact capitalized proper-name style: "estilo Frida Kahlo" / "style of Yayoi Kusama"
  {
    re: /\b(?:estilo|style\s+of)\s+([A-ZÁÉÍÓÚÑ][\p{L}'\-]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'\-]{2,}){1,2})\b/gu,
    replacement: 'con dirección visual autoral original, pincelada y paleta cromática distintiva',
  },
];

function isAllowedStylePhrase(candidate) {
  const norm = normalizePlain(candidate)
    .replace(/\b(?:de|del|la|el|los|las|un|una|a|an|the|and|y|con|en|para|esta|este|esa|ese|mi|nuestra|nuestro|this|that|my|our)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return true;
  if (ALLOWED_STYLE_TERMS.has(norm)) return true;
  const words = norm.split(' ');
  // If any token (or masculine/singular inflection) names a medium, art movement,
  // era, or reference noun (e.g. "acuarela japonesa", "fotografía analógica",
  // "pintura barroca"), it is a generic visual medium/movement, NOT a person's name.
  for (const w of words) {
    if (ALLOWED_STYLE_TERMS.has(w)) return true;
    const singular = w.replace(/(?:es|s)$/, '');
    if (ALLOWED_STYLE_TERMS.has(singular)) return true;
    const masc = singular.replace(/a$/, 'o');
    if (ALLOWED_STYLE_TERMS.has(masc)) return true;
  }
  return false;
}

/**
 * Enforce AGENTS.md §10.3 (`NO DEBE: imitar artistas por nombre`).
 * Translates named-artist attributions into objective craft descriptors while
 * leaving art movements, mediums, eras, and reference cues untouched.
 */
function neutralizeNamedArtistImitation(prompt) {
  const source = String(prompt == null ? '' : prompt);
  if (!source) return { prompt: '', neutralized: false, matchedNames: [] };

  let out = source;
  const matchedNames = [];

  for (const { re, replacement } of ARTIST_ATTRIBUTION_PATTERNS) {
    out = out.replace(re, (fullMatch, capturedName) => {
      const trimmedName = String(capturedName || '')
        .split(/\s*(?:,|;|\.| pero\b| y\b| con\b| en\b| sobre\b| para\b| como\b| que\b| but\b| and\b| with\b| on\b| in\b| featuring\b)/i)[0]
        .trim();
      if (!trimmedName || isAllowedStylePhrase(trimmedName)) {
        return fullMatch;
      }
      // Personal artist names carry proper-noun capitalization (e.g. "Frida Kahlo",
      // "Vincent Van Gogh", "Banksy"); lowercase common phrases are never proper names.
      const nameWords = trimmedName.split(/\s+/).filter(Boolean);
      const hasCapitalizedProperToken = nameWords.some((w) => /^[A-ZÁÉÍÓÚÑ]/.test(w));
      if (!hasCapitalizedProperToken) {
        return fullMatch;
      }
      matchedNames.push(trimmedName);
      const suffix = String(capturedName || '').slice(trimmedName.length);
      return `${replacement}${suffix}`;
    });
  }

  return {
    prompt: collapseSpaces(out),
    neutralized: matchedNames.length > 0,
    matchedNames,
  };
}

// ── Quoted Typography Precision Extractor ─────────────────────────────────

const EXPLICIT_LETTERING_CUE_RE = /\b(?:que\s+diga|con\s+el\s+texto|con\s+la\s+frase|con\s+el\s+titulo|con\s+las\s+palabras|letrero|rotulo|cartel\s+con|texto\s*:|titulo\s*:|with\s+(?:the\s+)?text|that\s+says|reading|saying|titled|headline)\b/i;
const TYPOGRAPHIC_DELIVERABLE_RE = /\b(?:logos?|logotipos?|posters?|cartel(?:es)?|afiches?|flyers?|portadas?|covers?|banners?|miniaturas?|thumbnails?|infografi(?:a|as)|etiquetas?|packaging|empaque|camisetas?|letreros?|neones?)\b/i;

/**
 * Extract exact quoted strings intended for on-image typographic rendering.
 */
function extractQuotedTypography(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) return [];
  const norm = normalizePlain(raw);
  const hasExplicitCue = EXPLICIT_LETTERING_CUE_RE.test(norm);
  const hasTypoDeliverable = TYPOGRAPHIC_DELIVERABLE_RE.test(norm);
  if (!hasExplicitCue && !hasTypoDeliverable) return [];

  const matches = [];
  const quotePatterns = [
    /"([^"\n]{1,72})"/g,
    /«([^»\n]{1,72})»/g,
    /“([^”\n]{1,72})”/g,
  ];
  for (const re of quotePatterns) {
    for (const m of raw.matchAll(re)) {
      const val = collapseSpaces(m[1]);
      if (val && val.length >= 1 && val.length <= 72 && !matches.includes(val)) {
        matches.push(val);
      }
    }
  }
  return matches.slice(0, 3);
}

// ── Document Grounding & Visual Continuity Cue Detectors ──────────────────

const DOCUMENT_GROUNDING_CUE_RE = new RegExp([
  '\\b(?:segun|basad[oa]s?\\s+en|a\\s+partir\\s+de|tomando\\s+de|usando|con\\s+los\\s+datos\\s+de|descrit[oa]s?\\s+en|mencionad[oa]s?\\s+en|del|de\\s+la|en\\s+el|en\\s+la)\\s+(?:el\\s+|la\\s+|los\\s+|las\\s+|mi\\s+|nuestro\\s+|este\\s+|esta\\s+)?(?:documento|documentos|pdf|informe|reporte|manual(?:\\s+de\\s+marca)?|guia(?:\\s+de\\s+estilo)?|brand\\s*book|presentacion|deck|archivo|archivos|texto\\s+adjunto|capitulo|articulo|estudio|propuesta|especificacion|ficha\\s+tecnica|brief|briefing|hoja\\s+de\\s+calculo|excel|tabla)\\b',
  '\\b(?:manual\\s+de\\s+marca|identidad\\s+de\\s+(?:la\\s+)?marca|paleta\\s+de\\s+(?:la\\s+)?marca|colores\\s+corporativos|brand\\s+guidelines|brand\\s+book|style\\s+guide)\\b',
  '\\b(?:according\\s+to|based\\s+on|from|described\\s+in|mentioned\\s+in|using\\s+data\\s+from)\\s+(?:the\\s+|this\\s+|my\\s+|our\\s+)?(?:document|documents|pdf|report|brand\\s+book|style\\s+guide|presentation|deck|file|attached\\s+file|chapter|article|spec|specification|brief|spreadsheet)\\b',
].join('|'));

/**
 * True when the user's prompt explicitly asks to ground the image in an
 * uploaded/project/chat document, report, or brand guide.
 */
function detectDocumentGroundingCue(text) {
  const norm = normalizePlain(text);
  if (!norm) return false;
  return DOCUMENT_GROUNDING_CUE_RE.test(norm);
}

const STRICT_CONTINUITY_CUE_RE = new RegExp([
  '\\b(?:el\\s+mismo|la\\s+misma|los\\s+mismos|las\\s+mismas)\\s+(?:personaje|persona|protagonista|sujeto|producto|explorador|guerrero|astronauta|robot|gato|perro|animal|modelo|edificio|vehiculo|coche|escenario|lugar)\\b',
  '\\b(?:continua(?:ndo)?|sigue)\\s+(?:la\\s+historia|la\\s+escena|la\\s+serie|el\\s+relato|la\\s+secuencia)\\b',
  '\\b(?:siguiente\\s+(?:escena|viñeta|vineta|paso|capitulo)|otra\\s+(?:escena|toma|pose|accion)\\s+del\\s+mismo|conserva(?:ndo)?\\s+al?\\s+(?:personaje|protagonista|sujeto)|manten(?:iendo)?\\s+al?\\s+(?:personaje|protagonista|sujeto))\\b',
  '\\b(?:same\\s+(?:character|person|protagonist|subject|product|hero|creature)|next\\s+(?:scene|panel|frame)|continue\\s+the\\s+(?:story|scene|series)|another\\s+(?:scene|shot|pose)\\s+of\\s+the\\s+same|keep(?:ing)?\\s+the\\s+same\\s+(?:character|subject|protagonist))\\b',
].join('|'));

const STYLE_CONTINUITY_CUE_RE = new RegExp([
  '\\b(?:el\\s+mismo|la\\s+misma|los\\s+mismos|las\\s+mismas)\\s+(?:estilo|estetica|paleta(?:\\s+de\\s+colores)?|colores|linea\\s+grafica|direccion\\s+de\\s+arte|universo\\s+visual|iluminacion|atmosfera|tono\\s+visual)\\b',
  '\\b(?:manten(?:iendo)?|conserva(?:ndo)?|siguiendo|repite)\\s+(?:el\\s+mismo\\s+|la\\s+misma\\s+|el\\s+|la\\s+)?(?:estilo|estetica|paleta|linea\\s+grafica|direccion\\s+de\\s+arte)(?:\\s+anterior)?\\b',
  '\\b(?:para\\s+la\\s+misma\\s+(?:serie|campaña|campana|coleccion)|de\\s+la\\s+misma\\s+(?:serie|campaña|campana|coleccion))\\b',
  '\\b(?:same\\s+(?:style|aesthetic|palette|color\\s+palette|art\\s+direction|visual\\s+universe|lighting\\s+mood)|keep(?:ing)?\\s+the\\s+(?:same\\s+)?(?:style|aesthetic|palette)|matching\\s+(?:style|aesthetic|palette)|for\\s+the\\s+same\\s+(?:series|campaign|collection))\\b',
].join('|'));

/**
 * Classify cross-turn visual continuity intent:
 *   - `'strict'`: keep character/subject identity + style + palette across scenes
 *   - `'style'`: keep visual style + palette + art direction for a new subject
 *   - `'none'`: standalone generation (default; triggers ZERO history DB reads)
 *
 * @param {string} text
 * @returns {'none'|'style'|'strict'}
 */
function detectVisualContinuityMode(text) {
  const norm = normalizePlain(text);
  if (!norm) return 'none';
  if (STRICT_CONTINUITY_CUE_RE.test(norm)) return 'strict';
  if (STYLE_CONTINUITY_CUE_RE.test(norm)) return 'style';
  return 'none';
}

// ── Cross-Lingual ES↔EN Visual Query Expansion & MMR Chunk Diversity ──────

const VISUAL_BILINGUAL_CLUSTERS = [
  {
    es: ['marca', 'manual de marca', 'identidad', 'corporativo', 'corporativos', 'logotipo'],
    en: ['brand', 'guidelines', 'identity', 'corporate', 'palette', 'logo'],
  },
  {
    es: ['color', 'colores', 'paleta', 'tono', 'tonos', 'acento', 'primario', 'secundario'],
    en: ['color', 'colors', 'palette', 'tone', 'accent', 'primary', 'secondary', 'hex', 'pantone'],
  },
  {
    es: ['envase', 'empaque', 'botella', 'frasco', 'caja', 'etiqueta', 'tapa', 'bolsa', 'lata'],
    en: ['packaging', 'container', 'bottle', 'jar', 'box', 'label', 'cap', 'lid', 'pouch'],
  },
  {
    es: ['producto', 'dispositivo', 'cargador', 'cafetera', 'reloj', 'termo', 'auriculares', 'calzado', 'perfume', 'cosmetico'],
    en: ['product', 'device', 'charger', 'espresso', 'coffee', 'watch', 'thermos', 'headphones', 'footwear', 'perfume', 'fragrance', 'skincare'],
  },
  {
    es: ['material', 'materiales', 'vidrio', 'acero', 'aluminio', 'madera', 'nogal', 'roble', 'ceramica', 'cuero', 'laton', 'hormigon', 'marmol', 'lino', 'papel'],
    en: ['material', 'materials', 'glass', 'steel', 'aluminum', 'wood', 'walnut', 'oak', 'ceramic', 'leather', 'brass', 'concrete', 'marble', 'linen', 'kraft'],
  },
  {
    es: ['mate', 'cepillado', 'esmerilado', 'anodizado', 'brillante', 'textura', 'acabado'],
    en: ['matte', 'brushed', 'frosted', 'anodized', 'glossy', 'polished', 'texture', 'finish'],
  },
  {
    es: ['arquitectura', 'pabellon', 'edificio', 'fachada', 'interior', 'sala', 'habitacion', 'oficina', 'mobiliario'],
    en: ['architecture', 'pavilion', 'building', 'facade', 'interior', 'room', 'living', 'office', 'furniture'],
  },
  {
    es: ['tipografia', 'fuente', 'letra', 'titulo', 'portada', 'cartel', 'poster', 'infografia', 'diagrama'],
    en: ['typography', 'typeface', 'font', 'headline', 'title', 'cover', 'poster', 'infographic', 'diagram'],
  },
  {
    es: ['personaje', 'protagonista', 'vestuario', 'ropa', 'retrato', 'modelo'],
    en: ['character', 'protagonist', 'wardrobe', 'apparel', 'garment', 'portrait', 'subject'],
  },
  {
    es: ['vehiculo', 'coche', 'auto', 'joya', 'anillo', 'diamante'],
    en: ['vehicle', 'car', 'automotive', 'jewelry', 'ring', 'diamond', 'gemstone'],
  },
];

function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsClusterTerm(normQuery, terms) {
  for (const t of terms) {
    const re = new RegExp(`\\b${escapeRegexLiteral(t)}\\b`, 'i');
    if (re.test(normQuery)) return true;
  }
  return false;
}

/**
 * Deterministic <0.5ms bilingual ES↔EN visual query expansion so Spanish
 * prompts retrieve English brand/product/architecture PDF chunks in lexical
 * BM25 mode and vice versa — zero LLM roundtrips.
 */
function expandVisualRagQuery(query) {
  const base = collapseSpaces(query);
  if (!base) return '';
  const norm = normalizePlain(base);
  const existingWords = new Set(norm.split(/\W+/).filter(Boolean));
  const added = [];

  for (const cluster of VISUAL_BILINGUAL_CLUSTERS) {
    const hasEs = containsClusterTerm(norm, cluster.es);
    const hasEn = containsClusterTerm(norm, cluster.en);
    if (hasEs) {
      for (const term of cluster.en) {
        for (const token of term.split(/\s+/)) {
          if (token && !existingWords.has(token) && !added.includes(token)) {
            added.push(token);
            if (added.length >= 18) break;
          }
        }
        if (added.length >= 18) break;
      }
    }
    if (hasEn && added.length < 18) {
      for (const term of cluster.es) {
        for (const token of term.split(/\s+/)) {
          if (token && !existingWords.has(token) && !added.includes(token)) {
            added.push(token);
            if (added.length >= 18) break;
          }
        }
        if (added.length >= 18) break;
      }
    }
    if (added.length >= 18) break;
  }

  return added.length > 0 ? `${base} ${added.join(' ')}` : base;
}

// ── Visual Fact & Palette Extraction from Retrieved Chunks ────────────────

const HEX_COLOR_RE = /#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g;
const COLOR_SPEC_RE = /\b(?:Pantone\s+[0-9A-Za-z][0-9A-Za-z\s-]{0,14}?(?=\s*(?:[,.;)|]|$|\band\b|\by\b))|PMS\s+[0-9]{2,4}\s*[CUcu]?|RAL\s+[0-9]{4})\b/gi;
const MATERIAL_CUE_RE = /\b(?:vidrio(?:\s+esmerilado|\s+ahumado)?|acero(?:\s+inoxidable|\s+cepillado)?|aluminio(?:\s+anodizado|\s+cepillado)?|madera(?:\s+de\s+[a-záéíóúñ]+)?|ceramica(?:\s+mate)?|porcelana|cuero(?:\s+vegetal)?|piel|algodon(?:\s+organico)?|lino|seda|terciopelo|papel\s+kraft|carton\s+reciclado|marmol|travertino|hormigon(?:\s+blanco|\s+visto)?|concreto|laton(?:\s+cepillado)?|bronce|oro\s+(?:mate|18k|rosa)|platino|titanio|fibra\s+de\s+carbono|brushed\s+(?:aluminum|steel|brass|titanium)|anodized\s+aluminum|frosted\s+glass|smoked\s+glass|matte\s+(?:ceramic|black|white|porcelain)|oak\s+wood|walnut(?:\s+wood)?|linen|kraft\s+paper|travertine|terracotta|carbon\s+fiber)\b/gi;
const GEOMETRY_CUE_RE = /\b(?:(?:frasco|envase|cuerpo|botella|estructura|silueta|caja|diseño)\s+(?:octogonal|cilindric[oa]|hexagonal|rectangular|esferic[oa]|cubica|minimalista|curv[oa]|modular)|(?:octagonal|cylindrical|hexagonal|spherical|modular|beveled)\s+(?:bottle|jar|body|vessel|housing|form|silhouette)|esquinas?\s+redondeadas?|bordes?\s+biselados?|rounded\s+corners?|beveled\s+edges?|\d{2,4}\s?(?:ml|mm|cm|oz))\b/gi;
const TYPOGRAPHY_STYLE_CUE_RE = /\b(?:sans[\s-]?serif\s+geometrica|geometric\s+sans(?:[\s-]?serif)?|serif\s+editorial|editorial\s+serif|high[\s-]?contrast\s+serif|grotesca\s+moderna|neo[\s-]?grotesque|tipografia\s+(?:condensada|minimalista|monoespaciada)|condensed\s+sans|monospace\s+typeface)\b/gi;

function normalizeHexColor(rawHex) {
  const clean = String(rawHex || '').trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(clean)) return clean;
  if (/^#[0-9A-F]{3}$/.test(clean)) {
    return `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
  }
  return clean;
}

function jaccardSetSimilarity(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const tok of small) {
    if (large.has(tok)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

function computeVisualSpecDensityBonus(text) {
  if (!text) return 0;
  let bonus = 0;
  HEX_COLOR_RE.lastIndex = 0;
  COLOR_SPEC_RE.lastIndex = 0;
  MATERIAL_CUE_RE.lastIndex = 0;
  GEOMETRY_CUE_RE.lastIndex = 0;
  if (HEX_COLOR_RE.test(text) || COLOR_SPEC_RE.test(text)) bonus += 0.07;
  if (MATERIAL_CUE_RE.test(text)) bonus += 0.05;
  if (GEOMETRY_CUE_RE.test(text)) bonus += 0.03;
  HEX_COLOR_RE.lastIndex = 0;
  COLOR_SPEC_RE.lastIndex = 0;
  MATERIAL_CUE_RE.lastIndex = 0;
  GEOMETRY_CUE_RE.lastIndex = 0;
  return bonus;
}

/**
 * Token-Jaccard Maximal Marginal Relevance (MMR) selector over candidate RAG
 * chunks (`lambda = 0.72`). Ensures multi-chunk retrieval from long documents
 * captures complementary visual facets (e.g. brand palette chunk + material/form
 * chunk + typography/mood chunk) instead of near-duplicate paragraphs.
 */
function selectDiverseVisualChunks(candidates, k = 4, lambda = 0.72) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const limit = Math.max(1, k);

  // Deduplicate exact normalized chunk bodies first.
  const unique = [];
  const seenText = new Set();
  for (const c of candidates) {
    const raw = String(c?.text || '').trim();
    if (!raw) continue;
    const key = normalizePlain(raw);
    if (!key || seenText.has(key)) continue;
    seenText.add(key);
    unique.push(c);
  }
  if (unique.length <= limit) return unique;

  const maxRawScore = Math.max(...unique.map((c) => Number(c.score) || 0), 1e-6);
  const prepared = unique.map((chunk, idx) => {
    const rawScore = Number(chunk.score);
    const rel = Number.isFinite(rawScore) && rawScore > 0
      ? rawScore / maxRawScore
      : Math.max(0.25, 1 - idx * 0.1);
    return {
      chunk,
      tokens: new Set(documentTokens(chunk.text)),
      relevance: Math.min(1.15, rel + computeVisualSpecDensityBonus(chunk.text)),
      source: chunk.source ? String(chunk.source) : '',
    };
  });

  const selected = [];
  const used = new Set();

  while (selected.length < limit && used.size < prepared.length) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < prepared.length; i += 1) {
      if (used.has(i)) continue;
      const item = prepared[i];
      let maxSim = 0;
      let sameSourceCount = 0;
      for (const sel of selected) {
        const sim = jaccardSetSimilarity(item.tokens, sel.tokens);
        if (sim > maxSim) maxSim = sim;
        if (item.source && sel.source && item.source === sel.source) sameSourceCount += 1;
      }
      const mmrScore = selected.length === 0
        ? item.relevance
        : (lambda * item.relevance) - ((1 - lambda) * maxSim) - (sameSourceCount > 0 ? 0.03 * sameSourceCount : 0);
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break;
    used.add(bestIdx);
    selected.push(prepared[bestIdx]);
  }

  return selected.map((s) => s.chunk);
}

function extractVisualFactsFromChunks(chunks, query) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return {
      summary: '',
      hexColors: [],
      colorSpecs: [],
      materials: [],
      geometryCues: [],
      typographyCues: [],
      sources: [],
    };
  }

  const expandedQuery = expandVisualRagQuery(query || '');
  const hexSet = new Set();
  const colorSpecSet = new Set();
  const materialSet = new Set();
  const geometrySet = new Set();
  const typographySet = new Set();
  const sourceSet = new Set();
  const excerpts = [];

  const diverseChunks = selectDiverseVisualChunks(chunks, 4);

  for (const hit of diverseChunks) {
    const rawText = String(hit?.text || '');
    if (!rawText.trim()) continue;

    for (const hexMatch of rawText.matchAll(HEX_COLOR_RE)) {
      if (hexSet.size < 5) hexSet.add(normalizeHexColor(hexMatch[0]));
    }
    for (const csMatch of rawText.matchAll(COLOR_SPEC_RE)) {
      const cleanedSpec = collapseSpaces(csMatch[0]);
      if (cleanedSpec && colorSpecSet.size < 4) colorSpecSet.add(cleanedSpec);
    }
    for (const matMatch of rawText.matchAll(MATERIAL_CUE_RE)) {
      const cleanedMat = collapseSpaces(matMatch[0].toLowerCase());
      if (cleanedMat && materialSet.size < 5) materialSet.add(cleanedMat);
    }
    for (const geoMatch of rawText.matchAll(GEOMETRY_CUE_RE)) {
      const cleanedGeo = collapseSpaces(geoMatch[0].toLowerCase());
      if (cleanedGeo && geometrySet.size < 4) geometrySet.add(cleanedGeo);
    }
    for (const typoMatch of rawText.matchAll(TYPOGRAPHY_STYLE_CUE_RE)) {
      const cleanedTypo = collapseSpaces(typoMatch[0].toLowerCase());
      if (cleanedTypo && typographySet.size < 3) typographySet.add(cleanedTypo);
    }
    if (hit.source) sourceSet.add(String(hit.source));

    const focused = queryFocusedExcerpt(rawText, expandedQuery || query || '', 210);
    const sanitized = sanitizeRetrievedVisualData(focused, 210);
    if (sanitized && !excerpts.includes(sanitized)) {
      excerpts.push(sanitized);
    }
  }

  const hexColors = [...hexSet];
  const colorSpecs = [...colorSpecSet];
  const materials = [...materialSet];
  const geometryCues = [...geometrySet];
  const typographyCues = [...typographySet];

  const parts = [];
  const paletteTokens = [...hexColors, ...colorSpecs];
  if (paletteTokens.length > 0) parts.push(`palette ${paletteTokens.join(', ')}`);
  if (materials.length > 0) parts.push(`materials ${materials.join(', ')}`);
  if (geometryCues.length > 0) parts.push(`form ${geometryCues.join(', ')}`);
  if (typographyCues.length > 0) parts.push(`typography ${typographyCues.join(', ')}`);
  if (excerpts.length > 0) parts.push(excerpts.slice(0, 2).join(' | '));

  const combined = sanitizeRetrievedVisualData(parts.join('; '), MAX_GROUNDING_CHARS);
  return {
    summary: combined,
    hexColors,
    colorSpecs,
    materials,
    geometryCues,
    typographyCues,
    sources: [...sourceSet].slice(0, 4),
  };
}

// ── Tier-1 Document / RAG Store Retrieval ─────────────────────────────────

function isNonImageMimeOrName(mimeType, name) {
  const mime = String(mimeType || '').toLowerCase().trim();
  const filename = String(name || '').toLowerCase().trim();
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) return false;
  if (/\.(?:png|jpe?g|webp|gif|bmp|svg|heic|heif|avif|mp3|wav|ogg|m4a|mp4|mov|webm)$/i.test(filename)) return false;
  if (mime || filename) return true;
  return false;
}

function collectNonImageFileIds({ documentFileIds, fileIds, fileMetadata }) {
  const out = [];
  const seen = new Set();
  const push = (id) => {
    const s = String(id || '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };

  if (Array.isArray(documentFileIds)) {
    for (const id of documentFileIds) push(id);
  }

  const metaById = new Map();
  if (Array.isArray(fileMetadata)) {
    for (const m of fileMetadata) {
      if (!m) continue;
      const id = m.id || m.fileId;
      if (id) metaById.set(String(id), m);
      if (id && isNonImageMimeOrName(m.mimeType || m.type, m.name || m.originalName || m.filename)) {
        push(id);
      }
    }
  }

  // If `fileIds` are passed without metadata, only include IDs not known to be media.
  if (Array.isArray(fileIds) && (!Array.isArray(fileMetadata) || fileMetadata.length === 0)) {
    for (const id of fileIds) push(id);
  } else if (Array.isArray(fileIds)) {
    for (const id of fileIds) {
      const m = metaById.get(String(id));
      if (m && isNonImageMimeOrName(m.mimeType || m.type, m.name || m.originalName || m.filename)) {
        push(id);
      }
    }
  }

  return out.slice(0, 6);
}

async function retrieveFromRagCollection(userId, collection, query, k = 4, { lexicalOnly = false } = {}) {
  if (!userId || !collection) return [];
  const expandedQuery = expandVisualRagQuery(query);
  try {
    const stats = await Promise.resolve(ragStore.stats(userId, collection));
    if (!stats || !stats.chunks || stats.chunks <= 0) return [];

    if (!lexicalOnly) {
      let timer = null;
      try {
        const timeoutSentinel = Symbol('rag_timeout');
        const raced = await Promise.race([
          ragService.retrieve(userId, collection, expandedQuery, k, {
            hybrid: true,
            mmr: true,
            documentMode: true,
            sourceDiversity: true,
            expand: false,
            rerank: false,
          }),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(timeoutSentinel), SEMANTIC_RETRIEVE_BUDGET_MS);
            if (timer && typeof timer.unref === 'function') timer.unref();
          }),
        ]);
        if (raced !== timeoutSentinel && Array.isArray(raced) && raced.length > 0) {
          return selectDiverseVisualChunks(raced, k);
        }
      } catch {
        // Fall through to deterministic lexical BM25 over stored chunks.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    const entries = await Promise.resolve(ragStore.getAll(userId, collection));
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const lexHits = searchDocumentLexical(entries, expandedQuery, Math.max(k * 3, 10))
      .filter((h) => h && h.doc && Number.isInteger(h.doc._idx) && h.score > 0)
      .map((h) => ({
        ...entries[h.doc._idx],
        score: h.score,
      }));
    return selectDiverseVisualChunks(diversifyDocumentSources(lexHits, Math.max(k * 2, 8)), k);
  } catch {
    return [];
  }
}

function parseFilesArray(rawFiles) {
  if (!rawFiles) return [];
  if (Array.isArray(rawFiles)) return rawFiles;
  if (typeof rawFiles === 'string') {
    try {
      const parsed = JSON.parse(rawFiles);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function loadChatDocumentChunksFromPrisma({
  prisma,
  userId,
  chatId,
  nonImageFileIds,
  recoverFromChatHistory,
  chatPreValidated,
}) {
  if (!prisma || !userId) return [];
  const candidateIds = [...nonImageFileIds];
  const seen = new Set(candidateIds);

  if (recoverFromChatHistory && chatId && candidateIds.length === 0 && typeof prisma.message?.findMany === 'function') {
    try {
      let owned = Boolean(chatPreValidated);
      if (!owned && typeof prisma.chat?.findFirst === 'function') {
        const chat = await prisma.chat.findFirst({
          where: { id: chatId, userId, deletedAt: null },
          select: { id: true },
        });
        owned = Boolean(chat);
      } else if (!owned) {
        owned = true;
      }
      if (owned) {
        const recentUserMsgs = await prisma.message.findMany({
          where: { chatId, role: 'USER', deletedAt: null },
          orderBy: { timestamp: 'desc' },
          take: 10,
          select: { files: true },
        });
        for (const msg of Array.isArray(recentUserMsgs) ? recentUserMsgs : []) {
          for (const item of parseFilesArray(msg?.files)) {
            const fid = typeof item === 'string' ? item : (item?.id || item?.fileId);
            const mime = typeof item === 'object' ? (item?.type || item?.mimeType) : '';
            const name = typeof item === 'object' ? (item?.name || item?.filename || item?.originalName) : '';
            if (fid && !seen.has(String(fid)) && (!mime && !name ? true : isNonImageMimeOrName(mime, name))) {
              seen.add(String(fid));
              candidateIds.push(String(fid));
              if (candidateIds.length >= 4) break;
            }
          }
          if (candidateIds.length >= 4) break;
        }
      }
    } catch {
      // Fail-open: skip history document recovery if DB mock does not support it.
    }
  }

  if (candidateIds.length === 0) return [];

  let records = [];
  try {
    if (typeof prisma.file?.findMany === 'function') {
      records = await prisma.file.findMany({
        where: { id: { in: candidateIds }, userId },
      });
    } else if (typeof prisma.file?.findFirst === 'function') {
      const loaded = await Promise.all(
        candidateIds.map((id) => prisma.file.findFirst({ where: { id, userId } }).catch(() => null))
      );
      records = loaded.filter(Boolean);
    } else if (typeof prisma.file?.findUnique === 'function') {
      const loaded = await Promise.all(
        candidateIds.map((id) => prisma.file.findUnique({ where: { id } }).catch(() => null))
      );
      records = loaded.filter((r) => r && (!r.userId || r.userId === userId));
    }
  } catch {
    records = [];
  }

  const chunkEntries = [];
  for (const file of Array.isArray(records) ? records : []) {
    if (!file || typeof file.extractedText !== 'string' || !file.extractedText.trim()) continue;
    const sourceName = file.originalName || file.filename || file.name || file.id;
    if (!isNonImageMimeOrName(file.mimeType, sourceName)) continue;
    const pieces = ragService.chunk(file.extractedText, { size: 1400, overlap: 200 });
    for (let i = 0; i < Math.min(pieces.length, 40); i += 1) {
      chunkEntries.push({
        text: pieces[i],
        source: sourceName,
        title: sourceName,
        chunkIndex: i,
      });
    }
  }
  return chunkEntries;
}

/**
 * Retrieve Tier-1 visual grounding facts from RAG collections and in-scope
 * chat/attached documents. Performs ZERO DB reads when no grounding triggers
 * are active.
 */
async function retrieveImageDocumentGrounding({
  prompt,
  userId,
  chatId,
  projectId,
  gptId,
  collection,
  prisma,
  documentFileIds,
  fileIds,
  fileMetadata,
  ragHits,
  chatPreValidated = false,
  lexicalOnly = false,
} = {}) {
  const query = String(prompt || '').trim();
  if (!query) {
    return { grounded: false, summary: '', hexColors: [], materials: [], sources: [], chunkCount: 0 };
  }

  const hasDocCue = detectDocumentGroundingCue(query);
  const nonImageFileIds = collectNonImageFileIds({ documentFileIds, fileIds, fileMetadata });
  const preSuppliedHits = Array.isArray(ragHits) ? ragHits.filter((h) => h && typeof h.text === 'string' && h.text.trim()) : [];

  // Check if chat-scoped in-memory RAG already holds chunks without touching Prisma.
  let hasInMemoryChatRag = false;
  if (userId && chatId && !ragStore.isPg && ragStore._memoryBackend) {
    try {
      const st = await ragStore._memoryBackend.stats(userId, `chat:${chatId}`);
      hasInMemoryChatRag = Boolean(st && st.chunks > 0);
    } catch {
      hasInMemoryChatRag = false;
    }
  }

  const shouldRun = hasDocCue || nonImageFileIds.length > 0 || preSuppliedHits.length > 0 || hasInMemoryChatRag;
  if (!shouldRun) {
    return { grounded: false, summary: '', hexColors: [], materials: [], sources: [], chunkCount: 0 };
  }

  const collectedHits = [...preSuppliedHits];

  if (userId) {
    const candidateCollections = [];
    if (chatId) candidateCollections.push(`chat:${chatId}`);
    if (projectId) candidateCollections.push(`project:${projectId}`);
    if (gptId) candidateCollections.push(`gpt:${gptId}`);
    if (collection && !candidateCollections.includes(collection) && (hasDocCue || collection !== 'default')) {
      candidateCollections.push(collection);
    } else if (hasDocCue && !candidateCollections.includes('default')) {
      candidateCollections.push('default');
    }

    for (const coll of candidateCollections) {
      // eslint-disable-next-line no-await-in-loop
      const hits = await retrieveFromRagCollection(userId, coll, query, 4, { lexicalOnly });
      for (const h of hits) collectedHits.push(h);
      if (collectedHits.length >= 6) break;
    }
  }

  if (collectedHits.length < 4 && (nonImageFileIds.length > 0 || hasDocCue)) {
    const fileChunks = await loadChatDocumentChunksFromPrisma({
      prisma,
      userId,
      chatId,
      nonImageFileIds,
      recoverFromChatHistory: hasDocCue,
      chatPreValidated,
    });
    if (fileChunks.length > 0) {
      const expandedQuery = expandVisualRagQuery(query);
      const lexRanked = searchDocumentLexical(fileChunks, expandedQuery, 12)
        .filter((h) => h && h.doc && Number.isInteger(h.doc._idx) && h.score > 0)
        .map((h) => ({ ...fileChunks[h.doc._idx], score: h.score }));
      const selected = lexRanked.length > 0
        ? selectDiverseVisualChunks(diversifyDocumentSources(lexRanked, 8), 4)
        : selectDiverseVisualChunks(fileChunks, 3);
      for (const s of selected) collectedHits.push(s);
    }
  }

  if (collectedHits.length === 0) {
    return {
      grounded: false,
      summary: '',
      hexColors: [],
      colorSpecs: [],
      materials: [],
      geometryCues: [],
      typographyCues: [],
      sources: [],
      chunkCount: 0,
    };
  }

  const extracted = extractVisualFactsFromChunks(collectedHits, query);
  return {
    grounded: Boolean(extracted.summary),
    summary: extracted.summary,
    hexColors: extracted.hexColors,
    colorSpecs: extracted.colorSpecs,
    materials: extracted.materials,
    geometryCues: extracted.geometryCues,
    typographyCues: extracted.typographyCues,
    sources: extracted.sources,
    chunkCount: collectedHits.length,
  };
}

// ── Cross-Turn Multi-Frame Visual Continuity Ledger ───────────────────────

function extractPriorImagePromptsFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const found = [];
  for (const msg of messages) {
    for (const f of parseFilesArray(msg?.files)) {
      if (!f || typeof f !== 'object') continue;
      const isImg = f.type === 'image' || String(f.mimeType || f.type || '').startsWith('image/') || Boolean(f.aspectRatio);
      if (!isImg) continue;
      const rawPrompt = stripPreviousImageDirection(String(f.prompt || '').trim());
      const storedAnchor = f.visualAnchor ? stripPreviousImageDirection(String(f.visualAnchor).trim()) : null;
      if (rawPrompt || storedAnchor) {
        found.push({
          prompt: rawPrompt || storedAnchor,
          visualAnchor: storedAnchor || null,
          aspectRatio: f.aspectRatio || null,
          archetype: f.ragArchetype || null,
        });
      }
    }
    if (found.length >= 6) break;
  }
  return found;
}

/**
 * Walk backward from `priors[0]` (most recent frame) along contiguous sequel
 * frames to recover the founding character/style origin anchor of the active
 * series without mixing in unrelated images from earlier in the chat.
 */
function resolveOriginAndLatestAnchors(priors) {
  if (!Array.isArray(priors) || priors.length === 0) {
    return { originAnchor: '', latestScene: '' };
  }
  const latestScene = sanitizeRetrievedVisualData(priors[0].prompt, 180);
  if (priors[0].visualAnchor) {
    const stored = sanitizeRetrievedVisualData(priors[0].visualAnchor, 180);
    if (stored) {
      return { originAnchor: stored, latestScene: latestScene || stored };
    }
  }

  let chainOriginIdx = 0;
  while (
    chainOriginIdx < priors.length - 1
    && detectVisualContinuityMode(priors[chainOriginIdx].prompt) !== 'none'
  ) {
    chainOriginIdx += 1;
    if (priors[chainOriginIdx].visualAnchor) {
      const stored = sanitizeRetrievedVisualData(priors[chainOriginIdx].visualAnchor, 180);
      if (stored) {
        return { originAnchor: stored, latestScene: latestScene || stored };
      }
    }
  }

  const originAnchor = sanitizeRetrievedVisualData(priors[chainOriginIdx].prompt, 180) || latestScene;
  return { originAnchor, latestScene };
}

/**
 * Resolve cross-turn visual continuity when the user explicitly asks to keep
 * the same character/subject (`strict`) or aesthetic/palette (`style`).
 * Preserves the founding character/style `visualAnchor` across 3+ turn chains
 * while returning `mode: 'none'` with ZERO DB reads for standalone prompts.
 */
async function resolveVisualContinuity({
  prompt,
  prisma,
  userId,
  chatId,
  historyPrompts,
  chatPreValidated = false,
} = {}) {
  const mode = detectVisualContinuityMode(prompt);
  if (mode === 'none') {
    return { mode: 'none', clause: '', priorCount: 0, visualAnchor: null };
  }

  let priors = [];
  if (Array.isArray(historyPrompts) && historyPrompts.length > 0) {
    priors = historyPrompts
      .map((item) => (typeof item === 'string'
        ? { prompt: stripPreviousImageDirection(item), visualAnchor: null }
        : {
          prompt: stripPreviousImageDirection(item?.prompt || ''),
          visualAnchor: item?.visualAnchor ? stripPreviousImageDirection(item.visualAnchor) : null,
          aspectRatio: item?.aspectRatio || null,
        }))
      .filter((p) => p.prompt || p.visualAnchor);
  } else if (prisma && userId && chatId && typeof prisma.message?.findMany === 'function') {
    try {
      let owned = Boolean(chatPreValidated);
      if (!owned && typeof prisma.chat?.findFirst === 'function') {
        const chat = await prisma.chat.findFirst({
          where: { id: chatId, userId, deletedAt: null },
          select: { id: true },
        });
        owned = Boolean(chat);
      } else if (!owned) {
        owned = true;
      }
      if (owned) {
        const rows = await prisma.message.findMany({
          where: { chatId, role: 'ASSISTANT', deletedAt: null },
          orderBy: { timestamp: 'desc' },
          take: 10,
          select: { files: true },
        });
        priors = extractPriorImagePromptsFromMessages(rows);
      }
    } catch {
      priors = [];
    }
  }

  if (priors.length === 0) {
    return { mode, clause: '', priorCount: 0, visualAnchor: null };
  }

  const { originAnchor, latestScene } = resolveOriginAndLatestAnchors(priors);
  if (!originAnchor) {
    return { mode, clause: '', priorCount: 0, visualAnchor: null };
  }

  const hasMultiStepChain = Boolean(
    latestScene
    && normalizePlain(originAnchor) !== normalizePlain(latestScene)
  );

  let clause;
  if (mode === 'strict') {
    clause = hasMultiStepChain
      ? `Series visual continuity: Maintain exact character/subject identity, facial/structural features, signature wardrobe/materials, color palette, and art style from origin anchor ("${originAnchor}") and latest frame ("${latestScene}"), adapting only the new scene action and staging.`
      : `Series visual continuity: Maintain exact character/subject identity, facial/structural features, signature wardrobe/materials, color palette, and art style established in the prior frame ("${originAnchor}"), adapting only the new scene action and staging.`;
  } else {
    clause = hasMultiStepChain
      ? `Series visual continuity: Maintain the exact visual style, color palette, lighting mood, and rendering craft from origin style anchor ("${originAnchor}") and latest frame ("${latestScene}"), applied cleanly to this new subject.`
      : `Series visual continuity: Maintain the exact visual style, color palette, lighting mood, and rendering craft established in the prior series ("${originAnchor}"), applied cleanly to this new subject.`;
  }

  return {
    mode,
    clause: clause.slice(0, MAX_CONTINUITY_CHARS + 120),
    priorCount: priors.length,
    visualAnchor: originAnchor,
  };
}

// ── Tier-2 Curated Visual Direction Synthesis ─────────────────────────────

function retrieveVisualDirection(query, {
  style,
  imageType,
  aspectRatio = '1:1',
  quality = '2K',
  model,
  quotedTexts = [],
  facetQuery,
  count = 1,
} = {}) {
  const hit = searchVisualDirectionCorpus(query, {
    style,
    imageType,
    aspectRatio,
    model,
    facetQuery: facetQuery !== undefined ? facetQuery : query,
  });
  const primary = hit.primary;
  const secondary = hit.secondary;
  const facets = Array.isArray(hit.facets) ? hit.facets : [];

  const segments = [
    primary.cameraAndOptics,
    primary.lightingAndColor,
    primary.surfaceAndMaterial,
  ];
  for (const facet of facets) {
    segments.push(facet.clause);
  }
  if (secondary) {
    segments.push(`Complementary craft (${secondary.category}): ${secondary.surfaceAndMaterial}`);
  }
  if (hit.frameSpec) {
    segments.push(hit.frameSpec);
  }
  if (hit.modelGuidance && hit.modelGuidance.hint) {
    segments.push(hit.modelGuidance.hint);
  }

  if (Array.isArray(quotedTexts) && quotedTexts.length > 0) {
    const quotedList = quotedTexts.map((t) => `"${t}"`).join(', ');
    segments.push(
      `Typography precision: Render exact legible text ${quotedList} with accurate spelling, balanced kerning, and high figure-ground contrast; do not invent extra words or garbled lettering.`
    );
  } else if (primary.preferTextFree) {
    segments.push('Clean composition free of watermarks, signatures, UI overlays, or unintended text.');
  }

  if (primary.antiArtifacts) {
    segments.push(primary.antiArtifacts);
  }

  const parsedCount = Number.parseInt(count, 10);
  if (Number.isFinite(parsedCount) && parsedCount > 1) {
    segments.push(
      `Multi-variant set (${Math.min(5, parsedCount)} images): Keep subject fidelity and visual style cohesive while varying subtle camera framing or pose across variants.`
    );
  }

  const normalizedQuality = String(quality || '').toUpperCase();
  if (normalizedQuality === '4K' || normalizedQuality === 'HD') {
    segments.push('Ultra-high 4K master resolution clarity and crisp micro-detail.');
  }

  return {
    archetypeId: primary.id,
    secondaryArchetypeId: secondary ? secondary.id : null,
    category: primary.category,
    modelFamily: hit.modelGuidance.family,
    facets: facets.map((f) => f.id),
    score: hit.score,
    directionClause: `Visual direction: ${collapseSpaces(segments.join(' '))}`,
  };
}

// ── Public Orchestrators ──────────────────────────────────────────────────

/**
 * Full Two-Tier Image Generation RAG orchestrator for new image creation
 * (`POST /api/ai/generate-image` and agentic `generate_image`).
 */
async function directImagePrompt({
  prompt,
  rawUserPrompt,
  style,
  imageType,
  aspectRatio = '1:1',
  quality = '2K',
  model,
  count = 1,
  userId,
  chatId,
  projectId,
  gptId,
  collection,
  prisma,
  documentFileIds,
  fileIds,
  fileMetadata,
  ragHits,
  historyPrompts,
  chatPreValidated = false,
  lexicalOnly = false,
} = {}) {
  const cleanSubjectBase = stripPreviousImageDirection(String(prompt || rawUserPrompt || '').trim());
  const intentSource = String(rawUserPrompt || cleanSubjectBase).trim();
  if (!cleanSubjectBase) {
    return {
      prompt: '',
      archetype: null,
      facets: [],
      continuityMode: 'none',
      visualAnchor: null,
      grounded: false,
      groundedSourcesCount: 0,
      artistGuardApplied: false,
      quotedTypography: [],
    };
  }

  // 1. Policy guard: neutralize named-artist imitation (AGENTS.md §10.3).
  const artistGuard = neutralizeNamedArtistImitation(cleanSubjectBase);
  const safeBasePrompt = artistGuard.prompt || cleanSubjectBase;

  // 2. Quoted typography extraction from original user phrasing.
  const quotedTypography = extractQuotedTypography(intentSource);

  // 3. Tier-1 Document / Project / Chat RAG Grounding (zero DB reads unless triggered).
  const grounding = await retrieveImageDocumentGrounding({
    prompt: intentSource,
    userId,
    chatId,
    projectId,
    gptId,
    collection,
    prisma,
    documentFileIds,
    fileIds,
    fileMetadata,
    ragHits,
    chatPreValidated,
    lexicalOnly,
  });

  // 4. Cross-Turn Multi-Frame Visual Continuity Ledger (zero DB reads unless explicit cue).
  const continuity = await resolveVisualContinuity({
    prompt: intentSource,
    prisma,
    userId,
    chatId,
    historyPrompts,
    chatPreValidated,
  });

  // 5. Tier-2 Curated Visual Direction BM25 RAG (augmented by grounded domain terms).
  const corpusQuery = grounding.grounded
    ? `${intentSource} ${intentSource} ${grounding.materials.join(' ')} ${grounding.summary.slice(0, 140)}`
    : intentSource;
  const visualDirection = retrieveVisualDirection(corpusQuery, {
    style,
    imageType,
    aspectRatio,
    quality,
    model,
    quotedTexts: quotedTypography,
    facetQuery: intentSource,
    count,
  });

  // 6. Assemble provider prompt with user subject FIRST for top attention weight,
  //    bounded safely within MAX_PROVIDER_PROMPT_CHARS without ever truncating
  //    the user's own core prompt.
  const tailBlocks = [];
  if (grounding.grounded && grounding.summary) {
    tailBlocks.push(`Reference visual attributes: ${grounding.summary}`);
  }
  if (continuity.clause) {
    tailBlocks.push(continuity.clause);
  }
  if (visualDirection.directionClause) {
    tailBlocks.push(visualDirection.directionClause);
  }

  let finalPrompt = safeBasePrompt;
  for (const block of tailBlocks) {
    const candidate = `${finalPrompt} ${block}`.replace(/\s+/g, ' ').trim();
    if (candidate.length <= MAX_PROVIDER_PROMPT_CHARS) {
      finalPrompt = candidate;
    } else {
      const remaining = MAX_PROVIDER_PROMPT_CHARS - finalPrompt.length - 2;
      if (remaining > 80) {
        finalPrompt = `${finalPrompt} ${block.slice(0, remaining).trim()}…`;
      }
      break;
    }
  }

  const effectiveVisualAnchor = continuity.visualAnchor
    || sanitizeRetrievedVisualData(safeBasePrompt, 180)
    || null;

  return {
    prompt: finalPrompt,
    archetype: visualDirection.archetypeId,
    secondaryArchetype: visualDirection.secondaryArchetypeId,
    category: visualDirection.category,
    facets: visualDirection.facets,
    continuityMode: continuity.mode,
    visualAnchor: effectiveVisualAnchor,
    grounded: grounding.grounded,
    groundedSourcesCount: grounding.sources.length,
    hexColors: grounding.hexColors,
    colorSpecs: grounding.colorSpecs,
    artistGuardApplied: artistGuard.neutralized,
    quotedTypography,
  };
}

/**
 * Targeted RAG enrichment for image edits (`edit_image` and `/generate-image`
 * edit mode). Strictly preserves all scoped target, selection, reference, and
 * canvas-role clauses, adding ONLY:
 *   - AGENTS.md §10.3 named-artist neutralization,
 *   - Document/brand RAG attributes (e.g. brand hex colors) when explicitly
 *     requested or attached,
 *   - Quoted typography precision when exact on-image text is quoted.
 */
async function directImageEditPrompt({
  editPrompt,
  rawInstruction,
  userId,
  chatId,
  projectId,
  gptId,
  collection,
  prisma,
  documentFileIds,
  fileIds,
  fileMetadata,
  ragHits,
  chatPreValidated = false,
  lexicalOnly = false,
} = {}) {
  const baseEditPrompt = stripPreviousImageDirection(String(editPrompt || rawInstruction || '').trim());
  const intentSource = String(rawInstruction || baseEditPrompt).trim();
  if (!baseEditPrompt) {
    return { prompt: '', grounded: false, groundedSourcesCount: 0, artistGuardApplied: false };
  }

  const artistGuard = neutralizeNamedArtistImitation(baseEditPrompt);
  let finalPrompt = artistGuard.prompt || baseEditPrompt;

  // For edits, query document grounding on explicit document/brand cues OR
  // when non-image documents were explicitly attached alongside the image.
  const hasExplicitDocs = Array.isArray(documentFileIds) && documentFileIds.length > 0;
  const grounding = (detectDocumentGroundingCue(intentSource) || hasExplicitDocs)
    ? await retrieveImageDocumentGrounding({
      prompt: intentSource,
      userId,
      chatId,
      projectId,
      gptId,
      collection,
      prisma,
      documentFileIds,
      fileIds,
      fileMetadata,
      ragHits,
      chatPreValidated,
      lexicalOnly,
    })
    : { grounded: false, summary: '', sources: [] };

  const quotedTypography = extractQuotedTypography(intentSource);
  const extras = [];
  if (grounding.grounded && grounding.summary) {
    extras.push(`Reference visual attributes: ${grounding.summary}`);
  }
  if (quotedTypography.length > 0) {
    const quotedList = quotedTypography.map((t) => `"${t}"`).join(', ');
    extras.push(`Visual direction: Render exact legible text ${quotedList} with accurate spelling and clean contrast.`);
  }

  for (const extra of extras) {
    const candidate = `${finalPrompt} ${extra}`.replace(/\s+/g, ' ').trim();
    if (candidate.length <= MAX_PROVIDER_PROMPT_CHARS) {
      finalPrompt = candidate;
    }
  }

  return {
    prompt: finalPrompt,
    grounded: grounding.grounded,
    groundedSourcesCount: grounding.sources.length,
    artistGuardApplied: artistGuard.neutralized,
    quotedTypography,
  };
}

module.exports = {
  directImagePrompt,
  directImageEditPrompt,
  retrieveImageDocumentGrounding,
  resolveVisualContinuity,
  retrieveVisualDirection,
  expandVisualRagQuery,
  selectDiverseVisualChunks,
  normalizeHexColor,
  detectDocumentGroundingCue,
  detectVisualContinuityMode,
  extractQuotedTypography,
  neutralizeNamedArtistImitation,
  sanitizeRetrievedVisualData,
  extractVisualFactsFromChunks,
  stripPreviousImageDirection,
};
