#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTAINER_ID = 'a'.repeat(64);
const statePath = path.join(os.tmpdir(), 'siragpt-doc-sandbox-fake-docker.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return null; }
}

function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state));
}

const command = process.argv[2];
if (command === 'ps') {
  const state = readState();
  process.stdout.write(state ? `${CONTAINER_ID}\n` : '');
  process.exit(0);
}
if (command === 'rm') {
  try { fs.unlinkSync(statePath); } catch { /* already gone */ }
  process.exit(0);
}
if (command === 'inspect') {
  const state = readState();
  if (!state) {
    process.stderr.write('missing\n');
    process.exit(1);
  }
  const snapshot = {
    id: CONTAINER_ID,
    name: `/${state.name}`,
    image: state.image,
    runtime: 'runsc',
    role: 'doc-validation',
    scope: state.scope,
    invocation: state.invocationId,
    user: '65532:65532',
    network: 'none',
    readonly: true,
    mounts: [{ Type: 'bind', Source: state.source, Destination: '/inputs', RW: false }],
  };
  process.stdout.write(JSON.stringify(snapshot));
  process.exit(0);
}

if (command !== 'run') {
  process.stderr.write('unsupported\n');
  process.exit(1);
}

const nameIndex = process.argv.indexOf('--name');
const name = nameIndex >= 0 ? process.argv[nameIndex + 1] : 'siragpt-doc-validator-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mount = process.argv.find((arg) => typeof arg === 'string' && arg.includes('type=bind,src='));
const source = mount ? mount.split('src=')[1].split(',')[0] : '';
const image = process.argv[process.argv.length - 1];
const invocationId = name.replace(/^siragpt-doc-validator-/, '');
const root = source ? path.dirname(path.dirname(source)) : '';
const scope = createHash('sha256').update(root).digest('hex');
writeState({ name, source, image, invocationId, scope });

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
