'use strict';

/**
 * Resolve an agent-artifact binary to a local filesystem path.
 *
 * After R2 offload, `saveArtifact` unlinks the VM copy and leaves only
 * metadata + storageRef. Download already streams from R2; preview.pdf
 * used to 409 instead. This helper hydrates the object to a temp file so
 * LibreOffice (and native-PDF streaming) can read it.
 */

const fs = require('node:fs');
const path = require('node:path');
const objectStorage = require('../object-storage');

function readArtifactMetadata(id, artifactDir) {
  const metadataPath = path.join(artifactDir, `${id}.json`);
  try {
    if (!fs.existsSync(metadataPath)) return null;
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return null;
  }
}

function safeJoinArtifact(artifactDir, storedRelPath) {
  if (!storedRelPath) return null;
  const root = path.resolve(artifactDir);
  const candidate = path.resolve(artifactDir, storedRelPath);
  if (candidate === root || candidate.startsWith(root + path.sep)) return candidate;
  return null;
}

function resolveLocalArtifactPath(metadata, artifactDir, id) {
  if (metadata?.storedRelPath) {
    const candidate = safeJoinArtifact(artifactDir, metadata.storedRelPath);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    const entry = fs.readdirSync(artifactDir).find((f) => f.startsWith(`${id}-`));
    if (entry) {
      const full = path.join(artifactDir, entry);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    }
  } catch { /* listing best-effort */ }
  return null;
}

function inferFilename(metadata, localPath) {
  if (metadata?.filename) return metadata.filename;
  if (localPath) return path.basename(localPath).replace(/^[a-f0-9]{6,40}-/i, '');
  return 'artifact';
}

function inferFormat(filename, metadata) {
  const fromName = path.extname(String(filename || '')).slice(1).toLowerCase();
  if (fromName) return fromName;
  return String(metadata?.format || '').toLowerCase();
}

/**
 * @param {{ id: string, artifactDir: string, ownerUserId: string, storage?: object }} opts
 * @returns {Promise<{
 *   ok: true, sourcePath: string, cleanup: function, metadata: object,
 *   filename: string, format: string, fromR2: boolean, isPdf: boolean
 * } | { ok: false, status: number, error: string, reason?: string }>}
 */
async function materializeArtifactSource({
  id,
  artifactDir,
  ownerUserId,
  storage = objectStorage,
} = {}) {
  if (!id || !artifactDir) {
    return { ok: false, status: 400, error: 'bad id' };
  }
  if (!fs.existsSync(artifactDir)) {
    return { ok: false, status: 404, error: 'no artifacts yet' };
  }

  const metadata = readArtifactMetadata(id, artifactDir);
  if (!metadata?.ownerUserId) {
    return { ok: false, status: 403, error: 'artifact ownership metadata missing' };
  }
  if (String(metadata.ownerUserId) !== String(ownerUserId)) {
    return { ok: false, status: 403, error: 'artifact not found' };
  }

  const local = resolveLocalArtifactPath(metadata, artifactDir, id);
  if (local) {
    const filename = inferFilename(metadata, local);
    const format = inferFormat(filename, metadata);
    return {
      ok: true,
      sourcePath: local,
      cleanup: async () => {},
      metadata,
      filename,
      format,
      fromR2: false,
      isPdf: format === 'pdf' || /\.pdf$/i.test(filename),
    };
  }

  if (!metadata.storageRef) {
    return { ok: false, status: 404, error: 'artifact not found' };
  }

  try {
    const materialized = await storage.toLocalTemp(metadata.storageRef);
    const filename = inferFilename(metadata, materialized.path);
    const format = inferFormat(filename, metadata);
    return {
      ok: true,
      sourcePath: materialized.path,
      cleanup: typeof materialized.cleanup === 'function' ? materialized.cleanup : async () => {},
      metadata,
      filename,
      format,
      fromR2: true,
      isPdf: format === 'pdf' || /\.pdf$/i.test(filename),
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: 'artifact hydrate failed',
      reason: String(err?.message || err).slice(0, 160),
    };
  }
}

module.exports = {
  readArtifactMetadata,
  resolveLocalArtifactPath,
  materializeArtifactSource,
};
