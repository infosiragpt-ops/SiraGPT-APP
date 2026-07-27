'use strict';

const { detectStudyType } = require('./evidence-extractor');

const PREPRINT_SOURCES = new Set(['arxiv', 'biorxiv', 'medrxiv']);
const JOURNAL_SOURCES = new Set(['pubmed', 'europepmc', 'scielo', 'doaj']);
const INTEGRITY_PRIORITY = Object.freeze({
  unknown: 0,
  clear: 1,
  corrected: 2,
  expression_of_concern: 3,
  withdrawn: 4,
  retracted: 5,
});

const UPDATE_STATUS = Object.freeze({
  correction: 'corrected',
  corrigendum: 'corrected',
  erratum: 'corrected',
  addendum: 'corrected',
  expression_of_concern: 'expression_of_concern',
  'expression-of-concern': 'expression_of_concern',
  partial_retraction: 'retracted',
  'partial-retraction': 'retracted',
  retraction: 'retracted',
  removal: 'withdrawn',
  withdrawal: 'withdrawn',
  withdrawn: 'withdrawn',
});

function normaliseDoi(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
}

function doiStatus(value) {
  const doi = normaliseDoi(value);
  if (!doi) return 'missing';
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? 'format_valid' : 'format_invalid';
}

function stringsFrom(value, out = [], includeKeys = false) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsFrom(item, out, includeKeys);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (includeKeys) out.push(key);
      stringsFrom(item, out, includeKeys);
    }
  }
  return out;
}

function updateTypes(item) {
  const raw = item && typeof item.raw === 'object' ? item.raw : {};
  const candidates = [
    raw['update-to'], raw.updateTo, raw.update_to, raw.relation,
    item && item['update-to'], item && item.updateTo, item && item.relation,
  ];
  return stringsFrom(candidates, [], true)
    .map((value) => value.toLowerCase().trim().replace(/\s+/g, '_'))
    .filter(Boolean);
}

function detectIntegrityStatus(item = {}) {
  const raw = item.raw && typeof item.raw === 'object' ? item.raw : {};
  if (item.isRetracted === true || item.retracted === true || raw.is_retracted === true || raw.isRetracted === true || raw.retracted === true) {
    return 'retracted';
  }
  if (item.withdrawn === true || raw.withdrawn === true) return 'withdrawn';

  let status = 'unknown';
  for (const value of updateTypes(item)) {
    for (const [needle, mapped] of Object.entries(UPDATE_STATUS)) {
      if (value.includes(needle) && INTEGRITY_PRIORITY[mapped] > INTEGRITY_PRIORITY[status]) status = mapped;
    }
  }

  if (status !== 'unknown') return status;
  if (raw.is_retracted === false || item.isRetracted === false) return 'clear';
  return 'unknown';
}

function rawTypes(item = {}) {
  const raw = item.raw && typeof item.raw === 'object' ? item.raw : {};
  return stringsFrom([
    item.type, item.subtype, item.publicationType, item.publicationTypes,
    raw.type, raw.subtype, raw.publicationType, raw.publicationTypes,
  ]).map((value) => value.toLowerCase().replace(/[\s_]+/g, '-'));
}

function detectPublicationStage(item = {}) {
  const sources = new Set([
    item.source,
    ...(Array.isArray(item.sources) ? item.sources : []),
  ].filter(Boolean).map((value) => String(value).toLowerCase()));
  const types = rawTypes(item);

  if ([...sources].some((source) => PREPRINT_SOURCES.has(source)) || types.some((type) => /preprint|posted-content/.test(type))) {
    return 'preprint';
  }
  if (types.some((type) => /dissertation|thesis/.test(type))) return 'thesis';
  if (types.some((type) => /dataset/.test(type))) return 'dataset';
  if (types.some((type) => /proceeding|conference/.test(type))) return 'conference_paper';
  if (
    item.journal || item.venue ||
    types.some((type) => /journal-article|article|review/.test(type)) ||
    [...sources].some((source) => JOURNAL_SOURCES.has(source))
  ) return 'published_article';
  return 'unknown';
}

function detectPeerReviewStatus(item = {}, publicationStage = detectPublicationStage(item)) {
  const raw = item.raw && typeof item.raw === 'object' ? item.raw : {};
  const explicit = item.peerReviewed ?? item.peer_reviewed ?? raw.peerReviewed ?? raw.peer_reviewed;
  if (explicit === true) return 'confirmed';
  if (explicit === false || publicationStage === 'preprint') return 'not_peer_reviewed';
  if (publicationStage === 'published_article') return 'likely_peer_reviewed';
  return 'unknown';
}

function normaliseStudyType(value) {
  const clean = String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return clean || 'unknown';
}

function integrityAlerts(status) {
  if (status === 'retracted') return ['retracted'];
  if (status === 'withdrawn') return ['withdrawn'];
  if (status === 'expression_of_concern') return ['expression_of_concern'];
  if (status === 'corrected') return ['corrected'];
  return [];
}

function annotateSource(item = {}) {
  const publicationStage = item.publicationStage || detectPublicationStage(item);
  const integrityStatus = item.integrityStatus || detectIntegrityStatus(item);
  const studyType = item.studyType && item.studyType !== 'unknown'
    ? normaliseStudyType(item.studyType)
    : detectStudyType(`${item.title || ''} ${item.abstract || ''}`);
  return {
    ...item,
    doiStatus: item.doiStatus || doiStatus(item.doi),
    publicationStage,
    peerReviewStatus: item.peerReviewStatus || detectPeerReviewStatus(item, publicationStage),
    studyType: normaliseStudyType(studyType),
    integrityStatus,
    integrityAlerts: Array.from(new Set([
      ...(Array.isArray(item.integrityAlerts) ? item.integrityAlerts : []),
      ...integrityAlerts(integrityStatus),
    ])),
  };
}

function passesIntegrityFilters(item = {}, filters = {}) {
  const source = item.integrityStatus ? item : annotateSource(item);
  if (!filters.includeRetracted && ['retracted', 'withdrawn'].includes(source.integrityStatus)) return false;
  if (filters.peerReviewedOnly && !['confirmed', 'likely_peer_reviewed'].includes(source.peerReviewStatus)) return false;
  if (filters.excludePreprints && source.publicationStage === 'preprint') return false;
  if (filters.studyTypeRequired && filters.studyType && source.studyType !== filters.studyType) return false;
  return true;
}

function strongerStatus(left, right) {
  return (INTEGRITY_PRIORITY[right] || 0) > (INTEGRITY_PRIORITY[left] || 0) ? right : left;
}

module.exports = {
  annotateSource,
  detectIntegrityStatus,
  detectPeerReviewStatus,
  detectPublicationStage,
  doiStatus,
  normaliseDoi,
  passesIntegrityFilters,
  strongerStatus,
  INTEGRITY_PRIORITY,
};
