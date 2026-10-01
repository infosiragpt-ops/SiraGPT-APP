'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pythonReady = spawnSync('python3', ['-B', '-c', 'import openpyxl'], { stdio: 'ignore' }).status === 0;
const requiredInCi = Boolean(process.env.CI);

test('native XLSX charts keep requested types, colors, data references and existing workbook content', {
  skip: !pythonReady && !requiredInCi && 'Python con openpyxl requerido; obligatorio en CI',
  timeout: 120_000,
}, () => {
  assert.ok(pythonReady, 'CI requires python3 + openpyxl; native chart verification must not be skipped');
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'python/test_sira_charts.py'), '-v'], {
    encoding: 'utf8', timeout: 110_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  assert.match(result.stderr, /Ran [1-9]\d* tests/);
  assert.match(result.stderr, /\nOK\s*$/);
});
