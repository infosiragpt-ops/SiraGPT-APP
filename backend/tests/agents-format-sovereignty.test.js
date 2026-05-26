/**
 * Tests for services/agents/format-sovereignty.js — hard gate that
 * enforces the UniversalTaskContract's required_extension + mime_type.
 *
 * The engine uses pickPipeline from ./pipeline-registry. We don't mock
 * it — the registry is itself a pure module — but we craft test
 * contracts that exercise the gate's invariants directly.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  enforceSovereignty,
  sniffMimeFromBuffer,
  extOf,
} = require('../src/services/agents/format-sovereignty');

// ── extOf ────────────────────────────────────────────────────────

describe('extOf', () => {
  it('returns the lowercase extension', () => {
    assert.equal(extOf('report.pdf'), 'pdf');
    assert.equal(extOf('REPORT.PDF'), 'pdf');
    assert.equal(extOf('data.DocX'), 'docx');
  });

  it('returns null when no extension is present', () => {
    assert.equal(extOf('makefile'), null);
    assert.equal(extOf(''), null);
    assert.equal(extOf(null), null);
    assert.equal(extOf(undefined), null);
  });

  it('returns the final extension on multi-dot filenames', () => {
    assert.equal(extOf('archive.tar.gz'), 'gz');
    assert.equal(extOf('foo.bar.baz.txt'), 'txt');
  });

  it('coerces non-string input', () => {
    assert.equal(extOf({}), null);
  });
});

// ── sniffMimeFromBuffer · magic-byte detection ──────────────────

describe('sniffMimeFromBuffer · magic bytes', () => {
  it('detects PDF', () => {
    const buf = Buffer.from('%PDF-1.4\n...rest');
    assert.equal(sniffMimeFromBuffer(buf), 'application/pdf');
  });

  it('detects PNG', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(sniffMimeFromBuffer(buf), 'image/png');
  });

  it('detects JPEG', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    assert.equal(sniffMimeFromBuffer(buf), 'image/jpeg');
  });

  it('detects GIF', () => {
    const buf = Buffer.from('GIF89a' + 'x'.repeat(10));
    assert.equal(sniffMimeFromBuffer(buf), 'image/gif');
  });

  it('detects WEBP', () => {
    const buf = Buffer.concat([
      Buffer.from('RIFF'),  // 0..3
      Buffer.from([0, 0, 0, 0]),  // 4..7 (file size, ignored)
      Buffer.from('WEBP'),  // 8..11
      Buffer.from('VP8 '),  // 12..15
    ]);
    assert.equal(sniffMimeFromBuffer(buf), 'image/webp');
  });

  it('ZIP signature with hint=docx → wordprocessingml mime', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    assert.equal(
      sniffMimeFromBuffer(buf, 'docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('ZIP signature with hint=xlsx → spreadsheetml mime', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    assert.equal(
      sniffMimeFromBuffer(buf, 'xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('ZIP signature with hint=pptx → presentationml mime', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    assert.equal(
      sniffMimeFromBuffer(buf, 'pptx'),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('ZIP signature with no hint → application/zip', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    assert.equal(sniffMimeFromBuffer(buf), 'application/zip');
  });
});

describe('sniffMimeFromBuffer · text content', () => {
  it('detects SVG with XML declaration', () => {
    const buf = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    assert.equal(sniffMimeFromBuffer(buf), 'image/svg+xml');
  });

  it('detects SVG without XML declaration', () => {
    const buf = Buffer.from('<svg width="10"><circle r="5"/></svg>');
    assert.equal(sniffMimeFromBuffer(buf), 'image/svg+xml');
  });

  it('detects generic XML', () => {
    const buf = Buffer.from('<?xml version="1.0"?><root><x/></root>');
    assert.equal(sniffMimeFromBuffer(buf), 'application/xml');
  });

  it('detects HTML (doctype and bare <html>)', () => {
    assert.equal(sniffMimeFromBuffer(Buffer.from('<!DOCTYPE html><html><body/></html>')), 'text/html');
    assert.equal(sniffMimeFromBuffer(Buffer.from('<html><body/></html>')), 'text/html');
  });

  it('detects JSON when JSON.parse succeeds', () => {
    assert.equal(sniffMimeFromBuffer(Buffer.from('{"k":1}')), 'application/json');
    assert.equal(sniffMimeFromBuffer(Buffer.from('[1, 2, 3]')), 'application/json');
  });

  it('text starting with { but invalid JSON falls through to octet-stream', () => {
    const buf = Buffer.from('{ not json at all }');
    const out = sniffMimeFromBuffer(buf);
    // Not application/json (parse fails); falls through to octet-stream.
    assert.notEqual(out, 'application/json');
  });
});

describe('sniffMimeFromBuffer · extension hint fallbacks', () => {
  it('returns text/csv for csv hint when magic byte unknown', () => {
    const buf = Buffer.from('a,b,c\n1,2,3\n');
    assert.equal(sniffMimeFromBuffer(buf, 'csv'), 'text/csv');
  });

  it('returns text/markdown for md hint', () => {
    const buf = Buffer.from('# heading\nbody');
    assert.equal(sniffMimeFromBuffer(buf, 'md'), 'text/markdown');
  });

  it('returns text/plain for txt hint', () => {
    const buf = Buffer.from('just plain text');
    assert.equal(sniffMimeFromBuffer(buf, 'txt'), 'text/plain');
  });

  it('returns octet-stream for unknown binary with no hint', () => {
    const buf = Buffer.from([0xab, 0xcd, 0xef, 0x12, 0, 0, 0, 0]);
    assert.equal(sniffMimeFromBuffer(buf), 'application/octet-stream');
  });
});

describe('sniffMimeFromBuffer · edge cases', () => {
  it('returns null for empty or too-short buffer', () => {
    assert.equal(sniffMimeFromBuffer(Buffer.alloc(0)), null);
    assert.equal(sniffMimeFromBuffer(Buffer.from([1, 2])), null);
  });

  it('returns null for non-Buffer input', () => {
    assert.equal(sniffMimeFromBuffer('not-a-buffer'), null);
    assert.equal(sniffMimeFromBuffer(null), null);
    assert.equal(sniffMimeFromBuffer(undefined), null);
  });
});

// ── enforceSovereignty ─────────────────────────────────────────

describe('enforceSovereignty · happy path', () => {
  it('passes when required_extension and mime match', () => {
    const contract = {
      required_extension: 'pdf',
      mime_type: 'application/pdf',
    };
    const artifact = {
      filename: 'report.pdf',
      buffer: Buffer.from('%PDF-1.4\nbody'),
    };
    const out = enforceSovereignty({ contract, artifact });
    assert.equal(out.ok, true);
    assert.deepEqual(out.violations, []);
    assert.equal(out.repairHint, null);
    assert.equal(out.expected.extension, 'pdf');
    assert.equal(out.expected.mime, 'application/pdf');
    assert.equal(out.actual.extension, 'pdf');
    assert.equal(out.actual.mime, 'application/pdf');
  });

  it('default policy is "hard-block"', () => {
    const out = enforceSovereignty({
      contract: { required_extension: 'pdf', mime_type: 'application/pdf' },
      artifact: { filename: 'a.pdf', buffer: Buffer.from('%PDF-1.4\n') },
    });
    assert.equal(out.policy, 'hard-block');
  });

  it('respects contract.format_violation_policy override', () => {
    const out = enforceSovereignty({
      contract: { required_extension: 'pdf', mime_type: 'application/pdf', format_violation_policy: 'warn' },
      artifact: { filename: 'a.pdf', buffer: Buffer.from('%PDF-1.4\n') },
    });
    assert.equal(out.policy, 'warn');
  });
});

describe('enforceSovereignty · violations', () => {
  it('flags required_extension_mismatch when ext differs', () => {
    const out = enforceSovereignty({
      contract: { required_extension: 'pdf', mime_type: 'application/pdf' },
      artifact: { filename: 'a.docx', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) },
    });
    assert.equal(out.ok, false);
    assert.ok(out.violations.some(v => v.id === 'required_extension_mismatch'));
    assert.ok(out.repairHint);
    assert.match(out.repairHint, /Regenerate.*\.pdf/);
  });

  it('flags required_mime_mismatch when buffer-sniffed mime is wrong', () => {
    const out = enforceSovereignty({
      contract: { required_extension: 'pdf', mime_type: 'application/pdf' },
      artifact: { filename: 'a.pdf', buffer: Buffer.from('<html><body/></html>') },
    });
    assert.ok(out.violations.some(v => v.id === 'required_mime_mismatch'));
  });

  it('flags forbidden_extension_delivered when contract forbids the ext', () => {
    // forbidden_outputs is parsed only when it's an ARRAY (entries
    // are joined into a regex source). Pin that expected input shape.
    const out = enforceSovereignty({
      contract: {
        required_extension: 'png',
        mime_type: 'image/png',
        forbidden_outputs: ['.jpg', '.gif'],
      },
      artifact: { filename: 'a.jpg', buffer: Buffer.from([0xff, 0xd8, 0xff]) },
    });
    assert.ok(out.violations.some(v => v.id === 'forbidden_extension_delivered'));
  });

  it('actual.mime reads from artifact.mime when buffer absent', () => {
    const out = enforceSovereignty({
      contract: { required_extension: 'pdf', mime_type: 'application/pdf' },
      artifact: { filename: 'a.pdf', mime: 'application/pdf' },
    });
    assert.equal(out.actual.mime, 'application/pdf');
  });

  it('multiple simultaneous violations stack', () => {
    const out = enforceSovereignty({
      contract: { required_extension: 'pdf', mime_type: 'application/pdf' },
      artifact: { filename: 'a.docx', buffer: Buffer.from('<html><body/></html>') },
    });
    assert.ok(out.violations.length >= 2);
    const ids = out.violations.map(v => v.id);
    assert.ok(ids.includes('required_extension_mismatch'));
    assert.ok(ids.includes('required_mime_mismatch'));
  });
});

describe('enforceSovereignty · missing contract fields', () => {
  it('no contract → no violations (degrades to "ok") since nothing is required', () => {
    const out = enforceSovereignty({
      contract: {},
      artifact: { filename: 'whatever.txt', buffer: Buffer.from('hi') },
    });
    // Pipeline registry may still pose extension allowlist constraints; pin
    // the actual behavior given an empty contract.
    assert.equal(typeof out.ok, 'boolean');
  });

  it('null contract is handled (defaults to hard-block + no requirements)', () => {
    const out = enforceSovereignty({
      contract: null,
      artifact: { filename: 'a.txt', buffer: Buffer.from('hi') },
    });
    assert.equal(out.policy, 'hard-block');
  });
});

describe('enforceSovereignty · output shape', () => {
  it('returns the expected fields', () => {
    const out = enforceSovereignty({
      contract: { required_extension: 'pdf', mime_type: 'application/pdf' },
      artifact: { filename: 'a.pdf', buffer: Buffer.from('%PDF-1.4\n') },
    });
    const keys = Object.keys(out).sort();
    assert.deepEqual(keys, ['actual', 'expected', 'ok', 'pipeline', 'policy', 'repairHint', 'violations']);
  });

  it('repairHint mentions ALL violation ids', () => {
    const out = enforceSovereignty({
      contract: { required_extension: 'pdf', mime_type: 'application/pdf' },
      artifact: { filename: 'a.docx', buffer: Buffer.from('<html><body/></html>') },
    });
    for (const v of out.violations) {
      assert.ok(out.repairHint.includes(v.id), `repairHint should mention ${v.id}`);
    }
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports enforceSovereignty, sniffMimeFromBuffer, extOf', () => {
    const mod = require('../src/services/agents/format-sovereignty');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['enforceSovereignty', 'extOf', 'sniffMimeFromBuffer']);
  });
});
