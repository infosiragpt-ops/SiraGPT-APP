'use strict';

/**
 * literature-synthesizer — turn a set of evidence-enriched papers into the
 * analytical backbone of a literature review: descriptive statistics, thematic
 * clusters (keyword co-occurrence), consensus vs. contradiction signals across
 * findings, research gaps, and the strongest key findings with source refs.
 *
 * Deterministic + offline. The prose is templated (bilingual ES/EN); an LLM can
 * later polish it, but the structure and numbers are always trustworthy.
 */

const { _internal: { STOPWORDS } } = require('./research-query-intelligence');

const EXTRA_STOP = new Set((
  'study studies research paper analysis approach method methods results using based model models ' +
  'system systems data results new use used review propose proposed paper article among within toward ' +
  'estudio estudios investigacion analisis metodo metodos resultados modelo modelos sistema sistemas datos ' +
  'nuevo nuevos uso revision propone propuesto entre hacia mediante'
).split(/\s+/).filter(Boolean));

function stripDiacritics(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function tokenize(text) {
  return stripDiacritics(String(text || '').toLowerCase())
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !EXTRA_STOP.has(w) && !/^\d+$/.test(w));
}

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function computeStats(papers) {
  const years = papers.map((p) => p.year).filter((y) => Number.isFinite(y));
  const byYear = {};
  for (const y of years) byYear[y] = (byYear[y] || 0) + 1;
  const citations = papers.map((p) => (Number.isFinite(p.citations) ? p.citations : 0));
  const oa = papers.filter((p) => p.openAccess === true).length;
  const withDoi = papers.filter((p) => p.doi).length;
  const studyTypes = {};
  for (const p of papers) {
    const st = p.evidence?.studyType;
    if (st) studyTypes[st] = (studyTypes[st] || 0) + 1;
  }
  return {
    count: papers.length,
    yearRange: years.length ? { from: Math.min(...years), to: Math.max(...years) } : null,
    medianYear: median(years),
    byYear,
    openAccess: oa,
    openAccessRate: papers.length ? Math.round((oa / papers.length) * 100) : 0,
    withDoi,
    totalCitations: citations.reduce((a, b) => a + b, 0),
    studyTypes,
  };
}

// Build thematic clusters: rank keywords by document frequency (how many papers
// mention them), drop terms shared by almost everything (the query topic) and by
// almost nothing, then group papers under each surviving keyword.
function buildThemes(papers, queryTerms = [], opts = {}) {
  const maxThemes = Number.isFinite(opts.maxThemes) && opts.maxThemes > 0 ? opts.maxThemes : 5;
  const qset = new Set((queryTerms || []).map((t) => stripDiacritics(String(t).toLowerCase())));
  const docTokens = papers.map((p) => new Set(tokenize(`${p.title || ''} ${p.abstract || ''}`)));
  const df = new Map();
  docTokens.forEach((toks) => {
    for (const tok of toks) {
      if (qset.has(tok)) continue; // skip the query topic itself — common to all
      df.set(tok, (df.get(tok) || 0) + 1);
    }
  });
  const n = papers.length || 1;
  const candidates = Array.from(df.entries())
    .filter(([, c]) => c >= 2 && c <= Math.ceil(n * 0.85))
    .sort((a, b) => b[1] - a[1]);

  const themes = [];
  const usedKeywords = new Set();
  for (const [keyword, count] of candidates) {
    if (themes.length >= maxThemes) break;
    if (usedKeywords.has(keyword)) continue;
    const paperIdx = [];
    docTokens.forEach((toks, i) => { if (toks.has(keyword)) paperIdx.push(i); });
    if (paperIdx.length < 2) continue;
    usedKeywords.add(keyword);
    themes.push({
      keyword,
      label: keyword.charAt(0).toUpperCase() + keyword.slice(1),
      count,
      paperIndexes: paperIdx,
    });
  }
  return themes;
}

function directionTally(papers, idxs) {
  const tally = { positive: 0, negative: 0, mixed: 0, neutral: 0 };
  for (const i of idxs) {
    const dir = papers[i]?.evidence?.findings?.[0]?.direction || 'neutral';
    tally[dir] = (tally[dir] || 0) + 1;
  }
  return tally;
}

function buildConsensus(papers, themes, lang = 'es') {
  const consensus = [];
  const contradictions = [];
  for (const theme of themes) {
    const tally = directionTally(papers, theme.paperIndexes);
    const directional = tally.positive + tally.negative;
    if (directional < 2) continue;
    if (tally.positive >= 2 && tally.negative >= 2) {
      contradictions.push(lang === 'es'
        ? `Sobre "${theme.label}", la evidencia está dividida: ${tally.positive} estudio(s) reportan efectos positivos frente a ${tally.negative} con efectos negativos.`
        : `On "${theme.label}", evidence is split: ${tally.positive} study(ies) report positive effects vs. ${tally.negative} reporting negative ones.`);
    } else if (tally.positive >= 2 && tally.negative === 0) {
      consensus.push(lang === 'es'
        ? `Hay consenso en que "${theme.label}" se asocia con efectos positivos (${tally.positive} estudios convergen).`
        : `There is consensus that "${theme.label}" is associated with positive effects (${tally.positive} studies converge).`);
    } else if (tally.negative >= 2 && tally.positive === 0) {
      consensus.push(lang === 'es'
        ? `Los estudios coinciden en efectos negativos/decrecientes relacionados con "${theme.label}" (${tally.negative} estudios).`
        : `Studies agree on negative/declining effects related to "${theme.label}" (${tally.negative} studies).`);
    }
  }
  return { consensus, contradictions };
}

function buildGaps(papers, stats, queryAnalysis) {
  const lang = queryAnalysis?.language === 'en' ? 'en' : 'es';
  const gaps = [];
  // 1. Temporal sparsity inside the covered range.
  if (stats.yearRange) {
    const missing = [];
    for (let y = stats.yearRange.from; y <= stats.yearRange.to; y += 1) {
      if (!stats.byYear[y]) missing.push(y);
    }
    if (missing.length >= 2) {
      gaps.push(lang === 'es'
        ? `Cobertura temporal irregular: sin estudios en ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}.`
        : `Uneven temporal coverage: no studies in ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}.`);
    }
  }
  // 2. Weak evidence base (few quantitative / stats-backed papers).
  const withStats = papers.filter((p) => p.evidence?.hasStats).length;
  if (papers.length >= 3 && withStats <= Math.floor(papers.length / 3)) {
    gaps.push(lang === 'es'
      ? `Evidencia mayormente cualitativa o descriptiva: solo ${withStats}/${papers.length} estudios reportan datos estadísticos.`
      : `Evidence is largely qualitative/descriptive: only ${withStats}/${papers.length} studies report statistical data.`);
  }
  // 3. Methodological gap (no RCT / meta-analysis among the set).
  const strongDesigns = (stats.studyTypes.rct || 0) + (stats.studyTypes.meta_analysis || 0) + (stats.studyTypes.systematic_review || 0);
  if (papers.length >= 4 && strongDesigns === 0) {
    gaps.push(lang === 'es'
      ? 'No se identificaron diseños de alta evidencia (ECA, meta-análisis o revisiones sistemáticas) en el conjunto.'
      : 'No high-evidence designs (RCTs, meta-analyses or systematic reviews) were identified in the set.');
  }
  // 4. Author-stated future work (deduped).
  const future = [];
  for (const p of papers) {
    if (p.evidence?.futureWork && future.length < 3) future.push(p.evidence.futureWork);
  }
  for (const f of future) gaps.push((lang === 'es' ? 'Línea futura señalada: ' : 'Stated future line: ') + f);
  return gaps;
}

function buildKeyFindings(papers, opts = {}) {
  const max = Number.isFinite(opts.max) && opts.max > 0 ? opts.max : 6;
  const out = [];
  papers.forEach((p, i) => {
    const f = p.evidence?.findings?.[0];
    if (f && f.sentence) {
      out.push({ paperIndex: i, title: p.title, year: p.year, sentence: f.sentence, score: f.score, direction: f.direction });
    }
  });
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

/**
 * synthesize — full analytical layer over the enriched paper set.
 *
 * @param {Array} papers — papers each carrying an `.evidence` object
 * @param {object} queryAnalysis — output of research-query-intelligence.analyzeQuery
 * @returns {{ stats, themes, consensus, contradictions, gaps, keyFindings, overview }}
 */
function synthesize(papers, queryAnalysis = {}) {
  const lang = queryAnalysis.language === 'en' ? 'en' : 'es';
  const stats = computeStats(papers);
  const themes = buildThemes(papers, queryAnalysis.terms || [], {});
  const { consensus, contradictions } = buildConsensus(papers, themes, lang);
  const gaps = buildGaps(papers, stats, queryAnalysis);
  const keyFindings = buildKeyFindings(papers, {});

  const topic = (queryAnalysis.terms || []).slice(0, 4).join(' ') || queryAnalysis.normalized || '';
  const rangeTxt = stats.yearRange ? `${stats.yearRange.from}–${stats.yearRange.to}` : (lang === 'es' ? 'sin fecha' : 'undated');
  const themeTxt = themes.slice(0, 3).map((t) => t.label).join(', ');
  const overview = lang === 'es'
    ? `Se analizaron ${stats.count} estudios sobre ${topic || 'el tema'} (${rangeTxt}). ${stats.openAccessRate}% de acceso abierto; ${stats.totalCitations} citas acumuladas.${themeTxt ? ` Los ejes temáticos dominantes son: ${themeTxt}.` : ''}`
    : `${stats.count} studies on ${topic || 'the topic'} were analysed (${rangeTxt}). ${stats.openAccessRate}% open access; ${stats.totalCitations} cumulative citations.${themeTxt ? ` Dominant thematic axes: ${themeTxt}.` : ''}`;

  return { stats, themes, consensus, contradictions, gaps, keyFindings, overview };
}

module.exports = {
  synthesize,
  computeStats,
  buildThemes,
  buildConsensus,
  buildGaps,
  buildKeyFindings,
  _internal: { tokenize, median, EXTRA_STOP },
};
