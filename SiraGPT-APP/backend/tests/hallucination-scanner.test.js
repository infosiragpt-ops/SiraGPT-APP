'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const scanner = require('../src/services/sira/hallucination-scanner');
const { scanAnswerForHallucinations, renderHallucinationReport } = scanner;

// ─── Numbers ────────────────────────────────────────────────────────

test('flags unsupported percent claims that do not appear in evidence', () => {
  const out = scanAnswerForHallucinations({
    answer: 'The conversion rate jumped to 42% last quarter.',
    evidence: 'The conversion rate moved from 24% to 28%.',
  });
  assert.ok(out.unsupportedNumbers.some(n => n.includes('42%')));
});

test('passes percent claims that appear verbatim in evidence', () => {
  const out = scanAnswerForHallucinations({
    answer: 'Revenue grew 18% YoY.',
    evidence: 'According to the report, revenue grew 18% YoY.',
  });
  assert.ok(!out.unsupportedNumbers.some(n => n.includes('18%')));
});

test('matches money even with comma / currency-symbol normalisation', () => {
  const out = scanAnswerForHallucinations({
    answer: 'The total cost is $1,200,000.',
    evidence: 'The contract value is 1200000 USD according to the schedule.',
  });
  // Should NOT flag $1,200,000 since the digits match normalised
  assert.ok(!out.unsupportedNumbers.some(n => /1,200,000/.test(n)),
    `expected no flag, got ${JSON.stringify(out.unsupportedNumbers)}`);
});

test('flags large numbers that have no support in evidence', () => {
  const out = scanAnswerForHallucinations({
    answer: 'The plant produced 4,567,890 units in 2026.',
    evidence: 'The plant is operational since 2020.',
  });
  assert.ok(out.unsupportedNumbers.length >= 1);
});

// ─── Quoted statements ─────────────────────────────────────────

test('flags a fabricated quoted statement', () => {
  const out = scanAnswerForHallucinations({
    answer: 'The CEO said "we will dominate the market by Q4 of next year for sure".',
    evidence: 'The CEO discussed competitive positioning during the call.',
  });
  assert.ok(out.fabricatedQuotes.length >= 1, `got ${JSON.stringify(out.fabricatedQuotes)}`);
});

test('does not flag quotes that match the evidence verbatim', () => {
  const evidence = 'According to the spokesperson, "the project is on track for Q3 delivery this year".';
  const out = scanAnswerForHallucinations({
    answer: 'The spokesperson said "the project is on track for Q3 delivery this year".',
    evidence,
  });
  assert.equal(out.fabricatedQuotes.length, 0);
});

test('soft-match: passes quotes with ≥70% significant word overlap', () => {
  const evidence = 'The team must validate the SLA before the customer launch this quarter.';
  // Slightly paraphrased version of the source
  const out = scanAnswerForHallucinations({
    answer: 'They wrote: "validate the SLA before the customer launch this quarter".',
    evidence,
  });
  assert.equal(out.fabricatedQuotes.length, 0, `got ${JSON.stringify(out.fabricatedQuotes)}`);
});

// ─── Entities ─────────────────────────────────────────────────

test('flags named entities absent from evidence (advisory)', () => {
  const out = scanAnswerForHallucinations({
    answer: 'Acme Corp and Northwind Labs announced a joint partnership.',
    evidence: 'A press release mentioned a partnership in the manufacturing sector.',
  });
  assert.ok(out.suspectEntities.length >= 1);
});

test('option to disable entity scanning', () => {
  const out = scanAnswerForHallucinations({
    answer: 'Acme Corp partnered with Northwind Labs.',
    evidence: 'A partnership was announced.',
    options: { includeEntities: false },
  });
  assert.equal(out.suspectEntities.length, 0);
});

// ─── Citation drift ─────────────────────────────────────────

test('flags out-of-range citation [n] when n > evidence count', () => {
  const out = scanAnswerForHallucinations({
    answer: 'See [3] for the methodology details.',
    evidence: [{ text: 'paper 1' }, { text: 'paper 2' }],
  });
  assert.ok(out.citationDrift.some(d => /out-of-range/.test(d.reason)));
});

test('flags citation drift when local lexical overlap is too low', () => {
  const out = scanAnswerForHallucinations({
    answer: 'The mating habits of penguins in Antarctica are fascinating [1].',
    evidence: [{ text: 'Quantum field theory in curved spacetime is a major research area.' }],
  });
  assert.ok(out.citationDrift.some(d => /weak lexical overlap/.test(d.reason)));
});

test('passes citation when local overlap is reasonable', () => {
  const out = scanAnswerForHallucinations({
    answer: 'Penguin colonies migrate during Antarctic winters [1].',
    evidence: [{ text: 'Penguin colonies migrate during the Antarctic winter season.' }],
  });
  assert.equal(out.citationDrift.length, 0);
});

// ─── Overall risk ─────────────────────────────────────────

test('overall risk = low when nothing is flagged', () => {
  const out = scanAnswerForHallucinations({
    answer: 'The text is fine.',
    evidence: 'The text is fine.',
  });
  assert.equal(out.overallRisk, 'low');
});

test('overall risk = high when many hard flags accumulate', () => {
  const out = scanAnswerForHallucinations({
    answer: 'Revenue was $99,999,999 and "we will dominate the market". The CFO said "all margins exceed 87%". Q4 grew 312%.',
    evidence: 'The company is operating.',
  });
  assert.equal(out.overallRisk, 'high');
});

// ─── Evidence shape resilience ───────────────────────────────

test('flattenEvidence accepts string, array, object', () => {
  const r1 = scanAnswerForHallucinations({ answer: 'X says 50%.', evidence: 'X says 50%.' });
  assert.equal(r1.unsupportedNumbers.length, 0);

  const r2 = scanAnswerForHallucinations({
    answer: 'X says 50%.',
    evidence: [{ text: 'X says 50%.' }, { content: 'irrelevant' }],
  });
  assert.equal(r2.unsupportedNumbers.length, 0);

  const r3 = scanAnswerForHallucinations({
    answer: 'X says 50%.',
    evidence: { passage: 'X says 50%.' },
  });
  assert.equal(r3.unsupportedNumbers.length, 0);
});

test('tolerates null answer and null evidence', () => {
  const out = scanAnswerForHallucinations({});
  assert.equal(out.overallRisk, 'low');
  assert.equal(out.totalFlags, 0);
});

// ─── Render ──────────────────────────────────────────────────

test('renderHallucinationReport: produces empty string when no flags', () => {
  const out = scanAnswerForHallucinations({ answer: 'all good', evidence: 'all good' });
  assert.equal(renderHallucinationReport(out), '');
});

test('renderHallucinationReport: includes sections for each flag type', () => {
  const out = scanAnswerForHallucinations({
    answer: 'CEO said "we cured everything yesterday" and revenue rose 999%.',
    evidence: 'Routine quarterly update.',
  });
  const md = renderHallucinationReport(out);
  assert.match(md, /HALLUCINATION SCAN/);
  assert.match(md, /Risk:/);
});
