'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ENH_VARS = ['SIRAGPT_MARKER_ENABLED', 'SIRAGPT_DOCLING_ENABLED', 'SIRAGPT_MARKITDOWN_ENABLED'];

function snapshotEnv() {
  return ENH_VARS.reduce((acc, k) => { acc[k] = process.env[k]; return acc; }, {});
}
function restoreEnv(snap) {
  for (const k of ENH_VARS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}
function setEnv(values) {
  for (const k of ENH_VARS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
}

function fresh() {
  // doc-pipeline-enhancer reads env eagerly inside createDocPipelineEnhancer
  // through its markerAvailable/doclingAvailable/markitdownAvailable helpers
  // (which read process.env per call), so the module itself can be cached.
  return require('../src/orchestration/doc-pipeline-enhancer').createDocPipelineEnhancer;
}

test('exports createDocPipelineEnhancer', () => {
  const { createDocPipelineEnhancer } = require('../src/orchestration/doc-pipeline-enhancer');
  assert.equal(typeof createDocPipelineEnhancer, 'function');
});

test('returns { enabled: false } when no SIRAGPT_*_ENABLED gates are set', () => {
  const snap = snapshotEnv();
  try {
    setEnv({});
    const create = fresh();
    const inst = create();
    assert.equal(inst.enabled, false);
  } finally {
    restoreEnv(snap);
  }
});

test('returns enabled bag with capability flags when any gate is true', () => {
  const snap = snapshotEnv();
  try {
    setEnv({ SIRAGPT_MARKER_ENABLED: 'true' });
    const create = fresh();
    const inst = create();
    assert.equal(inst.enabled, true);
    assert.equal(inst.hasMarker, true);
    assert.equal(inst.hasDocling, false);
    assert.equal(inst.hasMarkItDown, false);
    assert.equal(typeof inst.parserFor, 'function');
    assert.equal(typeof inst.enhanceParse, 'function');
  } finally {
    restoreEnv(snap);
  }
});

test('parserFor picks docling over marker for PDF when both available', () => {
  const snap = snapshotEnv();
  try {
    setEnv({ SIRAGPT_MARKER_ENABLED: 'true', SIRAGPT_DOCLING_ENABLED: 'true' });
    const inst = fresh()();
    assert.equal(inst.parserFor('application/pdf'), 'docling');
  } finally {
    restoreEnv(snap);
  }
});

test('parserFor falls back to marker for PDF when only marker is enabled', () => {
  const snap = snapshotEnv();
  try {
    setEnv({ SIRAGPT_MARKER_ENABLED: 'true' });
    const inst = fresh()();
    assert.equal(inst.parserFor('application/pdf'), 'marker');
  } finally {
    restoreEnv(snap);
  }
});

test('parserFor picks markitdown for Word/Excel/PowerPoint when available', () => {
  const snap = snapshotEnv();
  try {
    setEnv({ SIRAGPT_MARKITDOWN_ENABLED: 'true' });
    const inst = fresh()();
    // Word — matches via 'word' / 'docx' / 'doc'
    assert.equal(inst.parserFor('application/msword'), 'markitdown');
    assert.equal(inst.parserFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'markitdown');
    // Excel — matches via 'spreadsheet' / 'xlsx' / 'xls'
    assert.equal(inst.parserFor('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'markitdown');
    assert.equal(inst.parserFor('application/xlsx'), 'markitdown');
    // PowerPoint — matches via 'presentation' / 'pptx' / 'ppt'
    assert.equal(inst.parserFor('application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'markitdown');
    assert.equal(inst.parserFor('application/pptx'), 'markitdown');
  } finally {
    restoreEnv(snap);
  }
});

test('parserFor returns null for unknown mime types', () => {
  const snap = snapshotEnv();
  try {
    setEnv({ SIRAGPT_MARKER_ENABLED: 'true', SIRAGPT_DOCLING_ENABLED: 'true', SIRAGPT_MARKITDOWN_ENABLED: 'true' });
    const inst = fresh()();
    assert.equal(inst.parserFor('image/png'), null);
    assert.equal(inst.parserFor('text/plain'), null);
    assert.equal(inst.parserFor(''), null);
    assert.equal(inst.parserFor(null), null);
  } finally {
    restoreEnv(snap);
  }
});

test('parserFor returns null when no parser matches the mime (e.g. PDF without marker/docling)', () => {
  const snap = snapshotEnv();
  try {
    setEnv({ SIRAGPT_MARKITDOWN_ENABLED: 'true' });
    const inst = fresh()();
    assert.equal(inst.parserFor('application/pdf'), null, 'PDF needs marker or docling, not markitdown');
  } finally {
    restoreEnv(snap);
  }
});

test('enhanceParse returns enhanced:false when no parser is dispatched', async () => {
  const snap = snapshotEnv();
  try {
    setEnv({ SIRAGPT_MARKER_ENABLED: 'true' }); // no markitdown for docx
    const inst = fresh()();
    const out = await inst.enhanceParse({
      buffer: Buffer.from('x'),
      fileName: 'a.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      existingText: 'fallback',
    });
    assert.equal(out.enhanced, false);
    assert.equal(out.text, 'fallback');
  } finally {
    restoreEnv(snap);
  }
});

test('enhanceParse returns enhanced:false when existingText is empty (nothing to upgrade)', async () => {
  const snap = snapshotEnv();
  try {
    setEnv({ SIRAGPT_MARKITDOWN_ENABLED: 'true' });
    const inst = fresh()();
    const out = await inst.enhanceParse({
      buffer: Buffer.from('x'),
      fileName: 'a.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      existingText: '',
    });
    assert.equal(out.enhanced, false);
    assert.equal(out.text, '');
  } finally {
    restoreEnv(snap);
  }
});

test('enhanceParse gracefully falls back when markitdown binary is unavailable', async () => {
  const snap = snapshotEnv();
  try {
    setEnv({ SIRAGPT_MARKITDOWN_ENABLED: 'true' });
    const inst = fresh()();
    // The markitdown binary is not installed in the test env, so execSync
    // will throw. enhanceParse must swallow that and return the fallback.
    const out = await inst.enhanceParse({
      buffer: Buffer.from('fake docx body'),
      fileName: 'a.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      existingText: 'fallback-text',
    });
    assert.equal(out.enhanced, false, 'must not claim enhanced when subprocess failed');
    assert.equal(out.text, 'fallback-text', 'must return original text on failure');
  } finally {
    restoreEnv(snap);
  }
});
