'use strict';

const fs = require('fs');
const unzipper = require('unzipper');

const DEFAULT_MAX_RSS_MB = Number.parseInt(
  process.env.SIRAGPT_STREAM_MAX_RSS_MB || '900',
  10
);

function rssMb() {
  try {
    return process.memoryUsage().rss / (1024 * 1024);
  } catch {
    return 0;
  }
}

/**
 * Lightweight SAX-style scanner for the subset of WordprocessingML we
 * care about: <w:t> (text run) and <w:p> (paragraph). We do NOT build a
 * DOM — we just track tag boundaries and accumulate text per paragraph.
 *
 * Decoder is intentionally minimal: handles &amp; &lt; &gt; &quot; &apos;
 * which is sufficient for the OOXML escapes mammoth/Word produce.
 */
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

class DocxParaScanner {
  constructor() {
    this.carry = '';
    this.inText = false;
    this.currentText = '';
    this.currentPara = '';
    this.paraIndex = 0;
  }

  feed(chunkStr, emit) {
    let s = this.carry + chunkStr;
    this.carry = '';
    let i = 0;
    while (i < s.length) {
      if (!this.inText) {
        // Look for either <w:t (start text) or </w:p (end paragraph)
        const lt = s.indexOf('<', i);
        if (lt === -1) { i = s.length; break; }

        // Need at least 6 chars to disambiguate "<w:t..." or "</w:p>"
        if (lt + 6 > s.length) { this.carry = s.slice(lt); i = s.length; break; }

        const tag = s.slice(lt, lt + 6);
        if (tag.startsWith('<w:t>') || tag.startsWith('<w:t ')) {
          // Find closing '>'
          const gt = s.indexOf('>', lt);
          if (gt === -1) { this.carry = s.slice(lt); i = s.length; break; }
          // Self-closing? <w:t/> — skip
          if (s[gt - 1] === '/') { i = gt + 1; continue; }
          this.inText = true;
          this.currentText = '';
          i = gt + 1;
        } else if (tag.startsWith('</w:p>') || s.slice(lt, lt + 7) === '</w:p>') {
          // End of paragraph
          this.paraIndex += 1;
          const text = this.currentPara;
          this.currentPara = '';
          if (text.length || true) {
            emit({ paragraph: this.paraIndex, text });
          }
          i = lt + 6;
        } else if (tag.startsWith('<w:br/') || tag.startsWith('<w:br ')) {
          // Line break inside paragraph
          const gt = s.indexOf('>', lt);
          if (gt === -1) { this.carry = s.slice(lt); i = s.length; break; }
          this.currentPara += '\n';
          i = gt + 1;
        } else {
          i = lt + 1;
        }
      } else {
        // Inside <w:t>...</w:t> — read until </w:t>
        const close = s.indexOf('</w:t>', i);
        if (close === -1) {
          // Keep tail; might span chunks
          this.currentText += s.slice(i);
          // Save last few chars in carry in case '<' starts at the very end
          this.carry = '';
          i = s.length;
          break;
        }
        this.currentText += s.slice(i, close);
        this.currentPara += decodeXmlEntities(this.currentText);
        this.currentText = '';
        this.inText = false;
        i = close + 6;
      }
    }
  }

  flush(emit) {
    if (this.currentPara.length) {
      this.paraIndex += 1;
      emit({ paragraph: this.paraIndex, text: this.currentPara });
      this.currentPara = '';
    }
  }
}

/**
 * Stream paragraphs from a .docx file. Yields { paragraph, text, charCount, rssMb }.
 * Honors RSS cap by aborting early; sets partialRef.partial = true if so.
 */
async function* streamDocxParagraphs(filePath, opts = {}) {
  const maxRssMb = opts.maxRssMb || DEFAULT_MAX_RSS_MB;
  const partialRef = opts.partialRef || { partial: false };

  const directory = await unzipper.Open.file(filePath);
  const docEntry = directory.files.find(
    (f) => f.path === 'word/document.xml' || f.path.endsWith('/word/document.xml')
  );
  if (!docEntry) {
    throw new Error('streaming-docx: word/document.xml not found in archive');
  }

  const stream = docEntry.stream();
  const queue = [];
  const waiters = [];
  let closed = false;
  let err = null;

  function push(item) {
    if (waiters.length) waiters.shift().resolve(item);
    else queue.push(item);
  }
  function take() {
    return new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      if (closed) return err ? reject(err) : resolve(null);
      waiters.push({ resolve, reject });
    });
  }

  const scanner = new DocxParaScanner();
  stream.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    scanner.feed(s, (para) => push(para));
  });
  stream.on('end', () => {
    scanner.flush((para) => push(para));
    closed = true;
    while (waiters.length) waiters.shift().resolve(null);
  });
  stream.on('error', (e) => {
    err = e;
    closed = true;
    while (waiters.length) waiters.shift().reject(e);
  });

  let aborted = false;
  try {
    while (true) {
      const item = await take();
      if (item === null) break;
      const out = {
        paragraph: item.paragraph,
        text: item.text,
        charCount: item.text.length,
        rssMb: rssMb(),
      };
      yield out;
      if (rssMb() > maxRssMb) {
        aborted = true;
        partialRef.partial = true;
        break;
      }
    }
  } finally {
    if (typeof stream.destroy === 'function' && aborted) {
      try { stream.destroy(); } catch { /* ignore */ }
    }
  }
}

async function extractDocxStreaming(filePath, opts = {}) {
  const start = Date.now();
  let peakRss = rssMb();
  let totalChars = 0;
  let paraCount = 0;
  const partialRef = { partial: false };
  const paragraphs = [];

  for await (const p of streamDocxParagraphs(filePath, { ...opts, partialRef })) {
    paraCount += 1;
    totalChars += p.charCount;
    if (p.rssMb > peakRss) peakRss = p.rssMb;
    if (opts.collectText !== false) paragraphs.push(p.text);
    if (typeof opts.onParagraph === 'function') opts.onParagraph(p);
  }

  return {
    paragraphCount: paraCount,
    totalChars,
    paragraphs,
    partial: partialRef.partial,
    peakRssMb: peakRss,
    elapsedMs: Date.now() - start,
  };
}

module.exports = {
  streamDocxParagraphs,
  extractDocxStreaming,
  DocxParaScanner,
  decodeXmlEntities,
};
