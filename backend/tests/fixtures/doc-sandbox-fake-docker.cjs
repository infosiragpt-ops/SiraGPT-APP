#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const command = process.argv[2];
if (command === 'ps' || command === 'rm' || command === 'inspect') {
  process.stdout.write('');
  process.exit(0);
}

if (command !== 'run') {
  process.stderr.write('unsupported\n');
  process.exit(1);
}

const mount = process.argv.find((arg) => typeof arg === 'string' && arg.includes('type=bind,src='));
const source = mount ? mount.split('src=')[1].split(',')[0] : '';

function sha(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const first = source ? path.join(source, 'input-0.txt') : '';
  const hash = first && fs.existsSync(first) ? sha(first) : 'a'.repeat(64);
  if (input.command === 'inspect') {
    process.stdout.write(JSON.stringify({
      ok: true,
      inventories: [{
        id: input.inputs[0].id, format: 'txt', sha256: hash, size: fs.statSync(first).size,
        name: input.inputs[0].name, mime: 'text/plain',
        parts: { $document: fs.readFileSync(first, 'utf8') },
        units: [{ part: '$document', locator: 'text', text: '2026', kind: 'text' }],
        warnings: [],
      }],
    }));
  } else if (input.command === 'validate') {
    const diff = Buffer.from('{"changed":false}');
    process.stdout.write(JSON.stringify({
      ok: true,
      report: {
        schemaVersion: 1, passed: true, originalSha256: hash, outputSha256: hash,
        levels: [1, 2, 3, 4].map((level) => ({
          level, passed: true, applicable: true, details: { reason: 'ok' }, durationMs: 1,
        })),
        artifactFiles: ['text-diff.json'],
        artifactData: { 'text-diff.json': diff.toString('base64') },
        changes: [],
      },
    }));
  } else if (input.command === 'inspect_recipe') {
    process.stdout.write(JSON.stringify({
      ok: true,
      recipe: {
        sha256: hash, size: Math.max(1, fs.statSync(first).size), expandedBytes: 1,
        scripts: ['01_restore.py'], parts: { commands: '{}' },
      },
    }));
  } else if (input.command === 'preflight') {
    process.stdout.write(JSON.stringify({
      ok: true,
      preflight: {
        schemaVersion: 1, inputSha256: hash,
        applications: { writer: 'b'.repeat(64), calc: 'c'.repeat(64), impress: 'd'.repeat(64) },
      },
    }));
  } else {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'UNKNOWN', message: 'unsupported' } }));
  }
  process.exit(0);
});
