#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'audit-production-allowlist.json');
const RANK = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);

function readConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(config.allowed)) {
    throw new Error('audit-production-allowlist.json must include an allowed array');
  }

  const expiresOn = new Date(`${config.expiresOn}T23:59:59.999Z`);
  if (!Number.isFinite(expiresOn.getTime())) {
    throw new Error('audit-production-allowlist.json has an invalid expiresOn date');
  }
  if (Date.now() > expiresOn.getTime()) {
    throw new Error(`production audit allowlist expired on ${config.expiresOn}`);
  }

  const level = config.level || 'high';
  if (!RANK.has(level)) {
    throw new Error(`unsupported audit allowlist level: ${level}`);
  }

  return {
    level,
    minRank: RANK.get(level),
    allowed: new Set(config.allowed.map((item) => `${item.package}:${item.source}`)),
  };
}

function runAudit() {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });

  if (!result.stdout) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`npm audit produced no JSON output (exit ${result.status})`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`failed to parse npm audit JSON: ${error.message}`);
  }
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

try {
  main();
} catch (error) {
  console.error(`\n[audit-allowlist] ${error.message}`);
  process.exit(1);
}
