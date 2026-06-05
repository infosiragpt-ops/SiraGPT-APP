'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cycle = require('../src/services/agents/professional-document-cycle');

test('classifyDocument detects a health thesis → Vancouver', () => {
  const r = cycle.classifyDocument({
    topic: 'Tesis sobre adherencia al tratamiento en pacientes de enfermería',
  });
  assert.equal(r.documentType.id, 'tesis');
  assert.equal(r.confidence.type, 'detected');
  assert.equal(r.field.id, 'salud');
  assert.equal(r.citationStyle, 'vancouver');
  assert.ok(Array.isArray(r.documentType.sections) && r.documentType.sections.length > 0);
});

test('classifyDocument detects engineering → IEEE', () => {
  const r = cycle.classifyDocument({
    topic: 'Proyecto de investigación de software para sistemas embebidos en ingeniería',
  });
  assert.equal(r.documentType.id, 'proyecto_investigacion');
  assert.equal(r.field.id, 'ingenieria');
  assert.equal(r.citationStyle, 'ieee');
});

test('classifyDocument falls back to defaults (APA7) when nothing matches', () => {
  const r = cycle.classifyDocument({ topic: 'xyzzy plover frobnicate' });
  assert.equal(r.documentType.id, 'documento');
  assert.equal(r.confidence.type, 'default');
  assert.equal(r.field.id, 'general');
  assert.equal(r.confidence.field, 'default');
  assert.equal(r.citationStyle, 'apa7');
});

test('overrides take precedence over heuristics', () => {
  const r = cycle.classifyDocument({
    topic: 'Tesis sobre enfermería clínica',
    documentTypeOverride: 'ensayo',
    fieldOverride: 'derecho',
  });
  assert.equal(r.documentType.id, 'ensayo');
  assert.equal(r.confidence.type, 'override');
  assert.equal(r.field.id, 'derecho');
  assert.equal(r.confidence.field, 'override');
  assert.equal(r.citationStyle, 'apa7');
});

test('override accepts label as well as id', () => {
  const r = cycle.classifyDocument({
    topic: 'algo',
    documentTypeOverride: 'Monografía',
    fieldOverride: 'Psicología',
  });
  assert.equal(r.documentType.id, 'monografia');
  assert.equal(r.field.id, 'psicologia');
});

test('free-form override becomes a custom type/field using the generic outline', () => {
  const r = cycle.classifyDocument({
    topic: 'algo',
    documentTypeOverride: 'Manual operativo',
    fieldOverride: 'Gastronomía molecular',
  });
  assert.equal(r.documentType.id, 'custom');
  assert.equal(r.documentType.label, 'Manual operativo');
  assert.equal(r.field.id, 'custom');
  assert.equal(r.field.label, 'Gastronomía molecular');
  assert.equal(r.citationStyle, 'apa7');
});

test('sanitizeFolderCode neutralises traversal and unsafe characters', () => {
  assert.equal(cycle.sanitizeFolderCode('TESIS-2026-001'), 'TESIS-2026-001');
  assert.equal(cycle.sanitizeFolderCode('  spaced  code  '), 'spaced-code');
  assert.equal(cycle.sanitizeFolderCode('../../etc/passwd'), 'etc_passwd');
  assert.equal(cycle.sanitizeFolderCode('a/b\\c'), 'a_b_c');
  assert.equal(cycle.sanitizeFolderCode('Acción Penal'), 'Accion-Penal');
});

test('sanitizeFolderCode rejects empty / all-invalid input', () => {
  assert.throws(() => cycle.sanitizeFolderCode(''), TypeError);
  assert.throws(() => cycle.sanitizeFolderCode('   '), TypeError);
  assert.throws(() => cycle.sanitizeFolderCode('...'), TypeError);
});

test('getGuide returns outline + stages + citation for a known pair', () => {
  const g = cycle.getGuide('tesis', 'salud');
  assert.equal(g.documentType.id, 'tesis');
  assert.equal(g.field.id, 'salud');
  assert.equal(g.citationStyle, 'vancouver');
  assert.ok(g.sections.includes('Metodología'));
  assert.equal(g.stages.length, cycle.CYCLE_STAGES.length);
  assert.ok(g.notes.length > 0);
});

test('listOptions exposes types, fields and citation styles', () => {
  const o = cycle.listOptions();
  assert.ok(o.documentTypes.some((t) => t.id === 'tesis'));
  assert.ok(o.documentTypes.some((t) => t.id === 'documento'));
  assert.ok(o.fields.some((f) => f.id === 'salud'));
  assert.ok(o.fields.some((f) => f.id === 'general'));
  assert.ok(o.citationStyles.some((c) => c.id === 'apa7'));
});

test('buildProfessionalCycleRequest assembles goal/contract/stages/folderCode', () => {
  const req = cycle.buildProfessionalCycleRequest({
    topic: '  Telemedicina   en   pacientes crónicos  ',
    fieldOverride: 'salud',
    code: 'TESIS 2026/001',
  });
  assert.equal(req.folderCode, 'TESIS-2026_001');
  assert.equal(req.field.id, 'salud');
  assert.equal(req.citationStyle, 'vancouver');
  assert.match(req.goal, /DOS formatos/);
  assert.match(req.goal, /TESIS-2026_001/);
  assert.match(req.systemContract, /report_stage/);
  assert.match(req.systemContract, /create_document/);
  assert.match(req.systemContract, /web_search/);
  assert.equal(req.stages.length, cycle.CYCLE_STAGES.length);
  assert.match(req.displayGoal, /Telemedicina en pacientes crónicos/);
});

test('buildProfessionalCycleRequest honours an explicit citation override', () => {
  const req = cycle.buildProfessionalCycleRequest({
    topic: 'Tesis de ingeniería de software',
    code: 'ING-1',
    citationStyleOverride: 'apa7',
  });
  assert.equal(req.field.id, 'ingenieria');
  assert.equal(req.citationStyle, 'apa7');
});

test('buildProfessionalCycleRequest requires topic and code', () => {
  assert.throws(() => cycle.buildProfessionalCycleRequest({ topic: '', code: 'X' }), TypeError);
  assert.throws(() => cycle.buildProfessionalCycleRequest({ topic: 'X', code: '' }), TypeError);
});

test('saveArtifact groups files under the folder code and round-trips', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
  const prev = process.env.AGENT_ARTIFACT_DIR;
  process.env.AGENT_ARTIFACT_DIR = tmp;
  // Fresh require so the module picks up ARTIFACT_DIR from env at load.
  const modPath = require.resolve('../src/services/agents/task-tools');
  delete require.cache[modPath];
  const taskTools = require(modPath);
  try {
    const res = taskTools.saveArtifact({
      filename: 'documento.docx',
      base64: Buffer.from('hello world').toString('base64'),
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ownerUserId: 'user-1',
      chatId: 'chat-1',
      folderCode: '../weird/CODE 9',
    });
    assert.ok(res.id);
    assert.equal(res.folderCode, 'weird_CODE-9');

    // Metadata stays flat at ARTIFACT_DIR/<id>.json and records storedRelPath.
    const metaPath = path.join(tmp, `${res.id}.json`);
    assert.ok(fs.existsSync(metaPath));
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.folderCode, 'weird_CODE-9');
    assert.ok(meta.storedRelPath.startsWith('weird_CODE-9/'));

    // Binary actually landed inside the folder.
    const binPath = path.join(tmp, meta.storedRelPath);
    assert.ok(fs.existsSync(binPath));
    assert.equal(fs.readFileSync(binPath, 'utf8'), 'hello world');
  } finally {
    if (prev === undefined) delete process.env.AGENT_ARTIFACT_DIR;
    else process.env.AGENT_ARTIFACT_DIR = prev;
    delete require.cache[modPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verify_artifact resolves folder-grouped artifacts via storedRelPath', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-verify-'));
  const prev = process.env.AGENT_ARTIFACT_DIR;
  process.env.AGENT_ARTIFACT_DIR = tmp;
  const modPath = require.resolve('../src/services/agents/task-tools');
  delete require.cache[modPath];
  const taskTools = require(modPath);
  try {
    const saved = taskTools.saveArtifact({
      filename: 'reporte.txt',
      base64: Buffer.from('línea uno\nlínea dos\n').toString('base64'),
      mime: 'text/plain',
      ownerUserId: 'user-verify-1',
      chatId: 'chat-verify-1',
      folderCode: 'TESIS-2026-001',
    });
    assert.equal(saved.folderCode, 'TESIS-2026-001');

    const result = await taskTools.INTERNAL.verifyArtifact.execute(
      { artifactId: saved.id },
      { userId: 'user-verify-1' },
    );
    // The whole point of the fix: a folder-grouped artifact must NOT be reported
    // as missing. The Python verifier may be unavailable in some environments,
    // so we only assert that path resolution succeeded (no "not found" error).
    assert.doesNotMatch(String(result.error || ''), /not found/i);
  } finally {
    if (prev === undefined) delete process.env.AGENT_ARTIFACT_DIR;
    else process.env.AGENT_ARTIFACT_DIR = prev;
    delete require.cache[modPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
