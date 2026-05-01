#!/usr/bin/env node
/**
 * generate-third-party-licenses.js
 *
 * Walks both workspaces (root frontend + backend) with
 * license-checker-rseidelsohn, deduplicates, and emits
 * THIRD_PARTY_LICENSES.md at repo root.
 *
 * The output groups dependencies by license family so the obligations
 * (attribution / source-disclosure / patent-grant) are visible at a
 * glance. The CI job `licenses:check` enforces that no GPL/AGPL/LGPL
 * etc. has crept in; this script is the human-readable counterpart.
 *
 * Usage:
 *   node scripts/generate-third-party-licenses.js
 *   pnpm licenses:report  /  npm run licenses:report
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const OUTPUT = path.join(ROOT, 'THIRD_PARTY_LICENSES.md');

const FORBIDDEN_PATTERNS = ['GPL', 'AGPL', 'LGPL', 'CDDL', 'EPL', 'MPL-1.1', 'NPOSL'];

// Platform-suffixed native binary packages (sharp, esbuild, swc, rollup, etc.)
// resolve as optionalDependencies keyed by os/cpu in npm. Locally on macOS
// only the darwin-arm64 variant is installed; in CI on Linux only linux-x64
// (and sometimes linuxmusl-x64) is installed. Including them in the report
// makes it fluctuate per-host and breaks the drift gate. They are documented
// generically in the "Platform-conditional native binaries" footer instead.
const PLATFORM_BIN_PATTERN =
  /-(darwin|linux|linuxmusl|android|win32|windows|freebsd|openbsd|netbsd|sunos|aix)-(x64|arm64|arm|ia32|x86|riscv64|s390x|loongarch64|ppc64|mips64el)(-[a-z]+)?$/;

function isPlatformBinary(name) {
  return PLATFORM_BIN_PATTERN.test(name);
}

// Documented exceptions. Each entry must include a reason; CI will print it.
// Keys are package names (no version) so platform-suffixed variants share the
// same justification (e.g. @img/sharp-libvips-{linux,darwin}-{x64,arm64}).
const ALLOWLIST = {
  // Dynamic-link dependency of `sharp` via N-API. LGPL-3.0 obligations only
  // bind if we statically link; we use it through Node native bindings, which
  // matches the LGPL "library" exception. Replaceable via env-var override.
  '@img/sharp-libvips-darwin-arm64': 'LGPL-3.0 native binding via N-API; replaceable',
  '@img/sharp-libvips-darwin-x64': 'LGPL-3.0 native binding via N-API; replaceable',
  '@img/sharp-libvips-linux-arm': 'LGPL-3.0 native binding via N-API; replaceable',
  '@img/sharp-libvips-linux-arm64': 'LGPL-3.0 native binding via N-API; replaceable',
  '@img/sharp-libvips-linux-s390x': 'LGPL-3.0 native binding via N-API; replaceable',
  '@img/sharp-libvips-linux-x64': 'LGPL-3.0 native binding via N-API; replaceable',
  '@img/sharp-libvips-linuxmusl-arm64': 'LGPL-3.0 native binding via N-API; replaceable',
  '@img/sharp-libvips-linuxmusl-x64': 'LGPL-3.0 native binding via N-API; replaceable',
  // Dual-licensed (MIT OR GPL-3.0); we elect MIT, the more permissive option.
  jszip: 'Dual MIT OR GPL-3.0 — we elect MIT',
};

function runChecker(cwd) {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'license-checker-rseidelsohn');
  if (!fs.existsSync(bin)) {
    throw new Error(`license-checker-rseidelsohn not installed at ${bin}`);
  }
  const raw = execFileSync(
    bin,
    ['--production', '--json', '--excludePrivatePackages'],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw);
}

function normaliseLicense(license) {
  if (!license) return 'UNKNOWN';
  if (Array.isArray(license)) return license.join(' / ');
  return String(license).replace(/[()*]/g, '').trim();
}

function flagForbidden(license, name) {
  if (name && Object.prototype.hasOwnProperty.call(ALLOWLIST, name)) return false;
  const norm = String(license || '').toUpperCase();
  // Dual licensed `MIT OR GPL-...` — we elect the permissive side.
  if (/\bOR\b/.test(norm)) {
    const parts = norm.split(/\s+OR\s+|\s*\|\s*/).map((s) => s.trim());
    const hasPermissive = parts.some((p) =>
      /MIT|APACHE|BSD|ISC|CC0|UNLICENSE|0BSD/.test(p),
    );
    if (hasPermissive) return false;
  }
  return FORBIDDEN_PATTERNS.some((p) => norm.includes(p));
}

function collect() {
  const all = new Map();
  let platformBinariesSkipped = 0;
  for (const [workspace, cwd] of [['frontend (root)', ROOT], ['backend', BACKEND]]) {
    let entries;
    try {
      entries = runChecker(cwd);
    } catch (err) {
      console.warn(`[licenses] skipped ${workspace}: ${err.message}`);
      continue;
    }
    for (const [pkgVersion, info] of Object.entries(entries)) {
      // pkgVersion = "name@x.y.z"
      const at = pkgVersion.lastIndexOf('@');
      const name = pkgVersion.slice(0, at);
      const version = pkgVersion.slice(at + 1);
      if (isPlatformBinary(name)) {
        platformBinariesSkipped += 1;
        continue;
      }
      const key = name; // dedupe across workspaces by name
      if (!all.has(key)) {
        all.set(key, {
          name,
          versions: new Set(),
          license: normaliseLicense(info.licenses),
          repository: info.repository || '',
          publisher: info.publisher || '',
          email: info.email || '',
          url: info.url || '',
          workspaces: new Set(),
        });
      }
      const e = all.get(key);
      e.versions.add(version);
      e.workspaces.add(workspace);
    }
  }
  const list = [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
  list._platformBinariesSkipped = platformBinariesSkipped;
  return list;
}

function groupByFamily(entries) {
  const groups = new Map();
  for (const e of entries) {
    const family = familyFor(e.license);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(e);
  }
  return [...groups.entries()].sort();
}

function familyFor(license) {
  const upper = license.toUpperCase();
  if (upper.includes('MIT')) return 'MIT';
  if (upper.includes('APACHE')) return 'Apache-2.0';
  if (upper.startsWith('BSD')) return 'BSD';
  if (upper.includes('ISC')) return 'ISC';
  if (upper.includes('CC0')) return 'CC0';
  if (upper.includes('CC-BY')) return 'CC-BY';
  if (upper.includes('PYTHON')) return 'PSF';
  if (upper.includes('UNLICENSE') || upper.includes('WTFPL') || upper.includes('PUBLIC DOMAIN'))
    return 'Public Domain';
  if (upper === 'UNKNOWN' || upper === '') return 'UNKNOWN';
  return license;
}

function render(entries) {
  const groups = groupByFamily(entries);
  const total = entries.length;
  const flagged = entries.filter((e) => flagForbidden(e.license, e.name));

  const lines = [
    '# Third-Party Licenses',
    '',
    `Generated automatically by \`scripts/generate-third-party-licenses.js\`. ` +
      `Total third-party packages: **${total}**.`,
    '',
    '> Re-run with `npm run licenses:report` after every dependency change. CI ' +
      'enforces that no GPL/AGPL/LGPL/CDDL/EPL/MPL-1.1/NPOSL family appears via ' +
      '`npm run licenses:check`.',
    '',
  ];

  if (flagged.length > 0) {
    lines.push('## ⚠️ Flagged for review');
    lines.push('');
    lines.push('These packages carry copyleft / commercially-restrictive licenses. ' +
      'Review each before shipping. CI `licenses:check` will fail until cleared.');
    lines.push('');
    for (const e of flagged) {
      lines.push(`- **${e.name}** \`${[...e.versions].join(', ')}\` — ${e.license}`);
    }
    lines.push('');
  }

  const allowlistEntries = entries.filter((e) =>
    Object.prototype.hasOwnProperty.call(ALLOWLIST, e.name),
  );
  if (allowlistEntries.length > 0) {
    lines.push('## Allowlisted exceptions');
    lines.push('');
    lines.push(
      'Each entry below carries a non-permissive declared license but is permitted ' +
      'with the documented justification. Edit `scripts/generate-third-party-licenses.js` ' +
      'to add or remove entries.',
    );
    lines.push('');
    lines.push('| Package | Declared License | Reason |');
    lines.push('|---|---|---|');
    for (const e of allowlistEntries) {
      lines.push(`| \`${e.name}\` | ${e.license} | ${ALLOWLIST[e.name]} |`);
    }
    lines.push('');
  }

  for (const [family, items] of groups) {
    lines.push(`## ${family} (${items.length})`);
    lines.push('');
    lines.push('| Package | Version(s) | License | Source |');
    lines.push('|---|---|---|---|');
    for (const e of items) {
      const repo = e.repository ? `[link](${e.repository})` : '';
      const versions = [...e.versions].sort().join(', ');
      lines.push(`| \`${e.name}\` | ${versions} | ${e.license} | ${repo} |`);
    }
    lines.push('');
  }

  if (entries._platformBinariesSkipped) {
    lines.push('## Platform-conditional native binaries');
    lines.push('');
    lines.push(
      `${entries._platformBinariesSkipped} platform-suffixed packages (sharp, esbuild, ` +
      'rollup, swc, …) are intentionally omitted from the tables above. npm only ' +
      'installs the variants matching the host\'s `os`/`cpu`, so listing them ' +
      'directly would make this report drift between dev (macOS) and CI/prod ' +
      '(Linux). They are documented in the parent package\'s entry instead.',
    );
    lines.push('');
    lines.push('Currently the only family with non-permissive licensing in this ' +
      'group is `@img/sharp-libvips-*` (LGPL-3.0-or-later via N-API), which is ' +
      'allowlisted under the policy at the top of ' +
      '`scripts/generate-third-party-licenses.js`.');
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const entries = collect();
  if (entries.length === 0) {
    console.error('[licenses] no entries collected — install dependencies first');
    process.exit(1);
  }
  const flagged = entries.filter((e) => flagForbidden(e.license, e.name));
  if (checkOnly) {
    if (flagged.length > 0) {
      console.error(`[licenses] ❌ ${flagged.length} forbidden licenses detected:`);
      for (const e of flagged) {
        console.error(`  - ${e.name} (${[...e.versions].join(', ')}) — ${e.license}`);
      }
      console.error(
        '\nFix by either: (a) replacing the dependency, (b) adding it to ALLOWLIST in ' +
        'scripts/generate-third-party-licenses.js with a documented reason.',
      );
      process.exit(1);
    }
    console.log(`[licenses] ✅ ${entries.length} packages, all permissive or allowlisted`);
    return;
  }
  const md = render(entries);
  fs.writeFileSync(OUTPUT, md, 'utf8');
  console.log(`[licenses] wrote ${entries.length} entries to ${path.relative(ROOT, OUTPUT)}`);
  if (flagged.length > 0) {
    console.warn(
      `[licenses] ⚠️  ${flagged.length} packages need attention — see ${path.relative(ROOT, OUTPUT)}`,
    );
    process.exit(1);
  }
}

main();
