'use strict';

/**
 * cookie-jar-store — the user's own browser session for login-walled media.
 *
 * A class recording on an institutional platform (upn.class.com, an LMS, a
 * Zoom cloud recording) can only be downloaded WITH the user's session.
 * The user exports that session once as a Netscape `cookies.txt` (any
 * "Get cookies.txt" browser extension) and attaches it in the chat; this
 * store keeps it ENCRYPTED per user (AES-256 via utils/encryption, the same
 * key that protects connector tokens) so every later link to the same sites
 * works without re-attaching anything. Only the cookies whose domain matches
 * the link's host ever leave the store (see media-discovery.cookiesForHost).
 *
 * Nothing here is ever logged or returned to the model: callers get host
 * names and counts, never cookie values.
 */

const fs = require('node:fs');
const path = require('node:path');

const NETSCAPE_HEADER_RE = /^#\s*(Netscape )?HTTP Cookie File/im;
const MAX_JAR_BYTES = 512 * 1024;

function isNetscapeCookieText(text) {
  const s = String(text || '');
  if (!s || s.length > MAX_JAR_BYTES) return false;
  if (NETSCAPE_HEADER_RE.test(s)) return true;
  // Headerless export: at least two well-formed 7-column lines.
  const rows = s.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const wellFormed = rows.filter((l) => l.split('\t').length >= 7 && /^(TRUE|FALSE)$/i.test(l.split('\t')[1] || ''));
  return wellFormed.length >= 2 && wellFormed.length >= rows.length * 0.8;
}

function cookieHosts(text) {
  const hosts = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
    if (!l || l.startsWith('#')) continue;
    const domain = l.split('\t')[0];
    if (domain) hosts.add(domain.replace(/^\./, '').toLowerCase());
  }
  return [...hosts].sort();
}

function jarDir(env = process.env) {
  return path.join(env.SIRAGPT_COOKIE_JAR_DIR || path.join(env.UPLOAD_DIR || 'uploads', 'cookie-jars'));
}

function jarPath(userId, env) {
  const safe = String(userId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  if (!safe) return null;
  return path.join(jarDir(env), `${safe}.cookies.enc`);
}

function crypto() {
  // Lazy: utils/encryption exits the process without ENCRYPTION_KEY, which
  // unit tests never set unless they inject `cipher`.
  return require('../../../utils/encryption');
}

async function saveUserCookies(userId, text, { env = process.env, fsImpl = fs, cipher } = {}) {
  const file = jarPath(userId, env);
  if (!file) throw new Error('cookie_jar_no_user');
  if (!isNetscapeCookieText(text)) throw new Error('cookie_jar_not_netscape');
  const enc = (cipher || crypto()).encrypt(String(text));
  await fsImpl.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsImpl.promises.writeFile(tmp, enc, { mode: 0o600 });
  await fsImpl.promises.rename(tmp, file);
  return { hosts: cookieHosts(text), count: cookieHosts(text).length, path: file };
}

async function loadUserCookies(userId, { env = process.env, fsImpl = fs, cipher } = {}) {
  const file = jarPath(userId, env);
  if (!file) return null;
  let enc;
  try { enc = await fsImpl.promises.readFile(file, 'utf8'); } catch (_) { return null; }
  try {
    const text = (cipher || crypto()).decrypt(String(enc));
    return isNetscapeCookieText(text) ? text : null;
  } catch (_) {
    return null;
  }
}

async function forgetUserCookies(userId, { env = process.env, fsImpl = fs } = {}) {
  const file = jarPath(userId, env);
  if (!file) return false;
  try { await fsImpl.promises.unlink(file); return true; } catch (_) { return false; }
}

/** Merge two Netscape jars; later entries win for the same (domain, path, name). */
function mergeNetscapeCookies(baseText, extraText) {
  const rows = new Map();
  const headers = ['# Netscape HTTP Cookie File'];
  for (const text of [baseText, extraText]) {
    for (const line of String(text || '').split(/\r?\n/)) {
      const l = line.trim();
      if (!l || (l.startsWith('#') && !l.startsWith('#HttpOnly_'))) continue;
      const parts = (l.startsWith('#HttpOnly_') ? l.slice('#HttpOnly_'.length) : l).split('\t');
      if (parts.length < 7) continue;
      rows.set(`${parts[0]}|${parts[2]}|${parts[5]}`, l);
    }
  }
  return `${headers.join('\n')}\n\n${[...rows.values()].join('\n')}\n`;
}

module.exports = {
  isNetscapeCookieText,
  cookieHosts,
  saveUserCookies,
  loadUserCookies,
  forgetUserCookies,
  mergeNetscapeCookies,
  jarPath,
  MAX_JAR_BYTES,
};
