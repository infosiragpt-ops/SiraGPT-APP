'use strict';

// Shared source resolution for the image composer and the agent tools. An
// explicit target is binding: a missing target never becomes a different image.
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 8;
const MAX_REFERENCE_BYTES = 40 * 1024 * 1024;
const artifactIdFrom = (value) => String(value || '').match(/(?:^artifact:|\/api\/agent\/artifact\/)([a-f0-9]{6,64})(?:\b|$)/i)?.[1];
// Every artifact a message links, in document order: a turn that produced a
// chart AND an image must still yield the image (the first id alone skipped
// the whole message and fell back to an older picture).
const allArtifactIdsFrom = (value) => [...new Set(Array.from(String(value || '').matchAll(/\/api\/agent\/artifact\/([a-f0-9]{6,64})(?:\b|$)/gi), (match) => match[1]))];
const imageMime = (value) => /^image\/(png|jpeg|webp|gif|avif)$/i.test(String(value || ''));
function messageFiles(message) {
  try {
    const files = typeof message.files === 'string' ? JSON.parse(message.files) : message.files;
    return Array.isArray(files) ? files : [];
  } catch { return []; }
}

async function resolveImageSource({ fileId, imageUrl, fileIds } = {}, ctx = {}) {
  const { prisma, userId, chatId } = ctx;
  if (!userId) return null;
  if (chatId && prisma?.chat?.findFirst) {
    if (!await prisma.chat.findFirst({ where: { id: chatId, userId, deletedAt: null }, select: { id: true } })) return null;
  } else if (chatId && ctx.requireChatOwnership) return null;

  const fromRecord = async (record, metadata) => {
    if (!record?.path || record.deletedAt || Number(record.size) > MAX_IMAGE_BYTES || !imageMime(record.mimeType || 'image/png')) return null;
    let cleanup;
    try {
      const materialized = await require('../object-storage').toLocalTemp(record.path);
      cleanup = materialized.cleanup;
      const stat = await fs.stat(materialized.path);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
      const buffer = await fs.readFile(materialized.path);
      return buffer.length ? {
        buffer, mimeType: record.mimeType || 'image/png', fileId: record.id,
        source: record.originalName || record.filename, record, metadata,
      } : null;
    } catch { return null; }
    finally { if (cleanup) await cleanup(); }
  };
  const fromArtifact = async (id, metadata) => {
    if (!/^[a-f0-9]{6,64}$/i.test(id)) return null;
    const { materializeArtifactSource } = require('../agents/artifact-local-source');
    const artifactDir = ctx.artifactDir || process.env.AGENT_ARTIFACT_DIR || path.join(process.cwd(), 'uploads', 'agent-artifacts');
    const materialized = await materializeArtifactSource({ id, artifactDir, ownerUserId: userId });
    if (!materialized.ok) return null;
    try {
      if (materialized.metadata?.deletedAt || metadata?.deletedAt || !imageMime(materialized.metadata?.mime)) return null;
      if (chatId && materialized.metadata?.chatId && String(materialized.metadata.chatId) !== String(chatId)) return null;
      const stat = await fs.stat(materialized.sourcePath);
      if (stat.size > MAX_IMAGE_BYTES) return null;
      const buffer = await fs.readFile(materialized.sourcePath);
      return buffer.length ? { buffer, mimeType: materialized.metadata.mime, fileId: `artifact:${id}`, source: `artifact:${id}`, metadata: { ...materialized.metadata, ...metadata } } : null;
    } finally { await materialized.cleanup(); }
  };
  const fromId = async (id, metadata) => {
    if (!id) return null;
    const artifactId = artifactIdFrom(id);
    if (artifactId) return fromArtifact(artifactId, metadata);
    if (prisma?.file?.findFirst) {
      const record = await prisma.file.findFirst({ where: { id: String(id), userId, deletedAt: null } });
      if (record) return fromRecord(record, metadata);
    }
    // Agent artifact IDs are content hashes, not prisma File IDs.
    return /^[a-f0-9]{6,64}$/i.test(String(id)) ? fromArtifact(String(id), metadata) : null;
  };
  const fromUrl = async (value, metadata) => {
    const artifactId = artifactIdFrom(value);
    if (artifactId) return fromArtifact(artifactId, metadata);
    // Resolve upload URLs through their owned DB record; never read a caller
    // supplied filesystem path or fetch an arbitrary URL from chat history.
    const match = String(value || '').match(/(?:^|https?:\/\/[^/]+)\/uploads\/(?:images|[^/?#]+)\/([^/?#]+)(?:[?#].*)?$/);
    if (!match || !prisma?.file?.findFirst) return null;
    const record = await prisma.file.findFirst({ where: { filename: match[1], userId, deletedAt: null } });
    return fromRecord(record, metadata);
  };
  const history = async () => {
    if (!chatId || !prisma?.message?.findMany) return [];
    return prisma.message.findMany({ where: { chatId, deletedAt: null, ...(ctx.messageId ? { id: ctx.messageId } : {}) }, orderBy: { timestamp: 'desc' }, take: 100, select: { files: true, content: true } });
  };

  if (fileId) {
    const messages = await history();
    const matches = messages.flatMap(messageFiles).filter((file) => String(file.fileId || file.id) === String(fileId));
    const metadata = matches.find((file) => !file.deletedAt);
    if ((matches.length && !metadata) || (ctx.messageId && !metadata)) return null;
    return fromId(fileId, metadata);
  }
  if (imageUrl) {
    // Direct tool URL support is retained; canonical UI requests send fileId.
    const data = String(imageUrl).match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i);
    if (data) {
      if (data[2].length > MAX_IMAGE_BYTES * 4 / 3) return null;
      return { buffer: Buffer.from(data[2], 'base64'), mimeType: data[1], source: 'data-url' };
    }
    const local = await fromUrl(imageUrl);
    if (local || /\/uploads\/|\/api\/agent\/artifact\//.test(String(imageUrl))) return local;
    if (/^https?:\/\//i.test(imageUrl)) {
      let dispatcher;
      let response;
      try {
        const { assertSafeUrl, createPinnedDispatcher } = require('../agent-harness/tools/web-fetch-tool');
        const { resolveAndAssertSafe } = require('../connectors/web-fetch');
        const parsed = assertSafeUrl(imageUrl);
        // Validate every DNS address, then pin the connection to those exact
        // public addresses. A second resolver lookup must not reach a private
        // host after the initial safety check (DNS rebinding).
        const addresses = await resolveAndAssertSafe(parsed.hostname, ctx.lookup);
        dispatcher = createPinnedDispatcher(parsed.hostname, addresses);
        const fetchImage = ctx.fetch || require('undici').fetch;
        response = await fetchImage(imageUrl, { dispatcher, redirect: 'error', signal: ctx.signal || AbortSignal.timeout(15000) });
        if (!response.ok || !imageMime(response.headers.get('content-type')?.split(';')[0])) return null;
        if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) return null;
        const chunks = []; let total = 0;
        for await (const chunk of response.body) { total += chunk.length; if (total > MAX_IMAGE_BYTES) return null; chunks.push(chunk); }
        return total ? { buffer: Buffer.concat(chunks), mimeType: response.headers.get('content-type').split(';')[0], source: imageUrl } : null;
      } catch { return null; }
      finally {
        // Early MIME/size failures must release the body before closing the
        // dispatcher; otherwise a slow or infinite response can hold the job.
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        if (dispatcher) await dispatcher.close().catch(() => {});
      }
    }
    return null;
  }
  // Ids recovered from chat history are not this turn's attachments (see
  // resolveImageSources): the newest image in the chat is the default instead.
  const recovered = new Set((Array.isArray(ctx.recoveredFileIds) ? ctx.recoveredFileIds : []).map(String));
  const requested = (Array.isArray(fileIds) ? fileIds : ctx.fileIds);
  const freshAttachments = Array.isArray(requested) ? requested.filter((id) => !recovered.has(String(id))) : requested;
  if (Array.isArray(freshAttachments) && freshAttachments.length && prisma?.file?.findMany) {
    const records = await prisma.file.findMany({ where: { id: { in: freshAttachments.map(String) }, userId, deletedAt: null } });
    const image = freshAttachments.map((id) => records.find((record) => String(record.id) === String(id)))
      .find((record) => record && imageMime(record.mimeType));
    if (image) return fromRecord(image);
    return null;
  }
  // Files the caller rules out of the history scan: this turn's own
  // attachments when the "previous image" is wanted (on Regenerar or after
  // a triage clarification the user row with those files is already the
  // newest message in the chat).
  const excluded = new Set((Array.isArray(ctx.excludeFileIds) ? ctx.excludeFileIds : []).map(String));
  for (const message of await history()) {
    for (const file of messageFiles(message)) {
      if (!file || file.deletedAt || !(file.type === 'image' || imageMime(file.mimeType || file.mime || file.type))) continue;
      const id = file.fileId || file.id;
      if (excluded.size && (excluded.has(String(id)) || (artifactIdFrom(id) && excluded.has(`artifact:${artifactIdFrom(id)}`)))) continue;
      const resolved = await fromId(id, file) || await fromUrl(file.url || file.downloadUrl, file);
      if (resolved) return resolved;
    }
    for (const id of allArtifactIdsFrom(message.content)) {
      const hiddenArtifact = messageFiles(message).some((file) => file.deletedAt && (
        artifactIdFrom(file.fileId || file.id) === id || String(file.fileId || file.id) === id || artifactIdFrom(file.url || file.downloadUrl) === id
      ));
      if (hiddenArtifact || excluded.has(`artifact:${id}`)) continue;
      const resolved = await fromArtifact(id);
      if (resolved) return resolved;
    }
  }
  return null;
}

const sameSource = (a, b) => Boolean(a && b) && (String(a.fileId || '') === String(b.fileId || '')
  || (artifactIdFrom(a.fileId) && artifactIdFrom(a.fileId) === artifactIdFrom(b.fileId)));

/** Resolve every explicitly supplied reference in caller order. Never silently
 * drop a missing reference, or replace it with an unrelated historical image.
 *
 * `primaryFromHistory` (opt-in, by an explicit cue such as "ponle este logo a
 * la imagen anterior"): the chat's most recent image is the canvas and every
 * supplied id is a reference. Without a historical image the call behaves as
 * before, so the cue never costs the user their attachment. */
async function resolveImageSources({ fileId, referenceFileIds, imageUrl, primaryFromHistory = false } = {}, ctx = {}) {
  if (referenceFileIds !== undefined && referenceFileIds !== null && !Array.isArray(referenceFileIds)) {
    throw Object.assign(new Error('Las referencias de imagen no son válidas.'), { code: 'E_PARAMS', status: 400 });
  }
  // Agent tools receive the current turn's attachments in context. Include all
  // images automatically; documents are not image references. Keep unresolved
  // IDs so a missing/unowned attachment produces an error instead of vanishing.
  // Ids the loop recovered from chat history are NOT this turn's attachments:
  // they are skipped here so the newest image in the chat stays the default
  // canvas (an older upload used to displace the image just generated).
  const recovered = new Set((Array.isArray(ctx.recoveredFileIds) ? ctx.recoveredFileIds : []).map(String));
  const contextIds = Array.isArray(ctx.fileIds) ? ctx.fileIds.map(String) : [];
  const fresh = contextIds.filter((id) => !recovered.has(id));
  const imageIdsAmong = async (candidates) => {
    if (!candidates.length || !ctx.userId || !ctx.prisma?.file?.findMany) return candidates;
    const records = await ctx.prisma.file.findMany({ where: { id: { in: candidates }, userId: ctx.userId, deletedAt: null } });
    return candidates.filter((id) => {
      const record = records.find((entry) => String(entry.id) === id);
      return !record || imageMime(record.mimeType);
    });
  };
  if (ctx.userId && !referenceFileIds?.length && contextIds.length && ctx.prisma?.file?.findMany) {
    referenceFileIds = fresh.length ? await imageIdsAmong(fresh) : undefined;
    // «ponle este logo a la imagen anterior» after a clarification: the logo
    // is a recovered id, still the reference the cue names.
    if (!fresh.length && primaryFromHistory && !fileId) {
      const recoveredImages = await imageIdsAmong(contextIds.filter((id) => recovered.has(id)));
      if (recoveredImages.length) referenceFileIds = recoveredImages;
    }
  }
  if (Array.isArray(referenceFileIds)
    && referenceFileIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 160)) {
    throw Object.assign(new Error('Las referencias de imagen no son válidas.'), { code: 'E_PARAMS', status: 400 });
  }
  let ids = [...new Set([fileId, ...(referenceFileIds || [])].filter(Boolean))];
  const explicitUrl = !fileId && Boolean(imageUrl);
  if (ids.length + Number(explicitUrl) > MAX_REFERENCE_IMAGES) {
    throw Object.assign(new Error(`Puedes usar hasta ${MAX_REFERENCE_IMAGES} imágenes de referencia por edición.`), { code: 'E_PARAMS', status: 400 });
  }
  const sources = [];
  let bytes = 0;
  // An explicit fileId that is NOT one of this turn's attachments (the
  // composer lists its uploads in referenceFileIds too) is a canvas the user
  // chose (viewer «Editar»): the cue never demotes it to a reference.
  const explicitCanvas = Boolean(fileId) && !fresh.includes(String(fileId)) && !recovered.has(String(fileId))
    && !(Array.isArray(referenceFileIds) && referenceFileIds.map(String).includes(String(fileId)));
  if (primaryFromHistory && !explicitUrl && ids.length && !explicitCanvas) {
    // An empty `fileIds` bypasses the attachment branch of resolveImageSource;
    // the newest message in the chat wins (upload or generated artifact),
    // skipping the references themselves (already persisted on Regenerar).
    const previous = await resolveImageSource({}, { ...ctx, fileIds: [], excludeFileIds: ids });
    if (previous) {
      ids = ids.filter((id) => !sameSource({ fileId: id }, previous));
      if (ids.length + 1 + Number(explicitUrl) > MAX_REFERENCE_IMAGES) {
        throw Object.assign(new Error(`Puedes usar hasta ${MAX_REFERENCE_IMAGES} imágenes por edición contando la imagen anterior del chat.`), { code: 'E_PARAMS', status: 400 });
      }
      sources.push(previous);
      bytes += previous.buffer.length;
    }
  }
  const inputs = [...(explicitUrl ? [{ imageUrl }] : []), ...ids.map((id) => ({ fileId: id }))];
  if (!inputs.length && !sources.length) inputs.push({});
  for (const input of inputs) {
    const source = await resolveImageSource(input, ctx);
    if (!source) {
      if (!ids.length && !explicitUrl) return [];
      throw Object.assign(new Error('No pude abrir una de las imágenes de referencia. Vuelve a adjuntarla para continuar.'), { code: 'image_source_required', status: 400 });
    }
    bytes += source.buffer.length;
    if (bytes > MAX_REFERENCE_BYTES) {
      throw Object.assign(new Error('Las imágenes de referencia superan los 40 MB. Reduce su tamaño para continuar.'), { code: 'E_PARAMS', status: 400 });
    }
    sources.push(source);
  }
  if (sources.length > MAX_REFERENCE_IMAGES) {
    throw Object.assign(new Error(`Puedes usar hasta ${MAX_REFERENCE_IMAGES} imágenes de referencia por edición.`), { code: 'E_PARAMS', status: 400 });
  }
  return sources;
}

module.exports = { resolveImageSource, resolveImageSources, messageFiles, MAX_IMAGE_BYTES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_BYTES };
