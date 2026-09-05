#!/usr/bin/env node
'use strict';

// This is not an npm-audit suppression list. The original report is retained;
// only two exact advisories can be classified as patched-and-verified, using
// the installed, hash-pinned fix. Every other high/critical finding blocks.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const LEVELS = Object.freeze(['info', 'low', 'moderate', 'high', 'critical']);
const ALLOWED_URLS = Object.freeze([
  'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
  'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
]);
const VERIFY_SCRIPT = 'backend/scripts/image-size-security-patch.cjs';
const { PATCHES } = require('../backend/scripts/image-size-security-patch.cjs');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
function fail(message) { const error = new Error(message); error.code = 'BACKEND_AUDIT_BLOCKED'; throw error; }
function expect(condition, message) { if (!condition) fail(message); }
function severity(value) { expect(LEVELS.includes(value), 'Invalid audit severity'); return LEVELS.indexOf(value); }
function parseJson(value, label) {
  expect(typeof value === 'string' && value.trim().length > 0, `${label} produced no JSON`);
  try { return JSON.parse(value); } catch { return fail(`${label} produced invalid JSON`); }
}
function checkProcess(result, label, allowed) {
  expect(object(result) && !result.error && !result.signal && allowed.includes(result.status), `${label} failed or was interrupted`);
}

function classifyAuditReport(report) {
  expect(object(report) && report.auditReportVersion === 2 && !Object.hasOwn(report, 'error'), 'Unsupported or failed npm audit report');
  expect(object(report.vulnerabilities) && object(report.metadata) && object(report.metadata.vulnerabilities)
    && object(report.metadata.dependencies), 'Missing npm audit findings or metadata');
  const counts = report.metadata.vulnerabilities;
  expect(Object.keys(counts).every((level) => [...LEVELS, 'total'].includes(level)), 'Unknown raw npm audit severity count');
  for (const level of [...LEVELS, 'total']) expect(natural(counts[level]), 'Invalid raw npm audit counts');
  expect(counts.total === LEVELS.reduce((sum, level) => sum + counts[level], 0), 'Inconsistent raw npm audit total');
  const dependencies = report.metadata.dependencies;
  expect(natural(dependencies.prod) && natural(dependencies.total) && dependencies.total >= dependencies.prod, 'Invalid npm audit dependency metadata');
  for (const value of Object.values(dependencies)) expect(natural(value), 'Invalid npm audit dependency count');

  const entries = report.vulnerabilities;
  const observed = Object.fromEntries(LEVELS.map((level) => [level, 0]));
  for (const [name, item] of Object.entries(entries)) {
    expect(object(item) && item.name === name && name.length > 0, 'Invalid audit package identity');
    severity(item.severity); observed[item.severity]++;
    expect(Array.isArray(item.via) && item.via.length > 0, 'Missing audit advisory chain');
    expect(Array.isArray(item.nodes) && item.nodes.length > 0 && item.nodes.every((node) =>
      typeof node === 'string' && (node === `node_modules/${name}` || node.startsWith('node_modules/') && node.endsWith(`/node_modules/${name}`))
      && !node.split('/').some((part) => !part || part === '..' || part === '.') && !/[\\\0]/.test(node)),
    'Invalid audit installation paths');
    for (const via of item.via) {
      if (typeof via === 'string') {
        expect(via.length > 0 && Object.hasOwn(entries, via), 'Unresolved transitive audit finding');
      } else {
        expect(object(via) && via.name === name && via.dependency === name && Number.isSafeInteger(via.source) && via.source > 0,
          'Invalid audit advisory identity');
        severity(via.severity);
        expect(typeof via.url === 'string' && /^https:\/\//.test(via.url) && typeof via.title === 'string' && via.title.length > 0,
          'Invalid audit advisory details');
      }
    }
  }
  expect(counts.total === Object.keys(entries).length && LEVELS.every((level) => counts[level] === observed[level]), 'Raw audit counts do not match findings');

  const memo = new Map();
  function resolve(name, stack = new Set()) {
    expect(!stack.has(name), 'Cyclic transitive audit finding');
    if (memo.has(name)) return memo.get(name);
    const next = new Set([...stack, name]);
    const leaves = entries[name].via.flatMap((via) => typeof via === 'string' ? resolve(via, next) : [via]);
    expect(leaves.length > 0 && Math.max(...leaves.map((leaf) => severity(leaf.severity))) === severity(entries[name].severity),
      'Audit package severity does not match advisory chain');
    memo.set(name, leaves); return leaves;
  }
  const blocked = []; const patchedCandidates = new Map(); const affectedPackages = [];
  for (const [name, item] of Object.entries(entries)) {
    const leaves = resolve(name);
    if (severity(item.severity) < severity('high')) continue;
    const high = leaves.filter((leaf) => severity(leaf.severity) >= severity('high'));
    let candidate = true;
    for (const leaf of high) {
      if (leaf.name !== 'image-size' || leaf.dependency !== 'image-size' || leaf.severity !== 'high' || !ALLOWED_URLS.includes(leaf.url)) {
        blocked.push({ package: name, advisoryPackage: leaf.name, source: leaf.source, severity: leaf.severity, url: leaf.url });
        candidate = false;
      } else patchedCandidates.set(leaf.url, { package: leaf.name, source: leaf.source, severity: leaf.severity, url: leaf.url });
    }
    if (candidate) affectedPackages.push(name);
  }
  return { rawCounts: { ...counts }, blocked, patchedCandidates: [...patchedCandidates.values()], affectedPackages };
}

function validatePatchEvidence(evidence, report) {
  expect(object(evidence) && evidence.package === 'image-size' && evidence.version === '1.2.1'
    && evidence.verified === true && evidence.patchedFiles === 0, 'Installed image-size patch is not verified');
  expect(Array.isArray(evidence.advisories) && evidence.advisories.length === ALLOWED_URLS.length
    && ALLOWED_URLS.every((url) => evidence.advisories.includes(url.split('/').pop())), 'Unexpected image-size patch advisories');
  expect(Array.isArray(evidence.copies) && evidence.copies.length > 0, 'Image-size installation evidence is missing');
  const paths = new Set();
  for (const copy of evidence.copies) {
    expect(object(copy) && copy.version === '1.2.1' && typeof copy.path === 'string' && !path.isAbsolute(copy.path)
      && (copy.path === 'image-size' || copy.path.endsWith('/node_modules/image-size')) && !/[\\\0]/.test(copy.path)
      && !copy.path.split('/').some((part) => !part || part === '..' || part === '.') && !paths.has(copy.path), 'Invalid installed image-size copy');
    paths.add(copy.path);
    expect(Array.isArray(copy.files) && copy.files.length === PATCHES.length
      && PATCHES.every((patch) => copy.files.filter((file) => file.file === patch.file && file.sha256 === patch.afterSha256).length === 1),
    'Installed image-size patch hashes do not match');
  }
  const nodes = report.vulnerabilities['image-size']?.nodes;
  expect(Array.isArray(nodes) && nodes.length > 0 && nodes.every((node) => paths.has(node.slice('node_modules/'.length))),
    'Not every audited image-size copy was verified');
  return evidence;
}

function runBackendAuditGate({ root = ROOT, run = spawnSync, print = (text) => process.stdout.write(text) } = {}) {
  const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 };
  const audit = run('npm', ['--prefix', 'backend', 'audit', '--omit=dev', '--json'], options);
  checkProcess(audit, 'npm audit', [0, 1]);
  const report = parseJson(audit.stdout, 'npm audit');
  const classification = classifyAuditReport(report);
  expect(audit.status !== 1 || classification.rawCounts.total > 0, 'npm audit failed without reporting findings');
  // Preserve the full raw npm JSON and its untouched metadata, including
  // advisories mitigated below. A patch never turns npm's high count into 0.
  print(`${audit.stdout.trim()}\n`);
  print(`[backend-audit] raw-counts ${JSON.stringify(classification.rawCounts)}\n`);
  expect(classification.blocked.length === 0, `Unpatched high/critical backend advisories: ${JSON.stringify(classification.blocked)}`);
  let evidence = null;
  if (classification.patchedCandidates.length) {
    const verified = run(process.execPath, [path.join(root, VERIFY_SCRIPT), '--verify'], options);
    checkProcess(verified, 'image-size patch verification', [0]);
    evidence = validatePatchEvidence(parseJson(verified.stdout, 'image-size patch verification'), report);
    print(`[backend-audit] patched-and-verified ${JSON.stringify({ advisories: classification.patchedCandidates,
      affectedPackages: classification.affectedPackages, copies: evidence.copies })}\n`);
  }
  print('[backend-audit] passed: no unpatched high/critical findings; raw npm report retained\n');
  return { report, ...classification, patchedAndVerified: evidence ? classification.patchedCandidates : [], evidence, ok: true };
}

if (require.main === module) {
  try { runBackendAuditGate(); }
  catch (error) {
    console.error(`[backend-audit] ${error?.code === 'BACKEND_AUDIT_BLOCKED' ? error.message : 'Unexpected gate failure'}`);
    process.exitCode = 1;
  }
}
module.exports = { ALLOWED_URLS, classifyAuditReport, validatePatchEvidence, runBackendAuditGate };
