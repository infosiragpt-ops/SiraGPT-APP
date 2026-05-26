'use strict';

const scientificSearch = require('../scientific-search');
const { referenceEntry } = require('../marco-teorico/apa7');
const { getTemplate, listTemplates } = require('./chapter-templates');
const {
  validateWordCount,
  validateChapterPlan,
  validateAgainstSpec,
} = require('./word-count-validator');
const {
  markUnverified,
  strictModeEnabled,
  verifyDoisBatch,
  onlineFallbackEnabled,
  hallucinationThreshold,
} = require('./citation-verifier');
const {
  listSpecsForChapter,
  buildSpecBlock,
} = require('./section-specs');

const MIN_YEAR = 2020;

function filterVerifiedPapers(papers = []) {
  return papers.filter((p) => {
    const doi = String(p.doi || '').trim();
    if (!doi) return false;
    const year = Number(p.year) || 0;
    if (year > 0 && year < MIN_YEAR) return false;
    return true;
  });
}

async function researchPhase(topic, opts = {}) {
  const result = await scientificSearch.search(topic, {
    limit: opts.limit || 20,
    minYear: MIN_YEAR,
    timeoutMs: opts.timeoutMs || 25_000,
  });
  const verified = filterVerifiedPapers(result.papers || []);
  return {
    query: topic,
    providers: result.providers || [],
    papers: verified,
    rejected: (result.papers || []).length - verified.length,
  };
}

function buildReferences(papers = []) {
  return papers.map((p) => ({
    doi: p.doi,
    apa: referenceEntry({
      title: p.title,
      authors: (p.authors || []).map((a) => (typeof a === 'string' ? { family: a } : a)),
      year: p.year,
      container: p.venue,
      doi: p.doi,
    }),
    paper: p,
  }));
}

function structurePhase(chapterIds = ['introduction', 'methodology']) {
  return chapterIds
    .map((id) => getTemplate(id))
    .filter(Boolean);
}

/**
 * Heuristic extractor: given a chapter body and the list of expected
 * sub-section specs, find each sub-section's text by matching its
 * title as a markdown header. Returns a Map<specId, text>. The match
 * is forgiving: case-insensitive, ignores accents, allows the LLM to
 * use `##`, `###` or numbered titles like `1.1`.
 */
function extractSubsections(text, subspecs = []) {
  const map = new Map();
  if (!text || typeof text !== 'string' || !subspecs.length) return map;

  function normalize(s) {
    return String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  const normalizedText = text;
  // Build a sorted list of header positions to slice the body by
  // sub-section. Headers are matched greedily; if the LLM used plain
  // text titles we still try to find them as substrings.
  const positions = [];
  for (const spec of subspecs) {
    const normTitle = normalize(spec.title);
    if (!normTitle) continue;
    const headerRe = new RegExp(
      `(?:^|\\n)\\s*(?:#{1,6}\\s+|\\*\\*|\\d+(?:\\.\\d+)*\\s+)?[^\\n]*${escapeRegex(normTitle.split(' ').slice(0, 4).join(' '))}[^\\n]*`,
      'i',
    );
    const m = normalizedText.match(headerRe);
    if (m && typeof m.index === 'number') {
      positions.push({ specId: spec.id, start: m.index });
    }
  }

  positions.sort((a, b) => a.start - b.start);
  for (let i = 0; i < positions.length; i++) {
    const { specId, start } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : normalizedText.length;
    map.set(specId, normalizedText.slice(start, end).trim());
  }
  return map;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runThesisPipeline(params = {}, deps = {}) {
  const {
    topic,
    chapterIds = ['introduction', 'methodology'],
    onEvent = null,
  } = params;

  const emit = (event) => {
    if (typeof onEvent === 'function') onEvent(event);
  };

  emit({ type: 'phase', phase: 'research', percent: 10 });
  const research = deps.researchPhase
    ? await deps.researchPhase(topic)
    : await researchPhase(topic);
  emit({ type: 'research', count: research.papers.length, rejected: research.rejected });

  emit({ type: 'phase', phase: 'verify', percent: 35 });
  const references = buildReferences(research.papers);
  emit({ type: 'references', count: references.length });

  emit({ type: 'phase', phase: 'structure', percent: 50 });
  const templates = structurePhase(chapterIds);
  emit({ type: 'structure', chapters: templates.map((t) => t.id) });

  emit({ type: 'phase', phase: 'generate', percent: 70 });
  const generateChapter = deps.generateChapter || (async () => '');
  const strict = params.strictCitations === undefined ? strictModeEnabled() : Boolean(params.strictCitations);
  const chapters = [];
  let totalUnverified = 0;
  for (const tpl of templates) {
    // Hand the LLM the strict sub-section specs (exact word counts,
    // required citations, regions to mention, year ranges) so it can
    // generate paragraphs that survive the post-generation validator
    // — the prompt master nails specific counts like 75/100/220 words
    // that won't be hit unless the model knows them up front.
    const subspecs = listSpecsForChapter(tpl.id);
    if (subspecs.length > 0) {
      emit({
        type: 'subsection-specs',
        chapter: tpl.id,
        count: subspecs.length,
        ids: subspecs.map((s) => s.id),
      });
    }
    const subspecPrompt = subspecs.map(buildSpecBlock).filter(Boolean).join('\n\n');
    const raw = await generateChapter({
      template: tpl,
      topic,
      references,
      subspecs,
      subspecPrompt,
    });
    const { text: content, report: citationReport } = strict
      ? markUnverified(raw, references)
      : { text: raw, report: { totalUnverified: 0, totalVerified: 0, dois: { verified: [], unverified: [] }, apa: { verified: [], unverified: [] } } };
    totalUnverified += citationReport.totalUnverified;
    const validation = validateWordCount(content, {
      min: tpl.minWords,
      max: tpl.maxWords,
      label: tpl.title,
    });

    // Best-effort sub-section validation: when the LLM keeps section
    // headers in its output we can verify per-sub-section word counts
    // against the strict spec table. When headers can't be matched we
    // skip silently (the chapter-level validation already ran).
    let subsectionValidations = [];
    if (subspecs.length > 0) {
      const sectionsMap = extractSubsections(content, subspecs);
      subsectionValidations = subspecs.map((spec) => {
        const sectionText = sectionsMap.get(spec.id) || '';
        const v = sectionText
          ? validateAgainstSpec(sectionText, spec)
          : { ok: null, label: spec.title, words: 0, skipped: true };
        return { specId: spec.id, ...v };
      });
    }

    chapters.push({
      id: tpl.id,
      title: tpl.title,
      content,
      validation,
      citations: citationReport,
      subsectionValidations,
    });
    emit({
      type: 'chapter',
      id: tpl.id,
      words: validation.words,
      ok: validation.ok,
      unverifiedCitations: citationReport.totalUnverified,
      subsections: subsectionValidations.length,
      subsectionsOk: subsectionValidations.filter((s) => s.ok === true).length,
      subsectionsSkipped: subsectionValidations.filter((s) => s.skipped).length,
    });
  }
  let totalVerified = chapters.reduce((s, c) => s + (c.citations?.totalVerified || 0), 0);
  let externallyVerified = 0;

  // Optional online fallback: any DOI that wasn't in the canonical
  // references list may still be a real paper that the LLM cited from
  // its own knowledge. Check CrossRef once per unique unverified DOI
  // and reclassify the hits, dropping the `[no verificado]` marker.
  const onlineFallback = params.verifyOnlineFallback === undefined
    ? onlineFallbackEnabled()
    : Boolean(params.verifyOnlineFallback);
  if (strict && onlineFallback) {
    emit({ type: 'phase', phase: 'crossref-verify', percent: 85 });
    const unverifiedDois = [];
    for (const ch of chapters) {
      for (const d of ch.citations?.dois?.unverified || []) unverifiedDois.push(d);
    }
    if (unverifiedDois.length > 0) {
      try {
        const verifications = await verifyDoisBatch(unverifiedDois, {
          timeoutMs: Number(process.env.THESIS_DOI_VERIFY_TIMEOUT_MS) || 5_000,
          concurrency: 5,
          fetcher: deps.fetcher,
        });
        for (const ch of chapters) {
          const dois = ch.citations?.dois || { verified: [], unverified: [] };
          const stillUnverified = [];
          const reclassified = [];
          for (const doi of dois.unverified) {
            const v = verifications.get(doi);
            if (v && v.ok) {
              reclassified.push(doi);
              // Drop the marker we previously appended right after this DOI.
              const escaped = doi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const markerEscaped = '\\[no verificado\\]';
              const re = new RegExp(`(${escaped})\\s+${markerEscaped}`, 'gi');
              ch.content = ch.content.replace(re, '$1');
            } else {
              stillUnverified.push(doi);
            }
          }
          if (reclassified.length > 0) {
            ch.citations.dois.verified = [...dois.verified, ...reclassified];
            ch.citations.dois.unverified = stillUnverified;
            ch.citations.externallyVerifiedDois = reclassified;
            ch.citations.totalVerified += reclassified.length;
            ch.citations.totalUnverified -= reclassified.length;
            externallyVerified += reclassified.length;
            totalUnverified -= reclassified.length;
            totalVerified += reclassified.length;
          }
        }
        emit({ type: 'crossref-verify', checked: unverifiedDois.length, externallyVerified });
      } catch (err) {
        // Network-wide failure (no fetch at all, etc.) — log via the event
        // stream but don't fail the pipeline; the offline verification is
        // already complete and is the source of truth.
        emit({ type: 'crossref-verify', checked: unverifiedDois.length, error: err?.message || 'fetch_failed' });
      }
    }
  }

  // Hallucination guard. Anything above the configured threshold (default
  // 30%) of unverified citations is a strong signal the LLM is making
  // sources up. Surface the warning so the route can short-circuit or
  // the UI can render an honest disclaimer.
  const totalCitations = totalUnverified + totalVerified;
  const unverifiedRate = totalCitations > 0 ? totalUnverified / totalCitations : 0;
  const threshold = hallucinationThreshold();
  const hallucinationWarning = strict && unverifiedRate > threshold
    ? {
        level: 'critical',
        unverifiedRate: Number(unverifiedRate.toFixed(4)),
        threshold,
        totalUnverified,
        totalCitations,
        message:
          `${(unverifiedRate * 100).toFixed(0)}% de las citas no se verificaron contra la lista de referencias` +
          `${onlineFallback ? ' ni contra CrossRef' : ''}. Revisa cada cita antes de presentar el documento.`,
      }
    : null;

  emit({
    type: 'citations',
    strict,
    totalUnverified,
    totalVerified,
    externallyVerified,
    unverifiedRate: Number(unverifiedRate.toFixed(4)),
    hallucinationWarning,
  });

  const planValidation = validateChapterPlan(
    chapters.map((c) => ({
      id: c.id,
      title: c.title,
      content: c.content,
      minWords: getTemplate(c.id)?.minWords,
      maxWords: getTemplate(c.id)?.maxWords,
    })),
  );

  emit({ type: 'phase', phase: 'done', percent: 100 });
  return {
    topic,
    references,
    chapters,
    planValidation,
    templates: listTemplates(),
    citationVerification: {
      strict,
      onlineFallback,
      totalUnverified,
      totalVerified,
      externallyVerified,
      unverifiedRate: Number(unverifiedRate.toFixed(4)),
      hallucinationWarning,
    },
  };
}

module.exports = {
  MIN_YEAR,
  filterVerifiedPapers,
  researchPhase,
  buildReferences,
  structurePhase,
  runThesisPipeline,
};
