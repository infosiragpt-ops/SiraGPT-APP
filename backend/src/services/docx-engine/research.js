'use strict';

// Reuse the public, SSRF-guarded research tools. The Word editor never gets
// browser actions or network access through arbitrary code execution.
const { WEB_TOOL_DEFINITIONS, makeWebToolExecutors } = require('../agent-runner/browser/web-tools');
const { webToolsEnabled, UNTRUSTED_BEGIN, UNTRUSTED_END } = require('../agent-runner/browser/untrusted');

const READ_TOOLS = new Set(['web_search', 'web_fetch']);
const MAX_RESEARCH_CALLS = 8;
const MAX_SOURCES = 6;
// Keep the fetched text and the review evidence identical, below the review's
// 4k/source limit and the web envelope's 24k serialized-JSON limit.
const MAX_SOURCE_CHARS = 3000;
const SOURCE_LIMIT_ERROR = 'ERROR: Se alcanzó el límite de fuentes. Usa las fuentes ya leídas; si no bastan, explica qué información falta.';

function requestNeedsResearch(instruction) {
  const text = String(instruction || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return text.split(/[.;,\n]|\bpero\b/).some((clause) => {
    // Negating research is distinct from excluding one source. In particular,
    // "busca fuentes recientes, sin usar Wikipedia" still requests research.
    const affirmative = clause.replace(/\b(?:no|sin)\s+(?:busc\w*|investig\w*|consult\w*|verific\w*)\b.*$/, '');
    const external = /\b(?:web|internet|online|en linea|extern[ao]s?)\b/.test(affirmative);
    const local = /\b(?:en|del?|dentro de)\s+(?:(?:el|la|los|las|este|esta|estos|estas|mi|mis)\s+)?(?:documentos?|archivos?|word|texto|adjuntos?|pdf|anexos?)\b/.test(affirmative)
      || /\b(?:adjunt[oa]s?|adjunte|proporcionad[oa]s?|enviad[oa]s?)\b|\bque\s+(?:te\s+)?(?:envie|comparti)\b/.test(affirmative);
    if (local && !external) return false;
    return /\b(?:busc\w*|investig\w*|consult\w*|verific\w*)\b[^.;\n]{0,100}\b(?:web|internet|fuentes?|referencias?|informacion)\b/.test(affirmative)
      || /\b(?:fuentes?|referencias?)\s+(?:recientes|actualizadas|verificadas)\b/.test(affirmative);
  });
}

function fetchedSource(result) {
  const raw = String(result || '');
  const start = raw.indexOf(UNTRUSTED_BEGIN), end = raw.lastIndexOf(UNTRUSTED_END);
  if (start < 0 || end < start) return null;
  try {
    const data = JSON.parse(raw.slice(start + UNTRUSTED_BEGIN.length, end).trim());
    if (!(data.status >= 200 && data.status < 300) || !String(data.text || '').trim()) return null;
    const url = String(data.finalUrl || data.url || '');
    if (!/^https?:\/\//i.test(url)) return null;
    return { url, title: String(data.title || '').slice(0, 240), text: String(data.text).slice(0, MAX_SOURCE_CHARS) };
  } catch { return null; }
}

function makeDocumentResearch(options = {}) {
  const sources = [];
  if (!webToolsEnabled(options.env || process.env)) return { tools: [], executors: {}, sources };
  const web = makeWebToolExecutors(options);
  let calls = 0;
  const executors = Object.fromEntries([...READ_TOOLS].map((name) => [name, async (args, context) => {
    if (++calls > MAX_RESEARCH_CALLS) return 'ERROR: Se alcanzó el límite de consultas. Usa solo las fuentes ya leídas; si faltan datos, explica la limitación.';
    let boundedArgs = args;
    if (name === 'web_fetch') {
      const url = String(args?.url || '').trim();
      if (sources.length >= MAX_SOURCES && !sources.some((source) => source.url === url)) return SOURCE_LIMIT_ERROR;
      const requestedChars = Number(args?.max_chars);
      boundedArgs = { ...args, max_chars: Number.isFinite(requestedChars) && requestedChars > 0
        ? Math.min(requestedChars, MAX_SOURCE_CHARS) : MAX_SOURCE_CHARS };
    }
    const result = await web[name](boundedArgs, context);
    if (name === 'web_fetch') {
      const source = fetchedSource(result);
      if (source) {
        const previous = sources.findIndex((entry) => entry.url === source.url);
        if (previous >= 0) sources[previous] = source;
        else if (sources.length < MAX_SOURCES) sources.push(source);
        else return SOURCE_LIMIT_ERROR; // a previously known URL redirected to a new source
      }
    }
    return result;
  }]));
  return { tools: WEB_TOOL_DEFINITIONS.filter((tool) => READ_TOOLS.has(tool.function.name)), executors, sources };
}

module.exports = { makeDocumentResearch, requestNeedsResearch };
