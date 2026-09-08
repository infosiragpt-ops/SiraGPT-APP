'use strict';

/**
 * Hermes → Biblioteca deposit.
 *
 * Adapted from NousResearch/hermes-agent (MIT) curator reports
 * (`logs/curator/REPORT.md`) — not a dump of the Python module:
 *   https://github.com/NousResearch/hermes-agent
 *
 * Pattern adopted:
 *   - Skill / curator reports land as durable artifacts, not chat-only text
 *   - Owner-scoped: user B never sees user A's deposits
 *   - brand_label stays a SiraGPT product name (never a vendor / model_id)
 */

const BRAND_LABEL = 'SiraGPT';
const MAX_BODY_CHARS = 80_000;
const SAFE_TITLE = /[^a-zA-Z0-9._-]+/g;

function taskTools() {
  return require('./task-tools');
}

function normalizeUserId(userId) {
  const id = String(userId || '').trim();
  return id || null;
}

function safeFilename(title, ext = 'md') {
  const stem = String(title || 'biblioteca-artifact')
    .replace(SAFE_TITLE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'biblioteca-artifact';
  return `${stem}.${ext}`;
}

function deposit({ userId, chatId, title, body, kind, save } = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: 'userId required' };
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'body cannot be empty' };
  if (text.length > MAX_BODY_CHARS) {
    return { ok: false, error: `body exceeds ${MAX_BODY_CHARS} chars` };
  }

  const filename = safeFilename(title);
  const saveArtifact = typeof save === 'function' ? save : taskTools().saveArtifact;
  const artifact = saveArtifact({
    filename,
    base64: Buffer.from(text, 'utf8').toString('base64'),
    mime: 'text/markdown',
    ownerUserId: id,
    chatId: chatId || null,
    category: 'document',
    brandLabel: BRAND_LABEL,
    kind: kind || 'document',
  });

  return {
    ok: true,
    asset_id: artifact.id,
    kind: artifact.kind || kind || 'document',
    brand_label: BRAND_LABEL,
    filename: artifact.filename,
    downloadUrl: artifact.downloadUrl,
    chatId: chatId || null,
    userId: id,
  };
}

function listForUser(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return [];
  const listArtifactsByOwner = typeof opts.list === 'function'
    ? opts.list
    : taskTools().listArtifactsByOwner;
  return listArtifactsByOwner(id, {
    categories: opts.categories || ['document'],
    max: opts.max || 200,
  });
}

module.exports = {
  BRAND_LABEL,
  MAX_BODY_CHARS,
  deposit,
  listForUser,
};
