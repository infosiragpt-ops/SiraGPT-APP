/**
 * Tests for services/agents/pipeline-registry.js — UniversalTaskContract
 * task_category → pipeline descriptor lookup.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  PIPELINES,
  pickPipeline,
  listPipelines,
} = require('../src/services/agents/pipeline-registry');

// ── PIPELINES catalog ───────────────────────────────────────────

describe('PIPELINES catalog', () => {
  const expectedIds = [
    'visual-artifact', 'document', 'spreadsheet', 'presentation', 'pdf',
    'code', 'research-grounding', 'rag-document-understanding',
    'action-execution', 'direct-answer', 'multi-intent', 'unknown',
  ];

  it('contains all 12 documented pipelines', () => {
    for (const id of expectedIds) {
      assert.ok(PIPELINES[id], `missing pipeline ${id}`);
    }
    assert.equal(Object.keys(PIPELINES).length, expectedIds.length);
  });

  it('every pipeline has { id, name, allowedExtensions, allowedMimeTypes, requiredTools, recommendedTools, forbiddenTools, defaultChecks }', () => {
    for (const p of Object.values(PIPELINES)) {
      assert.equal(typeof p.id, 'string');
      assert.equal(typeof p.name, 'string');
      assert.ok('allowedExtensions' in p);
      assert.ok('allowedMimeTypes' in p);
      assert.ok(Array.isArray(p.requiredTools));
      assert.ok(Array.isArray(p.recommendedTools));
      assert.ok(Array.isArray(p.forbiddenTools));
      assert.ok(Array.isArray(p.defaultChecks));
    }
  });

  it('every defaultCheck has { id, check, type, description }', () => {
    for (const p of Object.values(PIPELINES)) {
      for (const c of p.defaultChecks) {
        assert.equal(typeof c.id, 'string');
        assert.equal(typeof c.check, 'string');
        assert.equal(c.type, 'deterministic');
        assert.equal(typeof c.description, 'string');
      }
    }
  });

  it('pipeline IDs are unique', () => {
    const ids = Object.values(PIPELINES).map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('direct-answer pipeline FORBIDS create_document (text-only)', () => {
    assert.ok(PIPELINES['direct-answer'].forbiddenTools.includes('create_document'));
  });

  it('visual-artifact + document + spreadsheet require create_document', () => {
    assert.ok(PIPELINES['visual-artifact'].requiredTools.includes('create_document'));
    assert.ok(PIPELINES.document.requiredTools.includes('create_document'));
    assert.ok(PIPELINES.spreadsheet.requiredTools.includes('create_document'));
  });

  it('research-grounding requires web_search', () => {
    assert.ok(PIPELINES['research-grounding'].requiredTools.includes('web_search'));
  });

  it('rag-document-understanding requires self_rag_answer', () => {
    assert.ok(PIPELINES['rag-document-understanding'].requiredTools.includes('self_rag_answer'));
  });

  it('code pipeline requires python_exec + run_tests', () => {
    assert.ok(PIPELINES.code.requiredTools.includes('python_exec'));
    assert.ok(PIPELINES.code.requiredTools.includes('run_tests'));
  });

  it('pdf pipeline allows only .pdf extension and application/pdf MIME', () => {
    assert.deepEqual(PIPELINES.pdf.allowedExtensions, ['pdf']);
    assert.deepEqual(PIPELINES.pdf.allowedMimeTypes, ['application/pdf']);
  });

  it('unknown pipeline has null allowedExtensions/MimeTypes (no constraint)', () => {
    assert.equal(PIPELINES.unknown.allowedExtensions, null);
    assert.equal(PIPELINES.unknown.allowedMimeTypes, null);
  });

  it('multi-intent allowedExtensions covers full media set', () => {
    const exts = PIPELINES['multi-intent'].allowedExtensions;
    for (const e of ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'svg', 'py', 'js', 'ts']) {
      assert.ok(exts.includes(e), `multi-intent missing ${e}`);
    }
  });

  it('action-execution + direct-answer + rag-document-understanding allow null extension (inline)', () => {
    assert.ok(PIPELINES['action-execution'].allowedExtensions.includes(null));
    assert.ok(PIPELINES['direct-answer'].allowedExtensions.includes(null));
    assert.ok(PIPELINES['rag-document-understanding'].allowedExtensions.includes(null));
  });
});

// ── pickPipeline ────────────────────────────────────────────────

describe('pickPipeline · happy path', () => {
  it('returns the exact pipeline when task_category matches', () => {
    for (const id of Object.keys(PIPELINES)) {
      assert.strictEqual(pickPipeline({ task_category: id }), PIPELINES[id]);
    }
  });
});

describe('pickPipeline · null/missing contract', () => {
  it('returns unknown pipeline for null contract', () => {
    assert.strictEqual(pickPipeline(null), PIPELINES.unknown);
  });

  it('returns unknown for non-object contract', () => {
    assert.strictEqual(pickPipeline('not-object'), PIPELINES.unknown);
    assert.strictEqual(pickPipeline(42), PIPELINES.unknown);
  });

  it('returns unknown for empty object (no category, no artifact_type)', () => {
    assert.strictEqual(pickPipeline({}), PIPELINES.unknown);
  });
});

describe('pickPipeline · artifact_type fallback', () => {
  it('artifact_type=svg/image/chart → visual-artifact', () => {
    for (const t of ['svg', 'image', 'chart']) {
      assert.strictEqual(pickPipeline({ artifact_type: t }), PIPELINES['visual-artifact']);
    }
  });

  it('artifact_type=document → document', () => {
    assert.strictEqual(pickPipeline({ artifact_type: 'document' }), PIPELINES.document);
  });

  it('artifact_type=spreadsheet → spreadsheet', () => {
    assert.strictEqual(pickPipeline({ artifact_type: 'spreadsheet' }), PIPELINES.spreadsheet);
  });

  it('artifact_type=presentation → presentation', () => {
    assert.strictEqual(pickPipeline({ artifact_type: 'presentation' }), PIPELINES.presentation);
  });

  it('artifact_type=pdf → pdf', () => {
    assert.strictEqual(pickPipeline({ artifact_type: 'pdf' }), PIPELINES.pdf);
  });

  it('artifact_type=code → code', () => {
    assert.strictEqual(pickPipeline({ artifact_type: 'code' }), PIPELINES.code);
  });

  it('artifact_type=data-search → research-grounding', () => {
    assert.strictEqual(pickPipeline({ artifact_type: 'data-search' }), PIPELINES['research-grounding']);
  });

  it('artifact_type=text-answer / none → direct-answer', () => {
    assert.strictEqual(pickPipeline({ artifact_type: 'text-answer' }), PIPELINES['direct-answer']);
    assert.strictEqual(pickPipeline({ artifact_type: 'none' }), PIPELINES['direct-answer']);
  });

  it('unrecognised artifact_type → unknown', () => {
    assert.strictEqual(pickPipeline({ artifact_type: 'crystal-ball' }), PIPELINES.unknown);
  });

  it('task_category wins over artifact_type when both present', () => {
    const out = pickPipeline({ task_category: 'document', artifact_type: 'image' });
    assert.strictEqual(out, PIPELINES.document);
  });

  it('unknown task_category falls through to artifact_type inference', () => {
    const out = pickPipeline({ task_category: 'made-up', artifact_type: 'spreadsheet' });
    assert.strictEqual(out, PIPELINES.spreadsheet);
  });
});

// ── listPipelines ───────────────────────────────────────────────

describe('listPipelines', () => {
  it('returns one entry per pipeline', () => {
    const out = listPipelines();
    assert.equal(out.length, Object.keys(PIPELINES).length);
  });

  it('each entry exposes the documented summary fields (no defaultChecks)', () => {
    for (const p of listPipelines()) {
      assert.ok('id' in p);
      assert.ok('name' in p);
      assert.ok('allowedExtensions' in p);
      assert.ok('allowedMimeTypes' in p);
      assert.ok('requiredTools' in p);
      assert.ok('recommendedTools' in p);
      assert.ok('forbiddenTools' in p);
      // defaultChecks intentionally omitted from the summary surface.
      assert.equal('defaultChecks' in p, false);
    }
  });

  it('summary entries are decoupled from internal objects (mutation isolated)', () => {
    const list = listPipelines();
    list[0].id = 'mutated';
    // The underlying PIPELINES entry should be untouched.
    const stillValid = listPipelines().every(p => Object.values(PIPELINES).some(x => x.id === p.id));
    assert.ok(stillValid);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/pipeline-registry');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['PIPELINES', 'listPipelines', 'pickPipeline']);
  });
});
