#!/usr/bin/env node
'use strict';

/**
 * Sync OpenClaw + Hermes upstream content into SiraGPT platform folders.
 * Populates `<folder>/upstream/openclaw/` and `<folder>/upstream/hermes/`.
 *
 * Usage:
 *   node backend/scripts/sync-platform-upstream.js
 *   node backend/scripts/sync-platform-upstream.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OPENCLAW = process.env.OPENCLAW_UPSTREAM_PATH || '/tmp/openclaw-reference';
const HERMES = process.env.HERMES_UPSTREAM_PATH || '/tmp/hermes-agent';

const EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.next',
  'uv.lock',
  'package-lock.json',
  '*.pyc',
];

const OPENCLAW_FOLDER_MAP = Object.freeze({
  '.agents': ['.agents'],
  '.github': ['.github'],
  '.vscode': ['.vscode'],
  apps: ['apps'],
  changelog: ['changelog'],
  config: ['config'],
  deploy: ['deploy'],
  docs: ['docs'],
  extensions: ['extensions'],
  'git-hooks': ['git-hooks'],
  packages: ['packages'],
  patches: ['patches'],
  qa: ['qa'],
  scripts: ['scripts'],
  security: ['security'],
  skills: ['skills'],
  src: ['src'],
  test: ['test'],
  ui: ['ui'],
});

const HERMES_FOLDER_MAP = Object.freeze({
  '.agents': ['AGENTS.md', 'hermes_bootstrap.py', 'hermes_constants.py'],
  '.github': ['.github'],
  changelog: ['RELEASE_v0.14.0.md', 'RELEASE_v0.13.0.md', 'RELEASE_v0.12.0.md'],
  config: ['cli-config.yaml.example', '.env.example', 'flake.nix'],
  deploy: ['docker', 'docker-compose.yml', 'Dockerfile', 'setup-hermes.sh'],
  docs: ['docs', 'website/docs'],
  extensions: ['plugins'],
  packages: ['ui-tui/packages'],
  qa: ['tests/e2e', 'tests/integration'],
  scripts: ['scripts'],
  security: ['SECURITY.md'],
  skills: ['skills', 'optional-skills'],
  src: ['agent', 'gateway', 'tools', 'hermes_cli', 'run_agent.py', 'cli.py', 'toolsets.py', 'trajectory_compressor.py', 'hermes_state.py'],
  test: ['tests'],
  ui: ['ui-tui', 'web'],
  apps: ['web'],
});

function shouldCopyPath(srcPath) {
  const parts = srcPath.split(path.sep);
  for (const part of parts) {
    if (EXCLUDES.includes(part)) return false;
    if (part.endsWith('.pyc')) return false;
  }
  return true;
}

function wipeDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function cpCopy(src, dest, dryRun = false) {
  if (!fs.existsSync(src)) return { copied: false, reason: 'source_missing', src };
  if (dryRun) return { copied: true, dryRun: true, src, dest };

  const stat = fs.lstatSync(src);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return { copied: true, src, dest };
  }

  fs.mkdirSync(dest, { recursive: true });
  const excludeArgs = EXCLUDES.flatMap((e) => ['--exclude', e]);
  try {
    execSync(
      ['rsync', '-a', '--no-times', '--omit-dir-times', '--no-perms', ...excludeArgs, `${src}/`, `${dest}/`].join(' '),
      { stdio: 'pipe' },
    );
    return { copied: true, src, dest };
  } catch (err) {
    return { copied: false, reason: err.message, src, dest };
  }
}

function copyFile(src, dest, dryRun = false) {
  if (!fs.existsSync(src)) return { copied: false, reason: 'source_missing', src };
  if (dryRun) return { copied: true, dryRun: true, src, dest };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return { copied: true, src, dest };
}

function writeSnapshot(folder, payload) {
  const target = path.join(REPO_ROOT, folder, 'upstream', 'SNAPSHOT.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n');
}

function syncOpenClaw(dryRun) {
  const results = [];
  const sha = execSync(`git -C "${OPENCLAW}" rev-parse HEAD`, { encoding: 'utf8' }).trim();

  for (const [destFolder, sources] of Object.entries(OPENCLAW_FOLDER_MAP)) {
    const destBase = path.join(REPO_ROOT, destFolder, 'upstream', 'openclaw');
    if (!dryRun) wipeDir(destBase);
    for (const rel of sources) {
      const src = path.join(OPENCLAW, rel);
      const dest = path.join(destBase, rel === sources[0] && sources.length === 1 ? '' : path.basename(rel));
      if (sources.length === 1) {
        results.push({ ...cpCopy(src, destBase, dryRun), folder: destFolder, upstream: 'openclaw' });
      } else {
        results.push({ ...cpCopy(src, dest, dryRun), folder: destFolder, upstream: 'openclaw' });
      }
    }
    writeSnapshot(destFolder, {
      upstream: 'openclaw',
      repository: 'https://github.com/openclaw/openclaw',
      commit: sha,
      syncedAt: new Date().toISOString().slice(0, 10),
      license: 'MIT',
      paths: sources,
    });
  }
  return { sha, results };
}

function syncHermes(dryRun) {
  const results = [];
  const sha = execSync(`git -C "${HERMES}" rev-parse HEAD`, { encoding: 'utf8' }).trim();

  for (const [destFolder, sources] of Object.entries(HERMES_FOLDER_MAP)) {
    const destBase = path.join(REPO_ROOT, destFolder, 'upstream', 'hermes');
    if (!dryRun) wipeDir(destBase);
    for (const rel of sources) {
      const src = path.join(HERMES, rel);
      const dest = path.join(destBase, rel);
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        results.push({ ...copyFile(src, dest, dryRun), folder: destFolder, upstream: 'hermes' });
      } else {
        results.push({ ...cpCopy(src, dest, dryRun), folder: destFolder, upstream: 'hermes' });
      }
    }
    const existing = path.join(REPO_ROOT, destFolder, 'upstream', 'SNAPSHOT.json');
    let snapshot = {};
    try { snapshot = JSON.parse(fs.readFileSync(existing, 'utf8')); } catch { /* */ }
    snapshot.hermes = {
      repository: 'https://github.com/NousResearch/hermes-agent',
      commit: sha,
      syncedAt: new Date().toISOString().slice(0, 10),
      license: 'MIT',
      paths: sources,
    };
    if (!dryRun) writeSnapshot(destFolder, snapshot);
  }
  return { sha, results };
}

function writeUpstreamReadme(folder) {
  const dir = path.join(REPO_ROOT, folder, 'upstream');
  const snapPath = path.join(dir, 'SNAPSHOT.json');
  let snapshot = {};
  try { snapshot = JSON.parse(fs.readFileSync(snapPath, 'utf8')); } catch { return; }

  const hasOc = fs.existsSync(path.join(dir, 'openclaw'));
  const hasHm = fs.existsSync(path.join(dir, 'hermes'));

  const lines = [
    '# Upstream reference (MIT)',
    '',
    'Contenido real sincronizado desde OpenClaw y Hermes. **No es runtime activo** —',
    'SiraGPT adapta patrones en `backend/src/services/agents/`.',
    '',
    'Refrescar: `npm run agent:platform:sync`',
    '',
  ];

  if (hasOc) {
    lines.push('## OpenClaw → `upstream/openclaw/`');
    lines.push(`- Repo: ${snapshot.repository || 'https://github.com/openclaw/openclaw'}`);
    if (snapshot.commit) lines.push(`- Commit: \`${snapshot.commit}\``);
    if (snapshot.paths?.length) lines.push(`- Paths: ${snapshot.paths.join(', ')}`);
    lines.push('');
  }

  if (hasHm && snapshot.hermes) {
    lines.push('## Hermes → `upstream/hermes/`');
    lines.push(`- Repo: ${snapshot.hermes.repository}`);
    lines.push(`- Commit: \`${snapshot.hermes.commit}\``);
    if (snapshot.hermes.paths?.length) lines.push(`- Paths: ${snapshot.hermes.paths.join(', ')}`);
    lines.push('');
  }

  fs.writeFileSync(path.join(dir, 'README.md'), lines.join('\n') + '\n');
}

function writeAllUpstreamReadmes() {
  for (const folder of Object.keys(OPENCLAW_FOLDER_MAP)) {
    writeUpstreamReadme(folder);
  }
}

function copyLicenses(dryRun) {
  if (dryRun) return;
  for (const folder of Object.keys(OPENCLAW_FOLDER_MAP)) {
    const dir = path.join(REPO_ROOT, folder, 'upstream');
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(path.join(OPENCLAW, 'LICENSE'))) {
      fs.copyFileSync(path.join(OPENCLAW, 'LICENSE'), path.join(dir, 'OPENCLAW-LICENSE'));
    }
    if (fs.existsSync(path.join(HERMES, 'LICENSE'))) {
      fs.copyFileSync(path.join(HERMES, 'LICENSE'), path.join(dir, 'HERMES-LICENSE'));
    }
  }
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!fs.existsSync(OPENCLAW)) {
    console.error(`OpenClaw clone missing at ${OPENCLAW}. Run: git clone --depth 1 https://github.com/openclaw/openclaw.git ${OPENCLAW}`);
    process.exit(1);
  }
  if (!fs.existsSync(HERMES)) {
    console.error(`Hermes clone missing at ${HERMES}`);
    process.exit(1);
  }

  console.log(`Syncing platform upstream content → ${REPO_ROOT}`);
  console.log(`OpenClaw: ${OPENCLAW}`);
  console.log(`Hermes: ${HERMES}`);
  if (dryRun) console.log('DRY RUN');

  const openclaw = syncOpenClaw(dryRun);
  const hermes = syncHermes(dryRun);
  copyLicenses(dryRun);
  if (!dryRun) writeAllUpstreamReadmes();

  const ok = [...openclaw.results, ...hermes.results].filter((r) => r.copied).length;
  const fail = [...openclaw.results, ...hermes.results].filter((r) => !r.copied).length;

  console.log(`\nDone. copied=${ok} failed=${fail}`);
  console.log(`OpenClaw @ ${openclaw.sha}`);
  console.log(`Hermes @ ${hermes.sha}`);
  if (fail > 0) process.exit(1);
}

main();
