'use strict';

const crypto = require('node:crypto');
const { normaliseDoi } = require('./source-integrity');

function normaliseText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleKeyFor(source) {
  return normaliseText(source?.title).slice(0, 500);
}

function identityKeyFor(source) {
  const doi = normaliseDoi(source?.doi || source?.DOI).toLowerCase();
  if (doi) return `doi:${doi.toLowerCase()}`;
  const basis = `${titleKeyFor(source)}|${Number(source?.year) || ''}`;
  return `title:${crypto.createHash('sha256').update(basis).digest('hex')}`;
}

function cleanString(value, max = 2000) {
  const clean = typeof value === 'string' ? value.trim() : '';
  return clean ? clean.slice(0, max) : null;
}

function normaliseAuthors(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((author) => {
    if (typeof author === 'string') return { name: cleanString(author, 300) };
    if (author && typeof author === 'object') {
      return {
        name: cleanString(author.name || author.display_name || author.fullName, 300),
        orcid: cleanString(author.orcid, 100),
      };
    }
    return null;
  }).filter((author) => author?.name);
}

function uniqueStrings(values, max = 50) {
  return Array.from(new Set((values || []).map((value) => cleanString(value, 120)).filter(Boolean))).slice(0, max);
}

function sourceToData(source, { userId, tags = [], note } = {}) {
  const doi = normaliseDoi(source?.doi || source?.DOI).toLowerCase();
  const title = cleanString(source?.title, 1000) || '(sin título)';
  const sourceNames = uniqueStrings([
    ...(Array.isArray(source?.sources) ? source.sources : []),
    source?.source,
  ]);
  return {
    userId,
    identityKey: identityKeyFor({ ...source, doi, title }),
    titleKey: titleKeyFor({ title }),
    doi,
    title,
    authors: normaliseAuthors(source?.authors),
    year: Number.isInteger(Number(source?.year)) ? Number(source.year) : null,
    venue: cleanString(source?.venue || source?.journal, 500),
    abstract: cleanString(source?.abstract, 20_000),
    url: cleanString(source?.doiResolvedUrl || source?.htmlUrl || source?.url, 2000),
    pdfUrl: cleanString(source?.pdfUrl, 2000),
    source: cleanString(source?.source, 120),
    sources: sourceNames,
    tags: uniqueStrings([...(Array.isArray(source?.tags) ? source.tags : []), ...tags]),
    note: cleanString(note, 10_000),
    citationCount: Number.isFinite(Number(source?.citations ?? source?.citationCount))
      ? Math.max(0, Math.trunc(Number(source.citations ?? source.citationCount)))
      : null,
    openAccess: typeof source?.openAccess === 'boolean' ? source.openAccess : null,
    publicationStage: cleanString(source?.publicationStage, 80),
    peerReviewStatus: cleanString(source?.peerReviewStatus, 80),
    studyType: cleanString(source?.studyType, 80),
    integrityStatus: cleanString(source?.integrityStatus, 80),
    metadata: source?.metadata && typeof source.metadata === 'object'
      ? source.metadata
      : {
          openAlexId: source?.openAlexId || (String(source?.url || '').includes('openalex.org/') ? source.url : null),
          referencedWorks: source?.referencedWorks || source?.referenced_works || [],
          relatedWorks: source?.relatedWorks || source?.related_works || [],
        },
  };
}

function richerText(current, incoming) {
  const a = cleanString(current, 20_000);
  const b = cleanString(incoming, 20_000);
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function mergeReferenceData(existing, incoming) {
  const authorsA = normaliseAuthors(existing?.authors);
  const authorsB = normaliseAuthors(incoming?.authors);
  return {
    doi: incoming.doi || existing.doi || null,
    title: richerText(existing.title, incoming.title),
    authors: authorsB.length > authorsA.length ? authorsB : authorsA,
    year: incoming.year || existing.year || null,
    venue: richerText(existing.venue, incoming.venue),
    abstract: richerText(existing.abstract, incoming.abstract),
    url: incoming.url || existing.url || null,
    pdfUrl: incoming.pdfUrl || existing.pdfUrl || null,
    source: incoming.source || existing.source || null,
    sources: uniqueStrings([...(existing.sources || []), ...(incoming.sources || [])]),
    tags: uniqueStrings([...(existing.tags || []), ...(incoming.tags || [])]),
    note: richerText(existing.note, incoming.note),
    metadata: { ...(existing.metadata || {}), ...(incoming.metadata || {}) },
    citationCount: Math.max(Number(existing.citationCount) || 0, Number(incoming.citationCount) || 0) || null,
    openAccess: incoming.openAccess === true || existing.openAccess === true ? true : (incoming.openAccess ?? existing.openAccess ?? null),
    publicationStage: incoming.publicationStage || existing.publicationStage || null,
    peerReviewStatus: incoming.peerReviewStatus || existing.peerReviewStatus || null,
    studyType: incoming.studyType || existing.studyType || null,
    integrityStatus: incoming.integrityStatus || existing.integrityStatus || null,
  };
}

async function ensureOwnedCollection(prisma, userId, {
  collectionId,
  collectionName,
  folder,
  tags = [],
  authorizedCollection = null,
} = {}) {
  if (authorizedCollection && (!collectionId || authorizedCollection.id === collectionId)) {
    return authorizedCollection;
  }
  if (collectionId) {
    return prisma.researchCollection.findFirst({ where: { id: collectionId, userId } });
  }
  const name = cleanString(collectionName, 160);
  if (!name) return null;
  return prisma.researchCollection.upsert({
    where: { userId_name: { userId, name } },
    update: {},
    create: { userId, name, folder: cleanString(folder, 160), tags: uniqueStrings(tags) },
  });
}

async function upsertSources(prisma, userId, sources, options = {}) {
  const collection = await ensureOwnedCollection(prisma, userId, options);
  if (options.collectionId && !collection) {
    const error = new Error('collection_not_found');
    error.code = 'collection_not_found';
    throw error;
  }
  const saved = [];
  const conflicts = [];
  let created = 0;
  let merged = 0;

  for (const source of Array.isArray(sources) ? sources.slice(0, 100) : []) {
    const data = sourceToData(source, { userId, tags: options.tags, note: options.note });
    const existing = await prisma.researchReference.findUnique({
      where: { userId_identityKey: { userId, identityKey: data.identityKey } },
    });
    let reference;
    if (existing) {
      reference = await prisma.researchReference.update({
        where: { id: existing.id },
        data: mergeReferenceData(existing, data),
      });
      merged += 1;
    } else {
      reference = await prisma.researchReference.create({ data });
      created += 1;
      const titleMatches = await prisma.researchReference.findMany({
        where: { userId, titleKey: data.titleKey, status: 'active', id: { not: reference.id } },
        take: 5,
      });
      for (const titleMatch of titleMatches) {
        if (titleMatch.doi && reference.doi && titleMatch.doi !== reference.doi) {
          const conflict = await prisma.researchReferenceConflict.upsert({
            where: {
              userId_existingReferenceId_candidateReferenceId: {
                userId,
                existingReferenceId: titleMatch.id,
                candidateReferenceId: reference.id,
              },
            },
            update: {},
            create: {
              userId,
              existingReferenceId: titleMatch.id,
              candidateReferenceId: reference.id,
              reason: 'same_normalized_title_conflicting_doi',
            },
          });
          conflicts.push(conflict);
        }
      }
    }
    if (collection) {
      await prisma.researchCollectionItem.upsert({
        where: { collectionId_referenceId: { collectionId: collection.id, referenceId: reference.id } },
        update: {},
        create: { collectionId: collection.id, referenceId: reference.id },
      });
    }
    saved.push(reference);
  }
  return { references: saved, collection, created, merged, conflicts: conflicts.length };
}

async function resolveConflict(prisma, userId, conflictId, action) {
  const conflict = await prisma.researchReferenceConflict.findFirst({
    where: { id: conflictId, userId, status: 'pending' },
    include: {
      existing: { include: { collectionItems: true } },
      candidate: { include: { collectionItems: true } },
    },
  });
  if (!conflict) return null;
  const keepCandidate = action === 'keep_candidate';
  const winner = keepCandidate ? conflict.candidate : conflict.existing;
  const loser = keepCandidate ? conflict.existing : conflict.candidate;
  const winnerData = action === 'merge'
    ? { ...mergeReferenceData(winner, loser), doi: winner.doi || null }
    : {};

  await prisma.$transaction(async (tx) => {
    if (action === 'merge') await tx.researchReference.update({ where: { id: winner.id }, data: winnerData });
    for (const item of loser.collectionItems || []) {
      await tx.researchCollectionItem.upsert({
        where: { collectionId_referenceId: { collectionId: item.collectionId, referenceId: winner.id } },
        update: {},
        create: { collectionId: item.collectionId, referenceId: winner.id, position: item.position || 0 },
      });
    }
    await tx.researchReference.update({
      where: { id: loser.id },
      data: { status: action === 'merge' ? 'merged' : 'duplicate_rejected', metadata: { ...(loser.metadata || {}), duplicateOf: winner.id } },
    });
    await tx.researchReferenceConflict.update({
      where: { id: conflict.id },
      data: { status: 'resolved', resolvedAt: new Date(), resolution: { action, winnerId: winner.id, loserId: loser.id } },
    });
  });
  return { action, winnerId: winner.id, loserId: loser.id };
}

module.exports = {
  identityKeyFor,
  mergeReferenceData,
  normaliseAuthors,
  normaliseText,
  resolveConflict,
  sourceToData,
  titleKeyFor,
  uniqueStrings,
  upsertSources,
};
