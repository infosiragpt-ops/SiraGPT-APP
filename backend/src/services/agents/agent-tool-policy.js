const PRIVATE_ATTACHMENT_RE = /\b(adjunt[oa]s?|archivo(?:s)? cargad[oa]s?|documento(?:s)? cargad[oa]s?|segun (?:mis|el|los) archivo|segun (?:mis|el|los) documento|según (?:mis|el|los) archivo|según (?:mis|el|los) documento|este documento|esta tesis|pdf cargado|word cargado|docx cargado|mis archivos|mi proyecto)\b/i;

const EXPLICIT_EXTERNAL_RESEARCH_RE = /\b(?:web|internet|online|extern[ao]s?|fuentes externas|buscar afuera|busca afuera|noticias?|actual(?:es)?|actualidad|reciente(?:s)?|hoy|ahora|latest|current|doi|scopus|web of science|wos|openalex|crossref|pubmed|doaj|scielo|semantic scholar|papers?|art[ií]culos?|cient[ií]fic[oa]s?|acad[eé]mic[oa]s?)\b/i;

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function hasFiles(fileIds) {
  return Array.isArray(fileIds) && fileIds.filter(Boolean).length > 0;
}

function wantsExternalResearch(goal) {
  const raw = String(goal || '');
  return EXPLICIT_EXTERNAL_RESEARCH_RE.test(raw) || EXPLICIT_EXTERNAL_RESEARCH_RE.test(normalize(raw));
}

function isPrivateDocumentOnlyRequest({
  goal = '',
  fileIds = [],
  documentPolicy = null,
  executionProfile = null,
  universalTaskContract = null,
} = {}) {
  const raw = String(goal || '');
  const normalized = normalize(raw);
  const privateContext =
    hasFiles(fileIds) ||
    PRIVATE_ATTACHMENT_RE.test(raw) ||
    PRIVATE_ATTACHMENT_RE.test(normalized) ||
    Boolean(executionProfile?.capabilities?.needsPrivateContext) ||
    Boolean(universalTaskContract?.grounding_required && hasFiles(fileIds));

  if (!privateContext) return false;
  if (wantsExternalResearch(raw)) return false;
  if (documentPolicy?.mode && documentPolicy.mode !== 'chat_only' && documentPolicy.autoGenerate) return false;
  return true;
}

function buildForbiddenToolNames({
  baseForbidden = [],
  goal = '',
  fileIds = [],
  documentPolicy = null,
  executionProfile = null,
  universalTaskContract = null,
} = {}) {
  const forbidden = new Set(Array.isArray(baseForbidden) ? baseForbidden : []);
  if (documentPolicy?.mode === 'chat_only' && documentPolicy.autoGenerate === false) {
    forbidden.add('create_document');
    forbidden.add('verify_artifact');
    forbidden.add('create_document_when_not_requested');
  }
  if (isPrivateDocumentOnlyRequest({
    goal,
    fileIds,
    documentPolicy,
    executionProfile,
    universalTaskContract,
  })) {
    forbidden.add('web_search');
    forbidden.add('read_url');
    forbidden.add('scientific_search');
  }
  return forbidden;
}

function filterTaskTools(tools = [], options = {}) {
  const forbidden = buildForbiddenToolNames(options);
  return (Array.isArray(tools) ? tools : []).filter((tool) => tool && !forbidden.has(tool.name));
}

module.exports = {
  buildForbiddenToolNames,
  filterTaskTools,
  isPrivateDocumentOnlyRequest,
  wantsExternalResearch,
};
