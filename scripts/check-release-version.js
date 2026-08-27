#!/usr/bin/env node
'use strict';

/**
 * Release version ↔ CHANGELOG integrity gate (semver domain).
 *
 * Validates that:
 *   1. Root package.json and backend/package.json declare strict semver.
 *   2. CHANGELOG.md carries a `## [x.y.z / backend a.b.c] — date` heading for
 *      the currently declared versions.
 *   3. Declared versions are strictly greater than the previous released
 *      versions in the changelog (no reuse, no regressions).
 *
 * Modes:
 *   default  — report findings, exit 0 (adoption phase: current drift stays visible)
 *   --strict — exit 1 on any finding (flip once the 0.4.4 entry is titled)
 *
 * Wired into root `npm test` so ci.yml's existing test step picks it up with
 * zero workflow changes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
  } catch {
    return null;
  }
}

function readText(relative) {
  try {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
  } catch {
    return null;
  }
}

function compareSemver(a, b) {
  const pa = a.split('.').map((s) => parseInt(s, 10));
  const pb = b.split('.').map((s) => parseInt(s, 10));
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// `## [0.4.3 / backend 1.3.3] — Cycles ... — 2026-05-20`
const RELEASE_HEADING_RE = /^## \[(\d+\.\d+\.\d+) \/ backend (\d+\.\d+\.\d+)\] — .*(\d{4}-\d{2}-\d{2})/gm;

function collectFindings() {
  const findings = [];
  const add = (id, message) => findings.push({ id, message });

  const pkg = readJson('package.json');
  const backendPkg = readJson('backend/package.json');
  const changelog = readText('CHANGELOG.md');

  if (!pkg || typeof pkg.version !== 'string') {
    add('pkg-missing', 'package.json missing or has no version field');
    return findings;
  }
  if (!SEMVER_RE.test(pkg.version)) {
    add('app-semver', `root package.json version "${pkg.version}" is not strict semver`);
  }
  if (!backendPkg || !SEMVER_RE.test(String(backendPkg && backendPkg.version))) {
    add('backend-semver', `backend/package.json version "${backendPkg ? backendPkg.version : null}" is not strict semver`);
  }

  if (!changelog) {
    add('changelog-missing', 'CHANGELOG.md not found at repo root');
    return findings;
  }

  const releases = [];
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = RELEASE_HEADING_RE.exec(changelog)) !== null) {
    releases.push({ app: match[1], backend: match[2], date: match[3], index: match.index });
  }

  if (!releases.some((r) => r.app === pkg.version)) {
    add(
      'app-unreleased',
      `CHANGELOG.md has no "## [${pkg.version} / backend <x.y.z>] — date" heading for current app version ${pkg.version}`,
    );
  }

  const appReleases = [...new Set(releases.map((r) => r.app))].sort(compareSemver);
  const newestApp = appReleases[appReleases.length - 1];
  if (newestApp && SEMVER_RE.test(pkg.version) && compareSemver(pkg.version, newestApp) <= 0 && pkg.version !== newestApp) {
    add(
      'app-regression',
      `declared app version ${pkg.version} must be greater than newest changelog release ${newestApp} (version reuse/regression)`,
    );
  }

  if (backendPkg && SEMVER_RE.test(String(backendPkg.version))) {
    const backendForApp = releases.filter((r) => r.app === pkg.version);
    const newestBackend = [...new Set(releases.map((r) => r.backend))].sort(compareSemver).pop();
    if (
      backendForApp.length > 0 &&
      newestBackend &&
      compareSemver(backendPkg.version, newestBackend) < 0
    ) {
      add(
        'backend-regression',
        `declared backend version ${backendPkg.version} is older than previously released backend ${newestBackend}`,
      );
    }
  }

  return findings;
}

function main() {
  const findings = collectFindings();
  if (findings.length === 0) {
    console.log('[check-release-version] OK — declared versions match CHANGELOG.md releases');
    process.exit(0);
  }

  console.error(`[check-release-version] ${findings.length} finding(s):`);
  for (const f of findings) {
    console.error(`  - [${f.id}] ${f.message}`);
  }

  if (STRICT) {
    console.error('[check-release-version] strict mode: failing.');
    process.exit(1);
  }
  console.warn('[check-release-version] report mode: exiting 0 until --strict is enabled in CI.');
  process.exit(0);
}

module.exports = { collectFindings, compareSemver, SEMVER_RE };
if (require.main === module) main();
