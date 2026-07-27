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
const { annotateSource, passesIntegrityFilters } = require('./source-integrity');
const { resolvePaperDois } = require('./doi-resolver');
const { orderProvidersForDiscipline } = require('./research-discipline-router');
const {
  buildPrismaFlow,
  buildProtocol,
  gradeEvidence,
  preliminaryRiskOfBias,
  screenPaper,
} = require('./systematic-review-protocol');
const {
  buildSystematicReviewAudit,
  critiqueEvidence,
  verifyScientificCitations,
} = require('./research-quality-agents');

function applyFilters(papers, filters = {}) {
  return papers.map(annotateSource).filter((p) => {
    if (filters.yearFrom && (!Number.isFinite(p.year) || p.year < filters.yearFrom)) return false;
    if (filters.yearTo && (!Number.isFinite(p.year) || p.year > filters.yearTo)) return false;
    if (filters.openAccessOnly && !(p.openAccess === true || p.pdfUrl)) return false;
    if (!passesIntegrityFilters(p, filters)) return false;
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
    ? ['#', 'Autores', 'Año', 'Título', 'Tipo', 'Integridad', 'DOI', 'Citas', 'AA', 'Hallazgo clave']
    : ['#', 'Authors', 'Year', 'Title', 'Type', 'Integrity', 'DOI', 'Cites', 'OA', 'Key finding'];
  const rows = papers.map((p, i) => {
    const t = p.evidence?.studyType || p.studyType || '—';
    const oa = p.openAccess === true ? '✓' : (p.openAccess === false ? '✗' : '?');
    const finding = truncate(p.evidence?.topFinding || p.abstract || '—', 90);
    const integrity = p.integrityStatus === 'unknown' ? '?' : p.integrityStatus;
    const doi = p.doiResolutionStatus === 'resolved'
      ? '✓'
      : (p.doiResolutionStatus === 'not_found' ? '✗' : (p.doiStatus === 'format_valid' ? 'formato' : '—'));
    return `| ${i + 1} | ${mdEscape(authorsShort(p))} | ${p.year || '—'} | ${mdEscape(truncate(p.title, 60))} | ${t} | ${integrity} | ${doi} | ${Number.isFinite(p.citations) ? p.citations : '—'} | ${oa} | ${mdEscape(finding)} |`;
  });
  return [`| ${h.join(' | ')} |`, `| ${h.map(() => '---').join(' | ')} |`, ...rows].join('\n');
}

function pushSystematicSections(out, { protocol, prisma, certainty, papers, es }) {
  if (!protocol?.active) return;
  out.push(`## ${es ? 'Protocolo de búsqueda' : 'Search protocol'}`);
  out.push(`- **${es ? 'Alcance' : 'Scope'}:** ${protocol.scope}`);
  if (protocol.framework) out.push(`- **Framework:** ${protocol.framework.toUpperCase()}`);
  if (protocol.searchExpression) out.push(`- **${es ? 'Estrategia' : 'Strategy'}:** \`${protocol.searchExpression}\``);
  if (protocol.missingFields?.length) out.push(`- **${es ? 'Campos pendientes' : 'Missing fields'}:** ${protocol.missingFields.join(', ')}`);
  const inclusion = protocol.inclusionCriteria?.automatic || [];
  const exclusion = protocol.exclusionCriteria?.automatic || [];
  if (inclusion.length) out.push(`- **${es ? 'Inclusión automática' : 'Automatic inclusion'}:** ${inclusion.join('; ')}`);
  if (exclusion.length) out.push(`- **${es ? 'Exclusión automática' : 'Automatic exclusion'}:** ${exclusion.join('; ')}`);
  const manualCount = (protocol.inclusionCriteria?.manual?.length || 0) + (protocol.exclusionCriteria?.manual?.length || 0);
  if (manualCount) {
    out.push(`- **${es ? 'Criterios manuales registrados' : 'Registered manual criteria'}:** ${manualCount}. ${es ? 'Requieren confirmación humana.' : 'Human confirmation is required.'}`);
  }
  out.push('');

  out.push(`## ${es ? 'Flujo PRISMA preliminar' : 'Preliminary PRISMA flow'}`);
  out.push(`- ${es ? 'Registros identificados' : 'Records identified'}: ${prisma.identification.recordsIdentified}`);
  out.push(`- ${es ? 'Duplicados eliminados' : 'Duplicates removed'}: ${prisma.deduplication.duplicatesRemoved}`);
  out.push(`- ${es ? 'Registros cribados' : 'Records screened'}: ${prisma.screening.recordsScreened}`);
  out.push(`- ${es ? 'Excluidos por título/resumen' : 'Excluded by title/abstract'}: ${prisma.screening.recordsExcluded}`);
  out.push(`- ${es ? 'En duda' : 'Uncertain'}: ${prisma.screening.recordsUncertain}`);
  out.push(`- ${es ? 'Incluidos en la síntesis preliminar' : 'Included in preliminary synthesis'}: ${prisma.included.studiesInPreliminarySynthesis}`);
  if (Object.keys(prisma.screening.exclusionReasons).length) {
    out.push(`- ${es ? 'Motivos' : 'Reasons'}: ${Object.entries(prisma.screening.exclusionReasons).map(([reason, count]) => `${reason} (${count})`).join(', ')}`);
  }
  out.push('');

  out.push(`## ${es ? 'Riesgo de sesgo preliminar' : 'Preliminary risk of bias'}`);
  out.push(`> ${es ? 'Evaluación orientativa basada en metadatos y resúmenes; no sustituye la lectura del texto completo ni la lista específica por diseño.' : 'Orientation based on metadata and abstracts; it does not replace full-text assessment or the design-specific checklist.'}`);
  papers.forEach((paper, index) => {
    out.push(`- ${index + 1}. **${paper.riskOfBias?.level || 'unknown'}** · ${paper.riskOfBias?.recommendedTool || 'design-specific checklist required'}`);
  });
  out.push('');

  out.push(`## ${es ? 'Certeza preliminar de la evidencia' : 'Preliminary certainty of evidence'}`);
  out.push(`- **${certainty.level}** — ${certainty.reasons.join(', ')}`);
  out.push(`- ${es ? 'La certeza final requiere evaluación del texto completo.' : 'Final certainty requires full-text assessment.'}`);
  out.push('');
}

function citationTrail(entry, papers) {
  const refs = Array.from(new Set((entry?.paperIndexes || [])
    .map((index) => papers[index])
    .filter(Boolean)
    .map(inTextCitation)));
  return refs.length ? ` ${refs.join('; ')}` : '';
}

function protocolSlug(qa) {
  const slug = String((qa.terms || []).slice(0, 6).join('-') || 'revision-sistematica')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return slug || 'revision-sistematica';
}

function buildProtocolExport({ qa, protocol, prisma, certainty, screeningDecisions }) {
  if (!protocol?.active) return null;
  const lines = [
    `# Protocolo de revisión sistemática: ${(qa.terms || []).slice(0, 8).join(' ') || qa.normalized}`,
    '',
    '> Exportación auditable basada en metadatos y resúmenes. La elegibilidad, el riesgo de sesgo y la certeza definitivos requieren evaluación del texto completo.',
    '',
    '## Estrategia de búsqueda',
    '',
    `- Framework: ${protocol.framework ? protocol.framework.toUpperCase() : 'sin framework estructurado'}`,
    `- Expresión: ${protocol.searchExpression || qa.searchQueries.join(' OR ')}`,
    `- Consultas ejecutadas: ${qa.searchQueries.join(' | ')}`,
    '',
    '## Campos del framework',
    '',
    '| Campo | Valor |',
    '|---|---|',
    ...Object.entries(protocol.fields || {}).map(([field, value]) => `| ${mdEscape(field)} | ${mdEscape(value)} |`),
    '',
    '## Criterios',
    '',
    `- Inclusión automática: ${(protocol.inclusionCriteria?.automatic || []).join('; ') || 'ninguna adicional'}`,
    `- Exclusión automática: ${(protocol.exclusionCriteria?.automatic || []).join('; ') || 'ninguna adicional'}`,
    `- Inclusión manual registrada: ${(protocol.inclusionCriteria?.manual || []).join('; ') || 'ninguna'}`,
    `- Exclusión manual registrada: ${(protocol.exclusionCriteria?.manual || []).join('; ') || 'ninguna'}`,
    '',
    '## Flujo PRISMA preliminar',
    '',
    '```mermaid',
    'flowchart TD',
    `  A["Identificados: ${prisma.identification.recordsIdentified}"] --> B["Únicos: ${prisma.deduplication.uniqueRecords}"]`,
    `  B --> C["Cribados: ${prisma.screening.recordsScreened}"]`,
    `  C --> D["Excluidos: ${prisma.screening.recordsExcluded}"]`,
    `  C --> E["En duda: ${prisma.screening.recordsUncertain}"]`,
    `  C --> F["Síntesis preliminar: ${prisma.included.studiesInPreliminarySynthesis}"]`,
    '```',
    '',
    '## Decisiones de cribado',
    '',
    '| # | Decisión | Motivos | Año | DOI | Título |',
    '|---:|---|---|---:|---|---|',
    ...screeningDecisions.map((item, index) => (
      `| ${index + 1} | ${item.screening.decision} | ${mdEscape((item.screening.reasons || []).join(', '))} | ${item.year || '—'} | ${mdEscape(item.doi || '—')} | ${mdEscape(truncate(item.title, 100))} |`
    )),
    '',
    '## Certeza preliminar',
    '',
    `- Nivel: ${certainty.level}`,
    `- Motivos: ${certainty.reasons.join(', ')}`,
    `- Dominios: ${Object.entries(certainty.domains || {}).map(([key, value]) => `${key}=${value}`).join('; ')}`,
    '',
  ];
  return {
    filename: `protocolo-${protocolSlug(qa)}.md`,
    contentType: 'text/markdown; charset=utf-8',
    content: lines.join('\n'),
  };
}

function buildMarkdownReport({ qa, papers, synthesis, bibliography, protocol, prisma, certainty }) {
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
  if (!papers.length) {
    out.push(`> ${L.none}`);
    out.push('');
    if (protocol?.active && prisma && certainty) {
      pushSystematicSections(out, { protocol, prisma, certainty, papers, es });
    }
    return out.join('\n');
  }

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

  pushSystematicSections(out, { protocol, prisma, certainty, papers, es });

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
  const evidenceStatements = [
    ...(synthesis.consensusEvidence || []),
    ...(synthesis.contradictionEvidence || []),
  ];
  const cc = [...synthesis.consensus, ...synthesis.contradictions];
  if (evidenceStatements.length) {
    for (const statement of evidenceStatements) out.push(`- ${statement.text}${citationTrail(statement, papers)}`);
  } else if (cc.length) for (const c of cc) out.push(`- ${c}`);
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
  let qa = analyzeQuery(rawQuery, { maxQueries: opts.maxQueries, discipline: opts.discipline });
  const protocol = buildProtocol(rawQuery, qa, opts.protocol || {});
  if (protocol.active && protocol.searchExpression) {
    qa = {
      ...qa,
      reviewMode: 'systematic',
      searchQueries: Array.from(new Set([protocol.searchExpression, ...qa.searchQueries])).slice(0, opts.maxQueries || 3),
    };
  } else if (protocol.active) {
    qa = { ...qa, reviewMode: 'systematic' };
  }

  if (!qa.normalized) {
    const emptySynthesis = synthesize([], qa);
    const emptyBibliography = { apa: [], ieee: [], mla: [] };
    const emptyPrisma = protocol.active ? buildPrismaFlow({}) : null;
    const emptyCertainty = protocol.active ? gradeEvidence([]) : null;
    const emptyReport = buildMarkdownReport({
      qa,
      papers: [],
      synthesis: emptySynthesis,
      bibliography: emptyBibliography,
      protocol,
      prisma: emptyPrisma,
      certainty: emptyCertainty,
    });
    const emptyCore = {
      query: qa, papers: [], synthesis: emptySynthesis,
      bibliography: emptyBibliography, comparisonTable: '',
      protocol,
      prisma: emptyPrisma,
      certainty: emptyCertainty,
      screeningDecisions: [],
      report: emptyReport,
      meta: { providers: [], errors: [{ provider: 'input', message: 'query is empty' }], count: 0, durationMs: Date.now() - t0 },
    };
    const evidenceCritic = critiqueEvidence({ papers: [], synthesis: emptySynthesis });
    const citationVerifier = verifyScientificCitations(emptyReport, []);
    return {
      ...emptyCore,
      agents: {
        evidenceCritic,
        citationVerifier,
        systematicReview: protocol.active
          ? buildSystematicReviewAudit(emptyCore, { evidenceCritic, citationVerifier })
          : null,
      },
    };
  }

  const searchOpts = {
    providers: Array.isArray(opts.providers) && opts.providers.length
      ? opts.providers
      : orderProvidersForDiscipline(scientificSearch.PROVIDERS, qa.discipline),
    limit: opts.limit,
    timeoutMs: opts.timeoutMs,
  };
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

  const deduped = scientificSearch._internal.dedupeByDoi(collected).map(annotateSource);
  const integrityExcluded = deduped
    .filter((paper) => !passesIntegrityFilters(paper, qa.filters))
    .length;
  const screened = protocol.active
    ? deduped.map((paper) => ({ ...paper, screening: screenPaper(paper, protocol, qa.filters) }))
    : [];
  let papers = protocol.active
    ? screened.filter((paper) => paper.screening.decision !== 'exclude')
    : applyFilters(deduped, qa.filters);
  papers = scientificSearch._internal.rankPapers(papers, qa.normalized).slice(0, maxPapers);

  const doiResolutionEnabled = opts.resolveDois !== false && process.env.SCIENTIFIC_DOI_RESOLUTION_ENABLED !== '0';
  let doiResolutionError = null;
  if (doiResolutionEnabled) {
    const resolver = typeof opts.doiResolver === 'function' ? opts.doiResolver : resolvePaperDois;
    try {
      papers = await resolver(papers, {
        timeoutMs: opts.doiTimeoutMs,
        maxPapers: Math.min(maxPapers, Number.isFinite(opts.maxDoiResolutions) ? opts.maxDoiResolutions : 15),
        signal: opts.signal,
      });
    } catch (error) {
      doiResolutionError = error?.message || String(error);
      errors.push({ provider: 'doi-resolver', message: doiResolutionError });
    }
  }

  for (const p of papers) {
    p.evidence = extractEvidence(p, qa.terms);
    p.inTextCitation = inTextCitation(p);
    if (protocol.active) p.riskOfBias = preliminaryRiskOfBias(p);
  }

  const synthesis = synthesize(papers, qa);
  const certainty = protocol.active ? gradeEvidence(papers, synthesis) : null;
  const prisma = protocol.active
    ? buildPrismaFlow({ identified: collected.length, deduped: deduped.length, screened, included: papers.length })
    : null;
  const screeningDecisions = protocol.active ? screened.map((paper) => ({
    source: paper.source,
    title: paper.title,
    doi: paper.doi || null,
    year: paper.year || null,
    screening: paper.screening,
  })) : [];
  const protocolExport = protocol.active
    ? buildProtocolExport({ qa, protocol, prisma, certainty, screeningDecisions })
    : null;
  const bibliography = {
    apa: formatBibliography(papers, 'apa'),
    ieee: formatBibliography(papers, 'ieee'),
    mla: formatBibliography(papers, 'mla'),
  };
  const comparisonTable = buildComparisonTable(papers, qa.language === 'en' ? 'en' : 'es');
  const report = buildMarkdownReport({ qa, papers, synthesis, bibliography, protocol, prisma, certainty });
  const meta = {
    providers: Array.from(providersUsed),
    errors,
    count: papers.length,
    integrityExcluded,
    screeningExcluded: protocol.active ? screened.filter((paper) => paper.screening.decision === 'exclude').length : 0,
    screeningUncertain: protocol.active ? screened.filter((paper) => paper.screening.decision === 'uncertain').length : 0,
    doiResolved: papers.filter((paper) => paper.doiResolutionStatus === 'resolved').length,
    doiNotFound: papers.filter((paper) => paper.doiResolutionStatus === 'not_found').length,
    doiResolutionError,
    queriesRun: qa.searchQueries,
    durationMs: Date.now() - t0,
  };
  const evidenceCritic = critiqueEvidence({ papers, synthesis });
  const citationVerifier = verifyScientificCitations(report, papers);
  const reviewCore = {
    query: qa,
    protocol: protocol.active ? protocol : null,
    prisma,
    certainty,
    screeningDecisions,
    protocolExport,
    papers,
    synthesis,
    bibliography,
    comparisonTable,
    report,
    meta,
  };
  return {
    ...reviewCore,
    agents: {
      evidenceCritic,
      citationVerifier,
      systematicReview: protocol.active
        ? buildSystematicReviewAudit(reviewCore, { evidenceCritic, citationVerifier })
        : null,
    },
  };
}

module.exports = {
  buildLiteratureReview,
  applyFilters,
  buildComparisonTable,
  buildMarkdownReport,
  buildProtocolExport,
  pushSystematicSections,
};
