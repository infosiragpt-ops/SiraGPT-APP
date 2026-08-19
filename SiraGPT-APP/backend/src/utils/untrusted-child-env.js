'use strict';

/**
 * untrusted-child-env — build a scrubbed environment for spawning UNTRUSTED
 * child processes (user-provided repo dev servers / build commands run by the
 * /code host-runner and the GitHub workspace-runner).
 *
 * SiraGPT's own secrets (DATABASE_URL, SESSION_SECRET, Stripe/R2/AI keys, etc.)
 * live in `process.env`. Spreading `...process.env` into code we do not control
 * hands every one of those secrets to arbitrary repo scripts, which can read
 * `process.env` and exfiltrate them. Instead we ALLOWLIST only the OS/toolchain
 * vars a dev server legitimately needs and drop everything else by default.
 *
 * Callers pass their own non-secret overrides (PORT, HOST, NODE_ENV, …) as
 * `extra`; those are always included and win over the allowlisted base.
 */

// Only these host vars are forwarded to untrusted children. Everything not in
// this list (i.e. every SiraGPT secret) is dropped. Keep this list to
// OS/toolchain essentials — never add app secrets or credentials here.
const ALLOWED_ENV_KEYS = Object.freeze([
  // POSIX toolchain resolution + shell basics
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'TMPDIR', 'TZ', 'TERM',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  // XDG dirs (npm / pnpm / yarn caches & config)
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  // Nix / Replit toolchain + TLS roots (needed for binaries & https on Nix)
  'NIX_PATH', 'NIX_PROFILES', 'NIX_SSL_CERT_FILE', 'SSL_CERT_FILE',
  'LD_LIBRARY_PATH', 'LOCALE_ARCHIVE', 'NIXPKGS_ALLOW_UNFREE',
  // Node / package-manager locations (non-secret)
  'NODE_PATH', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE', 'PNPM_HOME',
  'COREPACK_HOME', 'VOLTA_HOME', 'NVM_DIR', 'NVM_BIN',
  // Windows essentials
  'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'APPDATA', 'LOCALAPPDATA',
]);

/**
 * @param {Record<string, string>} [extra] non-secret overrides (always kept)
 * @returns {Record<string, string>} allowlisted base merged with `extra`
 */
function buildUntrustedChildEnv(extra = {}) {
  const base = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...extra };
}

module.exports = { buildUntrustedChildEnv, ALLOWED_ENV_KEYS };
