'use strict';

const scientificSearch = require('../scientific-search');
const { createNotification } = require('../user-notifications');

const SCHEDULES = new Set(['manual', 'daily', 'weekly']);
const SORTS = new Set(['relevance', 'date', 'citations', 'evidence', 'access']);

function boundedInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function uniqueStrings(values, max = 20) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))).slice(0, max);
}

function normalizeSavedSearchFilters(input = {}) {
  const filters = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const currentYear = new Date().getUTCFullYear() + 1;
  const yearFrom = filters.yearFrom == null || filters.yearFrom === ''
    ? null
    : boundedInt(filters.yearFrom, 1800, currentYear, null);
  const yearTo = filters.yearTo == null || filters.yearTo === ''
    ? null
    : boundedInt(filters.yearTo, 1800, currentYear, null);
  return {
    yearFrom,
    yearTo,
    openAccess: typeof filters.openAccess === 'boolean' ? filters.openAccess : null,
    peerReviewed: typeof filters.peerReviewed === 'boolean' ? filters.peerReviewed : null,
    studyTypes: uniqueStrings(filters.studyTypes),
    providers: uniqueStrings(filters.providers, 10).filter((provider) => scientificSearch.PROVIDERS.includes(provider)),
    sort: SORTS.has(filters.sort) ? filters.sort : 'relevance',
    limit: boundedInt(filters.limit, 1, 50, 25),
  };
}

function paperIdentity(paper = {}) {
  const doi = String(paper.doi || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  if (doi) return `doi:${doi}`;
  const title = String(paper.title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return title ? `title:${title}|${Number(paper.year) || ''}` : '';
}

function evidenceScore(paper = {}) {
  const study = String(paper.studyType || '').toLowerCase();
  const design = /meta|systematic/.test(study) ? 5
    : /random|\brct\b/.test(study) ? 4
      : /cohort/.test(study) ? 3
        : /case.control/.test(study) ? 2
          : 1;
  const peer = ['confirmed', 'likely_peer_reviewed'].includes(String(paper.peerReviewStatus || '')) ? 2 : 0;
  const integrity = ['retracted', 'withdrawn'].includes(String(paper.integrityStatus || '')) ? -10
    : String(paper.integrityStatus || '') === 'expression_of_concern' ? -4 : 1;
  return design + peer + integrity;
}

function applySavedSearchFilters(papers, rawFilters = {}) {
  const filters = normalizeSavedSearchFilters(rawFilters);
  const allowedProviders = new Set(filters.providers);
  const allowedStudies = new Set(filters.studyTypes);
  const filtered = (Array.isArray(papers) ? papers : []).filter((paper) => {
    const year = Number(paper?.year) || null;
    if (filters.yearFrom && (!year || year < filters.yearFrom)) return false;
    if (filters.yearTo && (!year || year > filters.yearTo)) return false;
    if (filters.openAccess === true && paper?.openAccess !== true) return false;
    if (filters.openAccess === false && paper?.openAccess === true) return false;
    if (filters.peerReviewed === true && !['confirmed', 'likely_peer_reviewed'].includes(String(paper?.peerReviewStatus || ''))) return false;
    if (filters.peerReviewed === false && ['confirmed', 'likely_peer_reviewed'].includes(String(paper?.peerReviewStatus || ''))) return false;
    if (allowedStudies.size && !allowedStudies.has(String(paper?.studyType || '').toLowerCase())) return false;
    if (allowedProviders.size) {
      const providers = [paper?.source, ...(Array.isArray(paper?.sources) ? paper.sources : [])]
        .map((provider) => String(provider || '').toLowerCase());
      if (!providers.some((provider) => allowedProviders.has(provider))) return false;
    }
    return true;
  });

  const sorted = filtered.map((paper, index) => ({ paper, index })).sort((left, right) => {
    if (filters.sort === 'date') return (Number(right.paper.year) || 0) - (Number(left.paper.year) || 0) || left.index - right.index;
    if (filters.sort === 'citations') return (Number(right.paper.citations ?? right.paper.citationCount) || 0) - (Number(left.paper.citations ?? left.paper.citationCount) || 0) || left.index - right.index;
    if (filters.sort === 'evidence') return evidenceScore(right.paper) - evidenceScore(left.paper) || left.index - right.index;
    if (filters.sort === 'access') {
      const access = (paper) => (paper.openAccess === true ? 2 : 0) + (paper.pdfUrl ? 1 : 0);
      return access(right.paper) - access(left.paper) || left.index - right.index;
    }
    return left.index - right.index;
  }).map(({ paper }) => paper);
  return sorted.slice(0, filters.limit);
}

function nextRunForSchedule(schedule, from = new Date()) {
  if (!SCHEDULES.has(schedule) || schedule === 'manual') return null;
  const days = schedule === 'weekly' ? 7 : 1;
  return new Date(new Date(from).getTime() + days * 24 * 60 * 60 * 1000);
}

async function executeSavedSearch(prisma, savedSearch, options = {}) {
  if (!savedSearch || savedSearch.kind !== 'scientific') {
    const error = new Error('scientific_saved_search_required');
    error.code = 'scientific_saved_search_required';
    throw error;
  }
  const filters = normalizeSavedSearchFilters(savedSearch.filters || {});
  const searchImpl = options.searchImpl || scientificSearch.search;
  const now = options.now instanceof Date ? options.now : new Date();
  const result = await searchImpl(savedSearch.query, {
    providers: filters.providers.length ? filters.providers : undefined,
    limit: filters.limit,
    timeoutMs: 8_000,
    diversify: filters.sort === 'relevance',
    unpaywall: filters.openAccess === true,
  });
  const papers = applySavedSearchFilters(result?.papers, filters);
  const identities = papers.map(paperIdentity).filter(Boolean);
  const previous = new Set(Array.isArray(savedSearch.resultIdentities) ? savedSearch.resultIdentities : []);
  const baseline = !savedSearch.lastRunAt;
  const newPapers = baseline ? [] : papers.filter((paper) => {
    const identity = paperIdentity(paper);
    return identity && !previous.has(identity);
  });
  const updated = await prisma.savedSearch.update({
    where: { id: savedSearch.id },
    data: {
      filters,
      lastRunAt: now,
      nextRunAt: savedSearch.active ? nextRunForSchedule(savedSearch.schedule, now) : null,
      lastResultCount: papers.length,
      lastNewCount: newPapers.length,
      resultIdentities: identities,
      lastError: null,
    },
  });
  if (newPapers.length && savedSearch.notifyInApp !== false) {
    await createNotification(prisma, {
      userId: savedSearch.userId,
      type: 'research_alert',
      title: `${newPapers.length} artículo${newPapers.length === 1 ? '' : 's'} nuevo${newPapers.length === 1 ? '' : 's'}`,
      message: `La búsqueda “${savedSearch.name}” encontró literatura nueva.`,
      severity: 'info',
      metadata: {
        savedSearchId: savedSearch.id,
        query: savedSearch.query,
        newCount: newPapers.length,
        route: '/chat',
      },
    });
  }
  return {
    savedSearch: updated,
    papers,
    newPapers,
    errors: Array.isArray(result?.errors) ? result.errors : [],
    providers: Array.isArray(result?.providers) ? result.providers : [],
    baseline,
  };
}

async function runDueSavedSearches(prisma, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const limit = boundedInt(options.limit, 1, 50, 10);
  const searches = await prisma.savedSearch.findMany({
    where: {
      kind: 'scientific',
      active: true,
      schedule: { in: ['daily', 'weekly'] },
      nextRunAt: { lte: now },
    },
    orderBy: { nextRunAt: 'asc' },
    take: limit,
  });
  let completed = 0;
  let failed = 0;
  let newPapers = 0;
  for (const savedSearch of searches) {
    try {
      const result = await executeSavedSearch(prisma, savedSearch, { ...options, now });
      completed += 1;
      newPapers += result.newPapers.length;
    } catch (error) {
      failed += 1;
      await prisma.savedSearch.update({
        where: { id: savedSearch.id },
        data: {
          lastRunAt: now,
          nextRunAt: nextRunForSchedule(savedSearch.schedule, now),
          lastError: String(error?.message || error).slice(0, 2000),
        },
      }).catch(() => {});
    }
  }
  return { due: searches.length, completed, failed, newPapers };
}

module.exports = {
  SCHEDULES,
  applySavedSearchFilters,
  evidenceScore,
  executeSavedSearch,
  nextRunForSchedule,
  normalizeSavedSearchFilters,
  paperIdentity,
  runDueSavedSearches,
};
