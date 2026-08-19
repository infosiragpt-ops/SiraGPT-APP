/**
 * Tests for services/agents/maintenance-agent.js — issue-ticket
 * triage + patch proposer.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  resolve,
  normalizeMaintenance,
  extractTicketHints,
  ROLE,
} = require('../src/services/agents/maintenance-agent');

// ── ROLE constant ────────────────────────────────────────────────

describe('ROLE constant', () => {
  it('positions as triaging senior engineer', () => {
    assert.match(ROLE, /senior engineer triaging/);
  });

  it('says NOT to guess unread code', () => {
    assert.match(ROLE, /Never guess code/);
  });

  it('prefers "not_localised" verdict over fabricated patch', () => {
    assert.match(ROLE, /not_localised.*more useful than a fabricated patch/s);
  });

  it('demands honest confidence', () => {
    // The ROLE wraps lines, so "State" and "your" are separated by a
    // newline + indent. The `s` flag lets `.` match newlines.
    assert.match(ROLE, /State.+your confidence honestly/s);
  });
});

// ── extractTicketHints ────────────────────────────────────────

describe('extractTicketHints · primitives', () => {
  it('returns {} for null/non-string/empty', () => {
    assert.deepEqual(extractTicketHints(null), {});
    assert.deepEqual(extractTicketHints(undefined), {});
    assert.deepEqual(extractTicketHints(42), {});
  });

  it('empty string returns object with empty arrays', () => {
    const out = extractTicketHints('');
    // Per source: returns {} for falsy (empty string is falsy).
    assert.deepEqual(out, {});
  });
});

describe('extractTicketHints · file paths', () => {
  it('extracts common code file extensions', () => {
    const ticket = 'See src/foo.ts and lib/bar.py and tests/baz.test.tsx for context';
    const out = extractTicketHints(ticket);
    assert.deepEqual(out.filePaths.sort(), ['lib/bar.py', 'src/foo.ts', 'tests/baz.test.tsx']);
  });

  it('extracts other supported extensions (rb, java, go, rs, sql, md, etc.)', () => {
    const ticket = 'a.rb b.java c.go d.rs e.sql f.md g.yaml h.toml';
    const out = extractTicketHints(ticket);
    assert.equal(out.filePaths.length, 8);
  });

  it('dedupes filePaths', () => {
    const ticket = 'foo.ts and foo.ts and foo.ts';
    const out = extractTicketHints(ticket);
    assert.equal(out.filePaths.length, 1);
  });

  it('caps filePaths at 20', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
    const ticket = paths.join(' ');
    const out = extractTicketHints(ticket);
    assert.equal(out.filePaths.length, 20);
  });
});

describe('extractTicketHints · symbols', () => {
  it('extracts camelCase + snake_case identifiers (mixed-case required)', () => {
    const ticket = 'function processUserData and snake_case_var';
    const out = extractTicketHints(ticket);
    assert.ok(out.symbols.includes('processUserData'));
    assert.ok(out.symbols.includes('snake_case_var'));
  });

  it('does NOT extract all-lowercase plain words', () => {
    const ticket = 'simple lowercase words like hello world should not match';
    const out = extractTicketHints(ticket);
    // None of these have an uppercase OR underscore, so filtered.
    assert.deepEqual(out.symbols, []);
  });

  it('does NOT extract all-uppercase constants without case mix', () => {
    const ticket = 'MAX VALUE LIMIT'; // all caps + no underscore
    const out = extractTicketHints(ticket);
    assert.deepEqual(out.symbols, []);
  });

  it('caps symbols at 30', () => {
    // Generate 50 distinct camelCase symbols.
    const symbols = Array.from({ length: 50 }, (_, i) => `myFn${i}A`);
    const ticket = symbols.join(' ');
    const out = extractTicketHints(ticket);
    assert.equal(out.symbols.length, 30);
  });
});

describe('extractTicketHints · quoted strings', () => {
  it('extracts double + single-quoted strings (4-120 chars)', () => {
    const ticket = 'errors say "user not found" and \'permission denied\'';
    const out = extractTicketHints(ticket);
    assert.equal(out.quotedStrings.length, 2);
  });

  it('rejects too-short quoted strings (< 4 chars)', () => {
    const ticket = 'msg="ok"';
    const out = extractTicketHints(ticket);
    assert.deepEqual(out.quotedStrings, []);
  });

  it('caps quotedStrings at 10', () => {
    const ticket = Array.from({ length: 30 }, (_, i) => `"phrase${i}"`).join(' ');
    const out = extractTicketHints(ticket);
    assert.equal(out.quotedStrings.length, 10);
  });
});

describe('extractTicketHints · urls', () => {
  it('extracts http and https URLs', () => {
    const ticket = 'See https://example.com/docs and http://example.org/issue/42';
    const out = extractTicketHints(ticket);
    assert.equal(out.urls.length, 2);
  });

  it('caps urls at 10', () => {
    const ticket = Array.from({ length: 20 }, (_, i) => `https://x.com/p${i}`).join(' ');
    const out = extractTicketHints(ticket);
    assert.equal(out.urls.length, 10);
  });
});

// ── resolve · validation ─────────────────────────────────────

describe('resolve · validation', () => {
  it('throws when ticket is missing', async () => {
    await assert.rejects(
      () => resolve({ openai: {}, userId: 'u' }),
      /"ticket" is required/,
    );
  });
});

// ── normalizeMaintenance · happy path ────────────────────────

describe('normalizeMaintenance · happy path', () => {
  it('passes through fully-valid output', () => {
    const out = normalizeMaintenance({
      final: {
        status: 'likely_fix',
        localisation: {
          confidence: 0.7,
          primary_file: 'src/handler.js',
          primary_symbol: 'processOrder',
          related_files: ['src/validator.js'],
          rationale: 'found in handler',
        },
        hypothesis: 'missing validation step',
        patches: [{
          source: 'src/handler.js',
          start_line: 12,
          end_line: 14,
          replacement: 'validate(input);',
          rationale: 'add validation',
          confidence: 0.8,
        }],
        tests_to_add: ['validates missing fields'],
        open_questions: ['which fields are required?'],
      },
      iterations: 6,
      terminatedBy: 'final',
      stats: { tokens: 1234 },
    }, { ticket: 't', hints: { filePaths: ['src/handler.js'] } });

    assert.equal(out.status, 'likely_fix');
    assert.equal(out.localisation.confidence, 0.7);
    assert.equal(out.localisation.primary_file, 'src/handler.js');
    assert.equal(out.patches.length, 1);
    assert.equal(out.patches[0].confidence, 0.8);
    assert.equal(out.tests_to_add.length, 1);
    assert.equal(out.open_questions.length, 1);
    assert.deepEqual(out.ticket_hints, { filePaths: ['src/handler.js'] });
    assert.equal(out.iterations, 6);
    assert.deepEqual(out.stats, { tokens: 1234 });
  });
});

// ── normalizeMaintenance · defaults + coercion ────────────────

describe('normalizeMaintenance · defaults', () => {
  it('unknown status → "not_localised"', () => {
    const out = normalizeMaintenance({ final: { status: 'fabricated' } }, { ticket: 't', hints: {} });
    assert.equal(out.status, 'not_localised');
  });

  it('accepts all 4 valid statuses', () => {
    for (const s of ['resolved', 'likely_fix', 'not_localised', 'out_of_scope']) {
      const out = normalizeMaintenance({ final: { status: s } }, { ticket: 't', hints: {} });
      assert.equal(out.status, s);
    }
  });

  it('missing localisation → default object with confidence 0.5', () => {
    const out = normalizeMaintenance({ final: {} }, { ticket: 't', hints: {} });
    assert.equal(out.localisation.confidence, 0.5);
    assert.equal(out.localisation.primary_file, null);
    assert.equal(out.localisation.primary_symbol, null);
    assert.deepEqual(out.localisation.related_files, []);
    assert.equal(out.localisation.rationale, '');
  });

  it('hypothesis/patches/tests_to_add/open_questions default to "" or []', () => {
    const out = normalizeMaintenance({ final: {} }, { ticket: 't', hints: {} });
    assert.equal(out.hypothesis, '');
    assert.deepEqual(out.patches, []);
    assert.deepEqual(out.tests_to_add, []);
    assert.deepEqual(out.open_questions, []);
  });
});

describe('normalizeMaintenance · field caps', () => {
  it('hypothesis truncated to 1500', () => {
    const out = normalizeMaintenance({
      final: { hypothesis: 'h'.repeat(3000) },
    }, { ticket: 't', hints: {} });
    assert.equal(out.hypothesis.length, 1500);
  });

  it('localisation.rationale truncated to 1000', () => {
    const out = normalizeMaintenance({
      final: { localisation: { rationale: 'r'.repeat(2000) } },
    }, { ticket: 't', hints: {} });
    assert.equal(out.localisation.rationale.length, 1000);
  });

  it('localisation.related_files capped at 20 + each coerced to string', () => {
    const files = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
    const out = normalizeMaintenance({
      final: { localisation: { related_files: files } },
    }, { ticket: 't', hints: {} });
    assert.equal(out.localisation.related_files.length, 20);
  });

  it('patches drop entries missing source OR replacement', () => {
    const out = normalizeMaintenance({
      final: { patches: [
        { source: 'a.js', replacement: 'fix' },
        { source: 'b.js' },             // no replacement
        { replacement: 'orphan' },       // no source
      ]},
    }, { ticket: 't', hints: {} });
    assert.equal(out.patches.length, 1);
  });

  it('patch rationale truncated to 400, confidence clamped [0,1]', () => {
    const out = normalizeMaintenance({
      final: { patches: [{
        source: 'a.js', replacement: 'x',
        rationale: 'r'.repeat(800), confidence: 1.5,
      }]},
    }, { ticket: 't', hints: {} });
    assert.equal(out.patches[0].rationale.length, 400);
    assert.equal(out.patches[0].confidence, 1);
  });

  it('non-integer start_line/end_line → null', () => {
    const out = normalizeMaintenance({
      final: { patches: [{ source: 'a', replacement: 'x', start_line: 'nope', end_line: 1.5 }] },
    }, { ticket: 't', hints: {} });
    assert.equal(out.patches[0].start_line, null);
    assert.equal(out.patches[0].end_line, null);
  });

  it('tests_to_add: each truncated to 300, list capped at 10', () => {
    const tests = Array.from({ length: 20 }, (_, i) => `test ${i}: ` + 'x'.repeat(500));
    const out = normalizeMaintenance({
      final: { tests_to_add: tests },
    }, { ticket: 't', hints: {} });
    assert.equal(out.tests_to_add.length, 10);
    for (const t of out.tests_to_add) assert.ok(t.length <= 300);
  });

  it('open_questions: each truncated to 200, list capped at 10', () => {
    const qs = Array.from({ length: 20 }, (_, i) => `q ${i}: ` + 'y'.repeat(500));
    const out = normalizeMaintenance({
      final: { open_questions: qs },
    }, { ticket: 't', hints: {} });
    assert.equal(out.open_questions.length, 10);
    for (const q of out.open_questions) assert.ok(q.length <= 200);
  });

  it('localisation.confidence clamped to [0, 1]; non-numeric → 0.5', () => {
    const a = normalizeMaintenance({ final: { localisation: { confidence: -0.5 } } }, { ticket: 't', hints: {} });
    assert.equal(a.localisation.confidence, 0);
    const b = normalizeMaintenance({ final: { localisation: { confidence: 1.5 } } }, { ticket: 't', hints: {} });
    assert.equal(b.localisation.confidence, 1);
    const c = normalizeMaintenance({ final: { localisation: { confidence: 'high' } } }, { ticket: 't', hints: {} });
    assert.equal(c.localisation.confidence, 0.5);
  });

  it('non-string primary_file / primary_symbol → null', () => {
    const out = normalizeMaintenance({
      final: { localisation: { primary_file: 42, primary_symbol: { not: 'string' } } },
    }, { ticket: 't', hints: {} });
    assert.equal(out.localisation.primary_file, null);
    assert.equal(out.localisation.primary_symbol, null);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/maintenance-agent');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['ROLE', 'extractTicketHints', 'normalizeMaintenance', 'resolve']);
  });
});
