#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { classifyAuditReport } = require('./audit-backend-production.cjs');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'audit-production-allowlist.json');
const RANK = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);

function readConfig(configPath = CONFIG_PATH, now = Date.now()) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.allowed)) {
    throw new Error('audit-production-allowlist.json must include an allowed array');
  }

  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) {
    throw new Error('audit production allowlist received an invalid clock value');
  }
  // An empty list grants no exception and must not acquire a fake expiry.
  // Every actual exception still requires a valid, non-expired deadline.
  if (config.allowed.length > 0) {
    const expiresOn = new Date(`${config.expiresOn}T23:59:59.999Z`);
    if (!Number.isFinite(expiresOn.getTime())) {
      throw new Error('audit-production-allowlist.json has an invalid expiresOn date');
    }
    if (nowMs > expiresOn.getTime()) {
      throw new Error(`production audit allowlist expired on ${config.expiresOn}`);
    }
  }

  const level = config.level || 'high';
  if (!RANK.has(level)) {
    throw new Error(`unsupported audit allowlist level: ${level}`);
  }

  for (const item of config.allowed) {
    if (!item || typeof item.package !== 'string' || typeof item.source !== 'number') {
      throw new Error('audit-production-allowlist.json allowed entries require package and numeric source');
    }
  }

  return {
    level,
    minRank: RANK.get(level),
    allowed: new Set(config.allowed.map((item) => `${item.package}:${item.source}`)),
  };
}

function runAudit({ run = spawnSync } = {}) {
  const result = run('npm', ['audit', '--omit=dev', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });

  if (!result || result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error('npm audit process failed or was interrupted');
  if (typeof result.stdout !== 'string' || !result.stdout.trim())
    throw new Error('npm audit produced no JSON output');
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error('failed to parse npm audit JSON');
  }
  // Reuse only schema/chain validation. Root/frontend findings still go
  // through its own allowlist policy: NEVER inherit the backend patch grant.
  const validation = classifyAuditReport(report);
  if (result.status === 1 && validation.rawCounts.total === 0)
    throw new Error('npm audit failed without reporting findings');
  return report;
}

function getRank(severity) {
  return RANK.get(severity || 'info') ?? 0;
}

function collectFindings(report, config) {
  const blocked = [];
  const accepted = [];
  const vulnerabilities = report.vulnerabilities || {};

  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    for (const via of vulnerability.via || []) {
      if (!via || typeof via !== 'object') continue;
      if (getRank(via.severity) < config.minRank) continue;

      const key = `${name}:${via.source}`;
      const finding = {
        key,
        name,
        source: via.source,
        severity: via.severity,
        title: via.title || '(untitled advisory)',
        url: via.url || '',
      };

      if (config.allowed.has(key)) accepted.push(finding);
      else blocked.push(finding);
    }
  }

  return { accepted, blocked };
}

function printFinding(prefix, finding) {
  const url = finding.url ? ` ${finding.url}` : '';
  console.log(`${prefix} ${finding.name}:${finding.source} [${finding.severity}] ${finding.title}${url}`);
}

function main() {
  const config = readConfig();
  const report = runAudit();
  const { accepted, blocked } = collectFindings(report, config);

  for (const finding of accepted) printFinding('[audit-allowlist] accepted', finding);

  if (blocked.length > 0) {
    for (const finding of blocked) printFinding('[audit-allowlist] blocked', finding);
    throw new Error(
      `${blocked.length} unallowlisted production advisories at ${config.level}+ severity`,
    );
  }

  const total = report.metadata?.vulnerabilities?.total ?? 0;
  console.log(
    `[audit-allowlist] ok: ${accepted.length} tracked ${config.level}+ advisories, ${total} total npm audit advisories`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\n[audit-allowlist] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  RANK,
  collectFindings,
  getRank,
  main,
  readConfig,
  runAudit,
};
