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
//
// Exits non-zero on any unsafe operation unless the migration file
// (or commit message via env MIGRATION_SAFETY_OVERRIDE=1) explicitly
// acknowledges it with a header line:
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

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'backend', 'prisma', 'migrations');

const argv = process.argv.slice(2);
const opts = {
  // Only check migrations newer than this many in the queue (default: all)
  pending: argv.includes('--pending-only'),
  override: argv.includes('--allow-destructive') || process.env.MIGRATION_SAFETY_OVERRIDE === '1',
  json: argv.includes('--json'),
};

const RULES = [
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

function findMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) => fs.statSync(path.join(MIGRATIONS_DIR, d)).isDirectory())
    .map((d) => path.join(MIGRATIONS_DIR, d, 'migration.sql'))
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

function scanFile(filePath) {
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
      file: path.relative(ROOT, filePath),
      ruleId: rule.id,
      label: rule.label,
      severity: rule.severity,
      hint: rule.hint,
    });
  }
  return findings;
}

function main() {
  const files = findMigrationFiles();
  const findings = [];
  for (const f of files) {
    findings.push(...scanFile(f));
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ files: files.length, findings }, null, 2) + '\n');
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

  if (findings.length && !opts.override) {
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

module.exports = { scanFile, findMigrationFiles, RULES };
