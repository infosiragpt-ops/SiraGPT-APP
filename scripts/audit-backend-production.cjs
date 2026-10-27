#!/usr/bin/env node
'use strict';

// This is not an npm-audit suppression list. The original report is retained;
// only two exact advisories can be classified as patched-and-verified, using
// the installed, hash-pinned fix. Every other high/critical finding blocks —
// except a TIME-BOXED exception approved by the owner and recorded in
// scripts/audit-backend-exceptions.json: one exact advisory URL for one
// package and its exact installed copies, severity high only (never
// critical), at most MAX_EXCEPTION_DAYS long, and blocking again by itself
// the moment it expires. The root/frontend gate never sees these exceptions.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const LEVELS = Object.freeze(['info', 'low', 'moderate', 'high', 'critical']);
const ALLOWED_URLS = Object.freeze([
  'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
  'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
]);
const VERIFY_SCRIPT = 'backend/scripts/image-size-security-patch.cjs';
const EXCEPTIONS_FILE = path.join(__dirname, 'audit-backend-exceptions.json');
const MAX_EXCEPTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const ADVISORY_URL_RE = /^https:\/\/github\.com\/advisories\/GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const PACKAGE_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]{1,214}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const { PATCHES } = require('../backend/scripts/image-size-security-patch.cjs');
const { auditTimeoutMs, runWithAuditRetries } = require('./lib/npm-audit-retry.cjs');
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
/** An npm install path of package `name`: no traversal, no empty component. */
function validNodePath(node, name) {
  return typeof node === 'string' && (node === `node_modules/${name}` || node.startsWith('node_modules/') && node.endsWith(`/node_modules/${name}`))
    && !node.split('/').some((part) => !part || part === '..' || part === '.') && !/[\\\0]/.test(node);
}
/** UTC midnight of a real calendar date (YYYY-MM-DD), or NaN. */
function utcDay(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

/**
 * One recorded exception, validated strictly: an exact GitHub advisory URL,
 * the advisory's package and its exact installed copies, who approved it and
 * why, real creation/expiry dates between 1 and MAX_EXCEPTION_DAYS apart, and
 * a creation date that is not in the future (which would stretch the window).
 * Anything else fails the gate — an invalid exception is never ignored.
 */
function validateException(entry, { now = Date.now() } = {}) {
  expect(object(entry), 'Invalid backend audit exception');
  expect(typeof entry.url === 'string' && ADVISORY_URL_RE.test(entry.url), 'Backend audit exception needs an exact GitHub advisory URL');
  expect(typeof entry.package === 'string' && PACKAGE_RE.test(entry.package), 'Backend audit exception needs the advisory package');
  expect(Array.isArray(entry.nodes) && entry.nodes.length > 0 && new Set(entry.nodes).size === entry.nodes.length
    && entry.nodes.every((node) => validNodePath(node, entry.package)), 'Backend audit exception needs the exact installed copies (nodes) of its package');
  expect(typeof entry.approvedBy === 'string' && entry.approvedBy.trim().length >= 2, 'Backend audit exception needs who approved it');
  expect(typeof entry.reason === 'string' && entry.reason.trim().length >= 20, 'Backend audit exception needs a reason');
  const createdAt = utcDay(entry.createdOn);
  const expiryDay = utcDay(entry.expiresOn);
  expect(Number.isFinite(createdAt) && Number.isFinite(expiryDay), 'Backend audit exception needs real createdOn and expiresOn dates (YYYY-MM-DD)');
  const days = (expiryDay - createdAt) / DAY_MS;
  expect(days >= 1 && days <= MAX_EXCEPTION_DAYS, `Backend audit exception must last between 1 and ${MAX_EXCEPTION_DAYS} days`);
  // One day of slack for time zones ahead of UTC; a later start is refused.
  expect(createdAt <= now + DAY_MS, 'Backend audit exception cannot start in the future');
  return Object.freeze({
    url: entry.url, package: entry.package, nodes: Object.freeze([...entry.nodes]),
    approvedBy: entry.approvedBy, reason: entry.reason, createdOn: entry.createdOn, expiresOn: entry.expiresOn,
    createdAt, expiresAt: expiryDay + DAY_MS - 1,
  });
}

/** The recorded exceptions (none when the file does not exist). */
function loadExceptions(file = EXCEPTIONS_FILE, { now = Date.now() } = {}) {
  if (!fs.existsSync(file)) return [];
  let data;
  // Its own message: "produced invalid JSON" is what the retry helper treats
  // as a transient npm failure, and a broken policy file is not transient.
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('Backend audit exceptions file is not valid JSON'); }
  expect(object(data) && Array.isArray(data.exceptions), 'Invalid backend audit exceptions file');
  const exceptions = data.exceptions.map((entry) => validateException(entry, { now }));
  const keys = exceptions.map((e) => `${e.package} ${e.url}`);
  expect(new Set(keys).size === keys.length, 'Duplicate backend audit exception');
  return exceptions;
}

function classifyAuditReport(report, { exceptions = [], now = Date.now() } = {}) {
  expect(Array.isArray(exceptions), 'Invalid backend audit exceptions');
  const active = exceptions.map((entry) => validateException(entry, { now })).filter((e) => now <= e.expiresAt);
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
    expect(Array.isArray(item.nodes) && item.nodes.length > 0 && item.nodes.every((node) => validNodePath(node, name)),
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
    const leafSeverity = Math.max(...leaves.map((leaf) => severity(leaf.severity)));
    const packageSeverity = severity(entries[name].severity);
    // npm's metavulnerability score can be lower than the direct advisory
    // (observed: monaco-editor low -> dompurify moderate). Preserve that raw
    // report, but accept this only below our high/critical boundary and only
    // for indirect entries. A lowered direct/high/critical finding still fails
    // closed; this grants no advisory exception or patch attestation.
    const nonBlockingMetaScore = entries[name].via.every((via) => typeof via === 'string')
      && packageSeverity < leafSeverity && leafSeverity < severity('high');
    expect(leaves.length > 0 && (leafSeverity === packageSeverity || nonBlockingMetaScore),
      'Audit package severity does not match advisory chain');
    memo.set(name, leaves); return leaves;
  }
  const blocked = []; const patchedCandidates = new Map(); const affectedPackages = []; const excepted = [];
  for (const [name, item] of Object.entries(entries)) {
    const leaves = resolve(name);
    if (severity(item.severity) < severity('high')) continue;
    const high = leaves.filter((leaf) => severity(leaf.severity) >= severity('high'));
    let candidate = true;
    for (const leaf of high) {
      if (leaf.name === 'image-size' && leaf.dependency === 'image-size' && leaf.severity === 'high' && ALLOWED_URLS.includes(leaf.url)) {
        patchedCandidates.set(leaf.url, { package: leaf.name, source: leaf.source, severity: leaf.severity, url: leaf.url });
        continue;
      }
      candidate = false;
      // A recorded, unexpired exception covers exactly one advisory of one
      // package at severity high, and only while every audited copy of that
      // package is one the exception names (a new vulnerable copy blocks).
      // A critical finding is never excepted.
      const advisoryNodes = entries[leaf.name].nodes;
      const exception = leaf.severity === 'high' && leaf.dependency === leaf.name
        && active.find((e) => e.url === leaf.url && e.package === leaf.name && advisoryNodes.every((node) => e.nodes.includes(node)));
      if (exception) {
        excepted.push({ package: name, advisoryPackage: leaf.name, source: leaf.source, severity: leaf.severity, url: leaf.url, expiresOn: exception.expiresOn });
        continue;
      }
      blocked.push({ package: name, advisoryPackage: leaf.name, source: leaf.source, severity: leaf.severity, url: leaf.url });
    }
    if (candidate) affectedPackages.push(name);
  }
  return { rawCounts: { ...counts }, blocked, patchedCandidates: [...patchedCandidates.values()], affectedPackages, excepted };
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

function runBackendAuditGate({
  root = ROOT,
  run = spawnSync,
  print = (text) => process.stdout.write(text),
  now = Date.now(),
  exceptions = loadExceptions(EXCEPTIONS_FILE, { now }),
} = {}) {
  expect(Array.isArray(exceptions), 'Invalid backend audit exceptions');
  const recorded = exceptions.map((entry) => validateException(entry, { now }));
  const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: auditTimeoutMs(), maxBuffer: 16 * 1024 * 1024 };
  const audit = run('npm', ['--prefix', 'backend', 'audit', '--omit=dev', '--json'], options);
  checkProcess(audit, 'npm audit', [0, 1]);
  const report = parseJson(audit.stdout, 'npm audit');
  const classification = classifyAuditReport(report, { exceptions: recorded, now });
  expect(audit.status !== 1 || classification.rawCounts.total > 0, 'npm audit failed without reporting findings');
  // Preserve the full raw npm JSON and its untouched metadata, including
  // advisories mitigated below. A patch never turns npm's high count into 0.
  print(`${audit.stdout.trim()}\n`);
  print(`[backend-audit] raw-counts ${JSON.stringify(classification.rawCounts)}\n`);
  const used = new Set(classification.excepted.map((item) => `${item.advisoryPackage} ${item.url}`));
  for (const e of recorded) {
    if (now > e.expiresAt) {
      print(`[backend-audit] exception EXPIRED on ${e.expiresOn}: ${e.package} ${e.url} blocks again — finish the fix or get a new owner approval\n`);
    } else if (used.has(`${e.package} ${e.url}`)) {
      print(`::warning title=Backend audit exception::${e.package} ${e.url} is NOT fixed; excepted until ${e.expiresOn} (approved by ${e.approvedBy}), then it blocks again\n`);
    } else {
      print(`[backend-audit] exception no longer needed (advisory not in the report) — remove it: ${e.package} ${e.url}\n`);
    }
  }
  if (classification.excepted.length) {
    print(`[backend-audit] time-boxed exceptions (NOT fixed; owner-approved, they block again when they expire): ${JSON.stringify(classification.excepted)}\n`);
  }
  expect(classification.blocked.length === 0, `Unpatched high/critical backend advisories: ${JSON.stringify(classification.blocked)}`);
  let evidence = null;
  if (classification.patchedCandidates.length) {
    const verified = run(process.execPath, [path.join(root, VERIFY_SCRIPT), '--verify'], options);
    checkProcess(verified, 'image-size patch verification', [0]);
    evidence = validatePatchEvidence(parseJson(verified.stdout, 'image-size patch verification'), report);
    print(`[backend-audit] patched-and-verified ${JSON.stringify({ advisories: classification.patchedCandidates,
      affectedPackages: classification.affectedPackages, copies: evidence.copies })}\n`);
  }
  print(classification.excepted.length
    ? `[backend-audit] passed with ${new Set(classification.excepted.map((item) => item.url)).size} time-boxed exception(s); no other unpatched high/critical findings; raw npm report retained\n`
    : '[backend-audit] passed: no unpatched high/critical findings; raw npm report retained\n');
  return { report, ...classification, patchedAndVerified: evidence ? classification.patchedCandidates : [], evidence, ok: true };
}

if (require.main === module) {
  // Transport failures of npm's audit endpoint are retried (bounded); a real
  // unpatched high/critical finding is not — it fails on the first attempt.
  try { runWithAuditRetries(() => runBackendAuditGate(), { label: 'backend-audit' }); }
  catch (error) {
    console.error(`[backend-audit] ${error?.code === 'BACKEND_AUDIT_BLOCKED' ? error.message : 'Unexpected gate failure'}`);
    process.exitCode = 1;
  }
}
module.exports = {
  ALLOWED_URLS,
  MAX_EXCEPTION_DAYS,
  classifyAuditReport,
  validatePatchEvidence,
  validateException,
  loadExceptions,
  runBackendAuditGate,
};
