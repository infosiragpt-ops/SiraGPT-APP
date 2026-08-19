'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterVerifiedPapers, structurePhase, runThesisPipeline } = require('../src/services/thesis/thesis-engine');
const { validateWordCount } = require('../src/services/thesis/word-count-validator');

test('filterVerifiedPapers rejects missing DOI and old year', () => {
  const papers = filterVerifiedPapers([
    { doi: '10.1234/x', year: 2024, title: 'A' },
    { doi: '', year: 2024, title: 'B' },
    { doi: '10.1234/y', year: 2010, title: 'C' },
  ]);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].title, 'A');
});

test('word count validator enforces bounds', () => {
  const short = validateWordCount('one two', { min: 5, max: 10 });
  assert.equal(short.ok, false);
  const ok = validateWordCount('one two three four five', { min: 4, max: 10 });
  assert.equal(ok.ok, true);
});

test('thesis pipeline runs with injected research', async () => {
  const templates = structurePhase(['introduction']);
  assert.equal(templates.length, 1);

  const report = await runThesisPipeline(
    { topic: 'Machine learning in healthcare', chapterIds: ['introduction'] },
    {
      researchPhase: async () => ({
        papers: [{ doi: '10.5555/test', year: 2024, title: 'Paper', authors: ['Smith'] }],
        providers: ['mock'],
        rejected: 0,
      }),
      generateChapter: async ({ template }) => `${template.title}\n\n`.repeat(120),
    },
  );
  assert.equal(report.chapters.length, 1);
  assert.ok(report.references.length >= 1);
});
