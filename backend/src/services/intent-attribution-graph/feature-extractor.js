'use strict';

/**
 * Feature extractor — atomic intent feature decomposition.
 *
 * Inspired by attribution-graphs: instead of treating a prompt as one
 * monolithic intent, we decompose it into ~10–30 atomic "features" that
 * each represent one human-understandable conceptual unit, with the
 * source span that triggered it. Later modules compose these into
 * supernodes, circuits, plans and confidence scores.
 *
 * Features have a category, label, source span, weight (how prominent in
 * the prompt) and confidence (how sure we are this was actually meant).
 */

const FEATURE_CATEGORIES = Object.freeze({
  ACTION: 'action',           // What the user wants done (verb)
  OBJECT: 'object',           // The thing being acted on
  MODIFIER: 'modifier',       // Qualifiers (urgency, scope, quality)
  CONSTRAINT: 'constraint',   // Hard limits (must, cannot, only)
  TEMPORAL: 'temporal',       // Time references (now, after, when)
  CONDITION: 'condition',     // If/unless/depending on
  PERSONA: 'persona',         // Who/role (as a developer, for clients)
  TONE: 'tone',               // Formal, casual, technical, friendly
  LANGUAGE: 'language',       // Output language indicator
  REFERENCE: 'reference',     // Refers to prior turn / external
  NEGATION: 'negation',       // Don't / no / never
  CLARIFICATION: 'clarification', // User asks back / questions
  EMOTION: 'emotion',         // Frustration, excitement, urgency
  IMPLICIT: 'implicit',       // Inferred but not stated
});

const ACTION_LEXICON = [
  // Spanish creative/build
  { pattern: /\b(crea|cre[aá](?:r|me|nos)?|gener(?:a|ar|e|emos)|haz|hacer|construy(?:e|a|amos)|desarroll(?:a|ar|e|emos)|implementa(?:r)?|implem[eé]ntalo|imp[lL]ementa|programa(?:r)?|escrib(?:e|ir|amos)|redacta(?:r)?)\b/i, label: 'create', weight: 1.0 },
  // Spanish modify
  { pattern: /\b(mejor(?:a|ar|e|emos)|optimiz(?:a|ar|e|emos)|refactoriz(?:a|ar)|reescrib(?:e|ir)|actualiz(?:a|ar|e|emos)|corrig(?:e|ir)|arregl(?:a|ar|e|emos)|repar(?:a|ar)|ajust(?:a|ar)|modific(?:a|ar|amos|alo|ame)|cambi(?:a|ar|alo|emos)|edit(?:a|ar|alo))\b/i, label: 'modify', weight: 0.95 },
  // Spanish analyze
  { pattern: /\b(analiz(?:a|ar|e|emos)|revis(?:a|ar|e|emos)|estudi(?:a|ar|e|emos)|investig(?:a|ar|e|emos)|examin(?:a|ar)|evalu(?:a|ar|e|emos)|audit(?:a|ar))\b/i, label: 'analyze', weight: 0.9 },
  // Spanish explain
  { pattern: /\b(explic(?:a|ar|e|emos)|describe|describir|cuenta(?:me)?|dime|dijiste|qu[eé] es|c[oó]mo (?:se|lo) hace|por qu[eé])\b/i, label: 'explain', weight: 0.85 },
  // Spanish deploy/run (handles vowel-raise: desplegar → despliega/despliegue/despliegan)
  { pattern: /\b(despleg(?:a|ar|amos)|despli[eé]g(?:a|ue|uen|uemos|alo)|deploy(?:ar)?|levanta(?:r|lo)?|publica(?:r|lo)?|ejecuta(?:r|lo)?|corre(?:r|lo)?|inicia(?:r|lo)?|lanza(?:r|lo)?|run\b|start\b)\b/i, label: 'execute', weight: 0.95 },
  // Spanish test
  { pattern: /\b(prueb(?:a|as|ame|alo)|test(?:ea(?:r)?|s)?|valid(?:a|ar)|verific(?:a|ar)|comprueb(?:a|ame)|chequea(?:r)?)\b/i, label: 'verify', weight: 0.85 },
  // Spanish delete/remove
  { pattern: /\b(elimin(?:a|ar)|borr(?:a|ar)|quit(?:a|ar)|remueve|remover|suprim(?:e|ir)|delete|remove)\b/i, label: 'remove', weight: 0.95 },
  // English create
  { pattern: /\b(create|build|develop|implement|generate|make|write|draft|design|produce|compose)\b/i, label: 'create', weight: 1.0 },
  // English modify
  { pattern: /\b(improve|optimiz(?:e|ation)|refactor|rewrite|update|fix|repair|adjust|tune|tweak)\b/i, label: 'modify', weight: 0.95 },
  // English analyze
  { pattern: /\b(analyze|review|audit|examine|inspect|investigate|study|evaluate|assess)\b/i, label: 'analyze', weight: 0.9 },
  // English explain
  { pattern: /\b(explain|describe|tell\s+me|what\s+is|how\s+does|why\s+is|clarify)\b/i, label: 'explain', weight: 0.85 },
  // English execute
  { pattern: /\b(deploy|release|publish|launch|push\s+to\s+(?:main|prod)|run|start|trigger|invoke|execute)\b/i, label: 'execute', weight: 0.95 },
  // English verify
  { pattern: /\b(test|verify|validate|check|confirm)\b/i, label: 'verify', weight: 0.85 },
  // English remove
  { pattern: /\b(remove|delete|drop|purge|wipe|clear)\b/i, label: 'remove', weight: 0.95 },
  // Multilingual help/seek
  { pattern: /\b(ayud(?:a|ar|ame|enos)|help|assist|aid|support)\b/i, label: 'help', weight: 0.7 },
  // Search / find
  { pattern: /\b(busca(?:r|me)?|encuentr(?:a|ar|ame)|search|find|look\s+for|locate|grep)\b/i, label: 'search', weight: 0.85 },
  // Compare
  { pattern: /\b(compar(?:a|ar|e|emos)|contrast(?:a|ar)|compare|contrast|versus|vs\.?)\b/i, label: 'compare', weight: 0.85 },
  // Summarize
  { pattern: /\b(resum(?:e|ir|i[eé]ndolo)|s[ií]ntesis|summariz(?:e|ation)|summary|tl;?dr|sintetiz(?:a|ar))\b/i, label: 'summarize', weight: 0.85 },
  // Translate
  { pattern: /\b(traduc(?:e|ir|elo)|translate|localize|localiz(?:a|ar))\b/i, label: 'translate', weight: 0.9 },
  // Continue
  { pattern: /\b(contin(?:u|ú)a(?:r)?|sigue(?:lo)?|prosigue|avanza|continue|keep going|carry on|prosigue)\b/i, label: 'continue', weight: 0.9 },
];

const OBJECT_LEXICON = [
  // Software domain
  { pattern: /\b(c[oó]digo|code|funci[oó]n|function|m[oó]dulo|module|clase|class|componente|component)\b/i, label: 'code-artifact' },
  { pattern: /\b(api|endpoint|route|ruta|servicio|service|backend|frontend)\b/i, label: 'api-surface' },
  { pattern: /\b(base de datos|database|esquema|schema|tabla|table|migration|migraci[oó]n|prisma|sql)\b/i, label: 'database' },
  { pattern: /\b(test|tests?|prueba|pruebas|spec|specs|coverage|cobertura)\b/i, label: 'test-suite' },
  { pattern: /\b(documento|document|reporte|report|informe|brief)\b/i, label: 'document' },
  { pattern: /\b(gr[aá]fic[oa]|chart|gr[aá]ficos?|infograf[ií]a|infographic|diagrama|diagram|dashboard|tablero)\b/i, label: 'visualization' },
  { pattern: /\b(imagen|image|foto|video|audio|gif|svg|png)\b/i, label: 'media-asset' },
  { pattern: /\b(pdf|docx|xlsx|pptx|csv|json|xml|yaml|markdown|html|epub)\b/i, label: 'file-format' },
  { pattern: /\b(usuario|user|cliente|client|customer|stakeholder)\b/i, label: 'persona-target' },
  { pattern: /\b(bug|error|fallo|problema|issue|crash|regression|regresi[oó]n)\b/i, label: 'defect' },
  { pattern: /\b(feature|funcionalidad|caracter[ií]stica|capability)\b/i, label: 'feature' },
  { pattern: /\b(pipeline|workflow|flujo|proceso|process|orquestaci[oó]n|orchestration)\b/i, label: 'workflow' },
  { pattern: /\b(security|seguridad|auth|authentication|authorization|rbac|permiso|permission)\b/i, label: 'security' },
  { pattern: /\b(performance|rendimiento|latency|latencia|throughput|p95|p99|optim(?:ization|izaci[oó]n))\b/i, label: 'performance' },
  { pattern: /\b(memoria|memory|cache|cach[eé]|context|contexto|prompt|sistema|system)\b/i, label: 'memory-context' },
  { pattern: /\b(agente|agent|llm|modelo|model|ia|ai|gpt|claude|opus|sonnet|haiku|gemini|grok)\b/i, label: 'ai-agent' },
  { pattern: /\b(deploy(?:ment)?|release|rollout|despliegue|ci\/cd|pipeline\s+ci|producci[oó]n|production|staging|prod\b)\b/i, label: 'deployment' },
  { pattern: /\b(software|sistema|system|plataforma|platform|aplicaci[oó]n|application|app)\b/i, label: 'system' },
];

const MODIFIER_LEXICON = [
  { pattern: /\b(urgent(?:e|ly)?|asap|cuanto antes|inmediatamente|now|ya|de inmediato|priority|prioridad)\b/i, label: 'high-urgency', weight: 1.0 },
  { pattern: /\b(despu[eé]s|later|after|cuando puedas|sin prisa|low priority|baja prioridad)\b/i, label: 'low-urgency', weight: 0.3 },
  { pattern: /\b(mejor|better|robusto|robust|production-ready|production ready|profesional|professional|enterprise)\b/i, label: 'quality-high', weight: 0.9 },
  { pattern: /\b(r[aá]pido|fast|quick|simple|simplificado|minimal|m[ií]nimo|prototype|prototipo|mvp|borrador|draft)\b/i, label: 'quality-low', weight: 0.4 },
  { pattern: /\b(seguro|safe|secure|reliable|confiable|estable|stable|consistent|consistente)\b/i, label: 'reliability', weight: 0.85 },
  { pattern: /\b(completo|complete|total|todo|all|exhaustivo|exhaustive|comprehensive|integral)\b/i, label: 'scope-full', weight: 0.9 },
  { pattern: /\b(parcial|partial|solo|only|just|just one|nada m[aá]s|nothing else)\b/i, label: 'scope-narrow', weight: 0.4 },
  { pattern: /\b(escalable|scalable|distribu(?:ido|ted)|multi-region|multi-tenant|multi-usuario)\b/i, label: 'scalability', weight: 0.7 },
  { pattern: /\b(auto(?:m[aá]tico|matic)|automat(?:ed|ic)|background|en segundo plano|sin intervenci[oó]n)\b/i, label: 'automation', weight: 0.7 },
];

const CONSTRAINT_LEXICON = [
  { pattern: /\b(debe|must|tiene que|has to|requir(?:e|ed)|obligatorio|mandatory|necesariamente|necessarily)\b/i, label: 'must-have' },
  { pattern: /\b(no debe|must not|no puede|cannot|prohibido|forbidden|jam[aá]s|never)\b/i, label: 'must-not' },
  { pattern: /\b(sin|without|excluding|excepto|except|skip|omitir|salvo)\b/i, label: 'exclusion' },
  { pattern: /\b(solo|only|exclusivamente|exclusively|nada m[aá]s|just|merely)\b/i, label: 'exclusivity' },
  { pattern: /\b(siempre|always|in every case|para todo|for all)\b/i, label: 'universality' },
  { pattern: /\b(antes|before|previo|prior to|primero|first|then|despu[eé]s|after that)\b/i, label: 'ordering' },
];

const TEMPORAL_LEXICON = [
  { pattern: /\b(ahora|now|ya|inmediatamente|immediately|right now)\b/i, label: 'now' },
  { pattern: /\b(hoy|today|esta noche|tonight|esta semana|this week)\b/i, label: 'short-term' },
  { pattern: /\b(ma[ñn]ana|tomorrow|pr[oó]xim[oa]s? d[ií]as?|next few days|next week|pr[oó]xima semana)\b/i, label: 'near-future' },
  { pattern: /\b(despu[eé]s|after|luego|then|m[aá]s tarde|later|pr[oó]ximamente|soon)\b/i, label: 'deferred' },
  { pattern: /\b(siempre|always|permanente|permanent|constantly|continuously|continuamente)\b/i, label: 'continuous' },
];

const CONDITION_LEXICON = [
  { pattern: /\bsi\s+(?!sirve|funciona\b)\w/i, label: 'spanish-if' },
  { pattern: /\bunless|a menos que|salvo que\b/i, label: 'unless' },
  { pattern: /\bif\b/i, label: 'english-if' },
  { pattern: /\bcuando\b|\bwhen\b/i, label: 'when' },
  { pattern: /\bdepend(?:ing|e) on|depende de\b/i, label: 'depends-on' },
];

const PERSONA_LEXICON = [
  { pattern: /\bcomo (?:un |una |el |la )?([a-záéíóúüñ]+)\b/i, label: 'as-role-es' },
  { pattern: /\bas an?\s+([a-z]+)\b/i, label: 'as-role-en' },
  { pattern: /\bpara (?:los |las )?([a-záéíóúüñ]+s?)\b/i, label: 'for-audience-es' },
  { pattern: /\bfor (?:my |our |the )?([a-z]+s?)\b/i, label: 'for-audience-en' },
];

const TONE_LEXICON = [
  { pattern: /\b(formal|profesional|professional|corporate|corporativo|empresarial)\b/i, label: 'formal' },
  { pattern: /\b(casual|informal|relajado|relaxed|amigable|friendly)\b/i, label: 'casual' },
  { pattern: /\b(t[eé]cnico|technical|detallado|detailed|exhaustivo|precise|preciso)\b/i, label: 'technical' },
  { pattern: /\b(simple|sencillo|f[aá]cil|easy|entendible|comprehensible|para no t[eé]cnicos|non-technical)\b/i, label: 'plain' },
  { pattern: /\b(divertido|fun|creativo|creative|original|innovador|innovative)\b/i, label: 'creative' },
];

const NEGATION_LEXICON = [
  { pattern: /\b(no\b|nunca|jam[aá]s|tampoco|ninguno|ning[uú]n|nada)\b/i, label: 'negative-es' },
  { pattern: /\b(not\b|never|none|no\s+one|nothing|don'?t|doesn'?t|won'?t|cannot|can'?t)\b/i, label: 'negative-en' },
];

const REFERENCE_LEXICON = [
  { pattern: /\b(esto|este|esta|estos|estas|eso|ese|esa|esos|esas|aquello|aquel)\b/i, label: 'deictic-es' },
  { pattern: /\b(this|that|these|those|it|them)\b/i, label: 'deictic-en' },
  { pattern: /\b(lo (?:anterior|de antes)|previamente|como dije|te dije|antes me dijiste)\b/i, label: 'backref-es' },
  { pattern: /\b(previous(?:ly)?|earlier|before|as I said|you said|you mentioned)\b/i, label: 'backref-en' },
  { pattern: /\b(este (?:link|enlace|url|archivo|file|documento)|aqu[ií] (?:tienes|est[aá])|adjunto|attached)\b/i, label: 'external-ref-es' },
  { pattern: /\b(this (?:link|url|file|document|attachment)|here(?:'s|\s+is)|attached)\b/i, label: 'external-ref-en' },
  { pattern: /https?:\/\/\S+/i, label: 'url-reference' },
];

const EMOTION_LEXICON = [
  { pattern: /\b(no funciona|no sirve|sigue fallando|otra vez|de nuevo|por favor|porfa|en serio|seriously|please)\b/i, label: 'frustration' },
  { pattern: /\b(genial|excelente|perfecto|awesome|great|amazing|fant[aá]stico|brillante)\b/i, label: 'positive' },
  { pattern: /[!]{2,}|[?]{2,}|¡{2,}/, label: 'emphasis' },
  { pattern: /\b(urgent(?:e|ly)?|asap|ya|now|cuanto antes|inmediatamente)\b/i, label: 'urgency-emotion' },
];

const LANGUAGE_LEXICON = [
  { pattern: /\b(en (?:ingl[eé]s|english)|in english|respond in english)\b/i, label: 'language-en' },
  { pattern: /\b(en (?:espa[ñn]ol|spanish)|in spanish|responde en espa[ñn]ol)\b/i, label: 'language-es' },
  { pattern: /\b(en franc[eé]s|in french|en franc[ai]s)\b/i, label: 'language-fr' },
  { pattern: /\b(en alem[aá]n|in german|auf deutsch)\b/i, label: 'language-de' },
  { pattern: /\b(en portugu[eé]s|in portuguese)\b/i, label: 'language-pt' },
];

const TOKEN_BOUND = /\s+/;

function safeText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(safeText).filter(Boolean).join(' ');
  if (typeof value === 'object' && typeof value.text === 'string') return value.text;
  try { return String(value); } catch { return ''; }
}

function makeFeatureId(category, label, index) {
  return `${category}:${label}:${index}`;
}

function locateSpan(text, regex) {
  if (!text) return null;
  const match = text.match(regex);
  if (!match) return null;
  const start = match.index ?? 0;
  return { start, end: start + match[0].length, snippet: match[0] };
}

function detectLanguage(text) {
  if (!text) return 'unknown';
  const spanishHits = (text.match(/[ñáéíóúü¿¡]|(\b(?:el|la|los|las|que|qué|para|con|del|por|una|uno|cuando|c[oó]mo)\b)/gi) || []).length;
  const englishHits = (text.match(/\b(the|and|that|with|from|this|what|how|when|where|because|need|want|please)\b/gi) || []).length;
  if (spanishHits > englishHits) return 'es';
  if (englishHits > spanishHits) return 'en';
  return spanishHits ? 'es' : englishHits ? 'en' : 'unknown';
}

function applyLexicon(text, lexicon, category, fixedConfidence = 0.8) {
  const out = [];
  let idx = 0;
  for (const entry of lexicon) {
    const span = locateSpan(text, entry.pattern);
    if (!span) continue;
    out.push({
      id: makeFeatureId(category, entry.label, idx++),
      category,
      label: entry.label,
      sourceSpan: span,
      weight: typeof entry.weight === 'number' ? entry.weight : 0.7,
      confidence: fixedConfidence,
      evidence: span.snippet.toLowerCase(),
    });
  }
  return out;
}

function detectAttachments(opts) {
  const attachments = Array.isArray(opts?.attachments) ? opts.attachments : [];
  if (!attachments.length) return [];
  return attachments.slice(0, 8).map((att, idx) => ({
    id: makeFeatureId(FEATURE_CATEGORIES.REFERENCE, 'attached-file', idx),
    category: FEATURE_CATEGORIES.REFERENCE,
    label: 'attached-file',
    sourceSpan: null,
    weight: 0.9,
    confidence: 0.95,
    evidence: typeof att === 'string' ? att : (att?.fileName || att?.name || att?.id || 'file'),
  }));
}

function inferImplicitFeatures(actions, objects, modifiers, text) {
  const out = [];
  let idx = 0;

  const actionLabels = new Set(actions.map((a) => a.label));
  const objectLabels = new Set(objects.map((o) => o.label));
  const modifierLabels = new Set(modifiers.map((m) => m.label));

  // create + code-artifact ⇒ implicit "test-suite" expectation
  if (actionLabels.has('create') && objectLabels.has('code-artifact') && !objectLabels.has('test-suite')) {
    out.push({
      id: makeFeatureId(FEATURE_CATEGORIES.IMPLICIT, 'expect-tests', idx++),
      category: FEATURE_CATEGORIES.IMPLICIT,
      label: 'expect-tests',
      sourceSpan: null,
      weight: 0.45,
      confidence: 0.55,
      evidence: 'code-creation usually warrants test coverage',
    });
  }
  // execute / deploy + no verify ⇒ implicit "expect-validation"
  if ((actionLabels.has('execute')) && !actionLabels.has('verify')) {
    out.push({
      id: makeFeatureId(FEATURE_CATEGORIES.IMPLICIT, 'expect-pre-flight-checks', idx++),
      category: FEATURE_CATEGORIES.IMPLICIT,
      label: 'expect-pre-flight-checks',
      sourceSpan: null,
      weight: 0.55,
      confidence: 0.6,
      evidence: 'deploy / run without explicit verification implies expectation of safety checks',
    });
  }
  // modify + defect ⇒ implicit "expect-regression-tests"
  if (actionLabels.has('modify') && objectLabels.has('defect')) {
    out.push({
      id: makeFeatureId(FEATURE_CATEGORIES.IMPLICIT, 'expect-regression-test', idx++),
      category: FEATURE_CATEGORIES.IMPLICIT,
      label: 'expect-regression-test',
      sourceSpan: null,
      weight: 0.6,
      confidence: 0.65,
      evidence: 'bugfix typically benefits from a guarding test',
    });
  }
  // analyze + visualization absent ⇒ implicit "expect-summary"
  if (actionLabels.has('analyze') && !actionLabels.has('summarize') && !objectLabels.has('visualization')) {
    out.push({
      id: makeFeatureId(FEATURE_CATEGORIES.IMPLICIT, 'expect-summary', idx++),
      category: FEATURE_CATEGORIES.IMPLICIT,
      label: 'expect-summary',
      sourceSpan: null,
      weight: 0.4,
      confidence: 0.5,
      evidence: 'analysis requests usually expect a synthesized summary',
    });
  }
  // url-reference ⇒ implicit "fetch-and-summarize"
  if (/https?:\/\//i.test(text || '')) {
    out.push({
      id: makeFeatureId(FEATURE_CATEGORIES.IMPLICIT, 'fetch-and-summarize-url', idx++),
      category: FEATURE_CATEGORIES.IMPLICIT,
      label: 'fetch-and-summarize-url',
      sourceSpan: null,
      weight: 0.7,
      confidence: 0.75,
      evidence: 'URL in prompt usually means the user wants its content analyzed',
    });
  }
  // high-urgency without execute ⇒ implicit "fast-iteration"
  if (modifierLabels.has('high-urgency') && !actionLabels.has('execute')) {
    out.push({
      id: makeFeatureId(FEATURE_CATEGORIES.IMPLICIT, 'fast-iteration', idx++),
      category: FEATURE_CATEGORIES.IMPLICIT,
      label: 'fast-iteration',
      sourceSpan: null,
      weight: 0.5,
      confidence: 0.55,
      evidence: 'urgent + non-deploy ⇒ minimize back-and-forth',
    });
  }
  // continue + no object ⇒ implicit "resume-prior-task"
  if (actionLabels.has('continue') && !objects.length) {
    out.push({
      id: makeFeatureId(FEATURE_CATEGORIES.IMPLICIT, 'resume-prior-task', idx++),
      category: FEATURE_CATEGORIES.IMPLICIT,
      label: 'resume-prior-task',
      sourceSpan: null,
      weight: 0.8,
      confidence: 0.8,
      evidence: 'continue verb with no new object refers to prior turn task',
    });
  }
  return out;
}

function extractFeatures(prompt, opts = {}) {
  const text = safeText(prompt);
  if (!text || text.length < 1) {
    return { features: [], language: 'unknown', text };
  }

  // Language-aware lexicon enrichment (PT/FR/DE/IT)
  let actionLexicon = ACTION_LEXICON;
  let objectLexicon = OBJECT_LEXICON;
  try {
    const ml = require('./multilingual-lexicon');
    const extLang = ml.detectExtendedLanguage(text);
    if (extLang) {
      const extActions = ml.EXTRA_ACTION_LEXICON.filter((e) => e.lang === extLang);
      const extObjects = ml.EXTRA_OBJECT_LEXICON.filter((e) => e.lang === extLang);
      if (extActions.length) actionLexicon = [...ACTION_LEXICON, ...extActions];
      if (extObjects.length) objectLexicon = [...OBJECT_LEXICON, ...extObjects];
    }
  } catch (_e) { /* multilingual lexicon optional */ }

  const features = [
    ...applyLexicon(text, actionLexicon, FEATURE_CATEGORIES.ACTION, 0.88),
    ...applyLexicon(text, objectLexicon, FEATURE_CATEGORIES.OBJECT, 0.82),
    ...applyLexicon(text, MODIFIER_LEXICON, FEATURE_CATEGORIES.MODIFIER, 0.78),
    ...applyLexicon(text, CONSTRAINT_LEXICON, FEATURE_CATEGORIES.CONSTRAINT, 0.8),
    ...applyLexicon(text, TEMPORAL_LEXICON, FEATURE_CATEGORIES.TEMPORAL, 0.75),
    ...applyLexicon(text, CONDITION_LEXICON, FEATURE_CATEGORIES.CONDITION, 0.7),
    ...applyLexicon(text, PERSONA_LEXICON, FEATURE_CATEGORIES.PERSONA, 0.6),
    ...applyLexicon(text, TONE_LEXICON, FEATURE_CATEGORIES.TONE, 0.65),
    ...applyLexicon(text, NEGATION_LEXICON, FEATURE_CATEGORIES.NEGATION, 0.9),
    ...applyLexicon(text, REFERENCE_LEXICON, FEATURE_CATEGORIES.REFERENCE, 0.78),
    ...applyLexicon(text, EMOTION_LEXICON, FEATURE_CATEGORIES.EMOTION, 0.7),
    ...applyLexicon(text, LANGUAGE_LEXICON, FEATURE_CATEGORIES.LANGUAGE, 0.9),
  ];

  features.push(...detectAttachments(opts));

  const actions = features.filter((f) => f.category === FEATURE_CATEGORIES.ACTION);
  const objects = features.filter((f) => f.category === FEATURE_CATEGORIES.OBJECT);
  const modifiers = features.filter((f) => f.category === FEATURE_CATEGORIES.MODIFIER);

  features.push(...inferImplicitFeatures(actions, objects, modifiers, text));

  let language = detectLanguage(text);
  if (language === 'unknown') {
    try {
      const ml = require('./multilingual-lexicon');
      const ext = ml.detectExtendedLanguage(text);
      if (ext) language = ext;
    } catch (_e) { /* optional */ }
  }
  const tokenCount = text.split(TOKEN_BOUND).filter(Boolean).length;

  return {
    features,
    language,
    text,
    metrics: {
      tokenCount,
      charCount: text.length,
      actionCount: actions.length,
      objectCount: objects.length,
      implicitCount: features.filter((f) => f.category === FEATURE_CATEGORIES.IMPLICIT).length,
      negationCount: features.filter((f) => f.category === FEATURE_CATEGORIES.NEGATION).length,
    },
  };
}

module.exports = {
  FEATURE_CATEGORIES,
  extractFeatures,
  detectLanguage,
  // exported for tests + diagnostics
  ACTION_LEXICON,
  OBJECT_LEXICON,
  MODIFIER_LEXICON,
};
