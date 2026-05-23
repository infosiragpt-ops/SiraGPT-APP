import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');
const script = path.join(root, 'scripts', 'quality-100-checks.js');

describe('quality:100 repository gate', () => {
  it('runs exactly 100 complete quality checks with no failures', () => {
    const result = spawnSync(process.execPath, [script, '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.total, 100);
    assert.equal(report.passed, 100);
    assert.equal(report.failed, 0);
    assert.equal(report.checks.length, 100);
    assert.equal(new Set(report.checks.map((check: { id: string }) => check.id)).size, 100);
  });
});
