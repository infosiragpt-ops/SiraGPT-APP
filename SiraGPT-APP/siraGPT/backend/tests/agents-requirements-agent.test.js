/**
 * Tests for services/agents/requirements-agent.js — requirements-
 * engineering specialist.
 *
 * Heavy requirements() invokes agentCore; we test the pure
 * normalizeRequirements + the request guard + the ROLE prompt.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  requirements,
  normalizeRequirements,
  ROLE,
} = require('../src/services/agents/requirements-agent');

// ── ROLE constant ────────────────────────────────────────────────

describe('ROLE constant', () => {
  it('describes the "As <role>... so that <value>" user-story format', () => {
    assert.match(ROLE, /As <role>.*I want.*so that/);
  });

  it('mentions Given/When/Then acceptance criteria', () => {
    assert.match(ROLE, /Given\/When\/Then/);
  });

  it('forbids inventing product decisions', () => {
    assert.match(ROLE, /DO NOT invent product decisions/);
  });

  it('requires assumptions to cite evidence', () => {
    assert.match(ROLE, /assumption's evidence|Name each assumption's evidence/i);
  });
});

// ── requirements · validation ────────────────────────────────────

describe('requirements · validation', () => {
  it('throws when request is missing', async () => {
    await assert.rejects(
      () => requirements({ openai: {}, userId: 'u' }),
      /"request" is required/,
    );
  });

  it('throws when request is empty', async () => {
    await assert.rejects(
      () => requirements({ openai: {}, userId: 'u', request: '' }),
      /"request" is required/,
    );
  });
});

// ── normalizeRequirements · happy path ──────────────────────────

describe('normalizeRequirements · happy path', () => {
  it('maps every documented field through', () => {
    const out = normalizeRequirements({
      final: {
        title: 'Add CSV export',
        summary: 'A short summary.',
        user_stories: [
          { id: 'US1', role: 'analyst', capability: 'export CSV', value: 'share with finance' },
        ],
        acceptance_criteria: [
          { story_id: 'US1', given: 'logged in', when: 'click export', then: 'CSV downloads' },
        ],
        non_goals: ['exporting PDF'],
        open_questions: [{ question: 'columns?', why_it_matters: 'changes schema' }],
        assumptions: [{ assumption: 'Zod validation', evidence: 'utils/validation.ts' }],
        suggested_files_touched: ['routes/export.ts', 'lib/csv.ts'],
        estimated_complexity: 'small',
      },
      iterations: 5,
      terminatedBy: 'final',
      stats: { toolCalls: 7 },
    }, 'export feature');

    assert.equal(out.title, 'Add CSV export');
    assert.equal(out.summary, 'A short summary.');
    assert.equal(out.user_stories.length, 1);
    assert.equal(out.user_stories[0].id, 'US1');
    assert.equal(out.acceptance_criteria.length, 1);
    assert.deepEqual(out.non_goals, ['exporting PDF']);
    assert.equal(out.open_questions.length, 1);
    assert.equal(out.assumptions.length, 1);
    assert.deepEqual(out.suggested_files_touched, ['routes/export.ts', 'lib/csv.ts']);
    assert.equal(out.estimated_complexity, 'small');
    assert.equal(out.original_request, 'export feature');
    assert.equal(out.iterations, 5);
    assert.equal(out.terminatedBy, 'final');
    assert.deepEqual(out.stats, { toolCalls: 7 });
  });
});

// ── normalizeRequirements · defaults ────────────────────────────

describe('normalizeRequirements · defaults', () => {
  it('title falls back to the original request (truncated to 120)', () => {
    const long = 'r'.repeat(500);
    const out = normalizeRequirements({ final: {} }, long);
    assert.equal(out.title.length, 120);
    assert.equal(out.title, 'r'.repeat(120));
  });

  it('summary defaults to ""', () => {
    const out = normalizeRequirements({ final: {} }, 'req');
    assert.equal(out.summary, '');
  });

  it('list fields default to []', () => {
    const out = normalizeRequirements({ final: {} }, 'req');
    assert.deepEqual(out.user_stories, []);
    assert.deepEqual(out.acceptance_criteria, []);
    assert.deepEqual(out.non_goals, []);
    assert.deepEqual(out.open_questions, []);
    assert.deepEqual(out.assumptions, []);
    assert.deepEqual(out.suggested_files_touched, []);
  });

  it('estimated_complexity defaults to "medium"', () => {
    const out = normalizeRequirements({ final: {} }, 'req');
    assert.equal(out.estimated_complexity, 'medium');
  });

  it('handles missing final entirely', () => {
    const out = normalizeRequirements({}, 'req');
    assert.equal(out.original_request, 'req');
  });
});

// ── normalizeRequirements · field caps ──────────────────────────

describe('normalizeRequirements · field caps', () => {
  it('title truncated to 120 chars', () => {
    const out = normalizeRequirements({
      final: { title: 't'.repeat(500) },
    }, 'req');
    assert.equal(out.title.length, 120);
  });

  it('summary truncated to 600 chars', () => {
    const out = normalizeRequirements({
      final: { summary: 's'.repeat(2000) },
    }, 'req');
    assert.equal(out.summary.length, 600);
  });

  it('user_story role truncated to 100, capability/value to 200', () => {
    const out = normalizeRequirements({
      final: { user_stories: [{
        capability: 'c'.repeat(500),
        role: 'r'.repeat(500),
        value: 'v'.repeat(500),
      }]},
    }, 'req');
    assert.equal(out.user_stories[0].role.length, 100);
    assert.equal(out.user_stories[0].capability.length, 200);
    assert.equal(out.user_stories[0].value.length, 200);
  });

  it('acceptance criteria given/when/then truncated to 300 each', () => {
    const out = normalizeRequirements({
      final: { acceptance_criteria: [{
        story_id: 'US1',
        given: 'g'.repeat(800),
        when: 'w'.repeat(800),
        then: 't'.repeat(800),
      }]},
    }, 'req');
    assert.equal(out.acceptance_criteria[0].given.length, 300);
    assert.equal(out.acceptance_criteria[0].when.length, 300);
    assert.equal(out.acceptance_criteria[0].then.length, 300);
  });

  it('non_goals each truncated to 200', () => {
    const out = normalizeRequirements({
      final: { non_goals: ['n'.repeat(500), 'short'] },
    }, 'req');
    assert.equal(out.non_goals[0].length, 200);
    assert.equal(out.non_goals[1], 'short');
  });

  it('open_questions question + why_it_matters truncated to 300 each', () => {
    const out = normalizeRequirements({
      final: { open_questions: [{
        question: 'q'.repeat(800),
        why_it_matters: 'w'.repeat(800),
      }]},
    }, 'req');
    assert.equal(out.open_questions[0].question.length, 300);
    assert.equal(out.open_questions[0].why_it_matters.length, 300);
  });

  it('assumptions assumption + evidence truncated to 300 each', () => {
    const out = normalizeRequirements({
      final: { assumptions: [{
        assumption: 'a'.repeat(800),
        evidence: 'e'.repeat(800),
      }]},
    }, 'req');
    assert.equal(out.assumptions[0].assumption.length, 300);
    assert.equal(out.assumptions[0].evidence.length, 300);
  });
});

// ── normalizeRequirements · filtering ───────────────────────────

describe('normalizeRequirements · filtering', () => {
  it('drops user stories without capability', () => {
    const out = normalizeRequirements({
      final: { user_stories: [
        { id: 'US1', capability: 'export', role: 'r', value: 'v' },
        { id: 'US2', role: 'r' },  // no capability — dropped
        null,                       // null — dropped
      ]},
    }, 'req');
    assert.equal(out.user_stories.length, 1);
    assert.equal(out.user_stories[0].id, 'US1');
  });

  it('auto-generates story ids when missing', () => {
    const out = normalizeRequirements({
      final: { user_stories: [
        { capability: 'c1' },
        { capability: 'c2' },
      ]},
    }, 'req');
    assert.equal(out.user_stories[0].id, 'US1');
    assert.equal(out.user_stories[1].id, 'US2');
  });

  it('drops acceptance criteria missing when OR then', () => {
    const out = normalizeRequirements({
      final: { acceptance_criteria: [
        { given: 'g', when: 'w', then: 't' },
        { given: 'g', when: '', then: 't' },     // no when — dropped
        { given: 'g', when: 'w', then: '' },     // no then — dropped
        null,
      ]},
    }, 'req');
    assert.equal(out.acceptance_criteria.length, 1);
  });

  it('drops empty / falsy non_goals strings', () => {
    const out = normalizeRequirements({
      final: { non_goals: ['valid', '', null, 'another'] },
    }, 'req');
    // String(null) = 'null' is truthy. The filter is `.filter(Boolean)`.
    // '' is falsy → dropped.
    assert.ok(out.non_goals.length >= 2);
    assert.ok(out.non_goals.includes('valid'));
    assert.ok(out.non_goals.includes('another'));
  });

  it('drops open_questions without a question', () => {
    const out = normalizeRequirements({
      final: { open_questions: [
        { question: 'real?', why_it_matters: 'why' },
        { why_it_matters: 'orphan' },  // no question — dropped
        {},
      ]},
    }, 'req');
    assert.equal(out.open_questions.length, 1);
  });

  it('drops assumptions without "assumption" text', () => {
    const out = normalizeRequirements({
      final: { assumptions: [
        { assumption: 'real', evidence: 'e' },
        { evidence: 'orphan-evidence' },
        null,
      ]},
    }, 'req');
    assert.equal(out.assumptions.length, 1);
  });

  it('non-array list fields coerce to []', () => {
    const out = normalizeRequirements({
      final: {
        user_stories: 'not-array',
        acceptance_criteria: 'not-array',
        non_goals: 'not-array',
        open_questions: 'not-array',
        assumptions: 'not-array',
        suggested_files_touched: 'not-array',
      },
    }, 'req');
    assert.deepEqual(out.user_stories, []);
    assert.deepEqual(out.acceptance_criteria, []);
    assert.deepEqual(out.non_goals, []);
    assert.deepEqual(out.open_questions, []);
    assert.deepEqual(out.assumptions, []);
    assert.deepEqual(out.suggested_files_touched, []);
  });

  it('estimated_complexity unknown value → "medium" default', () => {
    const out = normalizeRequirements({
      final: { estimated_complexity: 'colossal' },
    }, 'req');
    assert.equal(out.estimated_complexity, 'medium');
  });

  it('estimated_complexity accepts the 5 valid values', () => {
    for (const c of ['trivial', 'small', 'medium', 'large', 'epic']) {
      const out = normalizeRequirements({ final: { estimated_complexity: c } }, 'req');
      assert.equal(out.estimated_complexity, c);
    }
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/requirements-agent');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['ROLE', 'normalizeRequirements', 'requirements']);
  });
});
