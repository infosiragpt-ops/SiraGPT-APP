'use strict';

const MAX_PATTERNS = 20;
const MAX_PATTERN_CHARS = 512;
const DEFAULT_MAX_RESULTS = 500;
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

function normalizeGlobPatterns(raw) {
  const source = Array.isArray(raw) ? raw : [raw];
  if (!source.length || source.length > MAX_PATTERNS) return null;
  const patterns = [];
  const seen = new Set();
  for (const item of source) {
    const pattern = String(item || '').replaceAll('\\', '/').trim();
    if (
      !pattern
      || pattern.length > MAX_PATTERN_CHARS
      || pattern.includes('\0')
      || ABSOLUTE_PATH_RE.test(pattern)
      || pattern.split('/').includes('..')
    ) {
      return null;
    }
    if (!seen.has(pattern)) {
      seen.add(pattern);
      patterns.push(pattern);
    }
  }
  return patterns.length ? patterns : null;
}

function parseFileList(stdout) {
  const text = String(stdout || '');
  const separator = text.includes('\0') ? '\0' : '\n';
  return [...new Set(text.split(separator).map((entry) => entry.trim()).filter(Boolean))].sort();
}

async function runSafeGlob({
  runner,
  project,
  patterns,
  maxResults = DEFAULT_MAX_RESULTS,
  timeoutMs = 15_000,
}) {
  const normalized = normalizeGlobPatterns(patterns);
  if (!normalized) {
    return {
      ok: false,
      error: `patterns debe contener 1-${MAX_PATTERNS} globs relativos seguros (sin rutas absolutas ni "..")`,
    };
  }
  const limit = Math.min(Math.max(Math.trunc(Number(maxResults)) || DEFAULT_MAX_RESULTS, 1), 2_000);
  const pathspecs = normalized.map((pattern) => `:(top,glob)${pattern}`);
  const out = await runner.exec(
    project,
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
    { timeoutMs },
  );
  if (out.exitCode !== 0) {
    return {
      ok: false,
      error: String(out.stderr || out.stdout || `git ls-files exit ${out.exitCode}`),
      exitCode: out.exitCode,
    };
  }
  const files = parseFileList(out.stdout);
  return {
    ok: true,
    patterns: normalized,
    files: files.slice(0, limit),
    total: files.length,
    truncated: files.length > limit,
  };
}

module.exports = {
  runSafeGlob,
  normalizeGlobPatterns,
  parseFileList,
  MAX_PATTERNS,
  MAX_PATTERN_CHARS,
  DEFAULT_MAX_RESULTS,
};
