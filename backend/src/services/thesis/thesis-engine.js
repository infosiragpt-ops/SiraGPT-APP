'use strict';

const scientificSearch = require('../scientific-search');
const { referenceEntry } = require('../marco-teorico/apa7');
const { getTemplate, listTemplates } = require('./chapter-templates');
const { validateWordCount, validateChapterPlan } = require('./word-count-validator');
const { markUnverified, strictModeEnabled } = require('./citation-verifier');

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
    const raw = await generateChapter({
      template: tpl,
      topic,
      references,
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
    chapters.push({
      id: tpl.id,
      title: tpl.title,
      content,
      validation,
      citations: citationReport,
    });
    emit({ type: 'chapter', id: tpl.id, words: validation.words, ok: validation.ok, unverifiedCitations: citationReport.totalUnverified });
  }
  emit({ type: 'citations', strict, totalUnverified, totalVerified: chapters.reduce((s, c) => s + (c.citations?.totalVerified || 0), 0) });

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
      totalUnverified,
      totalVerified: chapters.reduce((s, c) => s + (c.citations?.totalVerified || 0), 0),
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
