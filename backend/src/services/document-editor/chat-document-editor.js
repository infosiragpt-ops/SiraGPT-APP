'use strict';

/**
 * Chat document editor — "edita mi documento" in /agentes.
 *
 * The model the user picked drives the whole edit: the OpenAI-compatible
 * client the chat resolved for that model runs the doc-agent tool loop inside
 * the isolated document sandbox (python-docx / openpyxl / python-pptx /
 * LibreOffice). Nothing here pins a provider or a model. Only a
 * provider-level failure of the picked model (auth, quota, rate limit, 5xx)
 * lets another configured provider finish the same loop, so an exhausted key
 * never leaves the user without their file.
 *
 * Sources: the documents attached to this turn; on a follow-up without
 * attachments, the most recent document of the conversation — an edited copy
 * delivered earlier wins over the original upload, so "ahora cambia X" keeps
 * iterating on the latest version.
 */

const fs = require('fs');
const path = require('path');

const EDITABLE_EXT_RE = /\.(?:docx?|xlsx?|xlsm|pptx?|pdf|csv|txt|md)$/i;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_SOURCES = 5;
const DOC_AGENT_MAX_ITERATIONS = 18;
const HISTORY_SCAN_MESSAGES = 40;
const ARTIFACT_ID_RE = /\/api\/agent\/artifact\/([a-f0-9]{6,40})/i;

const MIME_BY_EXT = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
});

class DocumentEditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocumentEditError';
    this.code = code;
  }
}

const MESSAGES = Object.freeze({
  NO_DOCUMENT: 'No encontré un documento para editar. Adjunta el Word, Excel, PowerPoint o PDF y vuelve a pedir el cambio.',
  FILE_TOO_LARGE: 'El documento es demasiado grande para editarlo (máximo 20 MB por archivo).',
  FILE_UNAVAILABLE: 'No pude leer el documento guardado. Vuelve a adjuntarlo y pide el cambio otra vez.',
  NO_VALID_OUTPUT: 'No pude entregar un archivo editado que superara la verificación. El documento original no se modificó; intenta describir el cambio con más detalle.',
  ENGINE_FAILED: 'El modelo seleccionado no pudo completar la edición. El documento original no se modificó; inténtalo de nuevo o elige otro modelo.',
});

function parseMessageFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  if (typeof files === 'string') {
    try {
      const parsed = JSON.parse(files);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function artifactIdFromRef(ref = {}) {
  const direct = String(ref.artifactId || '').trim();
  if (/^[a-f0-9]{6,40}$/i.test(direct)) return direct;
  const match = ARTIFACT_ID_RE.exec(String(ref.downloadUrl || ref.url || ''));
  return match ? match[1] : null;
}

function uploadIdFromRef(ref) {
  if (typeof ref === 'string') return ref.trim() || null;
  if (!ref || typeof ref !== 'object') return null;
  const id = ref.id || ref.fileId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function isEditableName(name) {
  return EDITABLE_EXT_RE.test(String(name || ''));
}

async function loadOwnedUploads(prisma, userId, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length || !prisma?.file?.findMany) return [];
  const rows = await prisma.file.findMany({
    where: { id: { in: unique }, userId },
    select: { id: true, filename: true, originalName: true, mimeType: true, size: true, path: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return unique
    .map((id) => byId.get(id))
    .filter((row) => row && isEditableName(row.originalName || row.filename))
    .map((row) => ({ kind: 'upload', name: row.originalName || row.filename, row }));
}

function readOwnedArtifactMetadata(artifactId, userId, deps) {
  const artifactDir = deps.artifactDir;
  const metadataPath = path.join(artifactDir, `${artifactId}.json`);
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return null;
  }
  if (!metadata || String(metadata.ownerUserId || '') !== String(userId)) return null;
  if (!isEditableName(metadata.filename)) return null;
  return metadata;
}

/**
 * Resolve which documents this turn edits. Explicit attachments win; a
 * follow-up scans the conversation newest-first and takes the latest document,
 * whether it was delivered by the assistant or uploaded by the user.
 */
async function resolveEditSources({ prisma, userId, chatId, fileIds = [], deps }) {
  const explicit = (Array.isArray(fileIds) ? fileIds : []).map(uploadIdFromRef).filter(Boolean);
  if (explicit.length) {
    return (await loadOwnedUploads(prisma, userId, explicit)).slice(0, MAX_SOURCES);
  }
  if (!chatId || !prisma?.message?.findMany) return [];
  const messages = await prisma.message.findMany({
    where: { chatId, deletedAt: null, chat: { userId } },
    select: { role: true, files: true },
    orderBy: { timestamp: 'desc' },
    take: HISTORY_SCAN_MESSAGES,
  });
  for (const message of messages) {
    const refs = parseMessageFiles(message.files);
    if (message.role === 'ASSISTANT') {
      for (const ref of refs) {
        const artifactId = artifactIdFromRef(ref);
        if (!artifactId) continue;
        const metadata = readOwnedArtifactMetadata(artifactId, userId, deps);
        if (metadata) return [{ kind: 'artifact', name: metadata.filename, artifactId, metadata }];
      }
      continue;
    }
    const uploads = await loadOwnedUploads(prisma, userId, deps.extractFileIds(message.files));
    if (uploads.length) return uploads.slice(0, 1);
  }
  return [];
}

async function readArtifactBuffer(source, deps) {
  const { metadata } = source;
  const root = path.resolve(deps.artifactDir);
  const candidates = [
    metadata.storedRelPath,
    // Legacy artifacts predate storedRelPath and live flat as <id>-<name>.
    `${source.artifactId}-${metadata.filename}`,
  ].filter(Boolean).map((rel) => path.resolve(root, rel));
  for (const candidate of candidates) {
    if (candidate.startsWith(root + path.sep) && fs.existsSync(candidate)) {
      return fs.promises.readFile(candidate);
    }
  }
  if (metadata.storageRef) {
    const local = await deps.objectStorage.toLocalTemp(metadata.storageRef);
    try {
      return await fs.promises.readFile(local.path);
    } finally {
      await local.cleanup().catch(() => {});
    }
  }
  throw new DocumentEditError('FILE_UNAVAILABLE', MESSAGES.FILE_UNAVAILABLE);
}

async function loadSourceFiles(sources, deps) {
  const files = [];
  let total = 0;
  for (const source of sources) {
    let buffer;
    try {
      if (source.kind === 'artifact') {
        buffer = await readArtifactBuffer(source, deps);
      } else {
        const read = await deps.readSourceBuffer(source.row);
        try { buffer = read.buffer; } finally { await read.cleanup().catch(() => {}); }
      }
    } catch (err) {
      if (err instanceof DocumentEditError) throw err;
      throw new DocumentEditError('FILE_UNAVAILABLE', MESSAGES.FILE_UNAVAILABLE);
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new DocumentEditError('FILE_UNAVAILABLE', MESSAGES.FILE_UNAVAILABLE);
    }
    total += buffer.length;
    if (buffer.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
      throw new DocumentEditError('FILE_TOO_LARGE', MESSAGES.FILE_TOO_LARGE);
    }
    files.push({ name: source.name, buffer });
  }
  return files;
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isTransientProviderError(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if (Number.isFinite(status)) return TRANSIENT_STATUSES.has(status);
  return /econnreset|etimedout|eai_again|socket hang up|fetch failed/i.test(String(err?.message || ''));
}

/** A brief provider hiccup (503, 429) retries the picked model before anything else takes over. */
function withTransientRetry(client, { retries = 2, baseDelayMs = 1500, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return {
    chat: {
      completions: {
        async create(payload, requestOptions) {
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await client.chat.completions.create(payload, requestOptions);
            } catch (err) {
              if (attempt >= retries || requestOptions?.signal?.aborted || !isTransientProviderError(err)) throw err;
              await wait(baseDelayMs * (attempt + 1));
            }
          }
        },
      },
    },
  };
}

/**
 * DeepSeek V4 thinking mode demands `reasoning_content` on assistant tool-call
 * turns it did not generate itself (e.g. after taking over from another
 * provider mid-loop); an empty value is accepted.
 */
function withDeepSeekToolTranscript(client) {
  return {
    chat: {
      completions: {
        create(payload = {}, requestOptions) {
          const messages = (payload.messages || []).map((message) => (
            message && message.role === 'assistant' && Array.isArray(message.tool_calls) && !('reasoning_content' in message)
              ? { ...message, reasoning_content: '' }
              : message
          ));
          return client.chat.completions.create({ ...payload, messages }, requestOptions);
        },
      },
    },
  };
}

/**
 * The picked model's client first; configured ladder providers only take over
 * on a provider-level failure of that client.
 */
function buildEditorClient({ client, model, provider, toolCallMode, deps }) {
  const pickedProvider = String(provider || '').trim().toLowerCase();
  const adapt = (base, providerName) => (String(providerName || '').toLowerCase() === 'deepseek' ? withDeepSeekToolTranscript(base) : base);
  const picked = withTransientRetry(
    adapt(toolCallMode === 'prompted' ? deps.createPromptedToolClient(client) : client, pickedProvider),
    { sleep: deps.sleep },
  );
  const ladder = deps.resolveDocAgentCandidates({ env: deps.env })
    .filter((candidate) => candidate.provider.toLowerCase() !== pickedProvider);
  const candidates = [{ provider: '__picked__', model }, ...ladder];
  return deps.createFailoverClient(candidates, {
    createClient: (candidate) => (candidate.provider === '__picked__'
      ? picked
      : adapt(deps.defaultCreateClient(candidate), candidate.provider)),
    onFailover: (info) => deps.onFailover(info),
  });
}

function stageFor(event) {
  switch (event?.type) {
    case 'sandbox_ready': return { label: 'Preparando el entorno de edición' };
    case 'phase':
      if (event.phase === 'inspect') return { label: 'Leyendo el documento' };
      if (event.phase === 'plan') return { label: 'Planificando los cambios' };
      if (event.phase === 'execute') return { label: event.attempt > 1 ? 'Corrigiendo la edición' : 'Editando el documento' };
      if (event.phase === 'validate') return { label: 'Verificando el archivo editado' };
      return null;
    case 'tool_call': return { label: 'Editando el documento', detail: String(event.preview || event.tool || '').slice(0, 160) };
    default: return null;
  }
}

/** The loop's final text talks about sandbox paths; the user only needs the change summary. */
function cleanSummary(text) {
  return String(text || '')
    .replace(/\s*(?:en|in)\s+`?\/workspace\/[^\s`]*[^\s`.,;:]`?/gi, '')
    .replace(/`?\/workspace\/(?:outputs|uploads)\/([^\s`]*[^\s`.,;:])`?/gi, '$1')
    .trim();
}

function extensionOf(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

/**
 * @returns {Promise<{ ok: true, artifacts: object[], summary: string } | { ok: false, code: string, message: string }>}
 */
async function runChatDocumentEdit({
  prisma,
  userId,
  chatId = null,
  fileIds = [],
  instruction,
  llm = {},
  signal,
  onEvent = () => {},
  deps: injected = {},
} = {}) {
  const deps = resolveDeps(injected);
  const emit = (stage) => { try { onEvent(stage); } catch { /* UI relay never breaks the edit */ } };
  try {
    const sources = await resolveEditSources({ prisma, userId, chatId, fileIds, deps });
    if (!sources.length) return { ok: false, code: 'NO_DOCUMENT', message: MESSAGES.NO_DOCUMENT };
    emit({ label: 'Abriendo el documento', detail: sources.map((source) => source.name).join(', ') });
    const files = await loadSourceFiles(sources, deps);

    const client = buildEditorClient({ ...llm, deps: { ...deps, onFailover: (info) => deps.log('failover', info) } });
    let result;
    try {
      result = await deps.runDocumentAgent({
        files,
        instruction,
        client,
        model: llm.model,
        signal,
        maxIterations: DOC_AGENT_MAX_ITERATIONS,
        onEvent: (event) => { const stage = stageFor(event); if (stage) emit(stage); },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      deps.log('engine_failed', { message: String(err?.message || err).slice(0, 200) });
      return { ok: false, code: 'ENGINE_FAILED', message: MESSAGES.ENGINE_FAILED };
    }

    const outputs = (result?.outputs || []).filter((out) => out && out.valid === true && Buffer.isBuffer(out.buffer) && out.buffer.length > 0);
    if (!outputs.length) return { ok: false, code: 'NO_VALID_OUTPUT', message: MESSAGES.NO_VALID_OUTPUT };

    const artifacts = outputs.map((out) => {
      const ext = extensionOf(out.name);
      const saved = deps.saveArtifact({
        filename: out.name,
        base64: out.buffer.toString('base64'),
        mime: MIME_BY_EXT[ext] || 'application/octet-stream',
        ownerUserId: userId,
        chatId,
        category: 'agent_artifact',
        validation: { passed: true, ...(out.changeReport ? { changes: out.changeReport } : {}) },
      });
      return {
        id: saved.id,
        filename: saved.filename,
        format: saved.format,
        mime: saved.mime,
        sizeBytes: saved.sizeBytes,
        downloadUrl: saved.downloadUrl,
      };
    });
    const names = artifacts.map((artifact) => artifact.filename).join(', ');
    const summary = cleanSummary(result.finalText) || `Listo. Apliqué los cambios y te dejo el archivo editado: ${names}.`;
    return { ok: true, artifacts, summary };
  } catch (err) {
    if (err instanceof DocumentEditError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}

/** Chat message `files` entries for the delivered documents (render as document cards). */
function toAssistantFiles(artifacts = []) {
  return artifacts.map((artifact) => ({
    type: 'doc',
    format: artifact.format,
    filename: artifact.filename,
    title: artifact.filename,
    artifactId: artifact.id,
    url: artifact.downloadUrl,
    downloadUrl: artifact.downloadUrl,
    mime: artifact.mime,
    size: artifact.sizeBytes,
  }));
}

function resolveDeps(injected) {
  const lazy = (key, load) => (injected[key] !== undefined ? injected[key] : load());
  return {
    env: lazy('env', () => process.env),
    artifactDir: lazy('artifactDir', () => require('../agents/task-tools').ARTIFACT_DIR),
    objectStorage: lazy('objectStorage', () => require('../object-storage')),
    readSourceBuffer: lazy('readSourceBuffer', () => require('../source-preserving-document-edit').readSourceBuffer),
    extractFileIds: lazy('extractFileIds', () => require('../message-attachments').extractFileIdsFromMessageFiles),
    saveArtifact: lazy('saveArtifact', () => require('../agents/task-tools').saveArtifact),
    runDocumentAgent: lazy('runDocumentAgent', () => require('../doc-agent').runDocumentAgent),
    createPromptedToolClient: lazy('createPromptedToolClient', () => require('./prompted-tool-client').createPromptedToolClient),
    resolveDocAgentCandidates: lazy('resolveDocAgentCandidates', () => require('../doc-agent/llm-runtime').resolveDocAgentCandidates),
    createFailoverClient: lazy('createFailoverClient', () => require('../doc-agent/llm-runtime').createFailoverClient),
    defaultCreateClient: lazy('defaultCreateClient', () => require('../doc-agent/llm-runtime').defaultCreateClient),
    sleep: injected.sleep,
    log: lazy('log', () => (event, details) => {
      try { console.warn(`[document-editor] ${event}`, JSON.stringify(details || {})); } catch { /* noop */ }
    }),
  };
}

module.exports = {
  runChatDocumentEdit,
  resolveEditSources,
  toAssistantFiles,
  cleanSummary,
  MESSAGES,
  INTERNAL: { buildEditorClient, stageFor, artifactIdFromRef, withTransientRetry, withDeepSeekToolTranscript },
};
