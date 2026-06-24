'use strict';

/**
 * literature-review-engine — orchestrates the full "scientific search →
 * literature review" pipeline:
 *
 *   raw query
 *     → research-query-intelligence.analyzeQuery (language, terms, filters,
 *       bilingual expanded query variants)
 *     → scientific-search.search × each variant  (wide recall)
 *     → dedupe + filter (year / open access) + relevance rank
 *     → evidence-extractor per paper (findings, study type, stats)
 *     → literature-synthesizer (stats, themes, consensus, gaps, key findings)
 *     → bibliography-formatter (APA / IEEE / MLA) + comparison table
 *     → assembled bilingual Markdown literature review
 *
 * `searchImpl` is injectable so the whole engine is unit-testable offline.
 */

const { analyzeQuery } = require('./research-query-intelligence');
const { extractEvidence } = require('./evidence-extractor');
const { synthesize } = require('./literature-synthesizer');
const { formatBibliography, inTextCitation } = require('./bibliography-formatter');
const scientificSearch = require('../scientific-search');

function applyFilters(papers, filters = {}) {
  return papers.filter((p) => {
    if (filters.yearFrom && (!Number.isFinite(p.year) || p.year < filters.yearFrom)) return false;
    if (filters.yearTo && (!Number.isFinite(p.year) || p.year > filters.yearTo)) return false;
    if (filters.openAccessOnly && !(p.openAccess === true || p.pdfUrl)) return false;
    return true;
  });
}

function mdEscape(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  const v = String(s || '').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

function authorsShort(paper) {
  const names = (paper.authors || []).map((a) => a && a.name).filter(Boolean);
  if (!names.length) return '—';
  const first = names[0].split(/\s+/).slice(-1)[0]; // surname-ish
  return names.length === 1 ? first : `${first} et al.`;
}

function buildComparisonTable(papers, lang = 'es') {
  const h = lang === 'es'
    ? ['#', 'Autores', 'Año', 'Título', 'Tipo', 'Citas', 'AA', 'Hallazgo clave']
    : ['#', 'Authors', 'Year', 'Title', 'Type', 'Cites', 'OA', 'Key finding'];
  const rows = papers.map((p, i) => {
    const t = p.evidence?.studyType || '—';
    const oa = p.openAccess === true ? '✓' : (p.openAccess === false ? '✗' : '?');
    const finding = truncate(p.evidence?.topFinding || p.abstract || '—', 90);
    return `| ${i + 1} | ${mdEscape(authorsShort(p))} | ${p.year || '—'} | ${mdEscape(truncate(p.title, 60))} | ${t} | ${Number.isFinite(p.citations) ? p.citations : '—'} | ${oa} | ${mdEscape(finding)} |`;
  });
  return [`| ${h.join(' | ')} |`, `| ${h.map(() => '---').join(' | ')} |`, ...rows].join('\n');
}

function buildMarkdownReport({ qa, papers, synthesis, bibliography }) {
  const es = qa.language !== 'en';
  const L = es
    ? {
        title: 'Revisión de literatura', summary: 'Resumen ejecutivo', stats: 'Panorama cuantitativo',
        themes: 'Ejes temáticos', key: 'Hallazgos clave', consensus: 'Consenso y contradicciones',
        gaps: 'Vacíos de investigación', table: 'Tabla comparativa', refs: 'Referencias (APA)',
        none: 'No se identificaron resultados para esta consulta.',
        studies: 'estudios', oa: 'acceso abierto', cites: 'citas', noConsensus: 'Sin señales claras de consenso o contradicción en los ejes detectados.',
        noGaps: 'No se detectaron vacíos evidentes con la evidencia disponible.',
      }
    : {
        title: 'Literature review', summary: 'Executive summary', stats: 'Quantitative overview',
        themes: 'Thematic axes', key: 'Key findings', consensus: 'Consensus & contradictions',
        gaps: 'Research gaps', table: 'Comparison table', refs: 'References (APA)',
        none: 'No results were found for this query.',
        studies: 'studies', oa: 'open access', cites: 'citations', noConsensus: 'No clear consensus/contradiction signals in the detected axes.',
        noGaps: 'No obvious gaps detected with the available evidence.',
      };

  const topic = (qa.terms || []).slice(0, 6).join(' ') || qa.normalized;
  const out = [];
  out.push(`# ${L.title}: ${topic}`);
  out.push('');
  if (!papers.length) { out.push(`> ${L.none}`); return out.join('\n'); }

  out.push(`## ${L.summary}`);
  out.push(synthesis.overview);
  out.push('');

  out.push(`## ${L.stats}`);
  const s = synthesis.stats;
  out.push(`- **${s.count}** ${L.studies}${s.yearRange ? ` (${s.yearRange.from}–${s.yearRange.to})` : ''}`);
  out.push(`- ${s.openAccessRate}% ${L.oa} · ${s.totalCitations} ${L.cites} · ${s.withDoi}/${s.count} DOI`);
  if (Object.keys(s.studyTypes).length) {
    out.push(`- ${es ? 'Diseños' : 'Designs'}: ${Object.entries(s.studyTypes).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  }
  out.push('');

  if (synthesis.themes.length) {
    out.push(`## ${L.themes}`);
    for (const th of synthesis.themes) {
      out.push(`- **${th.label}** — ${th.paperIndexes.length} ${es ? 'estudios' : 'studies'}`);
    }
    out.push('');
  }

  if (synthesis.keyFindings.length) {
    out.push(`## ${L.key}`);
    for (const kf of synthesis.keyFindings) {
      const ref = inTextCitation(papers[kf.paperIndex]);
      out.push(`- ${kf.sentence} ${ref}`);
    }
    out.push('');
  }

  out.push(`## ${L.consensus}`);
  const cc = [...synthesis.consensus, ...synthesis.contradictions];
  if (cc.length) for (const c of cc) out.push(`- ${c}`);
  else out.push(`- ${L.noConsensus}`);
  out.push('');

  out.push(`## ${L.gaps}`);
  if (synthesis.gaps.length) for (const g of synthesis.gaps) out.push(`- ${g}`);
  else out.push(`- ${L.noGaps}`);
  out.push('');

  out.push(`## ${L.table}`);
  out.push(buildComparisonTable(papers, es ? 'es' : 'en'));
  out.push('');

  out.push(`## ${L.refs}`);
  bibliography.apa.forEach((ref, i) => out.push(`${i + 1}. ${ref}`));
  out.push('');

  return out.join('\n');
}

/**
 * buildLiteratureReview — the public entry point.
 *
 * @param {string} rawQuery
 * @param {object} [opts]
 *   providers?, limit?, timeoutMs?, maxQueries?, maxPapers?,
 *   searchImpl? (defaults to scientific-search.search; injected in tests)
 * @returns {Promise<{ query, papers, synthesis, bibliography, comparisonTable, report, meta }>}
 */
async function buildLiteratureReview(rawQuery, opts = {}) {
  const t0 = Date.now();
  const searchImpl = typeof opts.searchImpl === 'function' ? opts.searchImpl : scientificSearch.search;
  const maxPapers = Number.isFinite(opts.maxPapers) && opts.maxPapers > 0 ? opts.maxPapers : 15;
  const qa = analyzeQuery(rawQuery, { maxQueries: opts.maxQueries });

  if (!qa.normalized) {
    return {
      query: qa, papers: [], synthesis: synthesize([], qa),
      bibliography: { apa: [], ieee: [], mla: [] }, comparisonTable: '',
      report: buildMarkdownReport({ qa, papers: [], synthesis: synthesize([], qa), bibliography: { apa: [] } }),
      meta: { providers: [], errors: [{ provider: 'input', message: 'query is empty' }], count: 0, durationMs: Date.now() - t0 },
    };
  }

  const searchOpts = { providers: opts.providers, limit: opts.limit, timeoutMs: opts.timeoutMs };
  const collected = [];
  const errors = [];
  const providersUsed = new Set();
  const results = await Promise.all(
    qa.searchQueries.map((q) => Promise.resolve(searchImpl(q, searchOpts)).catch((e) => ({ papers: [], errors: [{ provider: 'search', message: e?.message || String(e) }], providers: [] })))
  );
  for (const r of results) {
    for (const p of (r.papers || [])) collected.push(p);
    for (const e of (r.errors || [])) errors.push(e);
    for (const pr of (r.providers || [])) providersUsed.add(pr);
  }

  let papers = scientificSearch._internal.dedupeByDoi(collected);
  papers = applyFilters(papers, qa.filters);
  papers = scientificSearch._internal.rankPapers(papers, qa.normalized).slice(0, maxPapers);

  for (const p of papers) {
    p.evidence = extractEvidence(p, qa.terms);
    p.inTextCitation = inTextCitation(p);
  }

  const synthesis = synthesize(papers, qa);
  const bibliography = {
    apa: formatBibliography(papers, 'apa'),
    ieee: formatBibliography(papers, 'ieee'),
    mla: formatBibliography(papers, 'mla'),
  };
  const comparisonTable = buildComparisonTable(papers, qa.language === 'en' ? 'en' : 'es');
  const report = buildMarkdownReport({ qa, papers, synthesis, bibliography });

  return {
    query: qa,
    papers,
    synthesis,
    bibliography,
    comparisonTable,
    report,
    meta: {
      providers: Array.from(providersUsed),
      errors,
      count: papers.length,
      queriesRun: qa.searchQueries,
      durationMs: Date.now() - t0,
    },
  };
}

module.exports = {
  buildLiteratureReview,
  applyFilters,
  buildComparisonTable,
  buildMarkdownReport,
};
