#!/usr/bin/env node
'use strict';

const path = require('path');
const { auditI18n, formatReport } = require('./audit');

function parseArgs(argv) {
  const opts = { codeDirs: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--messages') opts.messagesDir = argv[++i];
    else if (a === '--base') opts.baseLocale = argv[++i];
    else if (a === '--code') opts.codeDirs.push(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function usage() {
  return [
    'Usage: node backend/src/i18n/cli.js [options]',
    '  --messages <dir>   Directory with locale JSON files (default: ./messages)',
    '  --code <dir>       Source directory to scan (repeatable; default: app components)',
    '  --base <locale>    Base locale (default: en)',
    '  --json             Output JSON report instead of text',
    '  --strict           Exit non-zero if missing or unused keys are found',
  ].join('\n');
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const root = process.cwd();
  const messagesDir = opts.messagesDir || path.join(root, 'messages');
  const codeDirs =
    opts.codeDirs.length > 0
      ? opts.codeDirs
      : [path.join(root, 'app'), path.join(root, 'components')];

  const report = auditI18n({
    messagesDir,
    codeDirs,
    baseLocale: opts.baseLocale || 'en',
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }

  if (opts.strict && (report.missing.length > 0 || report.unused.length > 0)) {
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
