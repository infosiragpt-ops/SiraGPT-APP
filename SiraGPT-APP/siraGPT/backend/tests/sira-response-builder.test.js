/**
 * Tests for services/sira/response-builder.js — final-response shaping
 * for user delivery (MASTER_SPEC §25).
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  buildFinalResponse,
  collectArtifacts,
} = require('../src/services/sira/response-builder');

// ── envelope fixtures ─────────────────────────────────────────────

const baseEnvelope = (overrides = {}) => ({
  request_id: 'req-1',
  intent_analysis: {
    primary_intent: { label: 'Generar PDF', id: 'generate_pdf' },
  },
  final_answer_contract: {
    must_not_include: ['internal_notes', 'planning_steps'],
  },
  ...overrides,
});

// ── buildFinalResponse · construction guards ──────────────────────

describe('buildFinalResponse · guards', () => {
  it('throws EnvelopeError when envelope missing', () => {
    assert.throws(
      () => buildFinalResponse({}),
      (err) => err.message.includes('envelope required') && err.code === 'envelope.response_builder_missing_envelope',
    );
  });

  it('returns a frozen response object', () => {
    const out = buildFinalResponse({ envelope: baseEnvelope() });
    assert.throws(() => { out.message = 'hack'; }, TypeError);
  });

  it('sets type="final_response" and propagates request_id', () => {
    const out = buildFinalResponse({ envelope: baseEnvelope({ request_id: 'req-42' }) });
    assert.equal(out.type, 'final_response');
    assert.equal(out.request_id, 'req-42');
  });
});

// ── ready / release_decision ──────────────────────────────────────

describe('buildFinalResponse · ready_to_deliver + release_decision', () => {
  it('blocked_for_repair when no validation frame present', () => {
    const out = buildFinalResponse({ envelope: baseEnvelope() });
    assert.equal(out.ready_to_deliver, false);
    assert.equal(out.release_decision, 'blocked_for_repair');
  });

  it('approved when validation.ready_to_deliver = true', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      validation: { ready_to_deliver: true, checks: [] },
    });
    assert.equal(out.ready_to_deliver, true);
    assert.equal(out.release_decision, 'approved');
  });

  it('runtime.validation_frame is used when validation arg absent', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      runtime: { validation_frame: { ready_to_deliver: true, checks: [] } },
    });
    assert.equal(out.ready_to_deliver, true);
  });

  it('explicit validation arg overrides runtime.validation_frame', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      validation: { ready_to_deliver: true, checks: [] },
      runtime: { validation_frame: { ready_to_deliver: false, checks: [] } },
    });
    assert.equal(out.ready_to_deliver, true);
  });
});

// ── message shaping ───────────────────────────────────────────────

describe('buildFinalResponse · message', () => {
  it('uses intent_analysis label in the human summary', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope({
        intent_analysis: { primary_intent: { label: 'Análisis de ventas' } },
      }),
      validation: { ready_to_deliver: true, checks: [] },
    });
    assert.match(out.message, /Análisis de ventas/);
  });

  it('falls back to intent id when label is missing', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope({
        intent_analysis: { primary_intent: { id: 'crm_extract' } },
      }),
      validation: { ready_to_deliver: true, checks: [] },
    });
    assert.match(out.message, /crm_extract/);
  });

  it('uses "La tarea" fallback when no intent at all', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope({ intent_analysis: {} }),
      validation: { ready_to_deliver: true, checks: [] },
    });
    assert.match(out.message, /La tarea/);
  });

  it('blocked-for-repair message mentions the first failure', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      validation: {
        ready_to_deliver: false,
        checks: [
          { status: 'failed', name: 'evidence_grounding', detail: 'No citations' },
        ],
      },
    });
    assert.match(out.message, /entrega bloqueada/);
    assert.match(out.message, /No citations/);
  });

  it('uses the check name when detail is absent in the failure', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      validation: {
        ready_to_deliver: false,
        checks: [{ status: 'failed', name: 'tone_match' }],
      },
    });
    assert.match(out.message, /tone_match/);
  });

  it('says "se generó y validó N artefacto(s)" when there are downloadable artifacts', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      runtime: {
        artifact_frame: {
          artifacts: [
            { id: 'a1', download_url: 'https://x/p.pdf', format: 'pdf' },
            { id: 'a2', download_url: 'https://x/p.docx', format: 'docx' },
          ],
        },
      },
      validation: { ready_to_deliver: true, checks: [] },
    });
    assert.match(out.message, /se generó y validó 2 artefacto\(s\)/);
    assert.match(out.message, /PDF/);
    assert.match(out.message, /DOCX/);
  });

  it('artifact summary omits the formats clause when none have a format', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      runtime: {
        artifact_frame: {
          artifacts: [{ id: 'a1', download_url: 'https://x/file' }],
        },
      },
      validation: { ready_to_deliver: true, checks: [] },
    });
    assert.match(out.message, /1 artefacto\(s\)/);
    // No " en " phrase because no formats.
    assert.equal(out.message.includes(' en '), false);
  });

  it('approved-without-downloads message defaults to "respuesta validada"', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      validation: { ready_to_deliver: true, checks: [] },
    });
    assert.match(out.message, /respuesta validada/);
  });
});

// ── artifacts shaping ─────────────────────────────────────────────

describe('buildFinalResponse · artifacts', () => {
  it('returns [] when no runtime/frame', () => {
    const out = buildFinalResponse({ envelope: baseEnvelope() });
    assert.deepEqual(out.artifacts, []);
  });

  it('maps every documented artifact field with sensible fallbacks', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      runtime: {
        artifact_frame: {
          artifacts: [{
            artifact_id: 'a1',
            filename: 'report.pdf',
            type: 'document',
            format: 'pdf',
            mime: 'application/pdf',
            size_bytes: 1234,
            download_url: 'https://x/r.pdf',
            preview_url: 'https://x/r.html',
            validation_status: 'passed',
          }],
        },
      },
    });
    assert.deepEqual(out.artifacts[0], {
      id: 'a1',
      label: 'report.pdf',
      type: 'document',
      format: 'pdf',
      mime: 'application/pdf',
      sizeBytes: 1234,
      downloadUrl: 'https://x/r.pdf',
      previewUrl: 'https://x/r.html',
      validationStatus: 'passed',
    });
  });

  it('falls back to id, name, then "type.format" for label', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      runtime: {
        artifact_frame: {
          artifacts: [
            { id: 'a1', name: 'pretty-name', status: 'ready' },
            { id: 'a2', type: 'chart', format: 'svg', status: 'ready' },
            { id: 'a3', status: 'planned' },
          ],
        },
      },
    });
    assert.equal(out.artifacts[0].label, 'pretty-name');
    assert.equal(out.artifacts[1].label, 'chart.svg');
    assert.equal(out.artifacts[2].label, 'artifact'); // both type+format absent
  });

  it('accepts camelCase aliases (sizeBytes, downloadUrl, previewUrl)', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      runtime: {
        artifact_frame: {
          artifacts: [{
            id: 'a1',
            sizeBytes: 555,
            downloadUrl: 'https://x/c.pdf',
            previewUrl: 'https://x/c.html',
          }],
        },
      },
    });
    assert.equal(out.artifacts[0].sizeBytes, 555);
    assert.equal(out.artifacts[0].downloadUrl, 'https://x/c.pdf');
    assert.equal(out.artifacts[0].previewUrl, 'https://x/c.html');
  });
});

// ── validation section ────────────────────────────────────────────

describe('buildFinalResponse · validation summary', () => {
  it('is null when no validation frame', () => {
    const out = buildFinalResponse({ envelope: baseEnvelope() });
    assert.equal(out.validation, null);
  });

  it('includes ready flag, score, minimumAcceptanceScore, warnings, failures, repairActions', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      validation: {
        ready_to_deliver: false,
        aggregate_score: 0.72,
        minimum_acceptance_score: 0.85,
        repair_actions: [{ kind: 'rerun', target: 'rag' }],
        checks: [
          { status: 'warning', name: 'tone', validator: 'tone_judge', detail: 'too formal' },
          { status: 'failed', name: 'citation', validator: 'citation_check', detail: 'missing url' },
          { status: 'passed', name: 'length' },
        ],
      },
    });
    assert.equal(out.validation.ready, false);
    assert.equal(out.validation.score, 0.72);
    assert.equal(out.validation.minimumAcceptanceScore, 0.85);
    assert.equal(out.validation.warnings.length, 1);
    assert.equal(out.validation.warnings[0].name, 'tone');
    assert.equal(out.validation.failures.length, 1);
    assert.equal(out.validation.failures[0].name, 'citation');
    assert.deepEqual(out.validation.repairActions, [{ kind: 'rerun', target: 'rag' }]);
  });

  it('uses overall_score when aggregate_score absent', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      validation: { ready_to_deliver: true, overall_score: 0.9, checks: [] },
    });
    assert.equal(out.validation.score, 0.9);
  });
});

// ── must_not_include passthrough ──────────────────────────────────

describe('buildFinalResponse · must_not_include', () => {
  it('forwards envelope.final_answer_contract.must_not_include', () => {
    const out = buildFinalResponse({ envelope: baseEnvelope() });
    assert.deepEqual(out.must_not_include, ['internal_notes', 'planning_steps']);
  });

  it('defaults to [] when contract absent', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope({ final_answer_contract: null }),
    });
    assert.deepEqual(out.must_not_include, []);
  });
});

// ── warnings list ─────────────────────────────────────────────────

describe('buildFinalResponse · warnings list', () => {
  it('merges caller-supplied warnings with warning-check details', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      warnings: ['large file - may take time'],
      validation: {
        ready_to_deliver: true,
        checks: [
          { status: 'warning', name: 'tone', detail: 'slight formality drift' },
        ],
      },
    });
    assert.deepEqual(out.warnings, [
      'large file - may take time',
      'slight formality drift',
    ]);
  });

  it('caps warnings at 8 entries', () => {
    const many = Array.from({ length: 15 }, (_, i) => `w-${i}`);
    const out = buildFinalResponse({ envelope: baseEnvelope(), warnings: many });
    assert.equal(out.warnings.length, 8);
  });

  it('filters out falsy entries', () => {
    const out = buildFinalResponse({
      envelope: baseEnvelope(),
      warnings: ['ok', null, undefined, '', 'also-ok'],
    });
    assert.deepEqual(out.warnings, ['ok', 'also-ok']);
  });
});

// ── collectArtifacts helper ───────────────────────────────────────

describe('collectArtifacts', () => {
  it('returns [] when runtime is null/undefined', () => {
    assert.deepEqual(collectArtifacts(null), []);
    assert.deepEqual(collectArtifacts(undefined), []);
    assert.deepEqual(collectArtifacts({}), []);
  });

  it('keeps artifacts with a download_url OR camelCase downloadUrl', () => {
    const out = collectArtifacts({
      artifact_frame: {
        artifacts: [
          { id: 'a1', download_url: 'https://x' },
          { id: 'a2', downloadUrl: 'https://y' },
          { id: 'a3' }, // dropped
        ],
      },
    });
    assert.equal(out.length, 2);
  });

  it('keeps artifacts with status=ready even without URL', () => {
    const out = collectArtifacts({
      artifact_frame: { artifacts: [{ id: 'a1', status: 'ready' }] },
    });
    assert.equal(out.length, 1);
  });

  it('keeps artifacts with status=planned (for the UI to surface as pending)', () => {
    const out = collectArtifacts({
      artifact_frame: { artifacts: [{ id: 'a1', status: 'planned' }] },
    });
    assert.equal(out.length, 1);
  });

  it('drops null entries safely', () => {
    const out = collectArtifacts({
      artifact_frame: { artifacts: [null, { id: 'a1', download_url: 'x' }, null] },
    });
    assert.equal(out.length, 1);
  });
});
