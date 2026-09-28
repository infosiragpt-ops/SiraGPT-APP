'use strict';

/**
 * The display name the picker shows for the model of a turn — the name the
 * user reads in the honest failure copy («Grok 4.7 no pudo responder: …»).
 *
 * Sources, in the picker's own order:
 *   1. the user's own connection row (catalog.displayName) for that model;
 *   2. a name known without a DB read: the curated catalog, DeepSeek V4
 *      Flash / Pro, SiraGPT Mini, the free tier (turn-progress.displayNameFor
 *      — never a prettified raw id or a transport name);
 *   3. the admin row the picker lists (publicPickerModel): the row the
 *      caller already fetched for this turn (`catalogRow`, e.g. the route's
 *      resolveCustomConnectionForTurn catalog), else an active-row read
 *      bounded by a short timeout so the lookup never delays the turn.
 * Returns '' when none is a real name: the copy then says «El modelo
 * elegido». Never a raw model id, never OpenRouter. Never throws.
 */

const DEFAULT_TIMEOUT_MS = 300;
const MAX_LABEL_CHARS = 60;

function fold(value) {
  return String(value || '').trim().toLowerCase();
}

/** A label fit for the user: non-empty, not the raw id, no transport. */
function acceptableLabel(label, rawId) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_LABEL_CHARS) return '';
  if (/openrouter/i.test(text) || text.includes('/')) return '';
  const raw = fold(rawId);
  // An admin row whose display name is its own id is still a raw id.
  if (raw && fold(text) === raw && /[-_:.]/.test(raw) && !/\s/.test(text)) return '';
  return text;
}

function syncLabel(model, provider) {
  try {
    const label = require('../turn-progress').displayNameFor(model, provider);
    if (label) return label;
  } catch (_) { /* fall through */ }
  try {
    return require('./billing-failover').publicModelLabel(model, provider) || '';
  } catch (_) {
    return '';
  }
}

function rowLabel(row, name) {
  let shown = row.displayName;
  try {
    const pub = require('./custom-provider-client').publicPickerModel({ ...row });
    if (pub && pub.displayName) shown = pub.displayName;
  } catch (_) { /* keep the row's name */ }
  return acceptableLabel(shown, name);
}

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * @param {object} p
 * @param {string} p.model           the model id of the turn
 * @param {string} [p.provider]
 * @param {object} [p.prisma]        client with aiModel.findFirst
 * @param {object} [p.customCatalog] the user's connection catalog row
 * @param {object} [p.catalogRow]    the aiModel row already fetched for this
 *                                   turn ({name, displayName, provider}); used
 *                                   instead of a DB read when it is this model
 * @param {number} [p.timeoutMs]
 * @returns {Promise<string>}
 */
async function resolvePickedModelLabel({ model, provider = '', prisma = null, customCatalog = null, catalogRow = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const name = String(model || '').trim();
  if (!name) return '';
  try {
    if (customCatalog && fold(customCatalog.name) === fold(name)) {
      const own = acceptableLabel(customCatalog.displayName, name);
      if (own) return own;
    }
    const known = acceptableLabel(syncLabel(name, provider), name);
    if (known) return known;
    // The row the turn already read is the same row a DB read would return:
    // no second query (its label, or '' when the row's name is a raw id).
    if (catalogRow && typeof catalogRow === 'object' && fold(catalogRow.name) === fold(name)) {
      return rowLabel(catalogRow, name);
    }
    if (!prisma || !prisma.aiModel || typeof prisma.aiModel.findFirst !== 'function') return '';
    const row = await withTimeout(prisma.aiModel.findFirst({
      where: { name, isActive: true },
      select: { name: true, displayName: true, provider: true, description: true },
    }), Math.max(50, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    if (!row) return '';
    return rowLabel(row, name);
  } catch (_) {
    return '';
  }
}

module.exports = {
  resolvePickedModelLabel,
  acceptableLabel,
  DEFAULT_TIMEOUT_MS,
};
