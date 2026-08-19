'use strict';

const { normaliseDoi } = require('./source-integrity');
const { normaliseText } = require('./research-library');

function names(reference) {
  return (Array.isArray(reference.authors) ? reference.authors : [])
    .map((author) => typeof author === 'string' ? author : author?.name)
    .filter(Boolean);
}

function identity(reference) {
  return normaliseDoi(reference?.doi).toLowerCase() || `${normaliseText(reference?.title)}|${reference?.year || ''}`;
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const error = new Error(`reference_manager_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function zoteroCreators(reference) {
  return names(reference).map((name) => {
    const parts = String(name).trim().split(/\s+/);
    return {
      creatorType: 'author',
      firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : '',
      lastName: parts[parts.length - 1] || name,
    };
  });
}

function zoteroItem(reference, collectionKey) {
  return {
    itemType: 'journalArticle',
    title: reference.title,
    creators: zoteroCreators(reference),
    abstractNote: reference.abstract || '',
    publicationTitle: reference.venue || '',
    date: reference.year ? String(reference.year) : '',
    DOI: normaliseDoi(reference.doi) || '',
    url: reference.url || '',
    tags: (reference.tags || []).map((tag) => ({ tag })),
    collections: collectionKey ? [collectionKey] : [],
  };
}

async function syncToZotero(references, options = {}) {
  const { apiKey, userId, collectionKey: requestedCollectionKey, collectionName = 'SiraGPT' } = options;
  if (!apiKey || !userId) throw new Error('zotero_credentials_required');
  const fetchImpl = options.fetchImpl || global.fetch;
  const prefix = `https://api.zotero.org/users/${encodeURIComponent(userId)}`;
  const headers = { 'Zotero-API-Key': apiKey, 'Zotero-API-Version': '3', 'Content-Type': 'application/json' };
  let collectionKey = requestedCollectionKey || null;
  if (!collectionKey) {
    const created = await requestJson(fetchImpl, `${prefix}/collections`, {
      method: 'POST', headers: { ...headers, 'Zotero-Write-Token': `siragpt-${Date.now()}` },
      body: JSON.stringify([{ name: collectionName, parentCollection: false }]),
    });
    collectionKey = created?.successful?.['0']?.key || created?.successful?.[0]?.key || null;
  }
  if (!collectionKey) throw new Error('zotero_collection_create_failed');
  const existing = await requestJson(fetchImpl, `${prefix}/items?format=json&itemType=journalArticle&limit=100`, { headers });
  const known = new Map((Array.isArray(existing) ? existing : []).map((item) => [identity({
    doi: item?.data?.DOI,
    title: item?.data?.title,
    year: String(item?.data?.date || '').match(/\d{4}/)?.[0],
  }), item]).filter(([key]) => key));
  let linkedExisting = 0;
  const unique = (references || []).filter((reference) => {
    const key = identity(reference);
    const item = known.get(key);
    if (!key || item) return false;
    known.set(key, { pending: true });
    return true;
  });
  for (const reference of references || []) {
    const item = known.get(identity(reference));
    if (!item || item.pending || !item.key || item.data?.collections?.includes(collectionKey)) continue;
    await requestJson(fetchImpl, `${prefix}/items/${encodeURIComponent(item.key)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...item.data, collections: Array.from(new Set([...(item.data?.collections || []), collectionKey])) }),
    });
    linkedExisting += 1;
  }
  let createdCount = 0;
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50).map((reference) => zoteroItem(reference, collectionKey));
    const result = await requestJson(fetchImpl, `${prefix}/items`, {
      method: 'POST', headers: { ...headers, 'Zotero-Write-Token': `siragpt-${Date.now()}-${index}` },
      body: JSON.stringify(batch),
    });
    createdCount += Object.keys(result?.successful || {}).length;
  }
  return { provider: 'zotero', collectionKey, created: createdCount, linkedExisting, skippedDuplicates: (references || []).length - unique.length };
}

function mendeleyDocument(reference) {
  const identifiers = {};
  const doi = normaliseDoi(reference.doi);
  if (doi) identifiers.doi = doi;
  return {
    type: 'journal',
    title: reference.title,
    source: reference.venue || undefined,
    year: reference.year || undefined,
    abstract: reference.abstract || undefined,
    websites: reference.url ? [reference.url] : undefined,
    authors: names(reference).map((name) => ({ first_name: name.split(/\s+/).slice(0, -1).join(' '), last_name: name.split(/\s+/).slice(-1)[0] })),
    identifiers,
    tags: reference.tags || [],
  };
}

async function syncToMendeley(references, options = {}) {
  const { accessToken, folderId: requestedFolderId, folderName = 'SiraGPT' } = options;
  if (!accessToken) throw new Error('mendeley_credentials_required');
  const fetchImpl = options.fetchImpl || global.fetch;
  const base = 'https://api.mendeley.com';
  const documentHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.mendeley-document.1+json',
    'Content-Type': 'application/vnd.mendeley-document.1+json',
  };
  let folderId = requestedFolderId || null;
  if (!folderId) {
    const folder = await requestJson(fetchImpl, `${base}/folders`, {
      method: 'POST',
      headers: { ...documentHeaders, Accept: 'application/vnd.mendeley-folder.1+json', 'Content-Type': 'application/vnd.mendeley-folder.1+json' },
      body: JSON.stringify({ name: folderName }),
    });
    folderId = folder?.id || null;
  }
  if (!folderId) throw new Error('mendeley_folder_create_failed');
  const existing = await requestJson(fetchImpl, `${base}/documents?limit=500&view=all`, { headers: documentHeaders });
  const existingByIdentity = new Map((Array.isArray(existing) ? existing : []).map((document) => [identity({
    doi: document?.identifiers?.doi,
    title: document?.title,
    year: document?.year,
  }), document.id]));
  let created = 0;
  let skippedDuplicates = 0;
  for (const reference of references || []) {
    const key = identity(reference);
    let documentId = existingByIdentity.get(key);
    if (!documentId) {
      const document = await requestJson(fetchImpl, `${base}/documents`, {
        method: 'POST', headers: documentHeaders, body: JSON.stringify(mendeleyDocument(reference)),
      });
      documentId = document?.id;
      if (documentId) existingByIdentity.set(key, documentId);
      created += 1;
    } else skippedDuplicates += 1;
    if (folderId && documentId) {
      try {
        await requestJson(fetchImpl, `${base}/folders/${encodeURIComponent(folderId)}/documents`, {
          method: 'POST', headers: documentHeaders, body: JSON.stringify({ id: documentId }),
        });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }
  }
  return { provider: 'mendeley', folderId, created, skippedDuplicates };
}

module.exports = { identity, mendeleyDocument, syncToMendeley, syncToZotero, zoteroItem };
