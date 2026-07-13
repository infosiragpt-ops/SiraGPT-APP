/**
 * agenticBatch — round-robin academic search orchestrator that
 * collects up to N sources by pulling B at a time from each provider,
 * yielding events as it goes so the UI can render an "agentic" search
 * progress indicator instead of a single JSON dump at the end.
 *
 * Why an async generator (and not just a callback): the SSE route
 * wants to `for await` the events and forward each as a `data:` frame.
 * That maps 1:1 onto a generator and avoids the inversion of control
 * a callback pattern would force on the route.
 *
 * Pipeline:
 *   start                           → emit { start } with config
 *   for round in 1..maxRounds:
 *     for provider in providers:
 *       fetch batchSize results at offset
 *       dedupe against the running pool
 *       emit { batch, batchN, provider, count, totalCollected, sources }
 *       advance offset; if zero results, mark provider exhausted
 *     stop early if total ≥ target OR every provider exhausted
 *   collection_done                 → snapshot of the run
 *   ranking_start                   → "selecting top K"
 *   for batch in pool grouped 10s:  → reranker yields rerankScore
 *   selected                        → top-K final list
 *   summary                         → markdown report ready for chat
 *   done                            → final stats
 *
 * Failure handling: each provider call is wrapped — a 500 from one
 * provider only surfaces as { batch_error, provider, error } and
 * the loop carries on. Two consecutive failures from the same
 * provider mark it exhausted to bound the run.
 */

const { retrieveFromProvider, REGISTRY } = require("./providers");
const { rerankResults } = require("./llmReranker");
const { callLLM } = require("./llmClient");
const { analyzeQuery } = require("../research/research-query-intelligence");
const { scoreResult } = require("../agents/web-search/relevance");
const {
  annotateSource,
  passesIntegrityFilters,
  strongerStatus,
} = require("../research/source-integrity");
const { resolvePaperDois } = require("../research/doi-resolver");
const { orderProvidersForDiscipline } = require("../research/research-discipline-router");
const {
  buildPrismaFlow,
  buildProtocol,
  gradeEvidence,
  preliminaryRiskOfBias,
  screenPaper,
} = require("../research/systematic-review-protocol");

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_TARGET = 500;
const DEFAULT_TOP_K = 25;
// Broad, worldwide academic pool. Public indexes go first; commercial and
// key-gated indexes remain available and soft-skip when not configured.
const DEFAULT_PROVIDERS = [
  "openalex", "crossref", "semantic", "pubmed", "europepmc", "scielo",
  "redalyc", "doaj", "arxiv", "dblp", "datacite", "biorxiv", "medrxiv",
  "core", "wos", "scopus",
];
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_PROVIDER_ERRORS = 2;
const HARD_ROUND_CAP = 60; // safety: never spin more rounds than this
const SOURCE_AUTHORITY = Object.freeze({
  wos: 1, scopus: 1, pubmed: 0.96, europepmc: 0.96, scielo: 0.92,
  doaj: 0.9, dblp: 0.9, semantic: 0.88, openalex: 0.86, redalyc: 0.85,
  core: 0.82, crossref: 0.78, arxiv: 0.72, biorxiv: 0.7, medrxiv: 0.7,
  datacite: 0.62,
});

function normaliseText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    url.search = "";
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return "";
  }
}

function identityKeys(item) {
  const keys = [];
  const doi = normaliseDoi(item?.doi);
  if (doi) keys.push(`doi:${doi.toLowerCase()}`);
  const title = normaliseText(item?.title);
  if (title && (title.length >= 24 || title.split(" ").length >= 4)) keys.push(`t:${title}`);
  const url = normaliseUrl(item?.url || item?.pdfUrl);
  if (url) keys.push(`url:${url}`);
  return keys;
}

function dedupKey(item) {
  return identityKeys(item)[0] || `u:${normaliseText(item?.title)}:${item?.source || "unknown"}`;
}

function preferLonger(a, b) {
  const left = typeof a === "string" ? a.trim() : "";
  const right = typeof b === "string" ? b.trim() : "";
  return right.length > left.length ? right : (left || right || undefined);
}

function mergeCandidate(base, extra) {
  const sources = Array.from(new Set([
    ...(Array.isArray(base.sources) ? base.sources : [base.source]),
    ...(Array.isArray(extra.sources) ? extra.sources : [extra.source]),
  ].filter(Boolean)));
  const baseCitations = Number.isFinite(base.citationCount) ? base.citationCount : undefined;
  const extraCitations = Number.isFinite(extra.citationCount) ? extra.citationCount : undefined;
  const citations = baseCitations === undefined
    ? extraCitations
    : (extraCitations === undefined ? baseCitations : Math.max(baseCitations, extraCitations));
  const openAccess = base.openAccess === true || extra.openAccess === true
    ? true
    : (base.openAccess === false || extra.openAccess === false ? false : undefined);
  const publicationStagePriority = { unknown: 0, preprint: 1, dataset: 2, thesis: 2, conference_paper: 3, published_article: 4 };
  const publicationStage = (publicationStagePriority[extra.publicationStage] || 0) > (publicationStagePriority[base.publicationStage] || 0)
    ? extra.publicationStage
    : (base.publicationStage || extra.publicationStage || "unknown");
  const peerReviewPriority = { unknown: 0, not_peer_reviewed: 1, likely_peer_reviewed: 2, confirmed: 3 };
  const peerReviewStatus = (peerReviewPriority[extra.peerReviewStatus] || 0) > (peerReviewPriority[base.peerReviewStatus] || 0)
    ? extra.peerReviewStatus
    : base.peerReviewStatus;
  return {
    ...base,
    title: preferLonger(base.title, extra.title) || "Untitled",
    authors: (extra.authors?.length || 0) > (base.authors?.length || 0) ? extra.authors : base.authors,
    year: base.year || extra.year,
    journal: preferLonger(base.journal, extra.journal),
    volume: base.volume || extra.volume,
    issue: base.issue || extra.issue,
    pages: base.pages || extra.pages,
    doi: base.doi || extra.doi,
    url: base.url || extra.url,
    pdfUrl: base.pdfUrl || extra.pdfUrl,
    abstract: preferLonger(base.abstract, extra.abstract),
    citationCount: citations,
    openAccess,
    providerRank: Math.min(base.providerRank ?? Number.MAX_SAFE_INTEGER, extra.providerRank ?? Number.MAX_SAFE_INTEGER),
    sources,
    sourceCount: sources.length,
    retrievalScore: Math.max(base.retrievalScore || 0, extra.retrievalScore || 0),
    doiStatus: [base.doiStatus, extra.doiStatus].includes("format_valid")
      ? "format_valid"
      : ([base.doiStatus, extra.doiStatus].includes("format_invalid") ? "format_invalid" : "missing"),
    publicationStage,
    peerReviewStatus: peerReviewStatus || "unknown",
    studyType: base.studyType && base.studyType !== "unknown" ? base.studyType : (extra.studyType || "unknown"),
    integrityStatus: strongerStatus(base.integrityStatus || "unknown", extra.integrityStatus || "unknown"),
    integrityAlerts: Array.from(new Set([
      ...(Array.isArray(base.integrityAlerts) ? base.integrityAlerts : []),
      ...(Array.isArray(extra.integrityAlerts) ? extra.integrityAlerts : []),
    ])),
  };
}

function passesFilters(item, filters) {
  const year = Number(item?.year);
  if (Number.isFinite(filters?.yearFrom) && (!Number.isFinite(year) || year < filters.yearFrom)) return false;
  if (Number.isFinite(filters?.yearTo) && (!Number.isFinite(year) || year > filters.yearTo)) return false;
  if (filters?.openAccessOnly && item?.openAccess !== true) return false;
  if (!passesIntegrityFilters(item, filters)) return false;
  return true;
}

function conceptCoverage(item, conceptGroups) {
  if (!Array.isArray(conceptGroups) || conceptGroups.length === 0) return null;
  const documentText = normaliseText(`${item?.title || ''} ${item?.abstract || ''}`);
  if (!documentText) return 0;
  let hits = 0;
  for (const group of conceptGroups) {
    const matched = Array.isArray(group) && group.some((form) => {
      const phrase = normaliseText(form);
      return phrase && documentText.includes(phrase);
    });
    if (matched) hits += 1;
  }
  return hits / conceptGroups.length;
}

function candidateRelevance(item, queries, conceptGroups) {
  const result = {
    title: item?.title,
    snippet: item?.abstract,
    url: item?.url || item?.pdfUrl,
  };
  const cleanQueries = Array.from(new Set((queries || []).map((query) => String(query || "").trim()).filter(Boolean)));
  if (cleanQueries.length === 0) return 0;
  const lexicalPrimary = scoreResult(cleanQueries[0], result);
  const concepts = conceptCoverage(item, conceptGroups);
  const primary = concepts === null
    ? lexicalPrimary
    : (lexicalPrimary * 0.7 + concepts * 0.3);
  let expansionBest = 0;
  for (const query of cleanQueries.slice(1)) {
    expansionBest = Math.max(expansionBest, scoreResult(query, result));
  }
  // Expanded/bilingual variants improve recall, but must never replace the
  // user's core topic. This prevents a broad variant such as "education
  // learning" from outranking a result that actually contains the requested
  // concept "aprendizaje autorregulado".
  return cleanQueries.length === 1 ? primary : (primary * 0.85 + expansionBest * 0.15);
}

function metadataCompleteness(item) {
  const signals = [
    item?.title && item.title !== "Untitled",
    Array.isArray(item?.authors) && item.authors.length > 0,
    Number.isFinite(Number(item?.year)),
    Boolean(item?.journal),
    Boolean(item?.doi || item?.url),
    Boolean(item?.abstract),
    Boolean(item?.pdfUrl || item?.openAccess),
  ];
  return signals.filter(Boolean).length / signals.length;
}

function sourceAuthority(item) {
  const sources = Array.isArray(item?.sources) && item.sources.length
    ? item.sources
    : [item?.source];
  return sources.reduce((best, source) => Math.max(best, SOURCE_AUTHORITY[source] || 0.6), 0.6);
}

function qualityScore(item, queries, conceptGroups, filters = {}) {
  if (["retracted", "withdrawn"].includes(item?.integrityStatus)) return 0;
  const relevance = candidateRelevance(item, queries, conceptGroups);
  const corroboration = Math.min(1, Math.max(0, (Number(item?.sourceCount) || 1) - 1) / 3);
  const metadata = metadataCompleteness(item);
  const authority = sourceAuthority(item);
  const citations = Math.min(1, Math.log1p(Math.max(0, Number(item?.citationCount) || 0)) / Math.log1p(1000));
  const year = Number(item?.year);
  const age = Number.isFinite(year) ? Math.max(0, new Date().getUTCFullYear() - year) : 20;
  const recency = Math.max(0, 1 - age / 15);
  const openAccess = item?.openAccess === true ? 1 : 0;
  const doi = item?.doiStatus === "format_valid" ? 1 : 0;
  const integrity = item?.integrityStatus === "clear"
    ? 1
    : (item?.integrityStatus === "corrected" ? 0.8 : (item?.integrityStatus === "expression_of_concern" ? 0.2 : 0.6));
  const studyMatch = filters?.studyType ? (item?.studyType === filters.studyType ? 1 : 0) : 0.5;
  return Math.min(1, (
    relevance * 0.60 +
    corroboration * 0.11 +
    authority * 0.08 +
    metadata * 0.06 +
    citations * 0.04 +
    recency * 0.03 +
    openAccess * 0.02 +
    doi * 0.03 +
    integrity * 0.02 +
    studyMatch * 0.01
  ));
}

function rankDeterministically(items, queries, conceptGroups, filters = {}) {
  return items
    .map((item) => {
      const retrievalScore = candidateRelevance(item, queries, conceptGroups);
      const annotated = { ...item, retrievalScore };
      return { ...annotated, qualityScore: qualityScore(annotated, queries, conceptGroups, filters) };
    })
    .sort((a, b) => (
      (b.qualityScore - a.qualityScore) ||
      (b.retrievalScore - a.retrievalScore) ||
      ((b.sourceCount || 1) - (a.sourceCount || 1)) ||
      ((b.citationCount || 0) - (a.citationCount || 0))
    ));
}

function compactSource(item) {
  // The SSE payload goes over the wire on every batch — keep it lean
  // by stripping the raw provider blob (often tens of KB).
  return {
    source: item.source,
    title: item.title,
    authors: Array.isArray(item.authors) ? item.authors.slice(0, 5) : [],
    year: item.year,
    journal: item.journal,
    volume: item.volume,
    issue: item.issue,
    pages: item.pages,
    doi: item.doi,
    url: item.url,
    pdfUrl: item.pdfUrl,
    abstract: typeof item.abstract === "string"
      ? item.abstract.slice(0, 320) + (item.abstract.length > 320 ? "…" : "")
      : undefined,
    citationCount: item.citationCount,
    openAccess: item.openAccess,
    rerankScore: item.rerankScore,
    retrievalScore: item.retrievalScore,
    qualityScore: item.qualityScore,
    sources: Array.isArray(item.sources) ? item.sources : (item.source ? [item.source] : []),
    sourceCount: item.sourceCount || (Array.isArray(item.sources) ? item.sources.length : 1),
    doiStatus: item.doiStatus,
    publicationStage: item.publicationStage,
    peerReviewStatus: item.peerReviewStatus,
    studyType: item.studyType,
    integrityStatus: item.integrityStatus,
    integrityAlerts: Array.isArray(item.integrityAlerts) ? item.integrityAlerts : [],
    doiResolutionStatus: item.doiResolutionStatus,
    doiResolvedUrl: item.doiResolvedUrl,
    doiResolutionHttpStatus: item.doiResolutionHttpStatus,
    doiCheckedAt: item.doiCheckedAt,
    doiResolutionCacheHit: item.doiResolutionCacheHit,
    editorialStatus: item.editorialStatus,
    screening: item.screening,
    riskOfBias: item.riskOfBias,
  };
}

function normaliseDoi(doi) {
  return String(doi || "").trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

function doiUrl(doi) {
  const clean = normaliseDoi(doi);
  return clean ? `https://doi.org/${clean}` : "";
}

function ensureSentence(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function formatAuthors(authors) {
  const list = Array.isArray(authors) ? authors.map(a => String(a || "").trim()).filter(Boolean) : [];
  if (list.length === 0) return "Autor desconocido";
  if (list.length > 6) return `${list.slice(0, 6).join(", ")}, et al.`;
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")}, & ${list[list.length - 1]}`;
}

function formatVenue(source) {
  const journal = String(source.journal || "").trim();
  if (!journal) return "";
  let out = `*${journal}*`;
  if (source.volume) {
    out += `, ${source.volume}`;
    if (source.issue) out += `(${source.issue})`;
  } else if (source.issue) {
    out += `, (${source.issue})`;
  }
  if (source.pages) out += `, ${source.pages}`;
  return ensureSentence(out);
}

function formatArticleCitation(source, index) {
  const authors = formatAuthors(source.authors);
  const year = source.year ? `(${source.year}).` : "(s. f.).";
  const title = ensureSentence(source.title || "Sin título");
  const venue = formatVenue(source);
  const link = source.doiResolvedUrl || (source.doi ? doiUrl(source.doi) : (source.url || source.pdfUrl || ""));
  const metadata = [authors, year, title, venue].filter(Boolean).join(" ");
  const provenance = source.sourceCount >= 2
    ? `\n_Validado en ${source.sourceCount} índices: ${(source.sources || []).join(", ")}._`
    : "";
  const signals = [];
  if (source.doiResolutionStatus === "resolved") signals.push("DOI resuelto en línea");
  else if (source.doiResolutionStatus === "not_found") signals.push("Alerta: DOI no localizado");
  else if (source.doiStatus === "format_valid") signals.push("DOI con formato válido; resolución no confirmada");
  if (source.publicationStage === "preprint") signals.push("Preprint: revisión por pares no confirmada");
  else if (source.peerReviewStatus === "confirmed") signals.push("Revisión por pares confirmada por metadatos");
  else if (source.peerReviewStatus === "likely_peer_reviewed") signals.push("Publicado en revista; revisión por pares no confirmada");
  if (source.studyType && source.studyType !== "unknown") signals.push(`Tipo: ${source.studyType.replace(/_/g, " ")}`);
  if (source.integrityStatus === "corrected") signals.push("Corrección registrada");
  if (source.integrityStatus === "expression_of_concern") signals.push("Alerta: expresión de preocupación");
  if (source.integrityStatus === "retracted") signals.push("Alerta: retractado");
  if (source.screening?.decision === "uncertain") signals.push("Cribado: requiere revisión humana");
  if (source.riskOfBias?.level) signals.push(`Sesgo preliminar: ${source.riskOfBias.level}`);
  const integrity = signals.length ? `\n_${signals.join(" · ")}._` : "";
  return `${index + 1}. ${metadata}${link ? `\n${link}` : ""}${provenance}${integrity}`;
}

function buildSystematicSummary(systematicReview) {
  if (!systematicReview?.protocol?.active) return "";
  const { protocol, prisma, certainty } = systematicReview;
  const lines = ["## Protocolo de revisión sistemática", ""];
  if (protocol.framework) lines.push(`- **Framework:** ${protocol.framework.toUpperCase()}`);
  if (protocol.searchExpression) lines.push(`- **Estrategia:** \`${protocol.searchExpression}\``);
  if (protocol.missingFields?.length) lines.push(`- **Campos pendientes:** ${protocol.missingFields.join(", ")}`);
  const manual = (protocol.inclusionCriteria?.manual?.length || 0) + (protocol.exclusionCriteria?.manual?.length || 0);
  if (manual) lines.push(`- **Criterios manuales registrados:** ${manual}; requieren confirmación humana.`);
  lines.push("");
  lines.push("### Flujo PRISMA preliminar");
  lines.push(`- Identificados: ${prisma.identification.recordsIdentified}`);
  lines.push(`- Duplicados eliminados: ${prisma.deduplication.duplicatesRemoved}`);
  lines.push(`- Cribados: ${prisma.screening.recordsScreened}`);
  lines.push(`- Excluidos: ${prisma.screening.recordsExcluded}`);
  lines.push(`- En duda: ${prisma.screening.recordsUncertain}`);
  lines.push(`- Incluidos en la síntesis preliminar: ${prisma.included.studiesInPreliminarySynthesis}`);
  if (Object.keys(prisma.screening.exclusionReasons).length) {
    lines.push(`- Motivos: ${Object.entries(prisma.screening.exclusionReasons).map(([reason, count]) => `${reason} (${count})`).join(", ")}`);
  }
  lines.push("");
  lines.push(`### Certeza preliminar: ${certainty.level}`);
  lines.push(`${certainty.reasons.join(", ")}. La evaluación definitiva requiere lectura del texto completo y listas específicas por diseño.`);
  lines.push("");
  return lines.join("\n");
}

function buildSummaryMarkdown({ query, totalCollected, dedupedCount, top, providerStats, systematicReview }) {
  const lines = [];
  const providersUsed = Object.entries(providerStats || {})
    .filter(([, stats]) => stats && stats.contributed > 0)
    .map(([provider]) => provider);
  lines.push("## Artículos encontrados");
  lines.push("");
  top.forEach((s, i) => {
    lines.push(formatArticleCitation(s, i));
    lines.push("");
  });
  lines.push("---");
  const systematic = buildSystematicSummary(systematicReview);
  if (systematic) {
    lines.push(systematic);
    lines.push("---");
  }
  const corroborated = top.filter((source) => source.sourceCount >= 2).length;
  const validDoi = top.filter((source) => source.doiStatus === "format_valid").length;
  const resolvedDoi = top.filter((source) => source.doiResolutionStatus === "resolved").length;
  const preprints = top.filter((source) => source.publicationStage === "preprint").length;
  lines.push(`*Consulta: "${query}". Se localizaron ${dedupedCount || totalCollected} registros únicos y se seleccionaron ${top.length}.` +
    (corroborated ? ` ${corroborated} fueron corroborados en más de un índice.` : "") +
    (resolvedDoi ? ` ${resolvedDoi} DOI fueron resueltos en línea.` : "") +
    (validDoi > resolvedDoi ? ` ${validDoi - resolvedDoi} DOI adicionales solo tienen formato válido.` : "") +
    (preprints ? ` ${preprints} son preprints y se muestran sin afirmar revisión por pares.` : "") +
    (providersUsed.length ? ` Proveedores con resultados: ${providersUsed.join(", ")}.` : "") + "*");
  return lines.join("\n");
}

/**
 * @typedef {object} AgenticBatchOptions
 * @property {string} query
 * @property {number} [target=500]
 * @property {number} [batchSize=10]
 * @property {number} [topK=25]
 * @property {string[]} [providers]
 * @property {number} [timeoutMs]
 * @property {string} [mailto]
 * @property {string} [language]
 * @property {string} [discipline]
 * @property {AbortSignal} [signal]
 * @property {boolean} [resolveDois]
 * @property {object} [deps]                — { retrieve, rerank, callLLM, sleep } (test seams)
 */

/**
 * Sleep helper that honours an AbortSignal so a client disconnect
 * cancels mid-pause instead of waiting out the throttle.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Runs the agentic batched search and yields events as they happen.
 *
 * @param {AgenticBatchOptions} opts
 */
async function* runAgenticBatch(opts) {
  const target = Math.min(Math.max(Number(opts.target) || DEFAULT_TARGET, 10), 1000);
  const batchSize = Math.min(Math.max(Number(opts.batchSize) || DEFAULT_BATCH_SIZE, 5), 50);
  const topK = Math.min(Math.max(Number(opts.topK) || DEFAULT_TOP_K, 1), 100);
  const hasExplicitProviders = Array.isArray(opts.providers) && opts.providers.length > 0;
  const requestedProviders = hasExplicitProviders
    ? opts.providers.filter((p) => p in REGISTRY)
    : DEFAULT_PROVIDERS.filter((p) => p in REGISTRY);
  let providers = requestedProviders.length > 0 ? requestedProviders : DEFAULT_PROVIDERS;
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const mailto = opts.mailto;
  const signal = opts.signal;
  const deps = opts.deps || {};
  const retrieve = deps.retrieve || retrieveFromProvider;
  const rerank = deps.rerank || rerankResults;
  const llm = deps.callLLM || callLLM;
  const _sleep = deps.sleep || sleep;
  const query = String(opts.query || "").trim();

  if (!query) {
    yield { type: "error", message: "query is required" };
    return;
  }

  const plan = analyzeQuery(query, { maxQueries: 3, discipline: opts.discipline });
  if (!hasExplicitProviders) {
    providers = orderProvidersForDiscipline(providers, plan.discipline);
  }
  const protocol = buildProtocol(query, plan, opts.protocol || {});
  const searchQueries = [];
  const queryKeys = new Set();
  for (const candidate of [protocol.searchExpression, ...(plan.searchQueries || [])].slice(0, 3)) {
    const value = String(candidate || "").replace(/\s+/g, " ").trim();
    const key = normaliseText(value);
    if (value && key && !queryKeys.has(key)) {
      queryKeys.add(key);
      searchQueries.push(value);
    }
  }
  if (searchQueries.length === 0) searchQueries.push(query);
  const filters = plan.filters || {};
  const conceptGroups = Array.isArray(plan.conceptGroups) ? plan.conceptGroups : [];
  const language = opts.language || filters.language || plan.language;
  const minimumSearchRounds = Math.min(2, searchQueries.length);
  const hardCollectionCap = Math.min(1200, target + providers.length * batchSize);
  const searchLimits = {
    requestedTarget: target,
    batchSize,
    maxCandidates: hardCollectionCap,
    maxRounds: HARD_ROUND_CAP,
    queryVariants: searchQueries.length,
    providerCount: providers.length,
  };
  const startedAt = Date.now();
  yield {
    type: "start",
    query,
    target,
    batchSize,
    topK,
    providers,
    queries: searchQueries,
    filters,
    conceptGroups,
    language,
    discipline: plan.discipline,
    limits: searchLimits,
    protocol: protocol.active ? protocol : undefined,
    startedAt,
  };

  // Per-provider and per-query state. Keeping each query variant on its own
  // offset prevents an English expansion from accidentally starting on page
  // 2 just because the Spanish literal query already consumed page 1.
  const laneKey = (provider, queryIndex) => `${provider}:${queryIndex}`;
  const lanes = new Map();
  for (const provider of providers) {
    for (let queryIndex = 0; queryIndex < searchQueries.length; queryIndex++) {
      lanes.set(laneKey(provider, queryIndex), {
        offset: 0,
        errors: 0,
        exhausted: false,
        stalePages: 0,
        reason: null,
      });
    }
  }
  const errors = Object.fromEntries(providers.map((p) => [p, 0]));
  const contributed = Object.fromEntries(providers.map((p) => [p, 0]));
  const confirmations = Object.fromEntries(providers.map((p) => [p, 0]));
  const providerMetrics = Object.fromEntries(providers.map((p) => [p, {
    calls: 0,
    durationMs: 0,
    received: 0,
    filtered: 0,
  }]));
  const exhausted = new Set();
  const providerDoneEmitted = new Set();

  const collected = [];
  const aliases = new Map();
  const systematicPool = new Map();
  let batchN = 0;
  let totalRequested = 0;
  let totalMatches = 0;
  let totalFiltered = 0;
  const integrityFilteredKeys = new Set();
  let roundsExecuted = 0;
  let stopReason = "round_cap";

  const providerFinished = (provider) => searchQueries.every((_, queryIndex) => (
    lanes.get(laneKey(provider, queryIndex))?.exhausted
  ));
  const allLanesFinished = () => providers.every(providerFinished);
  const providerOffset = (provider) => searchQueries.reduce((sum, _, queryIndex) => (
    sum + (lanes.get(laneKey(provider, queryIndex))?.offset || 0)
  ), 0);
  const providerStatsSnapshot = (selected = []) => providers.reduce((acc, provider) => {
    const selectedForProvider = selected.filter((source) => (
      (Array.isArray(source.sources) ? source.sources : [source.source]).includes(provider)
    ));
    const qualityValues = selectedForProvider
      .map((source) => Number(source.qualityScore ?? source.retrievalScore))
      .filter(Number.isFinite);
    acc[provider] = {
      contributed: contributed[provider],
      confirmations: confirmations[provider],
      errors: errors[provider],
      exhausted: exhausted.has(provider),
      offset: providerOffset(provider),
      calls: providerMetrics[provider].calls,
      durationMs: providerMetrics[provider].durationMs,
      received: providerMetrics[provider].received,
      filtered: providerMetrics[provider].filtered,
      selected: selectedForProvider.length,
      meanSelectedQuality: qualityValues.length
        ? Math.round((qualityValues.reduce((sum, value) => sum + value, 0) / qualityValues.length) * 1000) / 1000
        : null,
    };
    return acc;
  }, {});
  const searchAuditSnapshot = (selected = []) => ({
    stopReason,
    target,
    targetReached: collected.length >= target,
    roundsExecuted,
    requestedCalls: totalRequested,
    returnedMatches: totalMatches,
    uniqueCandidates: collected.length,
    filtered: totalFiltered,
    integrityFiltered: integrityFilteredKeys.size,
    limits: searchLimits,
    discipline: plan.discipline,
    providers: providerStatsSnapshot(selected),
  });

  const mergeIntoCollection = (rawItem, provider, laneQuery) => {
    const initialSources = Array.from(new Set([
      ...(Array.isArray(rawItem.sources) ? rawItem.sources : []),
      rawItem.source || provider,
      provider,
    ].filter(Boolean)));
    const item = annotateSource({
      ...rawItem,
      source: rawItem.source || provider,
      sources: initialSources,
      sourceCount: initialSources.length,
    });
    item.retrievalScore = candidateRelevance(
      item,
      [searchQueries[0], query, laneQuery, ...searchQueries.slice(1)],
      conceptGroups,
    );
    const keys = identityKeys(item);
    let index;
    for (const key of keys) {
      if (aliases.has(key)) {
        index = aliases.get(key);
        break;
      }
    }

    if (index === undefined) {
      if (collected.length >= hardCollectionCap) return { fresh: null, confirmed: false, capped: true };
      index = collected.length;
      collected.push(item);
      for (const key of keys) aliases.set(key, index);
      return { fresh: item, confirmed: false, capped: false };
    }

    const before = collected[index];
    const priorSources = new Set(Array.isArray(before.sources) ? before.sources : [before.source].filter(Boolean));
    const confirmed = !priorSources.has(provider);
    const merged = mergeCandidate(before, item);
    collected[index] = merged;
    for (const key of [...identityKeys(before), ...keys, ...identityKeys(merged)]) aliases.set(key, index);
    return { fresh: null, confirmed, capped: false };
  };

  for (let round = 0; round < HARD_ROUND_CAP; round++) {
    if (signal?.aborted) {
      yield { type: "aborted", reason: "client_disconnect", round };
      return;
    }
    if (allLanesFinished()) {
      stopReason = "providers_exhausted";
      break;
    }
    if (round >= minimumSearchRounds && collected.length >= target) {
      stopReason = "target_reached";
      break;
    }
    roundsExecuted = round + 1;

    const queryIndex = round % searchQueries.length;
    const laneQuery = searchQueries[queryIndex];
    const pending = new Map();

    for (const provider of providers) {
      const lane = lanes.get(laneKey(provider, queryIndex));
      if (!lane || lane.exhausted) continue;
      const offset = lane.offset;
      totalRequested++;
      providerMetrics[provider].calls += 1;
      const providerStartedAt = Date.now();
      const task = Promise.resolve()
        .then(() => retrieve({
          source: provider,
          query: laneQuery,
          maxResults: batchSize,
          offset,
          mailto,
          timeoutMs,
          language,
          signal,
        }))
        .then((batch) => ({ provider, lane, offset, batch, error: null, durationMs: Date.now() - providerStartedAt }))
        .catch((err) => ({
          provider,
          lane,
          offset,
          batch: [],
          error: err && err.message ? err.message : String(err),
          durationMs: Date.now() - providerStartedAt,
        }));
      pending.set(provider, task);
    }

    // Providers are independent hosts, so run one sweep concurrently and emit
    // each batch as soon as that provider settles. A slow commercial index can
    // no longer block fifteen public sources in sequence.
    while (pending.size > 0) {
      const result = await Promise.race(Array.from(pending.values()));
      pending.delete(result.provider);
      const { provider, lane, batch, error: providerError } = result;
      providerMetrics[provider].durationMs += Number(result.durationMs) || 0;

      if (signal?.aborted) {
        yield { type: "aborted", reason: "client_disconnect", provider, round };
        return;
      }

      if (providerError) {
        lane.errors += 1;
        errors[provider] += 1;
        if (lane.errors >= MAX_PROVIDER_ERRORS) {
          lane.exhausted = true;
          lane.reason = "errors";
        }
        yield {
          type: "batch_error",
          batchN: batchN + 1,
          provider,
          query: laneQuery,
          error: providerError,
          totalCollected: collected.length,
        };
      } else if (!Array.isArray(batch) || batch.length === 0) {
        lane.exhausted = true;
        lane.reason = "no_more_results";
      } else {
        lane.offset += batch.length;
        totalMatches += batch.length;
        providerMetrics[provider].received += batch.length;
        const fresh = [];
        let duplicateCount = 0;
        let confirmationCount = 0;
        let filteredCount = 0;
        let cappedCount = 0;

        for (const rawItem of batch) {
          if (!rawItem || typeof rawItem !== "object") continue;
          const annotatedItem = annotateSource({ ...rawItem, source: rawItem.source || provider });
          if (protocol.active) {
            const key = dedupKey(annotatedItem);
            const previous = systematicPool.get(key);
            systematicPool.set(key, previous ? mergeCandidate(previous, annotatedItem) : annotatedItem);
          }
          if (!passesFilters(annotatedItem, filters)) {
            filteredCount += 1;
            totalFiltered += 1;
            if (!passesIntegrityFilters(annotatedItem, filters)) integrityFilteredKeys.add(dedupKey(annotatedItem));
            continue;
          }
          const merged = mergeIntoCollection(annotatedItem, provider, laneQuery);
          if (merged.fresh) fresh.push(merged.fresh);
          else duplicateCount += 1;
          if (merged.confirmed) confirmationCount += 1;
          if (merged.capped) cappedCount += 1;
        }

        contributed[provider] += fresh.length;
        confirmations[provider] += confirmationCount;
        providerMetrics[provider].filtered += filteredCount;
        batchN++;
        yield {
          type: "batch",
          batchN,
          round: round + 1,
          provider,
          query: laneQuery,
          requested: batchSize,
          received: batch.length,
          unique: fresh.length,
          duplicates: duplicateCount,
          confirmations: confirmationCount,
          filtered: filteredCount,
          capped: cappedCount,
          totalCollected: collected.length,
          target,
          sources: fresh.map(compactSource),
        };

        if (batch.length < batchSize) {
          lane.exhausted = true;
          lane.reason = "page_short";
        } else if (fresh.length === 0) {
          lane.stalePages += 1;
          const canAdvance = (confirmationCount > 0 || filteredCount === batch.length) && lane.stalePages < 2;
          if (!canAdvance) {
            lane.exhausted = true;
            lane.reason = "no_new_results";
          }
        } else {
          lane.stalePages = 0;
        }
      }

      if (providerFinished(provider) && !providerDoneEmitted.has(provider)) {
        providerDoneEmitted.add(provider);
        exhausted.add(provider);
        const reasons = searchQueries.map((_, index) => lanes.get(laneKey(provider, index))?.reason).filter(Boolean);
        const reason = reasons.length > 0 && reasons.every((value) => value === "errors")
          ? "errors"
          : (reasons[reasons.length - 1] || "complete");
        yield {
          type: "provider_done",
          provider,
          contributed: contributed[provider],
          confirmations: confirmations[provider],
          reason,
          calls: providerMetrics[provider].calls,
          received: providerMetrics[provider].received,
          filtered: providerMetrics[provider].filtered,
          errors: errors[provider],
          durationMs: providerMetrics[provider].durationMs,
        };
      }
    }

    if (round + 1 >= minimumSearchRounds && collected.length >= target) {
      stopReason = "target_reached";
      break;
    }
    try { await _sleep(120, signal); } catch { return; }
  }

  if (stopReason === "round_cap" && allLanesFinished()) stopReason = "providers_exhausted";
  else if (stopReason === "round_cap" && collected.length >= target) stopReason = "target_reached";

  const collectionDoneAt = Date.now();
  yield {
    type: "collection_done",
    totalCollected: collected.length,
    totalMatches,
    deduped: collected.length,
    filtered: totalFiltered,
    integrityFiltered: integrityFilteredKeys.size,
    queries: searchQueries,
    filters,
    discipline: plan.discipline,
    stopReason,
    roundsExecuted,
    limits: searchLimits,
    requestedCalls: totalRequested,
    providerStats: providerStatsSnapshot(),
    elapsedMs: collectionDoneAt - startedAt,
  };

  const screenedRecords = protocol.active
    ? Array.from(systematicPool.values()).map((paper) => ({ ...paper, screening: screenPaper(paper, protocol, filters) }))
    : [];
  const systematicReviewFor = (includedPapers) => {
    if (!protocol.active) return null;
    const assessed = includedPapers.map((paper) => ({
      ...paper,
      riskOfBias: paper.riskOfBias || preliminaryRiskOfBias(paper),
    }));
    return {
      protocol,
      prisma: buildPrismaFlow({
        identified: totalMatches,
        deduped: systematicPool.size,
        screened: screenedRecords,
        included: assessed.length,
      }),
      certainty: gradeEvidence(assessed, { consensus: [], contradictions: [] }),
      screeningDecisions: screenedRecords.map((paper) => ({
        source: paper.source,
        title: paper.title,
        doi: paper.doi || null,
        year: paper.year || null,
        screening: paper.screening,
      })),
    };
  };

  if (collected.length === 0) {
    const systematicReview = systematicReviewFor([]);
    if (systematicReview) yield { type: "systematic_review", ...systematicReview };
    const protocolSummary = buildSystematicSummary(systematicReview);
    yield { type: "summary", markdown: `## ⚠️ Sin resultados\n\nNo se recuperaron fuentes para "${query}".${protocolSummary ? `\n\n${protocolSummary}` : ""}` };
    yield {
      type: "done",
      stats: {
        totalCollected: 0,
        dedupedCount: 0,
        selectedCount: 0,
        systematicReview: protocol.active,
        searchAudit: searchAuditSnapshot(),
      },
    };
    return;
  }

  const screeningByKey = new Map(screenedRecords.map((paper) => [dedupKey(paper), paper.screening]));
  const rankInput = protocol.active
    ? collected.map((paper) => ({ ...paper, screening: screeningByKey.get(dedupKey(paper)) || screenPaper(paper, protocol, filters) }))
    : collected;
  const deterministic = rankDeterministically(
    rankInput,
    [searchQueries[0], query, ...searchQueries.slice(1)],
    conceptGroups,
    filters,
  );
  const rerankPoolSize = Math.min(
    deterministic.length,
    Math.max(topK, Math.min(100, topK * 5)),
  );
  const rerankPool = deterministic.slice(0, rerankPoolSize);
  yield {
    type: "ranking_start",
    message: `Evaluando relevancia, calidad y corroboración de ${collected.length} fuentes; seleccionando las mejores ${topK}…`,
    pool: rerankPool.length,
    candidatePool: collected.length,
    topK,
  };

  let ranked = rerankPool;
  let rerankerWasUsed = false;
  try {
    const out = await rerank({
      query,
      results: rerankPool,
      callLLM: llm,
      batchSize: 10,
    });
    ranked = Array.isArray(out?.results) ? out.results : rerankPool;
    rerankerWasUsed = Boolean(out?.reranked);
  } catch (err) {
    yield { type: "rerank_error", error: err && err.message ? err.message : String(err) };
  }

  let selected = ranked.slice(0, topK);
  const doiResolutionEnabled = opts.resolveDois !== false && process.env.SCIENTIFIC_DOI_RESOLUTION_ENABLED !== "0";
  if (doiResolutionEnabled) {
    const resolver = deps.resolveDois || resolvePaperDois;
    yield {
      type: "validation_start",
      message: `Comprobando hasta ${Math.min(selected.length, 15)} DOI seleccionados…`,
      candidates: selected.filter((source) => source.doiStatus === "format_valid").slice(0, 15).length,
    };
    try {
      selected = await resolver(selected, {
        timeoutMs: Math.min(timeoutMs, 2_500),
        maxPapers: 15,
        concurrency: 4,
        signal,
      });
      yield {
        type: "validation_done",
        resolved: selected.filter((source) => source.doiResolutionStatus === "resolved").length,
        notFound: selected.filter((source) => source.doiResolutionStatus === "not_found").length,
        unavailable: selected.filter((source) => ["timeout", "unavailable", "aborted"].includes(source.doiResolutionStatus)).length,
      };
    } catch (error) {
      yield { type: "validation_error", error: error?.message || String(error) };
    }
  }
  if (protocol.active) {
    selected = selected.map((paper) => ({ ...paper, riskOfBias: preliminaryRiskOfBias(paper) }));
  }
  const systematicReview = systematicReviewFor(selected);
  if (systematicReview) yield { type: "systematic_review", ...systematicReview };
  const top = selected.map(compactSource);
  yield {
    type: "selected",
    topK: top.length,
    rerankerWasUsed,
    sources: top,
  };

  const providerStats = providers.reduce((acc, p) => {
    acc[p] = {
      contributed: contributed[p],
      confirmations: confirmations[p],
      errors: errors[p],
      exhausted: exhausted.has(p),
    };
    return acc;
  }, {});

  const markdown = buildSummaryMarkdown({
    query,
    totalCollected: collected.length,
    dedupedCount: collected.length,
    top,
    providerStats,
    systematicReview,
  });
  yield { type: "summary", markdown };

  yield {
    type: "done",
    stats: {
      totalCollected: collected.length,
      totalMatches,
      dedupedCount: collected.length,
      selectedCount: top.length,
      validatedCount: top.filter((source) => source.sourceCount >= 2).length,
      validDoiCount: top.filter((source) => source.doiStatus === "format_valid").length,
      resolvedDoiCount: top.filter((source) => source.doiResolutionStatus === "resolved").length,
      unresolvedDoiCount: top.filter((source) => source.doiStatus === "format_valid" && source.doiResolutionStatus !== "resolved").length,
      systematicReview: protocol.active,
      screeningExcludedCount: systematicReview?.prisma?.screening?.recordsExcluded || 0,
      screeningUncertainCount: systematicReview?.prisma?.screening?.recordsUncertain || 0,
      preprintCount: top.filter((source) => source.publicationStage === "preprint").length,
      integrityFilteredCount: integrityFilteredKeys.size,
      elapsedMs: Date.now() - startedAt,
      rerankerWasUsed,
      searchAudit: searchAuditSnapshot(top),
    },
  };
}

module.exports = {
  runAgenticBatch,
  buildSummaryMarkdown,
  buildSystematicSummary,
  DEFAULT_PROVIDERS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_TARGET,
  DEFAULT_TOP_K,
  INTERNAL: {
    dedupKey,
    identityKeys,
    mergeCandidate,
    passesFilters,
    candidateRelevance,
    conceptCoverage,
    sourceAuthority,
    qualityScore,
    rankDeterministically,
    compactSource,
    sleep,
  },
};
