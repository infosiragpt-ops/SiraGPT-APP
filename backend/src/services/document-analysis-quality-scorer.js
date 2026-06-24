'use strict';

/**
 * document-analysis-quality-scorer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure-function quality grader for the document-analysis enrichment pipeline.
 * Runs after `document-insights-engine` + `document-professional-analyzer`
 * and emits a "## ANALYSIS QUALITY ASSURANCE" markdown block the chat splices
 * before the directive, so the model can calibrate its answer confidence and
 * point at gaps instead of hallucinating coverage.
 *
 * Why this exists:
 *  - The professional-analyzer + insights-engine extract dozens of categories
 *    of findings. Without a quality lens, the model can't tell whether the
 *    pipeline scanned everything we know about or just the first 32 KB.
 *  - A quantified coverage / density / coherence triple gives the model a
 *    safe answer-shape ("I scanned ~38% of the document; here is what I
 *    found, here is what would need a full re-read to verify").
 *
 * Design constraints (mirrors document-insights-engine):
 *  - Synchronous, deterministic, no LLM call, no network. Adds < 5 ms to the
 *    chat path even for 1 MB of text and 20 attached files.
 *  - Resilient: handles null / partial / malformed reports without throwing.
 *  - Token-budget aware: total block stays under MAX_QUALITY_BLOCK_CHARS.
 *
 * Public API:
 *   scoreInsightsReport(report, opts)    → ScoreReport
 *   scoreClassificationCoherence(report, classification) → CoherenceReport
 *   renderQualityBlock(score, opts)      → string (markdown block)
 *   buildQualityForFiles(perFileReports, classifications, opts) → string
 */

const MAX_QUALITY_BLOCK_CHARS = Number.parseInt(
  process.env.SIRAGPT_QUALITY_BLOCK_MAX_CHARS || '2400',
  10,
);
const SCAN_HEAD_BYTES = 32_000; // mirror the insights-engine scan window

// ──────────────────────────────────────────────────────────────────────────
// Scoring helpers
// ──────────────────────────────────────────────────────────────────────────

function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function countFindings(report) {
  if (!report || typeof report !== 'object') return 0;
  const entities = report.entities || {};
  const contacts = report.contacts || {};
  const dates = report.dates || {};
  const numbers = report.numbers || {};
  const ids = report.identifiers || {};
  const bib = report.bibliographic || {};
  const stats = report.statistical || {};
  const geo = report.geographic || {};
  const sentiment = report.sentiment || {};
  const hashes = ids.hashes || {};
  return safeArray(entities.persons).length
    + safeArray(entities.organizations).length
    + safeArray(entities.places).length
    + safeArray(contacts.urls).length
    + safeArray(contacts.emails).length
    + safeArray(contacts.phones).length
    + safeArray(dates.absolute).length
    + safeArray(dates.relative).length
    + safeArray(numbers.money).length
    + safeArray(numbers.percentages).length
    + safeArray(numbers.largeNumbers).length
    + safeArray(report.actionItems).length
    + safeArray(report.questions).length
    + safeArray(report.risks).length
    + safeArray(report.claims).length
    + safeArray(ids.ipv4).length
    + safeArray(ids.ipv6).length
    + safeArray(ids.macAddresses).length
    + safeArray(ids.uuids).length
    + safeArray(hashes.md5).length
    + safeArray(hashes.sha1).length
    + safeArray(hashes.sha256).length
    + safeArray(ids.jwts).length
    + safeArray(ids.ibans).length
    + safeArray(ids.swiftCodes).length
    + safeArray(ids.awsArns).length
    + safeArray(bib.dois).length
    + safeArray(bib.isbns).length
    + safeArray(bib.arxivIds).length
    + safeArray(bib.rfcs).length
    + safeArray(bib.pubmedIds).length
    + safeArray(bib.pmcIds).length
    + safeArray(geo.coordinatesDecimal).length
    + safeArray(geo.coordinatesDms).length
    + safeArray(geo.postalCodes).length
    + safeArray(stats.sampleSizes).length
    + safeArray(stats.pValues).length
    + safeArray(stats.correlations).length
    + safeArray(stats.confidenceIntervals).length
    + safeArray(stats.effectSizes).length
    + safeArray(stats.meansAndSd).length
    + safeArray(report.acronyms).length
    + safeArray(report.trends).length
    + safeArray(report.crossReferences).length
    + safeArray(sentiment.positive).length
    + safeArray(sentiment.negative).length;
}

function countCategoriesWithFindings(report) {
  if (!report || typeof report !== 'object') return { populated: 0, total: 0 };
  // List of (category, has-findings?) tuples
  const categories = [
    ['entities.persons', safeArray(report.entities?.persons).length > 0],
    ['entities.organizations', safeArray(report.entities?.organizations).length > 0],
    ['contacts.urls', safeArray(report.contacts?.urls).length > 0],
    ['contacts.emails', safeArray(report.contacts?.emails).length > 0],
    ['contacts.phones', safeArray(report.contacts?.phones).length > 0],
    ['dates', safeArray(report.dates?.absolute).length + safeArray(report.dates?.relative).length > 0],
    ['numbers.money', safeArray(report.numbers?.money).length > 0],
    ['numbers.percentages', safeArray(report.numbers?.percentages).length > 0],
    ['actionItems', safeArray(report.actionItems).length > 0],
    ['questions', safeArray(report.questions).length > 0],
    ['risks', safeArray(report.risks).length > 0],
    ['claims', safeArray(report.claims).length > 0],
    ['identifiers', anyArrayPopulated([
      report.identifiers?.ipv4, report.identifiers?.ipv6, report.identifiers?.macAddresses,
      report.identifiers?.uuids, report.identifiers?.jwts, report.identifiers?.ibans,
      report.identifiers?.swiftCodes, report.identifiers?.awsArns,
      report.identifiers?.hashes?.md5, report.identifiers?.hashes?.sha1, report.identifiers?.hashes?.sha256,
    ])],
    ['bibliographic', anyArrayPopulated([
      report.bibliographic?.dois, report.bibliographic?.isbns, report.bibliographic?.arxivIds,
      report.bibliographic?.rfcs, report.bibliographic?.pubmedIds, report.bibliographic?.pmcIds,
    ])],
    ['geographic', anyArrayPopulated([
      report.geographic?.coordinatesDecimal, report.geographic?.coordinatesDms, report.geographic?.postalCodes,
    ])],
    ['statistical', anyArrayPopulated([
      report.statistical?.sampleSizes, report.statistical?.pValues, report.statistical?.correlations,
      report.statistical?.confidenceIntervals, report.statistical?.effectSizes, report.statistical?.meansAndSd,
    ])],
    ['acronyms', safeArray(report.acronyms).length > 0],
    ['trends', safeArray(report.trends).length > 0],
    ['crossReferences', safeArray(report.crossReferences).length > 0],
    ['sentiment', anyArrayPopulated([report.sentiment?.positive, report.sentiment?.negative])],
  ];
  const populated = categories.filter(([, hit]) => hit).length;
  return { populated, total: categories.length };
}

function anyArrayPopulated(arrays) {
  for (const a of arrays || []) {
    if (Array.isArray(a) && a.length > 0) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Coverage score — what portion of the document did we actually scan?
// Floor 5% so the score is never zero when ANY text was processed; coverage
// of 100% is reserved for documents whose entire body fits inside the scan
// window.
// ──────────────────────────────────────────────────────────────────────────

function computeCoverageScore(metrics) {
  if (!metrics || typeof metrics !== 'object') return 0;
  const chars = safeNumber(metrics.chars, 0);
  if (chars <= 0) return 0;
  const scanned = Math.min(chars, SCAN_HEAD_BYTES);
  // Honor the documented 5% floor — a large (e.g. 1 MB) document whose scanned
  // head is a tiny fraction would otherwise score 1-3%, contradicting the
  // "never zero when ANY text was processed" contract above.
  return clamp(Math.round((scanned / chars) * 100), 5, 100);
}

// ──────────────────────────────────────────────────────────────────────────
// Density score — findings per 1000 characters scanned. Tunable cap.
// ──────────────────────────────────────────────────────────────────────────

function computeDensityScore(report) {
  const metrics = report?.metrics || {};
  const chars = safeNumber(metrics.chars, 0);
  if (chars <= 0) return 0;
  const scanned = Math.min(chars, SCAN_HEAD_BYTES);
  const findings = countFindings(report);
  // Target: 5 findings per 1 KB scanned = "rich". Score caps at 100.
  const density = (findings / Math.max(scanned, 1)) * 1000;
  const ratio = density / 5;
  return clamp(Math.round(ratio * 100));
}

// ──────────────────────────────────────────────────────────────────────────
// Breadth score — how many extractor categories produced at least one hit.
// ──────────────────────────────────────────────────────────────────────────

function computeBreadthScore(report) {
  const { populated, total } = countCategoriesWithFindings(report);
  if (total === 0) return 0;
  return clamp(Math.round((populated / total) * 100));
}

// ──────────────────────────────────────────────────────────────────────────
// Classification coherence — do the insights agree with the detected doc
// type? E.g. "academic_paper" + ≥1 DOI/arXiv + statistical claims → high.
// ──────────────────────────────────────────────────────────────────────────

const COHERENCE_EXPECTATIONS = {
  academic_paper: {
    expected: ['bibliographic', 'statistical', 'acronyms'],
    helpful: ['claims', 'crossReferences', 'numbers.percentages'],
  },
  legal_contract: {
    expected: ['entities.organizations', 'dates', 'numbers.money'],
    helpful: ['risks', 'actionItems', 'crossReferences'],
  },
  financial_statement: {
    expected: ['numbers.money', 'numbers.percentages', 'trends'],
    helpful: ['dates', 'entities.organizations', 'claims'],
  },
  invoice: {
    expected: ['numbers.money', 'dates', 'entities.organizations'],
    helpful: ['identifiers'],
  },
  cv_resume: {
    expected: ['entities.organizations', 'dates'],
    helpful: ['acronyms', 'contacts'],
  },
  medical_clinical: {
    expected: ['dates', 'numbers.percentages'],
    helpful: ['risks', 'acronyms', 'statistical'],
  },
  technical_spec: {
    expected: ['identifiers', 'acronyms'],
    helpful: ['crossReferences', 'claims'],
  },
  business_report: {
    expected: ['numbers.percentages', 'trends', 'claims'],
    helpful: ['entities.organizations', 'sentiment', 'risks'],
  },
  meeting_transcript: {
    expected: ['entities.persons', 'actionItems'],
    helpful: ['questions', 'claims'],
  },
  regulatory_compliance: {
    expected: ['acronyms', 'risks', 'crossReferences'],
    helpful: ['identifiers', 'dates'],
  },
  research_proposal: {
    expected: ['claims', 'numbers.money', 'dates'],
    helpful: ['statistical', 'bibliographic'],
  },
  source_code: {
    expected: ['identifiers'],
    helpful: ['acronyms', 'crossReferences'],
  },
  log_file: {
    expected: ['dates', 'identifiers'],
    helpful: ['risks'],
  },
  patent: {
    expected: ['bibliographic', 'crossReferences', 'claims'],
    helpful: ['acronyms', 'entities.organizations'],
  },
  employment_contract: {
    expected: ['entities.persons', 'numbers.money', 'dates'],
    helpful: ['risks', 'actionItems'],
  },
  bank_statement: {
    expected: ['numbers.money', 'dates'],
    helpful: ['identifiers', 'trends'],
  },
  insurance_policy: {
    expected: ['numbers.money', 'dates', 'acronyms'],
    helpful: ['risks', 'entities.organizations'],
  },
  incident_postmortem: {
    expected: ['dates', 'actionItems', 'risks'],
    helpful: ['identifiers', 'trends', 'claims'],
  },
  pitch_deck: {
    expected: ['numbers.money', 'numbers.percentages', 'trends'],
    helpful: ['entities.organizations', 'claims'],
  },
};

function hasCategoryFinding(report, dotted) {
  if (!report) return false;
  if (!dotted.includes('.')) {
    // Top-level array like "actionItems", "questions"
    if (dotted === 'identifiers') {
      return countFindings({ identifiers: report.identifiers }) > 0
        && anyArrayPopulated([
          report.identifiers?.ipv4, report.identifiers?.ipv6, report.identifiers?.macAddresses,
          report.identifiers?.uuids, report.identifiers?.jwts, report.identifiers?.ibans,
          report.identifiers?.swiftCodes, report.identifiers?.awsArns,
          report.identifiers?.hashes?.md5, report.identifiers?.hashes?.sha1, report.identifiers?.hashes?.sha256,
        ]);
    }
    if (dotted === 'bibliographic') {
      return anyArrayPopulated([
        report.bibliographic?.dois, report.bibliographic?.isbns, report.bibliographic?.arxivIds,
        report.bibliographic?.rfcs, report.bibliographic?.pubmedIds, report.bibliographic?.pmcIds,
      ]);
    }
    if (dotted === 'statistical') {
      return anyArrayPopulated([
        report.statistical?.sampleSizes, report.statistical?.pValues, report.statistical?.correlations,
        report.statistical?.confidenceIntervals, report.statistical?.effectSizes, report.statistical?.meansAndSd,
      ]);
    }
    if (dotted === 'geographic') {
      return anyArrayPopulated([
        report.geographic?.coordinatesDecimal, report.geographic?.coordinatesDms, report.geographic?.postalCodes,
      ]);
    }
    if (dotted === 'sentiment') {
      return anyArrayPopulated([report.sentiment?.positive, report.sentiment?.negative]);
    }
    if (dotted === 'contacts') {
      return anyArrayPopulated([report.contacts?.urls, report.contacts?.emails, report.contacts?.phones]);
    }
    if (dotted === 'dates') {
      return safeArray(report.dates?.absolute).length + safeArray(report.dates?.relative).length > 0;
    }
    return safeArray(report[dotted]).length > 0;
  }
  // Two-segment dotted like "entities.persons", "numbers.money"
  const [parent, child] = dotted.split('.');
  return safeArray(report?.[parent]?.[child]).length > 0;
}

function scoreClassificationCoherence(report, classification) {
  const type = classification?.type || 'general_document';
  const expectation = COHERENCE_EXPECTATIONS[type];
  if (!expectation) {
    return {
      type,
      hits: [],
      misses: [],
      score: 50,
      verdict: 'neutral',
    };
  }
  const expected = expectation.expected || [];
  const helpful = expectation.helpful || [];
  const hits = [];
  const misses = [];
  for (const cat of expected) {
    if (hasCategoryFinding(report, cat)) hits.push(cat);
    else misses.push(cat);
  }
  let bonus = 0;
  for (const cat of helpful) {
    if (hasCategoryFinding(report, cat)) bonus += 1;
  }
  // 70% weight on expected hit ratio, 30% on helpful bonus (capped)
  const expectedRatio = expected.length > 0 ? hits.length / expected.length : 0;
  const helpfulRatio = helpful.length > 0 ? Math.min(bonus / helpful.length, 1) : 0;
  const score = clamp(Math.round((expectedRatio * 70) + (helpfulRatio * 30)));
  let verdict = 'low';
  if (score >= 75) verdict = 'high';
  else if (score >= 45) verdict = 'medium';
  return { type, hits, misses, helpfulHit: bonus, score, verdict };
}

// ──────────────────────────────────────────────────────────────────────────
// Composite — coverage/density/breadth/coherence aggregated.
// ──────────────────────────────────────────────────────────────────────────

function scoreInsightsReport(report, opts = {}) {
  if (!report || typeof report !== 'object') {
    return {
      coverage: 0,
      density: 0,
      breadth: 0,
      coherence: null,
      overall: 0,
      findings: 0,
      grade: 'F',
      categoriesPopulated: 0,
      categoriesTotal: 0,
    };
  }
  const coverage = computeCoverageScore(report.metrics);
  const density = computeDensityScore(report);
  const breadth = computeBreadthScore(report);
  const coherence = opts.classification
    ? scoreClassificationCoherence(report, opts.classification)
    : null;
  const coherenceScore = coherence ? coherence.score : 60; // neutral if absent

  // Weights chosen so coverage matters most, breadth and coherence next,
  // density least (density inflates on short documents).
  const overall = clamp(Math.round(
    (coverage * 0.35) + (breadth * 0.25) + (coherenceScore * 0.25) + (density * 0.15),
  ));

  const findings = countFindings(report);
  const cats = countCategoriesWithFindings(report);
  return {
    coverage,
    density,
    breadth,
    coherence,
    overall,
    findings,
    grade: gradeFromScore(overall),
    categoriesPopulated: cats.populated,
    categoriesTotal: cats.total,
  };
}

function gradeFromScore(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

// ──────────────────────────────────────────────────────────────────────────
// Markdown rendering
// ──────────────────────────────────────────────────────────────────────────

function gradeBadge(grade) {
  const badges = { A: '🟢', B: '🟢', C: '🟡', D: '🟠', F: '🔴' };
  return badges[grade] || '⚪';
}

function renderQualityBlock(score, opts = {}) {
  if (!score) return '';
  const title = opts.title || 'ANALYSIS QUALITY ASSURANCE';
  const fileLabel = opts.fileLabel ? ` — ${opts.fileLabel}` : '';
  const lines = [];
  lines.push(`## ${title}${fileLabel}`);
  lines.push(`**Overall:** ${gradeBadge(score.grade)} ${score.grade} (${score.overall}/100) · ${score.findings.toLocaleString()} structured findings across ${score.categoriesPopulated}/${score.categoriesTotal} extractor categories.`);
  lines.push('');
  lines.push('| Dimension | Score | What it means |');
  lines.push('|---|---|---|');
  lines.push(`| Coverage | ${score.coverage}/100 | % of document bytes scanned for facts |`);
  lines.push(`| Breadth | ${score.breadth}/100 | extractor categories with ≥1 finding |`);
  lines.push(`| Density | ${score.density}/100 | findings per KB scanned |`);
  if (score.coherence) {
    lines.push(`| Coherence | ${score.coherence.score}/100 | insights vs detected type \`${score.coherence.type}\` |`);
  }
  if (score.coherence) {
    if (score.coherence.misses.length > 0) {
      lines.push('');
      lines.push(`_Gaps for \`${score.coherence.type}\` (expected but not found):_ ${score.coherence.misses.map(m => `\`${m}\``).join(', ')}.`);
    }
  }
  if (score.coverage < 50) {
    lines.push('');
    lines.push('_The scanner reads the first ~32 KB of each document. Anything past that point is not represented in the structured findings — when you answer, signal which sections you have direct evidence for._');
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Multi-file aggregator
// ──────────────────────────────────────────────────────────────────────────

function buildQualityForFiles(perFileReports, classifications = [], opts = {}) {
  const list = Array.isArray(perFileReports) ? perFileReports : [];
  if (list.length === 0) return '';
  const classByFile = new Map();
  for (const c of safeArray(classifications)) {
    if (c && c.file) classByFile.set(c.file, c.classification || c);
  }
  if (list.length === 1) {
    const only = list[0];
    const cls = classByFile.get(only.file) || null;
    const score = scoreInsightsReport(only.report, { classification: cls });
    return renderQualityBlock(score, { fileLabel: only.file, title: opts.title });
  }
  const perFileScores = list.map((item) => ({
    file: item.file,
    score: scoreInsightsReport(item.report, { classification: classByFile.get(item.file) }),
  }));
  const aggregate = aggregateScores(perFileScores.map((p) => p.score));
  const block = [];
  block.push(`## ${opts.title || 'ANALYSIS QUALITY ASSURANCE'} — ${list.length} files`);
  block.push(`**Aggregate:** ${gradeBadge(aggregate.grade)} ${aggregate.grade} (${aggregate.overall}/100) across ${list.length} files.`);
  block.push('');
  block.push('| File | Grade | Coverage | Breadth | Coherence |');
  block.push('|---|---|---|---|---|');
  for (const p of perFileScores) {
    const coherence = p.score.coherence ? `${p.score.coherence.score} (${p.score.coherence.type})` : '—';
    block.push(`| ${p.file} | ${gradeBadge(p.score.grade)} ${p.score.grade} | ${p.score.coverage} | ${p.score.breadth} | ${coherence} |`);
  }
  let combined = block.join('\n');
  if (combined.length > MAX_QUALITY_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_QUALITY_BLOCK_CHARS - 80)}\n\n[...quality block truncated to stay within token budget]`;
  }
  return combined;
}

function aggregateScores(scores) {
  if (!Array.isArray(scores) || scores.length === 0) {
    return { overall: 0, grade: 'F' };
  }
  const mean = (key) => Math.round(scores.reduce((acc, s) => acc + (s[key] || 0), 0) / scores.length);
  const overall = mean('overall');
  return { overall, grade: gradeFromScore(overall) };
}

module.exports = {
  scoreInsightsReport,
  scoreClassificationCoherence,
  renderQualityBlock,
  buildQualityForFiles,
  _internal: {
    computeCoverageScore,
    computeDensityScore,
    computeBreadthScore,
    countFindings,
    countCategoriesWithFindings,
    hasCategoryFinding,
    gradeFromScore,
    COHERENCE_EXPECTATIONS,
  },
};
