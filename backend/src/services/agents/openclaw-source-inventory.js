'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const {
  FOLDER_CAPABILITY_MAP,
} = require('./openclaw-playbook-bridge');

const DEFAULT_REPOSITORY = 'https://github.com/openclaw/openclaw';
const INVENTORY_VERSION = 'openclaw-source-inventory-2026-07';
const AUDITED_OPENCLAW_RELEASE = Object.freeze({
  release: 'v2026.7.1',
  commit: '2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4',
  trackedFiles: 21922,
  license: 'MIT',
  inventoryMode: 'git_tree',
  activationPolicy: 'native_rewrite_only',
});
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'dist',
  'build',
  'node_modules',
]);

const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.css',
  '.cts',
  '.env',
  '.example',
  '.go',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const ROOT_CONFIG_FILES = [
  '.dockerignore',
  '.editorconfig',
  '.env.example',
  '.gitignore',
  'Dockerfile',
  'LICENSE',
  'Makefile',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'render.yaml',
  'tsconfig.json',
  'turbo.json',
  'vitest.config.ts',
];

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeReadText(filePath, maxBytes = 1024 * 1024) {
  const stat = safeStat(filePath);
  if (!stat || !stat.isFile() || stat.size > maxBytes) return '';
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function safeReadJson(filePath) {
  const raw = safeReadText(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectGitCommit(rootDir) {
  if (!rootDir) return null;
  try {
    return childProcess.execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function isOwnGitRepository(rootDir) {
  if (!rootDir) return false;
  const marker = path.join(rootDir, '.git');
  return fs.existsSync(marker);
}

function normalizeGitRevision(value) {
  const revision = String(value || 'HEAD').trim();
  if (revision === 'HEAD' || /^[0-9a-f]{7,64}$/i.test(revision)) return revision;
  throw new Error('OpenClaw inventory requires HEAD or a hexadecimal commit SHA');
}

function readGitTree(rootDir, revisionInput) {
  if (!isOwnGitRepository(rootDir)) return null;
  try {
    const revision = normalizeGitRevision(revisionInput);
    const commit = childProcess.execFileSync('git', ['-C', rootDir, 'rev-parse', `${revision}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    }).trim();
    // Do not request `-l`: in a partial clone Git must download every blob to
    // compute sizes. Paths + object IDs are sufficient for 100% tree coverage.
    const raw = childProcess.execFileSync('git', ['-C', rootDir, 'ls-tree', '-r', '-z', commit, '--'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const entries = [];
    for (const record of raw.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const metadata = record.slice(0, tab).trim().split(/\s+/);
      if (metadata.length < 3 || metadata[1] !== 'blob') continue;
      entries.push({
        mode: metadata[0],
        type: metadata[1],
        object: metadata[2],
        size: null,
        path: record.slice(tab + 1),
      });
    }
    return { commit, entries };
  } catch {
    return null;
  }
}

function readGitBlob(rootDir, commit, relativePath, maxBytes = 1024 * 1024) {
  try {
    const raw = childProcess.execFileSync('git', ['-C', rootDir, 'show', `${commit}:${relativePath}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: maxBytes,
    });
    return raw.length <= maxBytes ? raw : '';
  } catch {
    return '';
  }
}

function detectLicenseText(raw, file = 'LICENSE') {
  if (!raw) {
    return {
      id: 'unknown',
      file: file || null,
      attributionRequired: true,
      confidence: 'missing_or_unreadable',
    };
  }
  const firstLine = raw.split(/\r?\n/).find(Boolean) || '';
  const isMit = /\bMIT\b/i.test(raw.slice(0, 4096));
  return {
    id: isMit ? 'MIT' : 'unknown',
    file,
    attributionRequired: true,
    confidence: isMit ? 'high' : 'manual_review_required',
    headline: firstLine.slice(0, 120),
  };
}

function detectLicense(rootDir) {
  const licensePath = path.join(rootDir || '', 'LICENSE');
  const raw = safeReadText(licensePath, 64 * 1024);
  if (!raw) return detectLicenseText('', fs.existsSync(licensePath) ? 'LICENSE' : null);
  return detectLicenseText(raw, 'LICENSE');
}

function isTextPath(filePath) {
  const base = path.basename(filePath);
  if (['Dockerfile', 'Makefile', 'LICENSE'].includes(base)) return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function countLines(filePath, stat) {
  if (!isTextPath(filePath) || !stat || stat.size > 4 * 1024 * 1024) return 0;
  const raw = safeReadText(filePath, 4 * 1024 * 1024);
  if (!raw) return 0;
  return raw.split(/\r?\n/).length;
}

function summarizePackageJson(filePath, repoRoot) {
  const manifest = safeReadJson(filePath);
  if (!manifest) return null;
  const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const dependencyCounts = {};
  const dependencySamples = {};
  for (const section of dependencySections) {
    const names = Object.keys(manifest[section] || {}).sort();
    dependencyCounts[section] = names.length;
    dependencySamples[section] = names.slice(0, 12);
  }
  return {
    path: path.relative(repoRoot, filePath) || 'package.json',
    name: manifest.name || null,
    private: Boolean(manifest.private),
    scripts: Object.keys(manifest.scripts || {}).sort().slice(0, 24),
    dependencyCounts,
    dependencySamples,
  };
}

function createEmptyScan() {
  return {
    fileCount: 0,
    lineCount: 0,
    byteCount: 0,
    extensionCounts: new Map(),
    packageManifests: [],
    testSurfaces: new Set(),
    configFiles: new Set(),
    sampleFiles: [],
  };
}

function absorbFile(scan, filePath, stat, rootDir) {
  scan.fileCount += 1;
  scan.byteCount += stat.size;
  scan.lineCount += countLines(filePath, stat);
  const ext = path.extname(filePath).toLowerCase() || '[no_ext]';
  scan.extensionCounts.set(ext, (scan.extensionCounts.get(ext) || 0) + 1);
  const relative = path.relative(rootDir, filePath);
  if (scan.sampleFiles.length < 12) scan.sampleFiles.push(relative);
  const base = path.basename(filePath).toLowerCase();
  if (base === 'package.json') {
    const manifest = summarizePackageJson(filePath, rootDir);
    if (manifest) scan.packageManifests.push(manifest);
  }
  if (/\b(test|spec|vitest|playwright|qa|fixture|mock)\b/i.test(relative)) {
    scan.testSurfaces.add(relative.split(path.sep).slice(0, 3).join('/'));
  }
  if (/\b(tsconfig|eslint|prettier|vitest|playwright|docker|compose|package|pnpm|npm|turbo)\b/i.test(base)) {
    scan.configFiles.add(relative);
  }
}

function scanRootConfig(rootDir) {
  const scan = createEmptyScan();
  for (const name of ROOT_CONFIG_FILES) {
    const filePath = path.join(rootDir, name);
    const stat = safeStat(filePath);
    if (!stat || !stat.isFile()) continue;
    absorbFile(scan, filePath, stat, rootDir);
  }
  return finalizeScan(scan);
}

function scanDirectory(targetDir, rootDir) {
  const scan = createEmptyScan();
  const rootStat = safeStat(targetDir);
  if (!rootStat || !rootStat.isDirectory()) return finalizeScan(scan);
  const stack = [targetDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = safeStat(full);
      if (!stat) continue;
      absorbFile(scan, full, stat, rootDir);
    }
  }
  return finalizeScan(scan);
}

function finalizeScan(scan) {
  return {
    fileCount: scan.fileCount,
    lineCount: scan.lineCount,
    byteCount: scan.byteCount,
    extensionSummary: [...scan.extensionCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([extension, count]) => ({ extension, count })),
    packageManifests: scan.packageManifests,
    testSurfaces: [...scan.testSurfaces].sort().slice(0, 18),
    configFiles: [...scan.configFiles].sort().slice(0, 18),
    sampleFiles: scan.sampleFiles,
  };
}

function absorbGitEntry(scan, entry) {
  scan.fileCount += 1;
  scan.byteCount += Number(entry.size) || 0;
  const ext = path.posix.extname(entry.path).toLowerCase() || '[no_ext]';
  scan.extensionCounts.set(ext, (scan.extensionCounts.get(ext) || 0) + 1);
  if (scan.sampleFiles.length < 12) scan.sampleFiles.push(entry.path);
  const base = path.posix.basename(entry.path).toLowerCase();
  if (base === 'package.json') {
    scan.packageManifests.push({
      path: entry.path,
      name: null,
      private: null,
      scripts: [],
      dependencyCounts: {},
      dependencySamples: {},
      materialized: false,
    });
  }
  if (/\b(test|spec|vitest|playwright|qa|fixture|mock)\b/i.test(entry.path)) {
    scan.testSurfaces.add(entry.path.split('/').slice(0, 3).join('/'));
  }
  if (/\b(tsconfig|eslint|prettier|vitest|playwright|docker|compose|package|pnpm|npm|turbo)\b/i.test(base)) {
    scan.configFiles.add(entry.path);
  }
}

function scanGitEntries(entries, folder) {
  const scan = createEmptyScan();
  const selected = entries.filter((entry) => {
    if (folder === 'root-config') {
      return !entry.path.includes('/') && ROOT_CONFIG_FILES.includes(entry.path);
    }
    return entry.path.startsWith(`${folder}/`);
  });
  for (const entry of selected) absorbGitEntry(scan, entry);
  return {
    ...finalizeScan(scan),
    lineCountMode: 'not_materialized',
    byteCountMode: 'not_materialized',
  };
}

function listGitInventoryTargets(entries) {
  const mapped = FOLDER_CAPABILITY_MAP.map((entry) => entry.openclaw);
  const topLevelDirs = uniq(entries
    .map((entry) => entry.path.split('/'))
    .filter((parts) => parts.length > 1)
    .map((parts) => parts[0]));
  return uniq(['root-config', ...mapped, ...topLevelDirs]).sort((a, b) => {
    if (a === 'root-config') return -1;
    if (b === 'root-config') return 1;
    return a.localeCompare(b);
  });
}

function listInventoryTargets(rootDir) {
  const mapped = FOLDER_CAPABILITY_MAP.map((entry) => entry.openclaw);
  let topLevelDirs = [];
  try {
    topLevelDirs = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
      .map((entry) => entry.name);
  } catch {
    topLevelDirs = [];
  }
  return uniq(['root-config', ...mapped, ...topLevelDirs]).sort((a, b) => {
    if (a === 'root-config') return -1;
    if (b === 'root-config') return 1;
    return a.localeCompare(b);
  });
}

function getMapping(folder) {
  const exact = FOLDER_CAPABILITY_MAP.find((entry) => entry.openclaw === folder);
  if (exact) return exact;
  const nested = FOLDER_CAPABILITY_MAP.find((entry) => entry.openclaw.startsWith(`${folder}/`));
  if (nested) {
    return {
      ...nested,
      openclaw: folder,
      status: nested.status === 'integrated' ? 'partial' : nested.status,
      strategy: `top-level source for ${nested.openclaw}; ${nested.strategy}`,
    };
  }
  return {
    openclaw: folder,
    sira: 'manual review',
    status: 'unknown',
    strategy: 'inventory-only until a SiraGPT owner surface is assigned',
  };
}

function resolveTargetPath(rootDir, folder) {
  if (folder === 'root-config') return rootDir;
  return path.join(rootDir, folder);
}

function buildRiskFlags(folder, mapping, scan) {
  const flags = [];
  const manifestNames = scan.packageManifests.map((manifest) => manifest.name).filter(Boolean);
  const text = `${folder} ${mapping.sira} ${mapping.strategy} ${scan.sampleFiles.join(' ')} ${manifestNames.join(' ')}`.toLowerCase();
  if (mapping.status === 'protected' || /\b(ui|apps|frontend|components)\b/.test(text)) {
    flags.push('protected_product_surface');
  }
  if (/\b(deploy|release|git-hooks|github|workflow|announce|publish|docker|render)\b/.test(text)) {
    flags.push('external_side_effect_boundary');
  }
  if (/\b(secret|credential|token|auth|oauth|discord|slack|telegram|imessage|phone|device|meet|teams|zalo|line|mattermost)\b/.test(text)) {
    flags.push('credential_or_channel_boundary');
  }
  if (scan.packageManifests.length > 0) flags.push('dependency_boundary');
  if (scan.testSurfaces.length > 0) flags.push('test_surface_present');
  if (mapping.status === 'unknown') flags.push('unmapped_surface');
  return uniq(flags);
}

function pickActivationPolicy(folder, mapping, riskFlags, scan) {
  if (riskFlags.includes('protected_product_surface')) return 'blocked_until_product_or_ui_scope';
  if (riskFlags.includes('credential_or_channel_boundary')) return 'reference_only_until_secret_review';
  if (folder === 'root-config') return 'config_review_only';
  if (['.agents', 'skills', 'scripts', 'qa', 'test', 'security', 'docs'].includes(folder)) {
    return 'native_rewrite_candidate';
  }
  if (mapping.sira && /\bbackend\/src|backend\/tests|scripts|\.agents|docs|infra\b/.test(mapping.sira)) {
    return 'native_rewrite_candidate';
  }
  if (scan.fileCount === 0) return 'absent_or_empty';
  return 'reference_only';
}

function rankActivation(folder, mapping, scan, riskFlags, policy) {
  if (policy !== 'native_rewrite_candidate') return null;
  let score = 50;
  if (['scripts', 'qa', 'test', '.agents', 'skills'].includes(folder)) score -= 18;
  if (folder === 'docs' || folder === 'security') score -= 8;
  if (mapping.status === 'integrated') score -= 10;
  if (mapping.status === 'partial') score -= 4;
  if (scan.testSurfaces.length > 0) score -= 8;
  if (scan.fileCount > 500) score += 18;
  if (scan.fileCount > 2000) score += 30;
  if (riskFlags.includes('external_side_effect_boundary')) score += 18;
  return Math.max(1, score);
}

function buildQualityGates(policy, riskFlags) {
  const gates = [
    'license_attribution_preserved',
    'no_active_verbatim_runtime_import',
    'sira_owner_surface_named',
  ];
  if (policy === 'native_rewrite_candidate') {
    gates.push('focused_tests_added', 'rollback_path_named');
  }
  if (policy === 'blocked_until_product_or_ui_scope') {
    gates.push('explicit_ui_scope_required');
  }
  if (riskFlags.includes('dependency_boundary')) {
    gates.push('dependency_delta_reviewed');
  }
  if (riskFlags.includes('credential_or_channel_boundary')) {
    gates.push('secret_and_channel_config_redacted');
  }
  if (riskFlags.includes('external_side_effect_boundary')) {
    gates.push('side_effects_disabled_by_default');
  }
  return uniq(gates);
}

function analyzeFolder(rootDir, folder) {
  const mapping = getMapping(folder);
  const target = resolveTargetPath(rootDir, folder);
  const exists = folder === 'root-config'
    ? ROOT_CONFIG_FILES.some((name) => fs.existsSync(path.join(rootDir, name)))
    : fs.existsSync(target);
  const scan = exists
    ? folder === 'root-config'
      ? scanRootConfig(rootDir)
      : scanDirectory(target, rootDir)
    : finalizeScan(createEmptyScan());
  const riskFlags = buildRiskFlags(folder, mapping, scan);
  const activationPolicy = pickActivationPolicy(folder, mapping, riskFlags, scan);
  const activationRank = rankActivation(folder, mapping, scan, riskFlags, activationPolicy);
  return {
    folder,
    exists,
    siraSurface: mapping.sira,
    status: mapping.status,
    strategy: mapping.strategy,
    activationPolicy,
    activationRank,
    fileCount: scan.fileCount,
    lineCount: scan.lineCount,
    byteCount: scan.byteCount,
    extensionSummary: scan.extensionSummary,
    packageManifests: scan.packageManifests,
    testSurfaces: scan.testSurfaces,
    configFiles: scan.configFiles,
    sampleFiles: scan.sampleFiles,
    riskFlags,
    qualityGates: buildQualityGates(activationPolicy, riskFlags),
  };
}

function analyzeGitFolder(entries, folder) {
  const mapping = getMapping(folder);
  const scan = scanGitEntries(entries, folder);
  const exists = scan.fileCount > 0;
  const riskFlags = buildRiskFlags(folder, mapping, scan);
  const activationPolicy = pickActivationPolicy(folder, mapping, riskFlags, scan);
  const activationRank = rankActivation(folder, mapping, scan, riskFlags, activationPolicy);
  return {
    folder,
    exists,
    siraSurface: mapping.sira,
    status: mapping.status,
    strategy: mapping.strategy,
    activationPolicy,
    activationRank,
    fileCount: scan.fileCount,
    lineCount: null,
    lineCountMode: scan.lineCountMode,
    byteCount: null,
    byteCountMode: scan.byteCountMode,
    extensionSummary: scan.extensionSummary,
    packageManifests: scan.packageManifests,
    testSurfaces: scan.testSurfaces,
    configFiles: scan.configFiles,
    sampleFiles: scan.sampleFiles,
    riskFlags,
    qualityGates: buildQualityGates(activationPolicy, riskFlags),
  };
}

function buildActivationBudget(folders, opts = {}) {
  const maxActiveSlicesPerPass = Number(opts.maxActiveSlicesPerPass || 3);
  const candidates = folders
    .filter((folder) => folder.exists && folder.activationPolicy === 'native_rewrite_candidate')
    .sort((a, b) => (a.activationRank || 999) - (b.activationRank || 999) || a.folder.localeCompare(b.folder));
  return {
    mode: 'inventory_then_native_slices',
    maxActiveSlicesPerPass,
    rules: [
      'store upstream source only as inactive reference material with MIT attribution',
      'rewrite active behavior inside SiraGPT-owned backend, agent, script, doc, or test surfaces',
      'activate small slices only when owner surface, rollback path, and focused tests are named',
      'keep protected UI, release, credential, and channel code inactive until explicit scope exists',
    ],
    nextSlices: candidates.slice(0, maxActiveSlicesPerPass).map((folder) => ({
      folder: folder.folder,
      siraSurface: folder.siraSurface,
      activationRank: folder.activationRank,
      requiredProof: folder.qualityGates,
    })),
  };
}

function buildTotals(folders) {
  const present = folders.filter((folder) => folder.exists);
  return {
    foldersInventoried: folders.length,
    foldersPresent: present.length,
    files: present.reduce((sum, folder) => sum + folder.fileCount, 0),
    lines: present.reduce((sum, folder) => sum + folder.lineCount, 0),
    bytes: present.reduce((sum, folder) => sum + folder.byteCount, 0),
    packageManifests: present.reduce((sum, folder) => sum + folder.packageManifests.length, 0),
    testSurfaces: present.reduce((sum, folder) => sum + folder.testSurfaces.length, 0),
    nativeRewriteCandidates: present.filter((folder) => folder.activationPolicy === 'native_rewrite_candidate').length,
    blockedOrReferenceOnly: present.filter((folder) => folder.activationPolicy !== 'native_rewrite_candidate').length,
  };
}

function buildGitTreeTotals(folders, entries) {
  const present = folders.filter((folder) => folder.exists);
  const packageManifests = entries.filter((entry) => path.posix.basename(entry.path) === 'package.json').length;
  const testSurfaces = new Set(entries
    .filter((entry) => /\b(test|spec|vitest|playwright|qa|fixture|mock)\b/i.test(entry.path))
    .map((entry) => entry.path.split('/').slice(0, 3).join('/')));
  return {
    foldersInventoried: folders.length,
    foldersPresent: present.length,
    files: entries.length,
    trackedFiles: entries.length,
    inventoriedFiles: entries.length,
    coveragePercent: 100,
    lines: null,
    lineCountMode: 'not_materialized',
    bytes: null,
    byteCountMode: 'not_materialized',
    packageManifests,
    testSurfaces: testSurfaces.size,
    nativeRewriteCandidates: present.filter((folder) => folder.activationPolicy === 'native_rewrite_candidate').length,
    blockedOrReferenceOnly: present.filter((folder) => folder.activationPolicy !== 'native_rewrite_candidate').length,
  };
}

function buildOpenClawSourceInventory(opts = {}) {
  const upstreamRepoRoot = opts.upstreamRepoRoot || path.join(process.cwd(), '.agents', 'openclaw-upstream');
  const sourceRoot = path.resolve(upstreamRepoRoot);
  const gitTree = opts.preferGitTree === false
    ? null
    : readGitTree(sourceRoot, opts.upstreamCommit || 'HEAD');
  if (opts.requireGitTree === true && !gitTree) {
    throw new Error(`Unable to inventory the requested OpenClaw Git tree at ${sourceRoot}`);
  }

  if (gitTree) {
    const licenseEntry = gitTree.entries.find((entry) => entry.path === 'LICENSE');
    const licenseRaw = licenseEntry ? readGitBlob(sourceRoot, gitTree.commit, 'LICENSE', 64 * 1024) : '';
    const license = licenseEntry
      ? detectLicenseText(licenseRaw, 'LICENSE')
      : detectLicenseText('', null);
    const folders = listGitInventoryTargets(gitTree.entries)
      .map((folder) => analyzeGitFolder(gitTree.entries, folder));
    return {
      version: INVENTORY_VERSION,
      source: {
        repository: DEFAULT_REPOSITORY,
        commit: gitTree.commit,
        requestedCommit: opts.upstreamCommit || null,
        license: license.id,
        licenseFile: license.file,
        licenseConfidence: license.confidence,
        licenseHeadline: license.headline || null,
        attributionRequired: license.attributionRequired,
        snapshot: 'external-reference-only',
        inventoryMode: 'git_tree',
        auditRoot: sourceRoot,
        auditedReleaseMatch: gitTree.commit === AUDITED_OPENCLAW_RELEASE.commit
          && gitTree.entries.length === AUDITED_OPENCLAW_RELEASE.trackedFiles,
      },
      coverage: {
        mode: 'git_tree',
        trackedFiles: gitTree.entries.length,
        inventoriedFiles: gitTree.entries.length,
        percent: 100,
        workingTreeMaterializationRequired: false,
      },
      totals: buildGitTreeTotals(folders, gitTree.entries),
      attribution: {
        required: true,
        sourceRepository: DEFAULT_REPOSITORY,
        sourceCommit: gitTree.commit,
        rule: 'MIT notice must remain attached to reference snapshots; active runtime behavior must be SiraGPT-native unless separately reviewed.',
      },
      activationBudget: buildActivationBudget(folders, opts),
      folders,
    };
  }

  const license = detectLicense(sourceRoot);
  const folders = listInventoryTargets(sourceRoot).map((folder) => analyzeFolder(sourceRoot, folder));
  return {
    version: INVENTORY_VERSION,
    source: {
      repository: DEFAULT_REPOSITORY,
      commit: opts.upstreamCommit || detectGitCommit(sourceRoot) || null,
      license: license.id,
      licenseFile: license.file,
      licenseConfidence: license.confidence,
      licenseHeadline: license.headline || null,
      attributionRequired: license.attributionRequired,
      snapshot: 'external-reference-only',
      inventoryMode: 'working_tree',
      auditRoot: sourceRoot,
    },
    coverage: {
      mode: 'working_tree',
      trackedFiles: null,
      inventoriedFiles: buildTotals(folders).files,
      percent: null,
      workingTreeMaterializationRequired: true,
    },
    totals: buildTotals(folders),
    attribution: {
      required: true,
      sourceRepository: DEFAULT_REPOSITORY,
      sourceCommit: opts.upstreamCommit || detectGitCommit(sourceRoot) || null,
      rule: 'MIT notice must remain attached to reference snapshots; active runtime behavior must be SiraGPT-native unless separately reviewed.',
    },
    activationBudget: buildActivationBudget(folders, opts),
    folders,
  };
}

module.exports = {
  AUDITED_OPENCLAW_RELEASE,
  INVENTORY_VERSION,
  buildOpenClawSourceInventory,
};
