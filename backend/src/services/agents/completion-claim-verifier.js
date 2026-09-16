'use strict';

/**
 * completion-claim-verifier — deterministic "did the agent actually do
 * what it says it did?" check for EVERY chat turn.
 *
 * The system prompt tells the model not to claim it modified a repo /
 * created a file / searched the web unless a tool really did it, but
 * nothing enforces it. This module closes that gap: given the final
 * answer text and the set of tools that actually executed in the turn,
 * it flags first-person, past-tense completion claims that have no
 * supporting tool evidence, and produces a corrective instruction the
 * runtime can use for self-repair (or surface as a trace event).
 *
 * Design:
 *   - Conservative on purpose: only clear first-person past-tense action
 *     claims are matched, so offers ("puedo crear…"), future ("voy a…")
 *     and conditional phrasings do not trip it. Bilingual ES/EN.
 *   - A claim is SUPPORTED when any of its evidence tools ran; otherwise
 *     it is UNSUPPORTED. Pure function, no I/O, fully testable.
 */

// Each claim kind: a matcher and the tool names that would substantiate it.
// Boundaries use Unicode letter lookarounds ((?<![\p{L}]) / (?![\p{L}]))
// instead of \b, because \b is ASCII-only and breaks around accented
// Spanish verbs ("creé", "busqué", "ejecuté").
const CLAIM_KINDS = Object.freeze([
  {
    kind: 'web_research',
    // "busqué en la web", "consulté internet", "I searched the web"
    re: /(?<![\p{L}])(?:busqu[ée]|consult[ée]|investigu[ée]|revis[ée]|encontr[ée]|hall[ée]|searched|search|looked\s+up|look\s+up|browsed|found)(?![\p{L}])[^.?!\n]{0,60}(?<![\p{L}])(?:web|internet|online|google|bing|fuentes?|sources?|en\s+l[ií]nea|navegador)(?![\p{L}])/iu,
    tools: ['web_search', 'read_url', 'web_extract', 'scientific_search', 'github_search', 'x_search', 'browser_navigate'],
  },
  {
    kind: 'source_read',
    // "leí la fuente / el artículo / la página", "I read the page/article"
    re: /(?<![\p{L}])(?:le[ií]|revis[ée]|abr[ií]|read|opened|fetched|visited|visit)(?![\p{L}])[^.?!\n]{0,50}(?<![\p{L}])(?:p[aá]gina|art[ií]culo|fuente|enlace|url|sitio|web|page|article|source|link|website)(?![\p{L}])/iu,
    tools: ['read_url', 'web_extract', 'web_search', 'browser_navigate'],
  },
  {
    kind: 'file_created',
    // "creé/generé el archivo/documento/pdf", "I created the file/document"
    re: /(?<![\p{L}])(?:cre[ée]|gener[ée]|elabor[ée]|prepar[ée]|produj[ée]|arm[ée]|he\s+cre[aá]do|created|generated|produced|built|made|prepared)(?![\p{L}])[^.?!\n]{0,60}(?<![\p{L}])(?:archivo|documento|fichero|pdf|word|docx|excel|xlsx|pptx?|powerpoint|presentaci[oó]n|hoja\s+de\s+c[aá]lculo|informe|reporte|file|document|spreadsheet|deck|report|chart|gr[aá]fico|imagen|image|diagram)(?![\p{L}])/iu,
    tools: [
      'create_document', 'verify_artifact', 'host_file', 'generate_image',
      'create_chart', 'create_mermaid_diagram', 'create_infographic_svg',
      'create_dashboard_html', 'generate_video',
    ],
  },
  {
    kind: 'doc_edited',
    // "actualicé/modifiqué/edité tu word", "I updated your document"
    re: /(?<![\p{L}])(?:actualic[ée]|modifiqu[ée]|edit[ée]|reescrib[ií]|cambi[ée]|ajust[ée]|updated|modified|edited|rewrote|changed|adjusted)(?![\p{L}])[^.?!\n]{0,50}(?<![\p{L}])(?:archivo|documento|word|docx|excel|xlsx|pptx?|pdf|file|document)(?![\p{L}])/iu,
    tools: ['create_document', 'host_file', 'verify_artifact'],
  },
  {
    kind: 'code_executed',
    // "ejecuté/corrí el código/script/tests", "I ran the code/tests"
    re: /(?<![\p{L}])(?:ejecut[ée]|corr[ií]|prob[ée]|lanc[ée]|ran|run|executed|tested|compiled)(?![\p{L}])[^.?!\n]{0,40}(?<![\p{L}])(?:c[oó]digo|script|programa|tests?|pruebas?|comando|code|command|build|suite)(?![\p{L}])/iu,
    tools: ['python_exec', 'bash_exec', 'run_tests', 'host_bash', 'code_sandbox'],
  },
  {
    kind: 'repo_modified',
    // commit/push/clone/deploy claims
    re: /(?<![\p{L}])(?:commit|committ?ed|commite[ée]|push|pushed|push[ée]|clon[ée]|cloned|merge[ée]|merged|despleg[uü][ée]|deployed)(?![\p{L}])/iu,
    tools: ['host_bash', 'clone_project', 'check_ci_status', 'monitor_ci'],
  },
  {
    kind: 'memory_used',
    // "recordé / según tu memoria / recuperé de tu historial"
    re: /(?<![\p{L}])(?:recuerd[oé]|record[ée]|recuper[ée]|recalled|recall)(?![\p{L}])|seg[uú]n\s+tu\s+(?:memoria|historial)|de\s+tu\s+(?:memoria|historial)|from\s+your\s+(?:memory|history)/iu,
    tools: ['memory_recall', 'session_search', 'session_history', 'session_list', 'rag_retrieve'],
  },
]);

function normalizeExecuted(executedTools) {
  if (executedTools instanceof Set) return executedTools;
  const arr = Array.isArray(executedTools) ? executedTools : [];
  return new Set(arr.map((t) => (typeof t === 'string' ? t : t && t.name)).filter(Boolean).map(String));
}

/**
 * Extract the completion claims asserted by `text`.
 * @returns {Array<{kind:string, tools:string[], snippet:string}>}
 */
function extractClaims(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const claims = [];
  for (const def of CLAIM_KINDS) {
    const m = def.re.exec(s);
    if (m) {
      const start = Math.max(0, m.index - 10);
      claims.push({ kind: def.kind, tools: def.tools.slice(), snippet: s.slice(start, start + 90).replace(/\s+/g, ' ').trim() });
    }
  }
  return claims;
}

/**
 * Verify the answer's completion claims against the tools that actually ran.
 * @param {string} text final answer
 * @param {string[]|Set<string>} executedTools tool names that executed (successfully)
 * @returns {{ok:boolean, claims:object[], supported:object[], unsupported:object[], severity:'none'|'low'|'high'}}
 */
function verifyClaims(text, executedTools) {
  const executed = normalizeExecuted(executedTools);
  const claims = extractClaims(text);
  const supported = [];
  const unsupported = [];
  for (const c of claims) {
    const ok = c.tools.some((t) => executed.has(t));
    (ok ? supported : unsupported).push(c);
  }
  // High severity for side-effecting / externally-visible claims with no
  // evidence (the dangerous lies); low for read-only claims.
  const HIGH = new Set(['file_created', 'doc_edited', 'code_executed', 'repo_modified']);
  const severity = unsupported.length === 0
    ? 'none'
    : (unsupported.some((c) => HIGH.has(c.kind)) ? 'high' : 'low');
  return { ok: unsupported.length === 0, claims, supported, unsupported, severity };
}

/**
 * Build a corrective instruction for the model when claims are unsupported.
 * Returns '' when everything checks out.
 */
function buildCorrectionInstruction(result) {
  if (!result || result.ok || !result.unsupported || result.unsupported.length === 0) return '';
  const kinds = Array.from(new Set(result.unsupported.map((c) => c.kind)));
  return [
    'HONESTY CHECK FAILED: your answer claims actions that no tool actually performed',
    `(${kinds.join(', ')}).`,
    'Either (a) call the appropriate tool to really perform the action and verify it,',
    'or (b) rewrite the answer to state plainly what was and was not done.',
    'Never assert that you created a file, edited a document, ran code, searched the web,',
    'or modified a repository unless a tool in this turn did it.',
  ].join(' ');
}

// Read-only Q&A / summarize / explain-image. These turns answer from
// attached pixels or already-injected text; they must not be held hostage
// by a tool-evidence judge that cannot succeed without create/search tools.
const READ_ONLY_QA_RE = /\b(?:resumen|resume(?:r|me|n)?|resumir|s[ií]ntesis|analiza(?:r|me)?|an[aá]lisis|explica(?:r|me)?|explique|describe(?:r|me)?|describ|qu[eé]\s+dice|qu[eé]\s+muestra|de\s+qu[eé]\s+trata|un\s+solo\s+p[aá]rrafo|en\s+(?:un|uno)\s+p[aá]rrafo|summarize|summarise|explain|describe|what\s+(?:does|is)|interpreta(?:r|me)?|identifica(?:r)?)\b/iu;

const QUERY_NEEDS_TOOL_SIDEEFFECTS_RE = /\b(?:busca(?:r)?|investig(?:a|ar)|fuentes|citas)\b[^.?!\n]{0,40}\b(?:web|internet|online|google|papers?|art[ií]culos?)\b|\b(?:crea(?:r|me)?|genera(?:r|me)?|exporta(?:r|me)?|descarga(?:r|me)?|haz(?:me)?)\b[^.?!\n]{0,140}\b(?:word|docx|pdf|excel|xlsx|pptx?|powerpoint|archivo|documento|informe|imagen|video|gr[aá]fico)\b|\bdame\s+(?:un|una)\s+(?:word|docx|pdf|excel|xlsx|pptx?|powerpoint|archivo|documento)\b|\b(?:edita(?:r)?|modifica(?:r)?|actualiza(?:r)?)\b[^.?!\n]{0,80}\b(?:word|docx|pdf|excel|archivo|documento)\b|\b(?:commit|push|clone|deploy)\b/iu;

function isReadOnlyQaIntent(query) {
  const q = String(query || '');
  if (!q.trim()) return false;
  if (QUERY_NEEDS_TOOL_SIDEEFFECTS_RE.test(q)) return false;
  return READ_ONLY_QA_RE.test(q);
}

/**
 * Fail-open the quality/verify loop for pure Q&A, summarize-attachment and
 * explain-image turns whose draft does not claim a tool side-effect.
 * High-severity unsupported claims (created file, edited doc, ran code,
 * modified repo) still require evidence.
 */
function shouldFailOpenVerification({ query, answer, executedTools } = {}) {
  if (!isReadOnlyQaIntent(query)) return false;
  const draft = String(answer || '').trim();
  if (!draft) return false;
  const claims = verifyClaims(draft, executedTools);
  return claims.severity !== 'high';
}

module.exports = {
  CLAIM_KINDS,
  extractClaims,
  verifyClaims,
  buildCorrectionInstruction,
  normalizeExecuted,
  isReadOnlyQaIntent,
  shouldFailOpenVerification,
};
