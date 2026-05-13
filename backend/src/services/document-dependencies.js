'use strict';

/**
 * document-dependencies.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects package / dependency declarations across ecosystems:
 *
 *   - npm/yarn: "react@18.2.0", "lodash": "^4.17",
 *     package.json deps blocks, "npm install react"
 *   - pypi: "requests==2.31", "pip install foo", pyproject.toml [tool.poetry.dependencies]
 *   - cargo: "serde = \"1.0\"" (Rust)
 *   - gomod: "require example.com/foo v1.2.3"
 *   - maven/gradle: "implementation('com.example:lib:1.2.3')"
 *
 * Output groups by ecosystem with name+version pairs. Routes
 * "what dependencies does this use?", "what version of X?" to a
 * citeable inventory. Different from document-identifiers (ISBNs etc.)
 * by focusing on package names.
 *
 * Public API:
 *   extractDependencies(text)        → DepReport
 *   buildDependenciesForFiles(files) → { perFile, aggregate, totals }
 *   renderDependenciesBlock(report)  → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_ECOSYSTEM = 12;
const MAX_PER_FILE = 32;
const MAX_AGGREGATE = 36;
const MAX_BLOCK_CHARS = 5500;
const MAX_NAME_LEN = 100;

// npm: "name": "version" inside object — captures inside quoted JSON-ish lines
const NPM_JSON_RE = /["']([@a-zA-Z0-9_\-/.]+)["']\s*:\s*["'](\^?~?[\d.x*]+(?:[\-+][\w.]+)?)["']/g;
// npm/yarn install commands
const NPM_INSTALL_RE = /\b(?:npm|yarn|pnpm)\s+(?:install|add|i)\s+((?:@?[\w\-/.]+(?:@[\w.\-]+)?\s*)+)/gi;
// pip install
const PIP_INSTALL_RE = /\bpip\s+install\s+((?:[a-zA-Z0-9_\-.]+(?:[=<>!~]=?[\d.a-zA-Z]+)?\s*)+)/gi;
// requirements.txt-style: package==version
const PIP_REQ_RE = /^[\t ]*([a-zA-Z][a-zA-Z0-9_\-.]*)\s*(==|>=|<=|~=|>|<)\s*([\d.a-zA-Z\-+]+)/gm;
// cargo: name = "version"  (TOML)
const CARGO_TOML_RE = /^[\t ]*([a-zA-Z][a-zA-Z0-9_\-]*)\s*=\s*"(\^?~?[\d.]+(?:[\-+][\w.]+)?)"/gm;
// go.mod: require example.com/foo v1.2.3
const GO_MOD_RE = /\brequire\s+(?:\(|)([a-zA-Z0-9_./\-]+)\s+v?(\d+\.\d+\.\d+(?:[\-+][\w.]+)?)/gi;
// maven/gradle: 'com.example:lib:1.2.3' or implementation 'com.example:lib:1.2.3'
const MAVEN_RE = /['"]([a-zA-Z0-9_\-.]+:[a-zA-Z0-9_\-.]+:\d+\.\d+(?:\.\d+)?(?:[\-+][\w.]+)?)['"]/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipName(n) {
  const s = String(n || '').trim();
  if (s.length <= MAX_NAME_LEN) return s;
  return `${s.slice(0, MAX_NAME_LEN - 1)}…`;
}

const ECOSYSTEMS = ['npm', 'pip', 'cargo', 'gomod', 'maven'];

function emptyByEcosystem() {
  const r = {};
  for (const e of ECOSYSTEMS) r[e] = 0;
  return r;
}

function isLikelyNpmName(name) {
  if (!name || name.length < 2) return false;
  if (/^[\d.x*]+$/.test(name)) return false; // version-only
  if (name === 'version' || name === 'name' || name === 'description') return false;
  // Reject keys that look like dependency-section headings
  if (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].includes(name)) return false;
  return /^@?[a-zA-Z0-9_\-]/.test(name);
}

function extractDependencies(input) {
  const text = safeText(input);
  if (!text) return { deps: [], total: 0, byEcosystem: emptyByEcosystem(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const deps = [];
  const seen = new Set();
  const byEcosystem = emptyByEcosystem();

  function add(ecosystem, name, version) {
    if (deps.length >= MAX_PER_FILE) return;
    if (byEcosystem[ecosystem] >= MAX_PER_ECOSYSTEM) return;
    const n = clipName(name);
    if (!n) return;
    const v = version ? clipName(version) : null;
    const key = `${ecosystem}|${n}|${v || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    deps.push({ ecosystem, name: n, version: v });
    byEcosystem[ecosystem] += 1;
  }

  // npm JSON-form
  for (const m of head.matchAll(NPM_JSON_RE)) {
    if (!isLikelyNpmName(m[1])) continue;
    add('npm', m[1], m[2]);
  }

  // npm install commands
  for (const m of head.matchAll(NPM_INSTALL_RE)) {
    const list = (m[1] || '').trim().split(/\s+/);
    for (const pkg of list) {
      if (!pkg) continue;
      const [name, version] = pkg.split('@').length === 3 ? [`@${pkg.split('@')[1]}`, pkg.split('@')[2]] : pkg.split('@');
      add('npm', name, version || null);
    }
  }

  // pip install commands
  for (const m of head.matchAll(PIP_INSTALL_RE)) {
    const list = (m[1] || '').trim().split(/\s+/);
    for (const pkg of list) {
      if (!pkg) continue;
      const pmatch = /^([a-zA-Z0-9_\-.]+)(?:[=<>!~]=?([\d.a-zA-Z]+))?$/.exec(pkg);
      if (pmatch) add('pip', pmatch[1], pmatch[2] || null);
    }
  }

  // requirements.txt
  for (const m of head.matchAll(PIP_REQ_RE)) {
    add('pip', m[1], `${m[2]}${m[3]}`);
  }

  // cargo TOML
  for (const m of head.matchAll(CARGO_TOML_RE)) {
    add('cargo', m[1], m[2]);
  }

  // go.mod
  for (const m of head.matchAll(GO_MOD_RE)) {
    add('gomod', m[1], `v${m[2]}`);
  }

  // maven/gradle coords
  for (const m of head.matchAll(MAVEN_RE)) {
    const parts = m[1].split(':');
    if (parts.length === 3) {
      add('maven', `${parts[0]}:${parts[1]}`, parts[2]);
    }
  }

  return { deps, total: deps.length, byEcosystem, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildDependenciesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byEcosystem = emptyByEcosystem();
  for (const f of list) {
    const r = extractDependencies(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, deps: r.deps, byEcosystem: r.byEcosystem });
    aggregate = aggregate.concat(r.deps.map((d) => ({ ...d, file: name })));
    for (const e of ECOSYSTEMS) byEcosystem[e] += r.byEcosystem[e];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byEcosystem };
}

function renderDep(d, opts = {}) {
  const file = opts.includeFile && d.file ? ` _(${d.file})_` : '';
  const ver = d.version ? ` \`${d.version}\`` : '';
  return `- [${d.ecosystem}] **${d.name}**${ver}${file}`;
}

function renderDependenciesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byEcosystem = report.byEcosystem || emptyByEcosystem();
  const breakdown = ECOSYSTEMS
    .filter((e) => byEcosystem[e] > 0)
    .map((e) => `${e}=${byEcosystem[e]}`)
    .join('  ');
  const heading = `## DEPENDENCIES
Package dependencies declared across ecosystems (npm/yarn/pnpm, PyPI/pip, Cargo, Go modules, Maven/Gradle). Surfaces name + version pin where present. Routes "what dependencies does this use?" / "what version of X?" to a citeable inventory.

**By ecosystem:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const d of only.deps) sections.push(renderDep(d));
  } else {
    sections.push('### Aggregate dependencies across all files');
    for (const d of report.aggregate) sections.push(renderDep(d, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const d of p.deps) sections.push(renderDep(d));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...dependencies block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractDependencies,
  buildDependenciesForFiles,
  renderDependenciesBlock,
  _internal: {
    NPM_JSON_RE,
    NPM_INSTALL_RE,
    PIP_INSTALL_RE,
    PIP_REQ_RE,
    CARGO_TOML_RE,
    GO_MOD_RE,
    MAVEN_RE,
    ECOSYSTEMS,
    isLikelyNpmName,
  },
};
