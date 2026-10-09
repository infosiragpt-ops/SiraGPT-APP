#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────
// siraGPT — Migration Safety Checker (cycle 34)
// ──────────────────────────────────────────────────────────────
// Scans Prisma migration SQL under `backend/prisma/migrations` and
// flags destructive operations that would risk data loss or
// unsafe production rollouts:
//
//   - DROP TABLE / DROP COLUMN
//   - ALTER COLUMN ... TYPE      (lossy type changes)
//   - SET NOT NULL with no DEFAULT (back-fill missing)
//   - Renames without an opt-in "two-phase" marker
//   - Credential hashes or user-password mutations in migration SQL
//
// Exits non-zero on any unsafe operation unless the migration file
// (or commit message via env MIGRATION_SAFETY_OVERRIDE=1) explicitly
// acknowledges it with a header line. Credential findings are forbidden and
// cannot be overridden:
//
//   -- migration-safety: allow-destructive reason="planned column drop, no data"
//
// Two-phase rename rule:
//   Renames must first land as an additive "deprecate" migration
//   (add new column, dual-write) and only later remove the old
//   column in a separate migration tagged with:
//     -- migration-safety: phase-2-remove of=<old_name>
//
// Wired into .github/workflows/deploy.yml pre-check.
// ──────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'backend', 'prisma', 'migrations');

const argv = process.argv.slice(2);
const opts = {
  // Pending mode requires a real Git baseline (never guesses applied history).
  pending: argv.includes('--pending-only'),
  override: argv.includes('--allow-destructive') || process.env.MIGRATION_SAFETY_OVERRIDE === '1',
  json: argv.includes('--json'),
  baseRef: argv.find(arg => arg.startsWith('--base-ref='))?.slice('--base-ref='.length)
    || (argv.includes('--base-ref') ? argv[argv.indexOf('--base-ref') + 1] : null),
};

const RULES = [
  { id: 'truncate-data', label: 'TRUNCATE', pattern: /\bTRUNCATE\b/i, severity: 'unsafe',
    hint: 'Deleting existing data is not an additive migration.' },
  { id: 'delete-data', label: 'DELETE FROM', pattern: /\bDELETE\s+FROM\b/i, severity: 'unsafe',
    hint: 'Data removals need an explicit reviewed retention/backfill plan.' },
  { id: 'add-required-no-default', label: 'ADD NOT NULL without DEFAULT',
    pattern: /\bALTER\s+TABLE\b[^;]*\bADD\s+(?:COLUMN\s+)?[^;]*\bNOT\s+NULL\b(?![^;]*\bDEFAULT\b)/i,
    severity: 'unsafe', hint: 'Add nullable, backfill existing rows, then constrain in a later migration.' },
  {
    id: 'credential-hash-literal',
    label: 'VERSIONED CREDENTIAL HASH',
    pattern: /\$(?:2[abxy]|argon2(?:id|i|d))\$/i,
    severity: 'forbidden',
    hint: 'Credentials must be supplied through an audited one-shot rotation, never migration SQL.',
  },
  {
    id: 'user-password-dml',
    label: 'USER PASSWORD DML',
    pattern: /\b(?:INSERT\s+INTO|UPDATE)\s+"?users"?\b[\s\S]*?\bpassword\b/i,
    severity: 'forbidden',
    hint: 'Do not create or reset user credentials from a migration.',
  },
  {
    id: 'drop-table',
    label: 'DROP TABLE',
    pattern: /\bDROP\s+TABLE\b(?!\s+IF\s+EXISTS\s+"_prisma_migrations")/i,
    severity: 'unsafe',
    hint: 'Use two-phase: stop writing to the table first, then drop in a later migration.',
  },
  {
    id: 'drop-column',
    label: 'DROP COLUMN',
    pattern: /\bDROP\s+COLUMN\b/i,
    severity: 'unsafe',
    hint: 'Two-phase: deprecate the column (stop writing), wait one release, then drop.',
  },
  {
    id: 'alter-type',
    label: 'ALTER COLUMN ... TYPE',
    pattern: /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
    severity: 'unsafe',
    hint: 'Lossy type changes need a USING expression and offline migration.',
  },
  {
    id: 'set-not-null-no-default',
    label: 'SET NOT NULL without DEFAULT',
    test: (sql) => {
      // crude scan: SET NOT NULL lines that don't have a DEFAULT in the same statement
      const matches = sql.match(/[^;]*SET\s+NOT\s+NULL[^;]*;/gi) || [];
      return matches.some((stmt) => !/DEFAULT\s+/i.test(stmt));
    },
    severity: 'unsafe',
    hint: 'Back-fill existing rows first, then SET NOT NULL in a follow-up migration.',
  },
  {
    id: 'rename-column',
    label: 'RENAME COLUMN',
    pattern: /\bRENAME\s+COLUMN\b/i,
    severity: 'two-phase',
    hint: 'Renames must be two-phase: add new column + dual-write, then drop old in a later migration.',
  },
  {
    id: 'rename-table',
    label: 'RENAME TO (table rename)',
    pattern: /\bALTER\s+TABLE\b[^;]*\bRENAME\s+TO\b/i,
    severity: 'two-phase',
    hint: 'Table renames must be two-phase: create new + dual-write, drop old later.',
  },
];

function findMigrationFiles(root = ROOT) {
  const migrationsDir = path.join(root, 'backend/prisma/migrations');
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((d) => fs.statSync(path.join(migrationsDir, d)).isDirectory())
    .map((d) => path.join(migrationsDir, d, 'migration.sql'))
    .filter((p) => fs.existsSync(p));
}

function readAllowMarker(sql) {
  const allowed = new Set();
  const re = /--\s*migration-safety:\s*([^\n]+)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const directive = m[1].trim().toLowerCase();
    if (directive.startsWith('allow-destructive')) allowed.add('allow-destructive');
    if (directive.startsWith('phase-2-remove')) allowed.add('phase-2-remove');
    if (directive.startsWith('allow-rename')) allowed.add('allow-rename');
  }
  return allowed;
}

function scanFile(filePath, root = ROOT) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const markers = readAllowMarker(sql);
  const findings = [];
  for (const rule of RULES) {
    const hit = rule.test ? rule.test(sql) : rule.pattern.test(sql);
    if (!hit) continue;
    // Marker handling per severity
    if (rule.severity === 'unsafe' && (markers.has('allow-destructive') || markers.has('phase-2-remove'))) {
      continue; // explicitly acknowledged
    }
    if (rule.severity === 'two-phase' && markers.has('allow-rename')) {
      continue;
    }
    findings.push({
      file: path.relative(root, filePath),
      ruleId: rule.id,
      label: rule.label,
      severity: rule.severity,
      hint: rule.hint,
    });
  }
  return findings;
}

function scanRepository(baseRef, { root = ROOT } = {}) {
  const files = findMigrationFiles(root);
  if (!baseRef) return { files, findings: files.flatMap(file => scanFile(file, root)), baseRef: null };
  if (!/^[a-zA-Z0-9_./:-]+$/.test(baseRef)) throw new Error('Invalid base reference');
  const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
  const baseSha = git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]).toString().trim();
  const baseFiles = git(['ls-tree', '-r', '-z', '--name-only', baseSha, '--', 'backend/prisma/migrations'])
    .toString().split('\0').filter(file => file.endsWith('/migration.sql'));
  const historical = new Set(baseFiles);
  const findings = [];
  for (const file of baseFiles) {
    const absolute = path.join(root, file);
    const unchanged = fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()
      && !fs.lstatSync(absolute).isSymbolicLink()
      && fs.readFileSync(absolute).equals(git(['show', `${baseSha}:${file}`]));
    if (!unchanged) findings.push({ file, ruleId: 'migration-history-mutated', label: 'HISTORICAL MIGRATION CHANGED OR DELETED',
      severity: 'forbidden', hint: 'Applied migration bytes are immutable. Add a new reviewed migration instead.' });
  }
  const pending = files.filter(file => !historical.has(path.relative(root, file).split(path.sep).join('/')));
  const newestHistorical = baseFiles.map(file => path.basename(path.dirname(file))).sort().at(-1);
  for (const file of pending) {
    if (newestHistorical && path.basename(path.dirname(file)) <= newestHistorical) findings.push({
      file: path.relative(root, file), ruleId: 'migration-history-backdated', label: 'BACKDATED MIGRATION', severity: 'forbidden',
      hint: 'New migrations must sort after the baseline history.' });
    findings.push(...scanFile(file, root));
  }
  return { files: pending, historicalFiles: baseFiles.length, findings, baseRef: baseSha };
}

function main() {
  if (opts.pending && !opts.baseRef) throw new Error('--pending-only requires --base-ref; applied history cannot be guessed');
  const result = scanRepository(opts.baseRef);
  const { files, findings } = result;

  if (opts.json) {
    process.stdout.write(JSON.stringify({ files: files.length, historicalFiles: result.historicalFiles || 0, baseRef: result.baseRef, findings }, null, 2) + '\n');
  } else {
    console.log(`[check-migration-safety] scanned ${files.length} migration file(s)`);
    if (!findings.length) {
      console.log('[check-migration-safety] OK — no unsafe operations detected');
    } else {
      console.error(`[check-migration-safety] FOUND ${findings.length} unsafe operation(s):`);
      for (const f of findings) {
        console.error(
          `  - ${f.file}\n      ${f.severity.toUpperCase()} ${f.label} (${f.ruleId})\n      hint: ${f.hint}`,
        );
      }
    }
  }

  const hasForbiddenFinding = findings.some((finding) => finding.severity === 'forbidden');
  if (findings.length && (!opts.override || hasForbiddenFinding)) {
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[check-migration-safety] fatal:', err && err.message ? err.message : err);
    process.exit(2);
  }
}

module.exports = { scanFile, findMigrationFiles, scanRepository, RULES };
