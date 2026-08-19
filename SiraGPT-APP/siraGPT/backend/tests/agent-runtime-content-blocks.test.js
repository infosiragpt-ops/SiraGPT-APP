/**
 * Tests for services/agent-runtime/content-blocks.js — builds the
 * normalized content-block array fed into the agent prompt assembler.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  buildContentBlocks,
  createTextBlock,
  attachmentToBlock,
  validateContentBlocks,
  summarizeContentBlocks,
} = require('../src/services/agent-runtime/content-blocks');

// ── createTextBlock ───────────────────────────────────────────────

describe('createTextBlock', () => {
  it('returns a frozen block with type="text"', () => {
    const b = createTextBlock('hello');
    assert.equal(b.type, 'text');
    assert.equal(b.text, 'hello');
    assert.throws(() => { b.text = 'hack'; }, TypeError);
  });

  it('generates a stable id seeded from the text', () => {
    const a = createTextBlock('same text');
    const b = createTextBlock('same text');
    assert.equal(a.id, b.id, 'id must be stable for identical text');
    assert.match(a.id, /^text_[0-9a-f]+$/);
  });

  it('honours explicit id', () => {
    const b = createTextBlock('hi', { id: 'custom-id' });
    assert.equal(b.id, 'custom-id');
  });

  it('annotations default to []', () => {
    const b = createTextBlock('hi');
    assert.deepEqual(b.annotations, []);
  });
});

// ── attachmentToBlock ────────────────────────────────────────────

describe('attachmentToBlock', () => {
  it('returns null for null/non-object input', () => {
    assert.equal(attachmentToBlock(null), null);
    assert.equal(attachmentToBlock(undefined), null);
    assert.equal(attachmentToBlock('not-an-object'), null);
    assert.equal(attachmentToBlock(42), null);
  });

  it('produces an image block for image MIME types', () => {
    const b = attachmentToBlock({
      filename: 'pic.png',
      mime_type: 'image/png',
      url: 'https://x/pic.png',
      size: 1234,
    });
    assert.equal(b.type, 'image');
    assert.equal(b.filename, 'pic.png');
    assert.equal(b.mime_type, 'image/png');
    assert.equal(b.size_bytes, 1234);
    assert.equal(b.url, 'https://x/pic.png');
  });

  it('detects image by filename extension when mime is missing', () => {
    const b = attachmentToBlock({ filename: 'photo.jpeg' });
    assert.equal(b.type, 'image');
    assert.match(b.mime_type, /^image\/jpeg/);
  });

  it('detects document type via MIME (pdf)', () => {
    const b = attachmentToBlock({ filename: 'doc.pdf', mime_type: 'application/pdf' });
    assert.equal(b.type, 'document');
  });

  it('detects document type via filename extension (docx, xlsx, pptx)', () => {
    for (const fn of ['report.docx', 'data.xlsx', 'deck.pptx', 'notes.md', 'list.csv']) {
      const b = attachmentToBlock({ filename: fn });
      assert.equal(b.type, 'document', `${fn} should be document`);
    }
  });

  it('audio MIME → type=audio', () => {
    const b = attachmentToBlock({ filename: 'song.mp3', mime_type: 'audio/mpeg' });
    assert.equal(b.type, 'audio');
  });

  it('video MIME → type=video', () => {
    const b = attachmentToBlock({ filename: 'clip.mp4', mime_type: 'video/mp4' });
    assert.equal(b.type, 'video');
  });

  it('unknown filename + unknown MIME falls back to type=file', () => {
    const b = attachmentToBlock({ filename: 'mystery.bin' });
    assert.equal(b.type, 'file');
  });

  it('id from attachment.id is preferred', () => {
    const b = attachmentToBlock({ id: 'file-explicit', filename: 'x.png' });
    assert.equal(b.id, 'file-explicit');
  });

  it('falls back to stable id when no id given', () => {
    const b = attachmentToBlock({ filename: 'x.png', mime_type: 'image/png' });
    assert.match(b.id, /^file_[0-9a-f]+$/);
  });

  it('extras records source=current_turn by default', () => {
    const b = attachmentToBlock({ filename: 'x.png' });
    assert.equal(b.extras.source, 'current_turn');
  });

  it('extras records source=conversation_history when from_history=true', () => {
    const b = attachmentToBlock({ filename: 'x.png', from_history: true });
    assert.equal(b.extras.source, 'conversation_history');
  });

  it('stripUndefined drops null/undefined extras (only non-empty values kept)', () => {
    const b = attachmentToBlock({
      filename: 'x.png',
      extractedText: undefined,
      openai_file_id: null,
    });
    assert.equal('extracted_text' in b.extras, false);
    assert.equal('openai_file_id' in b.extras, false);
    // source is always present.
    assert.ok('source' in b.extras);
  });

  it('returned block is frozen', () => {
    const b = attachmentToBlock({ filename: 'x.png' });
    assert.throws(() => { b.type = 'hack'; }, TypeError);
  });
});

// ── validateContentBlocks ────────────────────────────────────────

describe('validateContentBlocks', () => {
  it('throws on non-array input', () => {
    assert.throws(() => validateContentBlocks('not-array'), /must be an array/);
  });

  it('throws on non-object block', () => {
    assert.throws(() => validateContentBlocks([null]), /must be an object/);
  });

  it('throws when block lacks an id', () => {
    assert.throws(
      () => validateContentBlocks([{ type: 'text', text: 'hi' }]),
      /id required/,
    );
  });

  it('throws on unsupported type', () => {
    assert.throws(
      () => validateContentBlocks([{ id: 'x', type: 'unknown' }]),
      /unsupported content block type/,
    );
  });

  it('text block must have text', () => {
    assert.throws(
      () => validateContentBlocks([{ id: 'x', type: 'text' }]),
      /text content block requires text/,
    );
  });

  it('non-text block must have filename', () => {
    assert.throws(
      () => validateContentBlocks([{ id: 'x', type: 'image' }]),
      /image content block requires filename/,
    );
  });

  it('valid blocks pass through and are individually frozen', () => {
    const out = validateContentBlocks([
      { id: 't1', type: 'text', text: 'hi' },
      { id: 'f1', type: 'image', filename: 'x.png' },
    ]);
    assert.equal(out.length, 2);
    assert.throws(() => { out[0].text = 'hack'; }, TypeError);
  });
});

// ── summarizeContentBlocks ───────────────────────────────────────

describe('summarizeContentBlocks', () => {
  it('returns total=0 + empty counts for empty / non-array input', () => {
    const a = summarizeContentBlocks([]);
    assert.equal(a.total, 0);
    assert.deepEqual(a.counts, {});
    assert.equal(a.has_text, false);
    assert.equal(a.has_image, false);
    assert.equal(a.has_file_context, false);

    const b = summarizeContentBlocks(null);
    assert.equal(b.total, 0);
  });

  it('counts by type', () => {
    const out = summarizeContentBlocks([
      { type: 'text' },
      { type: 'text' },
      { type: 'image' },
      { type: 'document' },
    ]);
    assert.equal(out.total, 4);
    assert.equal(out.counts.text, 2);
    assert.equal(out.counts.image, 1);
    assert.equal(out.counts.document, 1);
  });

  it('has_* flags: text/image/document each independently true when present', () => {
    const t = summarizeContentBlocks([{ type: 'text' }]);
    assert.equal(t.has_text, true);
    assert.equal(t.has_image, false);

    const i = summarizeContentBlocks([{ type: 'image' }]);
    assert.equal(i.has_image, true);
    assert.equal(i.has_text, false);

    const d = summarizeContentBlocks([{ type: 'document' }]);
    assert.equal(d.has_document, true);
  });

  it('has_file_context: true when any of {document, file, image} present', () => {
    assert.equal(summarizeContentBlocks([{ type: 'file' }]).has_file_context, true);
    assert.equal(summarizeContentBlocks([{ type: 'image' }]).has_file_context, true);
    assert.equal(summarizeContentBlocks([{ type: 'document' }]).has_file_context, true);
    assert.equal(summarizeContentBlocks([{ type: 'text' }]).has_file_context, false);
  });

  it('returned summary is frozen', () => {
    const out = summarizeContentBlocks([]);
    assert.throws(() => { out.total = 99; }, TypeError);
  });
});

// ── buildContentBlocks ───────────────────────────────────────────

describe('buildContentBlocks', () => {
  it('builds a text-only block list from text input', () => {
    const blocks = buildContentBlocks({ text: 'hello world' });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[0].text, 'hello world');
  });

  it('skips text block when text is empty / whitespace', () => {
    assert.equal(buildContentBlocks({ text: '' }).length, 0);
    assert.equal(buildContentBlocks({ text: '   \n  ' }).length, 0);
  });

  it('appends attachments after text', () => {
    const blocks = buildContentBlocks({
      text: 'hi',
      attachments: [{ filename: 'a.png', mime_type: 'image/png' }],
    });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[1].type, 'image');
  });

  it('handles non-array attachments without throwing', () => {
    const blocks = buildContentBlocks({ text: 'hi', attachments: 'not-array' });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
  });

  it('history scans last 8 messages and inlines their files marked from_history', () => {
    const history = [];
    for (let i = 0; i < 12; i++) {
      history.push({ files: [{ filename: `h${i}.png`, mime_type: 'image/png' }] });
    }
    const blocks = buildContentBlocks({ text: 'q', history });
    // 1 text + last 8 from history (one image per).
    assert.equal(blocks.length, 9);
    // The retained ones are h4..h11 (last 8).
    const filenames = blocks.slice(1).map((b) => b.filename);
    assert.deepEqual(filenames, ['h4.png', 'h5.png', 'h6.png', 'h7.png', 'h8.png', 'h9.png', 'h10.png', 'h11.png']);
    // All history blocks tagged accordingly.
    for (const b of blocks.slice(1)) {
      assert.equal(b.extras.source, 'conversation_history');
    }
  });

  it('dedupes identical blocks (same type+id+filename+text)', () => {
    const blocks = buildContentBlocks({
      attachments: [
        { id: 'f1', filename: 'a.png', mime_type: 'image/png' },
        { id: 'f1', filename: 'a.png', mime_type: 'image/png' }, // dup
        { id: 'f2', filename: 'b.png', mime_type: 'image/png' },
      ],
    });
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((b) => b.id), ['f1', 'f2']);
  });

  it('return value is frozen (validateContentBlocks final step)', () => {
    const blocks = buildContentBlocks({ text: 'hi' });
    assert.throws(() => blocks.push({}), TypeError);
  });
});

// ── module surface ───────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public functions', () => {
    const mod = require('../src/services/agent-runtime/content-blocks');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'attachmentToBlock',
      'buildContentBlocks',
      'createTextBlock',
      'summarizeContentBlocks',
      'validateContentBlocks',
    ]);
  });
});
