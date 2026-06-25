/**
 * New output formats wired through the registry:
 *   txt, json, xml, yaml, rtf, odt, epub
 *
 * The registry must:
 *   1. Resolve the format from MIME and from extension.
 *   2. Return at least one runtime-allowed generator.
 *   3. Pick the highest-preference candidate first.
 *   4. Pass the integrity audit (no duplicate ids).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseGenerators,
  contentQualityScore,
  formatAdvice,
  formatExtension,
  inspectFormat,
  getGeneratorById,
  getParserById,
  inferFormat,
  integrity,
  listFormats,
  mimeForFormat,
  validateGeneratorPlan,
} = require('../src/services/sira/document-pipeline-registry');

const NEW_FORMATS = [
  { format: 'txt',  ext: 'txt',  mime: 'text/plain' },
  { format: 'json', ext: 'json', mime: 'application/json' },
  { format: 'xml',  ext: 'xml',  mime: 'application/xml' },
  { format: 'yaml', ext: 'yml',  mime: 'application/yaml' },
  { format: 'rtf',  ext: 'rtf',  mime: 'application/rtf' },
  { format: 'odt',  ext: 'odt',  mime: 'application/vnd.oasis.opendocument.text' },
  { format: 'epub', ext: 'epub', mime: 'application/epub+zip' },
];

for (const { format, ext, mime } of NEW_FORMATS) {
  test(`registry: ${format} resolves from mime + ext`, () => {
    assert.equal(inferFormat(mime, null), format);
    assert.equal(inferFormat(null, ext), format);
    assert.equal(inferFormat(null, '.' + ext), format);
  });

  test(`registry: ${format} has at least one generator`, () => {
    const { generators } = chooseGenerators({ format });
    assert.ok(generators.length >= 1, `expected ≥1 generator for ${format}`);
    // Highest-preference first
    for (let i = 1; i < generators.length; i++) {
      assert.ok(generators[i - 1].preference >= generators[i].preference);
    }
  });
}

test('registry: yml extension normalises to yaml format', () => {
  assert.equal(inferFormat(null, 'yml'), 'yaml');
});

test('registry: htm extension normalises to html format', () => {
  assert.equal(inferFormat(null, 'htm'), 'html');
});

test('registry: integrity audit passes after additions', () => {
  const r = integrity();
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test('registry: pure-node runtime can still produce txt/json', () => {
  const nodeOnly = { python: false, node: true, binary: false };
  for (const fmt of ['txt', 'json', 'xml', 'yaml']) {
    const { generators } = chooseGenerators({ format: fmt, runtime: nodeOnly });
    assert.ok(generators.length >= 1, `${fmt} needs a node generator`);
    assert.ok(generators.every(g => g.language === 'node'));
  }
});

test('registry: markdown mime variants resolve to md', () => {
  for (const m of ['text/markdown', 'text/x-markdown', 'application/markdown']) {
    assert.equal(inferFormat(m, null), 'md', `mime ${m} → md`);
  }
  for (const e of ['md', 'markdown', 'mdown', 'mkd']) {
    assert.equal(inferFormat(null, e), 'md', `ext ${e} → md`);
  }
});

test('registry: yaml mime variants resolve to yaml', () => {
  for (const m of ['application/yaml', 'text/yaml', 'application/x-yaml', 'text/x-yaml']) {
    assert.equal(inferFormat(m, null), 'yaml', `mime ${m} → yaml`);
  }
});

test('registry: tex/latex aliases resolve to tex', () => {
  for (const m of ['application/x-tex', 'application/x-latex', 'text/x-tex']) {
    assert.equal(inferFormat(m, null), 'tex');
  }
  for (const e of ['tex', 'latex', 'ltx']) {
    assert.equal(inferFormat(null, e), 'tex');
  }
});

test('registry: xhtml normalises to html', () => {
  assert.equal(inferFormat('application/xhtml+xml', null), 'html');
  assert.equal(inferFormat(null, 'xhtml'), 'html');
});

test('registry: image mime/ext coverage', () => {
  for (const m of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff']) {
    assert.equal(inferFormat(m, null), 'image');
  }
  for (const e of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']) {
    assert.equal(inferFormat(null, e), 'image');
  }
});

test('registry: mime with charset suffix still resolves', () => {
  assert.equal(inferFormat('text/markdown; charset=utf-8', null), 'md');
  assert.equal(inferFormat('application/json; charset=UTF-8', null), 'json');
});

test('registry: rtf falls back to node when binary unavailable', () => {
  const { generators } = chooseGenerators({
    format: 'rtf',
    runtime: { python: false, node: true, binary: false },
  });
  assert.ok(generators.length >= 1);
  assert.equal(generators[0].id, 'sira-rtf');
  assert.ok(generators.some((g) => g.id === 'rtf-writer'));
});

// ── New formats: ndjson / tsv / ics / vcf / bib ─────────────────

const EXTRA_FORMATS = [
  { format: 'ndjson', ext: 'ndjson', mime: 'application/x-ndjson' },
  { format: 'ndjson', ext: 'jsonl',  mime: 'application/jsonl' },
  { format: 'tsv',    ext: 'tsv',    mime: 'text/tab-separated-values' },
  { format: 'ics',    ext: 'ics',    mime: 'text/calendar' },
  { format: 'ics',    ext: 'ical',   mime: 'text/calendar' },
  { format: 'vcf',    ext: 'vcf',    mime: 'text/vcard' },
  { format: 'vcf',    ext: 'vcard',  mime: 'text/x-vcard' },
  { format: 'bib',    ext: 'bib',    mime: 'application/x-bibtex' },
  { format: 'bib',    ext: 'bibtex', mime: 'text/x-bibtex' },
];

for (const { format, ext, mime } of EXTRA_FORMATS) {
  test(`registry: ${format} resolves from mime "${mime}" and ext "${ext}"`, () => {
    assert.equal(inferFormat(mime, null), format);
    assert.equal(inferFormat(null, ext), format);
  });
  test(`registry: ${format} has at least one node generator`, () => {
    const { generators } = chooseGenerators({ format, runtime: { python: false, node: true, binary: false } });
    assert.ok(generators.length >= 1, `${format} needs a node generator`);
  });
}

test('registry: getGeneratorById / getParserById lookups', () => {
  assert.equal(getGeneratorById('exceljs').format, 'xlsx');
  assert.equal(getGeneratorById('nonexistent'), undefined);
  assert.ok(getParserById('docling').formats.includes('pdf'));
  assert.equal(getParserById('nope'), undefined);
});

test('registry: listFormats covers parsers and generators', () => {
  const all = listFormats();
  for (const fmt of ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'json', 'ndjson', 'ics', 'vcf', 'bib', 'epub']) {
    assert.ok(all.includes(fmt), `expected ${fmt} in listFormats() — got ${all.join(',')}`);
  }
  const onlyGen = listFormats({ side: 'generators' });
  assert.ok(onlyGen.includes('rtf'));
  assert.ok(!onlyGen.includes('image'));
  const onlyParse = listFormats({ side: 'parsers' });
  assert.ok(onlyParse.includes('image'));
});

test('registry: mimeForFormat returns highest-preference MIME', () => {
  assert.equal(mimeForFormat('json'), 'application/json');
  assert.equal(mimeForFormat('csv'), 'text/csv');
  assert.equal(mimeForFormat('ics'), 'text/calendar');
  assert.equal(mimeForFormat('unknown'), null);
});

// ── contentQualityScore extensions ──────────────────────────────

test('contentQualityScore: detects markdown structure', () => {
  const md = `# Heading

This document has multiple paragraphs and some structure.
Sentences explaining things, with reasonable length and clarity.

## Second section

- bullet one
- bullet two
- bullet three

\`\`\`js
const x = 1;
\`\`\`

See [docs](https://example.com) for more.`;
  const r = contentQualityScore(md, 'md');
  assert.equal(r.passed, true);
  assert.ok(r.detail.headings >= 2);
  assert.ok(r.detail.listItems >= 3);
  assert.equal(r.detail.codeBlocks, 1);
  assert.equal(r.detail.links, 1);
});

test('contentQualityScore: flags repeated lines', () => {
  const repeated = ['# Title', '', ...Array(10).fill('Lorem ipsum dolor sit amet consectetur adipiscing.'), ''].join('\n');
  const r = contentQualityScore(repeated, 'md');
  assert.ok(r.warnings.includes('repeated_lines') || r.warnings.includes('contains_placeholders'));
});

test('contentQualityScore: empty / non-string returns score 0', () => {
  assert.equal(contentQualityScore('', 'md').score, 0);
  assert.equal(contentQualityScore(null, 'md').score, 0);
  assert.equal(contentQualityScore(123, 'md').score, 0);
});

test('contentQualityScore: whitespace-only trims to empty → content_too_short (not no_content)', () => {
  // Distinct branch from the falsy/non-string path: a truthy string that trims
  // to '' reaches the length checks, flagging content_too_short.
  const r = contentQualityScore('   \n\t  ', 'md');
  assert.ok(r.issues.includes('content_too_short'), 'flags too-short body');
  assert.equal(r.issues.includes('no_content'), false, 'not the empty/non-string path');
  assert.ok(r.score < 100);
});

test('contentQualityScore: detects markdown table rows', () => {
  const md = `# Report

| Col A | Col B |
|-------|-------|
| 1     | 2     |
| 3     | 4     |

Conclusion paragraph with some explanatory sentences for context.`;
  const r = contentQualityScore(md, 'md');
  assert.ok(r.detail.tableRows >= 4);
});

// ── formatAdvice extensions ─────────────────────────────────────

test('formatAdvice: recommends pdf/docx for resume', () => {
  const adv = formatAdvice('txt', 'create my resume');
  assert.ok(adv.alternatives.includes('pdf'));
  assert.ok(adv.notes.some(n => /resume|cv/i.test(n)));
});

test('formatAdvice: recommends ics for calendar events', () => {
  const adv = formatAdvice('json', 'export my calendar of meetings');
  assert.ok(adv.alternatives.includes('ics'));
});

test('formatAdvice: recommends vcf for contacts', () => {
  const adv = formatAdvice('csv', 'export contact records');
  assert.ok(adv.alternatives.includes('vcf'));
});

test('formatAdvice: recommends epub for ebook', () => {
  const adv = formatAdvice('docx', 'publish my novel as an ebook');
  assert.ok(adv.alternatives.includes('epub'));
});

test('formatAdvice: recommends ndjson for streaming logs', () => {
  const adv = formatAdvice('json', 'stream of event log records');
  assert.ok(adv.alternatives.includes('ndjson'));
});

test('formatAdvice: alternatives are unique', () => {
  const adv = formatAdvice('json', 'data table chart calendar contact');
  const seen = new Set();
  for (const a of adv.alternatives) {
    assert.ok(!seen.has(a), `duplicate alternative ${a}`);
    seen.add(a);
  }
});

test('formatAdvice: leaves "best" matching the chosen format', () => {
  const adv = formatAdvice('PDF', 'formal report');
  assert.equal(adv.best, 'pdf');
});

// ── formatExtension ────────────────────────────────────────────

test('formatExtension: maps known formats to canonical extensions', () => {
  assert.equal(formatExtension('pdf'), 'pdf');
  assert.equal(formatExtension('docx'), 'docx');
  assert.equal(formatExtension('ndjson'), 'ndjson');
  assert.equal(formatExtension('ics'), 'ics');
  assert.equal(formatExtension('image'), 'png');
  assert.equal(formatExtension('IMAGE'), 'png');
});

test('formatExtension: returns null for unknown', () => {
  assert.equal(formatExtension('whatever'), null);
  assert.equal(formatExtension(''), null);
  assert.equal(formatExtension(null), null);
});

test('formatExtension: round-trips with inferFormat for every supported format', () => {
  const formats = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'tsv', 'html', 'md',
    'json', 'ndjson', 'xml', 'yaml', 'rtf', 'odt', 'epub', 'tex',
    'ics', 'vcf', 'bib', 'svg', 'txt'];
  for (const f of formats) {
    const ext = formatExtension(f);
    assert.ok(ext, `format ${f} must have an extension`);
    assert.equal(inferFormat(null, ext), f, `${f} -> ${ext} -> ${inferFormat(null, ext)}`);
  }
});

// ── validateGeneratorPlan ──────────────────────────────────────

test('validateGeneratorPlan: rejects null/undefined plans', () => {
  assert.deepEqual(validateGeneratorPlan('pdf', null).issues, ['plan_missing']);
  assert.deepEqual(validateGeneratorPlan('pdf', undefined).issues, ['plan_missing']);
});

test('validateGeneratorPlan: tabular formats need rows', () => {
  assert.equal(validateGeneratorPlan('csv', { rows: [] }).ok, false);
  assert.equal(validateGeneratorPlan('csv', { rows: [{ a: 1 }] }).ok, true);
  assert.equal(validateGeneratorPlan('csv', [{ a: 1 }]).ok, true);
  assert.equal(validateGeneratorPlan('xlsx', { data: [{ a: 1 }] }).ok, true);
  assert.equal(validateGeneratorPlan('tsv', { rows: [] }).ok, false);
});

test('validateGeneratorPlan: ndjson/ics/vcf need their respective collections', () => {
  assert.equal(validateGeneratorPlan('ndjson', { records: [] }).ok, false);
  assert.equal(validateGeneratorPlan('ndjson', { records: [{ a: 1 }] }).ok, true);
  assert.equal(validateGeneratorPlan('ics', { events: [{ summary: 's' }] }).ok, true);
  assert.equal(validateGeneratorPlan('ics', {}).ok, false);
  assert.equal(validateGeneratorPlan('vcf', { contacts: [{ name: 'n' }] }).ok, true);
  assert.equal(validateGeneratorPlan('vcf', {}).ok, false);
});

test('validateGeneratorPlan: document formats accept body or sections', () => {
  assert.equal(validateGeneratorPlan('docx', { body: 'hello' }).ok, true);
  assert.equal(validateGeneratorPlan('docx', { markdown: '# h' }).ok, true);
  assert.equal(validateGeneratorPlan('docx', { sections: [{ heading: 'a' }] }).ok, true);
  assert.equal(validateGeneratorPlan('docx', 'plain string body ok').ok, true);
  assert.equal(validateGeneratorPlan('docx', {}).ok, false);
});

test('validateGeneratorPlan: lenient for formats without specific shape rules', () => {
  // svg/json/png have no specific row/event shape — empty object is fine.
  assert.equal(validateGeneratorPlan('json', {}).ok, true);
  assert.equal(validateGeneratorPlan('svg', { svg: '<svg/>' }).ok, true);
});

// ── inspectFormat ──────────────────────────────────────────────

test('inspectFormat: returns null for unknown formats', () => {
  assert.equal(inspectFormat('asdf'), null);
  assert.equal(inspectFormat(null), null);
  assert.equal(inspectFormat(''), null);
});

test('inspectFormat: pdf summary lists OCR + layout capabilities', () => {
  const s = inspectFormat('pdf');
  assert.equal(s.format, 'pdf');
  assert.equal(s.extension, 'pdf');
  assert.equal(s.mime, 'application/pdf');
  assert.ok(s.parsers > 0 && s.generators > 0);
  assert.equal(s.canParse, true);
  assert.equal(s.canGenerate, true);
  assert.equal(s.capabilities.ocr, true);
  assert.equal(s.capabilities.layout, true);
  assert.ok(s.bestParser);
  assert.ok(s.bestGenerator);
});

test('inspectFormat: ndjson is generate-only', () => {
  const s = inspectFormat('ndjson');
  assert.equal(s.canGenerate, true);
  assert.equal(s.canParse, false);
  assert.equal(s.bestGenerator, 'ndjson-writer');
  assert.equal(s.bestParser, null);
});

test('inspectFormat: respects runtime profile', () => {
  // Pure-node runtime: PDF generators that need binary become unavailable.
  const noBinary = { python: true, node: true, binary: false };
  const s = inspectFormat('pdf', noBinary);
  assert.equal(s.canParse, true); // some python parsers still work
  // Highest-preference generator (playwright-pdf) requires binary; verify
  // bestGenerator is one that's actually node-library-based.
  if (s.bestGenerator) {
    const g = require('../src/services/sira/document-pipeline-registry').getGeneratorById(s.bestGenerator);
    assert.notEqual(g.runtime, 'binary');
  }
});

test('inspectFormat: csv reports tables capability', () => {
  const s = inspectFormat('csv');
  assert.equal(s.capabilities.tables, true);
  assert.equal(s.extension, 'csv');
});
