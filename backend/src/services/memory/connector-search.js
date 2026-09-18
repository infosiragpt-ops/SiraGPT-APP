'use strict';

/**
 * memory/connector-search — the "conectores" rung of agentic search.
 *
 * Searches the user's CONNECTED sources (Google Drive, Gmail) with the OAuth
 * tokens already stored for that user (`users.googleServicesTokens`,
 * `users.gmailTokens`) — the same credentials the /conexiones flows use.
 * Every source fails soft (`{ ok:false, error }`), tokens never leave this
 * module, and results are bounded snippets/metadata only (no bodies).
 */

const deps = { prisma: null, google: null, decrypt: null, log: console };
function setDeps(next = {}) { Object.assign(deps, next); }
function resetForTests() { deps.prisma = null; deps.google = null; deps.decrypt = null; }

function prisma() {
  if (deps.prisma) return deps.prisma;
  try {
    // eslint-disable-next-line global-require
    deps.prisma = require('../../config/database');
  } catch { deps.prisma = null; }
  return deps.prisma;
}

function googleApis() {
  if (deps.google) return deps.google;
  try {
    // eslint-disable-next-line global-require
    deps.google = require('googleapis').google;
  } catch { deps.google = null; }
  return deps.google;
}

function decryptFn() {
  if (deps.decrypt) return deps.decrypt;
  // eslint-disable-next-line global-require
  deps.decrypt = require('../../utils/encryption').decrypt;
  return deps.decrypt;
}

function clampLimit(n, d = 8) { return Math.max(1, Math.min(20, Number(n) || d)); }

/** Escape a user query for a Drive `q` string literal. */
function driveLiteral(query) {
  return String(query || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").slice(0, 200);
}

async function loadGoogleServicesAuth(userId, db) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { googleServicesTokens: true } });
  if (!user || !user.googleServicesTokens) return { ok: false, error: 'not_connected' };
  let tokens;
  try { tokens = JSON.parse(decryptFn()(user.googleServicesTokens)); } catch { return { ok: false, error: 'tokens_invalid' }; }
  const g = googleApis();
  if (!g) return { ok: false, error: 'googleapis_unavailable' };
  const auth = new g.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({
    access_token: tokens.accessToken || tokens.access_token,
    refresh_token: tokens.refreshToken || tokens.refresh_token,
    expiry_date: tokens.expiresAt || tokens.expiry_date,
    scope: tokens.scope,
  });
  return { ok: true, auth, google: g };
}

async function searchDrive(userId, query, { limit = 8 } = {}) {
  const db = prisma();
  if (!db || !userId) return { source: 'drive', ok: false, error: 'db_unavailable', results: [] };
  try {
    const loaded = await loadGoogleServicesAuth(userId, db);
    if (!loaded.ok) return { source: 'drive', ok: false, error: loaded.error, results: [] };
    const drive = loaded.google.drive({ version: 'v3', auth: loaded.auth });
    const lit = driveLiteral(query);
    const res = await drive.files.list({
      q: `(name contains '${lit}' or fullText contains '${lit}') and trashed = false`,
      pageSize: clampLimit(limit),
      orderBy: 'modifiedTime desc',
      fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
    });
    const files = (res && res.data && Array.isArray(res.data.files)) ? res.data.files : [];
    return {
      source: 'drive',
      ok: true,
      results: files.map((f) => ({ id: f.id, title: f.name, kind: f.mimeType, modifiedAt: f.modifiedTime || null, url: f.webViewLink || null })),
    };
  } catch (err) {
    deps.log.warn?.(`[connector-search] drive failed: ${err && err.message}`);
    return { source: 'drive', ok: false, error: 'drive_failed', results: [] };
  }
}

function header(headers, name) {
  const h = (Array.isArray(headers) ? headers : []).find((x) => String(x.name || '').toLowerCase() === name.toLowerCase());
  return h ? String(h.value || '') : '';
}

async function searchGmail(userId, query, { limit = 8 } = {}) {
  const db = prisma();
  if (!db || !userId) return { source: 'gmail', ok: false, error: 'db_unavailable', results: [] };
  try {
    // eslint-disable-next-line global-require
    const { loadGmailClientForUser } = require('../gmail-user-client');
    const g = googleApis();
    if (!g) return { source: 'gmail', ok: false, error: 'googleapis_unavailable', results: [] };
    let client;
    try {
      ({ client } = await loadGmailClientForUser({ prisma: db, userId }));
    } catch (err) {
      return { source: 'gmail', ok: false, error: (err && err.code) || 'not_connected', results: [] };
    }
    const gmail = g.gmail({ version: 'v1', auth: client });
    const list = await gmail.users.messages.list({ userId: 'me', q: String(query || '').slice(0, 300), maxResults: clampLimit(limit) });
    const ids = (list && list.data && Array.isArray(list.data.messages)) ? list.data.messages : [];
    const results = [];
    for (const m of ids) {
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
        const payload = msg && msg.data ? msg.data : {};
        const headers = payload.payload && payload.payload.headers;
        results.push({
          id: m.id,
          subject: header(headers, 'Subject'),
          from: header(headers, 'From'),
          date: header(headers, 'Date'),
          snippet: String(payload.snippet || '').replace(/\s+/g, ' ').slice(0, 240),
          url: `https://mail.google.com/mail/u/0/#all/${m.id}`,
        });
      } catch { /* skip one message, keep the rest */ }
    }
    return { source: 'gmail', ok: true, results };
  } catch (err) {
    deps.log.warn?.(`[connector-search] gmail failed: ${err && err.message}`);
    return { source: 'gmail', ok: false, error: 'gmail_failed', results: [] };
  }
}

const SOURCES = { drive: searchDrive, gmail: searchGmail };

/** Fan out to the requested connectors in parallel; each one fails soft. */
async function searchConnectors(userId, query, { sources = ['drive', 'gmail'], limit = 8 } = {}) {
  const wanted = (Array.isArray(sources) ? sources : [sources]).map((s) => String(s || '').toLowerCase()).filter((s) => SOURCES[s]);
  if (!wanted.length) return { ok: false, error: 'no_valid_sources', sources: [] };
  const out = await Promise.all(wanted.map((s) => SOURCES[s](userId, query, { limit })));
  return { ok: out.some((r) => r.ok), sources: out };
}

module.exports = { searchConnectors, searchDrive, searchGmail, driveLiteral, SOURCE_NAMES: Object.keys(SOURCES), setDeps, resetForTests };
