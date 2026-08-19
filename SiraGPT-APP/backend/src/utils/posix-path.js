'use strict';

/**
 * posix-path — minimal POSIX-style path normalize/join without
 * pulling in node:path. Pairs with the upload security policy
 * (validate user paths) and the slugify helper (#104, generate
 * file names): when the agent receives a tool-arg path or a user-
 * uploaded filename, this is the safe canonicalization layer.
 *
 * Public API:
 *   isAbsolute(p)                      — leading '/'
 *   normalize(p)                       — collapse //, resolve ../
 *   join(...parts)                     — normalize after concat
 *   dirname(p) / basename(p, ext?)
 *   extname(p)
 *   isSafeRelative(p)                  — false if normalized escapes root
 */

function isAbsolute(p) {
  return typeof p === 'string' && p.length > 0 && p[0] === '/';
}

function normalize(p) {
  if (typeof p !== 'string' || p.length === 0) return '.';
  const absolute = isAbsolute(p);
  const trailing = p.length > 1 && p[p.length - 1] === '/';
  const segments = p.split('/');
  const out = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  let result = out.join('/');
  if (absolute) result = '/' + result;
  if (trailing && result !== '' && !result.endsWith('/')) result += '/';
  return result || (absolute ? '/' : '.');
}

function join(...parts) {
  if (parts.length === 0) return '.';
  const filtered = parts.filter((p) => typeof p === 'string' && p.length > 0);
  if (filtered.length === 0) return '.';
  return normalize(filtered.join('/'));
}

function dirname(p) {
  if (typeof p !== 'string' || p.length === 0) return '.';
  const norm = normalize(p);
  const idx = norm.lastIndexOf('/');
  if (idx === -1) return '.';
  if (idx === 0) return '/';
  return norm.slice(0, idx);
}

function basename(p, ext) {
  if (typeof p !== 'string') return '';
  const norm = normalize(p);
  let base = norm;
  const idx = norm.lastIndexOf('/');
  if (idx !== -1) base = norm.slice(idx + 1);
  if (typeof ext === 'string' && ext && base.endsWith(ext) && base !== ext) {
    base = base.slice(0, -ext.length);
  }
  return base;
}

function extname(p) {
  if (typeof p !== 'string') return '';
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot);
}

function isSafeRelative(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (isAbsolute(p)) return false;
  const norm = normalize(p);
  if (norm === '..' || norm.startsWith('../')) return false;
  return true;
}

module.exports = {
  isAbsolute,
  normalize,
  join,
  dirname,
  basename,
  extname,
  isSafeRelative,
};
