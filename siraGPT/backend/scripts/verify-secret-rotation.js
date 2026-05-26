#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PLACEHOLDER_VALUES = new Set([
  '', 'changeme', 'change-me', 'placeholder', 'example',
  'your-key-here', 'todo', 'xxx', 'xxxx', 'secret', 'password',
]);

const KEY_RULES = {
  OPENAI_API_KEY: { prefix: ['sk-'], minLen: 20 },
  ANTHROPIC_API_KEY: { prefix: ['sk-ant-'], minLen: 20 },
  STRIPE_SECRET_KEY: { prefix: ['sk_live_', 'sk_test_'], minLen: 20 },
  STRIPE_WEBHOOK_SECRET: { prefix: ['whsec_'], minLen: 20 },
  JWT_SECRET: { minLen: 32, minEntropyBits: 128 },
  SESSION_SECRET: { minLen: 32, minEntropyBits: 128 },
  ENCRYPTION_KEY: { minLen: 32, minEntropyBits: 128 },
  LANGFUSE_SECRET_KEY: { prefix: ['sk-lf-'], minLen: 16 },
  LANGSMITH_API_KEY: { minLen: 16 },
  REDIS_URL: { pattern: /^rediss?:\/\// },
  PRISMA_DATABASE_URL: { pattern: /^(mysql|postgres(ql)?):\/\// },
};

function shannonEntropyBits(str) {
  if (!str) return 0;
  const freq = Object.create(null);
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let h = 0;
  const len = str.length;
  for (const k in freq) {
    const p = freq[k] / len;
    h -= p * Math.log2(p);
  }
  return h * len;
}

function fingerprint(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function parseEnvText(text) {
  const out = {};
  if (!text) return out;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function readEnvFile(filePath) {
  if (!filePath) return {};
  if (!fs.existsSync(filePath)) return {};
  return parseEnvText(fs.readFileSync(filePath, 'utf8'));
}

function validateSecret(name, value, rule) {
  const issues = [];
  if (value == null || value === '') {
    issues.push({ level: 'error', code: 'missing', message: `${name} is empty` });
    return issues;
  }
  const lower = String(value).toLowerCase();
  if (PLACEHOLDER_VALUES.has(lower)) {
    issues.push({ level: 'error', code: 'placeholder', message: `${name} looks like a placeholder` });
  }
  if (!rule) return issues;
  if (rule.minLen && value.length < rule.minLen) {
    issues.push({ level: 'error', code: 'too_short', message: `${name} length ${value.length} < ${rule.minLen}` });
  }
  if (rule.prefix && !rule.prefix.some((p) => value.startsWith(p))) {
    issues.push({ level: 'warn', code: 'bad_prefix', message: `${name} missing expected prefix (${rule.prefix.join('|')})` });
  }
  if (rule.pattern && !rule.pattern.test(value)) {
    issues.push({ level: 'error', code: 'bad_pattern', message: `${name} does not match expected pattern` });
  }
  if (rule.minEntropyBits) {
    const bits = shannonEntropyBits(value);
    if (bits < rule.minEntropyBits) {
      issues.push({ level: 'warn', code: 'low_entropy', message: `${name} entropy ${bits.toFixed(0)} < ${rule.minEntropyBits} bits` });
    }
  }
  return issues;
}

function verifyRotation({ current = {}, previous = {}, rules = KEY_RULES, requiredKeys = null } = {}) {
  const report = {
    ok: true,
    checked: 0,
    rotated: [],
    unchanged: [],
    missing: [],
    issues: [],
    fingerprints: {},
  };

  const keys = requiredKeys && requiredKeys.length
    ? requiredKeys
    : Object.keys({ ...rules, ...current, ...previous });

  for (const key of keys) {
    const cur = current[key];
    const prev = previous[key];
    report.checked += 1;
    report.fingerprints[key] = {
      current: fingerprint(cur),
      previous: fingerprint(prev),
    };

    if (cur == null || cur === '') {
      if (rules[key] || (requiredKeys || []).includes(key)) {
        report.missing.push(key);
        report.issues.push({ key, level: 'error', code: 'missing', message: `${key} not set` });
        report.ok = false;
      }
      continue;
    }

    const rule = rules[key];
    const issues = validateSecret(key, cur, rule);
    for (const issue of issues) {
      report.issues.push({ key, ...issue });
      if (issue.level === 'error') report.ok = false;
    }

    if (prev != null && prev !== '') {
      if (prev === cur) {
        report.unchanged.push(key);
        report.issues.push({ key, level: 'warn', code: 'unchanged', message: `${key} not rotated` });
      } else {
        report.rotated.push(key);
      }
    }
  }

  return report;
}

function formatReport(report) {
  const lines = [];
  lines.push(`secret-rotation: checked=${report.checked} rotated=${report.rotated.length} unchanged=${report.unchanged.length} missing=${report.missing.length} ok=${report.ok}`);
  for (const issue of report.issues) {
    lines.push(`  [${issue.level}] ${issue.key}: ${issue.message}`);
  }
  if (report.rotated.length) {
    lines.push(`  rotated: ${report.rotated.join(', ')}`);
  }
  return lines.join('\n');
}

function main(argv) {
  const args = { current: null, previous: null, required: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--current' || a === '-c') args.current = argv[++i];
    else if (a === '--previous' || a === '-p') args.previous = argv[++i];
    else if (a === '--required' || a === '-r') args.required = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write([
        'verify-secret-rotation [options]',
        '  --current <path>     env file with current secrets (default: process.env)',
        '  --previous <path>    env file with previous secrets (optional)',
        '  --required <list>    comma-separated keys required to be present',
        '  --json               output JSON',
        '',
      ].join('\n'));
      return 0;
    }
  }

  const current = args.current ? readEnvFile(path.resolve(args.current)) : { ...process.env };
  const previous = args.previous ? readEnvFile(path.resolve(args.previous)) : {};
  const required = args.required ? args.required.split(',').map((s) => s.trim()).filter(Boolean) : null;

  const report = verifyRotation({ current, previous, requiredKeys: required });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(report) + '\n');
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  verifyRotation,
  validateSecret,
  parseEnvText,
  readEnvFile,
  shannonEntropyBits,
  fingerprint,
  formatReport,
  KEY_RULES,
  PLACEHOLDER_VALUES,
};
