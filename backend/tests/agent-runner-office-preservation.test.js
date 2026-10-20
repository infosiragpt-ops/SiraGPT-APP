'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createSandbox } = require('../src/services/doc-agent/sandbox');
const office = require('../src/services/agent-runner/tools.office');

const PYTHON_READY = spawnSync('python3', ['-B', '-c', 'import lxml.etree']).status === 0;
const contract = {
  version: 1,
  namespaces: { w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main' },
  allow: [{ part: 'word/document.xml', xpath: '/w:document/w:body/w:p[9]/w:r[2]/w:t', text: true }],
};

test('real Word/Excel/PPTX preservation fixtures and adversarial packages', { skip: !PYTHON_READY && 'python3 + lxml required' }, () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', path.join(__dirname, 'python'), '-p', 'test_sira_preserve.py', '-v'], {
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stderr, /OK\s*$/);
});

test('the existing verify_visual tool exposes the bounded preservation contract', () => {
  const schema = office.OFFICE_TOOL_DEFINITIONS.find((tool) => tool.function.name === 'verify_visual').function.parameters.properties.expect.properties.preserve;
  assert.deepEqual(schema.required, ['version', 'namespaces']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.allow.maxItems, 256);
  assert.equal(schema.properties.allow.items.additionalProperties, false);
  assert.deepEqual(schema.properties.allow.items.properties.text.enum, [true]);
  assert.equal(schema.properties.allow.items.properties.subtree, undefined);
});

test('a legacy engine cannot approve a preservation request it silently ignored', async () => {
  const observations = [];
  const sandbox = {
    writeFile: async () => {},
    exec: async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, summary: 'Content matches.', composites: [] }) }),
  };
  const executors = office.makeOfficeToolExecutors(sandbox, { onVerify: (value) => observations.push(value) });
  const result = await executors.verify_visual({
    before: 'uploads/a.docx', after: 'outputs/a.docx', checklist: ['No cambiar nada más'], expect: { preserve: contract },
  });
  assert.match(result, /^ERROR:/);
  assert.match(result, /preservación no confirmada/);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].passed, false);
  assert.equal(observations[0].checksOk, false);
});

test('actual staged engine rejects a collateral Word margin change without a renderer', { skip: !PYTHON_READY && 'python3 + lxml required' }, async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    await sandbox.exec('mkdir -p /workspace/uploads /workspace/outputs /workspace/tmp', { timeoutMs: 10_000 });
    assert.equal(await office.installOfficeEngine(sandbox), true);
    await sandbox.putFile('uploads/source.docx', fs.readFileSync(path.join(__dirname, 'fixtures/office/tesis_demo.docx')));
    const py = [
      'import sys',
      "sys.path.insert(0, 'tmp')",
      'from sira_office import OfficePackage, W, edit',
      "edit('uploads/source.docx', 'outputs/result.docx', [{'op':'replace_text','paragraph':8,'find':'2024','replace':'2025'}])",
      "p=OfficePackage('outputs/result.docx')",
      "p.xml('word/document.xml').find('.//'+W('pgMar')).set(W('left'), '1')",
      "p.touch('word/document.xml')",
      "p.save('outputs/result.docx')",
    ].join('\n');
    await sandbox.writeFile('tmp/change.py', py);
    const changed = await sandbox.exec('cd /workspace && python3 /workspace/tmp/change.py', { timeoutMs: 20_000 });
    assert.equal(changed.exitCode, 0, changed.stderr);
    const observations = [];
    const executors = office.makeOfficeToolExecutors(sandbox, { onVerify: (value) => observations.push(value) });
    const result = await executors.verify_visual({
      before: 'uploads/source.docx', after: 'outputs/result.docx', checklist: ['Cambiar solo 2024 por 2025'], expect: { preserve: contract },
    });
    const text = typeof result === 'string' ? result : result.text;
    assert.match(text, /^ERROR:/);
    assert.match(text, /preserve_collateral_change/);
    assert.match(text, /word\/document.xml/);
    assert.match(text, /No se ejecutó la revisión visual/);
    assert.equal(observations[0].passed, false);
    assert.equal(observations[0].visionOk, null);
  } finally {
    await sandbox.destroy();
  }
});
