// Sanity guardrail: ensures `prisma/schema.prisma` is already canonically
// formatted and semantically valid. Spawns `npx prisma format` against a
// throw-away copy and diffs the result; spawns `npx prisma validate`
// against the real file.
//
// Skipped in CI by default — set `RUN_PRISMA_SCHEMA_TESTS=1` to enable.
// Useful locally before pushing schema-touching changes.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');
const SHOULD_RUN =
  process.env.RUN_PRISMA_SCHEMA_TESTS === '1' ||
  process.env.RUN_PRISMA_SCHEMA_TESTS === 'true';

// Default: skip in CI (and any environment that does not opt in) so the
// matrix doesn't depend on prisma CLI being installed / network resolvable.
const skip = !SHOULD_RUN
  ? 'set RUN_PRISMA_SCHEMA_TESTS=1 to enable prisma schema guardrail tests'
  : false;

test('prisma schema is canonically formatted (format-idempotent)', { skip }, () => {
  assert.ok(fs.existsSync(SCHEMA_PATH), `expected schema at ${SCHEMA_PATH}`);

  const original = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-fmt-'));
  const tmpSchema = path.join(tmpDir, 'schema.prisma');

  try {
    fs.writeFileSync(tmpSchema, original);

    const res = spawnSync('npx', ['--no-install', 'prisma', 'format', `--schema=${tmpSchema}`], {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });

    assert.equal(
      res.status,
      0,
      `prisma format exited with ${res.status}: ${res.stderr || res.stdout}`,
    );

    const formatted = fs.readFileSync(tmpSchema, 'utf8');
    assert.equal(
      formatted,
      original,
      'schema.prisma is not canonically formatted — run `npx prisma format` and commit the diff',
    );
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('prisma schema validates', { skip }, () => {
  const res = spawnSync('npx', ['--no-install', 'prisma', 'validate', `--schema=${SCHEMA_PATH}`], {
    encoding: 'utf8',
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });

  assert.equal(
    res.status,
    0,
    `prisma validate exited with ${res.status}: ${res.stderr || res.stdout}`,
  );
});
