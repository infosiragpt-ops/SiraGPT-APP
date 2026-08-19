'use strict';

const { test, describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectDialect,
  parseCSV,
  formatCsvBlock,
  splitCSVLine,
  CANDIDATE_DELIMITERS,
} = require('../src/services/csv-dialect-detector');

describe('csv-dialect-detector — module exports', () => {
  it('exports the documented functions and constant', () => {
    assert.equal(typeof splitCSVLine, 'function');
    assert.equal(typeof formatCsvBlock, 'function');
    assert.equal(typeof detectDialect, 'function');
    assert.equal(typeof parseCSV, 'function');
    assert.ok(Array.isArray(CANDIDATE_DELIMITERS));
  });
});

describe('CANDIDATE_DELIMITERS', () => {
  it('contains 8 candidate delimiters, each {char,name}', () => {
    assert.equal(CANDIDATE_DELIMITERS.length, 8);
    for (const d of CANDIDATE_DELIMITERS) {
      assert.equal(typeof d.char, 'string');
      assert.equal(typeof d.name, 'string');
    }
  });

  it('includes comma, tab, semicolon, pipe with expected chars', () => {
    const byName = Object.fromEntries(CANDIDATE_DELIMITERS.map(d => [d.name, d.char]));
    assert.equal(byName.comma, ',');
    assert.equal(byName.tab, '\t');
    assert.equal(byName.semicolon, ';');
    assert.equal(byName.pipe, '|');
    assert.equal(byName.colon, ':');
    assert.equal(byName.caret, '^');
    assert.equal(byName.tilde, '~');
    assert.equal(byName['unit-separator'], '\x1F');
  });
});

describe('splitCSVLine — basic splitting', () => {
  it('splits a plain comma line into 3 fields', () => {
    assert.deepEqual(splitCSVLine('a,b,c', ','), ['a', 'b', 'c']);
  });

  it('returns a single-element array when no delimiter present', () => {
    assert.deepEqual(splitCSVLine('hello', ','), ['hello']);
  });

  it('produces empty-string fields for adjacent delimiters', () => {
    assert.deepEqual(splitCSVLine('a,,c', ','), ['a', '', 'c']);
  });

  it('produces a trailing empty field for a trailing delimiter', () => {
    assert.deepEqual(splitCSVLine('a,b,', ','), ['a', 'b', '']);
  });

  it('produces a leading empty field for a leading delimiter', () => {
    assert.deepEqual(splitCSVLine(',a,b', ','), ['', 'a', 'b']);
  });
});

describe('splitCSVLine — alternate delimiters', () => {
  it('splits a tab-delimited line', () => {
    assert.deepEqual(splitCSVLine('a\tb\tc', '\t'), ['a', 'b', 'c']);
  });

  it('splits a semicolon-delimited line', () => {
    assert.deepEqual(splitCSVLine('a;b;c', ';'), ['a', 'b', 'c']);
  });

  it('splits a pipe-delimited line', () => {
    assert.deepEqual(splitCSVLine('a|b|c', '|'), ['a', 'b', 'c']);
  });
});

describe('splitCSVLine — quoting (RFC 4180)', () => {
  it('keeps an embedded delimiter inside a quoted field', () => {
    assert.deepEqual(splitCSVLine('"a,b",c', ','), ['a,b', 'c']);
  });

  it('handles a doubled-quote escape inside a quoted field', () => {
    // "a""b" -> a"b
    assert.deepEqual(splitCSVLine('"a""b",c', ','), ['a"b', 'c']);
  });

  it('strips the surrounding quotes from a quoted field', () => {
    assert.deepEqual(splitCSVLine('"hello",world', ','), ['hello', 'world']);
  });

  it('supports a custom single-quote quote char', () => {
    assert.deepEqual(splitCSVLine("'a,b',c", ',', "'"), ['a,b', 'c']);
  });

  it('falls back to double quote when quote arg is empty string', () => {
    // quote='' -> q = '"' via `quote || '"'`
    assert.deepEqual(splitCSVLine('"a,b",c', ',', ''), ['a,b', 'c']);
  });

  it('treats a doubled quote at the very start as open+close (NOT an escape)', () => {
    // '""x"' : first '"' opens quotes; the 2nd char is '"' but the lookahead
    // (line[i+1]==='x') is NOT a quote, so it is a *closing* quote, not an
    // escape. Then 'x' is appended outside quotes, then the final '"' re-opens
    // quotes with no content. Result is just 'x'. (Code-as-written contract.)
    assert.deepEqual(splitCSVLine('""x"', ','), ['x']);
  });
});

describe('splitCSVLine — per-field trim contract', () => {
  it('trims surrounding whitespace from unquoted fields', () => {
    assert.deepEqual(splitCSVLine('  a , b ,c  ', ','), ['a', 'b', 'c']);
  });

  it('TRIMS intentional spaces even inside a quoted field (locked contract)', () => {
    // The final current.trim() applies regardless of quoting, so a quoted
    // field with intentional leading/trailing spaces IS trimmed.
    assert.deepEqual(splitCSVLine('"  spaced  ",b', ','), ['spaced', 'b']);
  });

  it('preserves internal spaces, trims only the edges', () => {
    assert.deepEqual(splitCSVLine('"a  b",c', ','), ['a  b', 'c']);
  });
});

describe('splitCSVLine — empty / non-string input', () => {
  it('returns [] for empty string', () => {
    assert.deepEqual(splitCSVLine('', ','), []);
  });

  it('returns [] for null', () => {
    assert.deepEqual(splitCSVLine(null, ','), []);
  });

  it('returns [] for undefined', () => {
    assert.deepEqual(splitCSVLine(undefined, ','), []);
  });

  it('returns [] for a number', () => {
    assert.deepEqual(splitCSVLine(12345, ','), []);
  });
});

describe('formatCsvBlock — pure rendering', () => {
  it('renders a stable comma block WITHOUT a dialect comment (comma is default)', () => {
    const out = formatCsvBlock({
      headers: ['name', 'age'],
      rows: [['alice', '30'], ['bob', '25']],
      dialect: { delimiterName: 'comma', delimiter: ',' },
      encoding: 'utf8',
    });
    assert.equal(out, [
      '# Columns: name | age',
      'name,age',
      'alice,30\nbob,25',
    ].join('\n'));
  });

  it('emits a dialect comment for non-comma delimiters', () => {
    const out = formatCsvBlock({
      headers: ['a', 'b'],
      rows: [['1', '2']],
      dialect: { delimiterName: 'semicolon', delimiter: ';' },
      encoding: 'latin1',
    });
    assert.equal(out, [
      '# Detected dialect: semicolon (encoding: latin1)',
      '# Columns: a | b',
      'a;b',
      '1;2',
    ].join('\n'));
  });

  it('defaults encoding label to utf8 in the dialect comment when missing', () => {
    const out = formatCsvBlock({
      headers: [],
      rows: [['x', 'y']],
      dialect: { delimiterName: 'tab', delimiter: '\t' },
      encoding: undefined,
    });
    const lines = out.split('\n');
    assert.equal(lines[0], '# Detected dialect: tab (encoding: utf8)');
    // No header block when headers is empty
    assert.ok(!out.includes('# Columns:'));
    assert.equal(lines[1], 'x\ty');
  });

  it('omits the header block when headers is empty', () => {
    const out = formatCsvBlock({
      headers: [],
      rows: [['1', '2'], ['3', '4']],
      dialect: { delimiterName: 'comma', delimiter: ',' },
      encoding: 'utf8',
    });
    assert.equal(out, '1,2\n3,4');
  });

  it('renders an empty rows block as an empty string segment', () => {
    const out = formatCsvBlock({
      headers: ['a', 'b'],
      rows: [],
      dialect: { delimiterName: 'comma', delimiter: ',' },
      encoding: 'utf8',
    });
    // rows.map(...).join('\n') === '' so the last segment is empty
    assert.equal(out, '# Columns: a | b\na,b\n');
  });
});

describe('detectDialect — buffer / non-fs paths', () => {
  it('returns the comma default for non-string, non-buffer input', async () => {
    const d = await detectDialect(42);
    assert.equal(d.delimiter, ',');
    assert.equal(d.delimiterName, 'comma');
    assert.equal(d.header, true);
    assert.equal(d.quote, '"');
    assert.equal(d.avgColumns, 0);
    assert.equal(d.rowsAnalyzed, 0);
  });

  it('returns the empty-buffer default (header:false) for an empty buffer', async () => {
    const d = await detectDialect(Buffer.alloc(0));
    assert.equal(d.delimiter, ',');
    assert.equal(d.delimiterName, 'comma');
    assert.equal(d.header, false);
    assert.equal(d.avgColumns, 0);
    assert.equal(d.rowsAnalyzed, 0);
  });

  it('detects a comma dialect with header from a buffer', async () => {
    const csv = 'name,age,city\nalice,30,madrid\nbob,25,paris\ncarol,40,rome\n';
    const d = await detectDialect(Buffer.from(csv, 'utf8'));
    assert.equal(d.delimiter, ',');
    assert.equal(d.header, true);
    assert.equal(d.avgColumns, 3);
    assert.ok(d.rowsAnalyzed >= 4);
  });

  it('handles leading # comment lines without dropping data rows (header + count intact)', async () => {
    // Regression: the comment-row offset was applied twice, sliding the header
    // (and the first real data rows) out of the analyzed window — so header
    // detection flipped to false and rowsAnalyzed undercounted.
    const csv = '# generated by export\n# 2026-06-25\nname,age,city\nalice,30,madrid\nbob,25,paris\ncarol,40,rome\n';
    const d = await detectDialect(Buffer.from(csv, 'utf8'));
    assert.equal(d.delimiter, ',');
    assert.equal(d.header, true);
    assert.equal(d.avgColumns, 3);
    assert.equal(d.rowsAnalyzed, 4); // header + 3 data rows; comments skipped exactly once
  });

  it('carries delimiterName through on the detected (success) path', async () => {
    // scoreDelimiter now carries the candidate name, so best.name (and thus
    // dialect.delimiterName) is populated on the success path, not just on the
    // hard-coded fallbacks.
    const csv = 'name,age,city\nalice,30,madrid\nbob,25,paris\ncarol,40,rome\n';
    const d = await detectDialect(Buffer.from(csv, 'utf8'));
    assert.equal(d.delimiterName, 'comma');
  });

  it('detects a semicolon dialect from a buffer', async () => {
    const csv = 'product;price;qty\nwidget;9.99;3\ngadget;19.99;5\ngizmo;4.50;7\n';
    const d = await detectDialect(Buffer.from(csv, 'utf8'));
    assert.equal(d.delimiter, ';');
    assert.equal(d.delimiterName, 'semicolon');
    assert.equal(d.avgColumns, 3);
  });

  it('returns the low-confidence comma fallback for non-tabular text', async () => {
    const text = 'just one column of plain words\nanother line of words\nyet more words here\n';
    const d = await detectDialect(Buffer.from(text, 'utf8'));
    assert.equal(d.delimiterName, 'comma');
    assert.equal(d.header, false);
    assert.equal(d.avgColumns, 0);
  });

  it('reports CRLF line ending when present', async () => {
    const csv = 'a,b,c\r\n1,2,3\r\n4,5,6\r\n7,8,9\r\n';
    const d = await detectDialect(Buffer.from(csv, 'utf8'));
    assert.equal(d.lineEnding, '\r\n');
  });
});

describe('detectDialect + parseCSV — real fs path (tmpdir)', () => {
  let dir;
  let commaFile;
  let tabFile;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-dialect-test-'));
    commaFile = path.join(dir, 'people.csv');
    tabFile = path.join(dir, 'people.tsv');
    fs.writeFileSync(
      commaFile,
      'name,age,city\nalice,30,madrid\nbob,25,paris\ncarol,40,rome\n',
      'utf8',
    );
    fs.writeFileSync(
      tabFile,
      'name\tage\tcity\nalice\t30\tmadrid\nbob\t25\tparis\ncarol\t40\trome\n',
      'utf8',
    );
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detectDialect reads a file path and detects comma', async () => {
    const d = await detectDialect(commaFile);
    assert.equal(d.delimiter, ',');
    assert.equal(d.header, true);
  });

  it('detectDialect reads a file path and detects tab', async () => {
    const d = await detectDialect(tabFile);
    assert.equal(d.delimiter, '\t');
  });

  it('parseCSV returns headers + rows for a comma file', async () => {
    const result = await parseCSV(commaFile);
    assert.deepEqual(result.headers, ['name', 'age', 'city']);
    assert.equal(result.rows.length, 3);
    assert.deepEqual(result.rows[0], ['alice', '30', 'madrid']);
    assert.deepEqual(result.rows[2], ['carol', '40', 'rome']);
    assert.equal(result.dialect.delimiter, ',');
    assert.equal(result.encoding, 'utf8');
  });

  it('parseCSV honours the maxRows option', async () => {
    const result = await parseCSV(commaFile, { maxRows: 1 });
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0], ['alice', '30', 'madrid']);
  });

  it('parseCSV result round-trips through formatCsvBlock', async () => {
    const result = await parseCSV(commaFile);
    const block = formatCsvBlock(result);
    assert.ok(block.includes('# Columns: name | age | city'));
    assert.ok(block.includes('alice,30,madrid'));
    // A plain comma file is the default dialect, so formatCsvBlock emits NO
    // "Detected dialect" comment (it only annotates non-comma dialects). Before
    // the delimiterName fix this wrongly printed "Detected dialect: undefined".
    assert.ok(!block.includes('# Detected dialect:'));
  });
});
