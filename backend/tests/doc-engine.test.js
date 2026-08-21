'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const PizZip = require('pizzip');

const flags = require('../src/services/doc-engine/flags');
const ooxml = require('../src/services/doc-engine/ooxml');
const { transformBuffers } = require('../src/services/doc-engine/transform-to-template');
const { buildHardenedRunArgs } = require('../src/services/doc-engine/runner');
const { runVerifyLoop, pickDeepSeekModel } = require('../src/services/doc-engine/verify-loop');
const { tryDocEngineTransform } = require('../src/services/doc-engine/chat-bridge');
const { createJob, getJob, resetStore, appendEvent } = require('../src/services/doc-engine/job-store');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function makeDocx(parts) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const SECT = '<w:sectPr><w:pgMar w:top="1701" w:right="1418" w:bottom="1418" w:left="1985"/></w:sectPr>';

function templateDocx() {
  return makeDocx({
    'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:styleId="TituloUPN"><w:name w:val="heading 1"/></w:style></w:styles>`,
    'word/header1.xml': `<?xml version="1.0"?><w:hdr xmlns:w="${W}"><w:p><w:r><w:t>H</w:t></w:r></w:p></w:hdr>`,
    'word/footer1.xml': `<?xml version="1.0"?><w:ftr xmlns:w="${W}"><w:p><w:r><w:t>F</w:t></w:r></w:p></w:ftr>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>XXXXXXXX</w:t></w:r></w:p>${SECT}</w:body></w:document>`,
  });
}

function sourceDocx() {
  return makeDocx({
    'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    'word/header1.xml': `<?xml version="1.0"?><w:hdr xmlns:w="${W}"><w:p/></w:hdr>`,
    'word/footer1.xml': `<?xml version="1.0"?><w:ftr xmlns:w="${W}"><w:p/></w:ftr>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Portada original UPN</w:t></w:r></w:p><w:sectPr><w:pgMar w:top="1"/></w:sectPr></w:body></w:document>`,
  });
}

describe('doc-engine flag default', () => {
  it('FEATURE_DOC_ENGINE is off by default', () => {
    assert.equal(flags.isDocEngineEnabled({}), false);
  });
});

describe('doc-engine transform', () => {
  it('extracts top-level w:p / w:tbl without hanging on w:pPr', () => {
    const inner = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hola</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>celda</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '<w:sectPr><w:pgMar w:top="1"/></w:sectPr>';
    const blocks = ooxml.extractTopLevelBlocks(inner);
    assert.equal(blocks.length, 2);
    assert.match(blocks[0], /Hola/);
    assert.match(blocks[1], /<w:tbl/);
    assert.match(blocks[1], /celda/);
  });

  it('replaces XXXXXXXX body with source content and keeps sectPr', () => {
    const out = transformBuffers(sourceDocx(), templateDocx());
    assert.match(out.documentXml, /Portada original UPN/);
    assert.equal(out.templateSectPr, SECT);
    assert.equal(out.resultSectPr, SECT);
    const body = out.documentXml.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, '');
    assert.doesNotMatch(body, /XXXXXXXX/);
    assert.equal(out.styleMap.Heading1, 'TituloUPN');
    assert.match(out.documentXml, /w:pStyle w:val="TituloUPN"/);
  });
});

describe('doc-engine runner', () => {
  it('hardens docker run flags', () => {
    const args = buildHardenedRunArgs({
      name: 't',
      image: 'siragpt-sandbox:doc-engine',
      jobId: 'abc',
    });
    assert.ok(args.includes('--network') && args.includes('none'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--cap-drop') && args.includes('ALL'));
    assert.ok(args.includes('10001:10001'));
    assert.doesNotMatch(args.join(' '), /openrouter/i);
  });
});

describe('doc-engine verify', () => {
  it('picks DeepSeek V4 models only', () => {
    assert.equal(pickDeepSeekModel({ env: {} }), 'deepseek-v4-flash');
    assert.equal(pickDeepSeekModel({ preferPro: true, env: {} }), 'deepseek-v4-pro');
  });

  it('does not invent API keys', async () => {
    const r = await runVerifyLoop({}, { env: {}, client: null });
    assert.equal(r.skipped, true);
  });
});

describe('doc-engine chat bridge', () => {
  const prev = process.env.FEATURE_DOC_ENGINE;
  after(() => {
    if (prev === undefined) delete process.env.FEATURE_DOC_ENGINE;
    else process.env.FEATURE_DOC_ENGINE = prev;
  });

  it('returns null when flag is off', async () => {
    delete process.env.FEATURE_DOC_ENGINE;
    const hit = await tryDocEngineTransform({
      prompt: 'pasa este word al formato UPN',
      files: [
        { name: 'src.docx', buffer: sourceDocx() },
        { name: 'formato-upn.docx', buffer: templateDocx() },
      ],
      env: {},
    });
    assert.equal(hit, null);
  });

  it('transplants when flag is on', async () => {
    const hit = await tryDocEngineTransform({
      prompt: 'pasa este word al formato UPN',
      files: [
        { name: 'tesis.docx', buffer: sourceDocx(), originalName: 'tesis.docx' },
        { name: 'formato-upn.docx', buffer: templateDocx(), originalName: 'formato-upn.docx' },
      ],
      env: { FEATURE_DOC_ENGINE: '1' },
      readBuffer: async (f) => f.buffer,
    });
    assert.ok(hit);
    assert.equal(hit.engine, 'doc-engine');
    assert.equal(hit.format, 'docx');
    const xml = new PizZip(hit.file.buffer).file('word/document.xml').asText();
    assert.match(xml, /Portada original UPN/);
  });
});

describe('doc-engine unpack guards', () => {
  it('rejects path traversal and zip-bomb entry counts', () => {
    const zip = new PizZip();
    zip.file('[Content_Types].xml', '<Types xmlns="x"/>');
    zip.file('../../etc/passwd', 'root\n');
    const bad = zip.generate({ type: 'nodebuffer' });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'de-trav-'));
    assert.throws(() => ooxml.unpackBuffer(bad, dest), /path traversal/);
    assert.throws(() => ooxml.assertSafeZipName('/tmp/evil.xml'), /path traversal/);

    const bomb = new PizZip();
    bomb.file('[Content_Types].xml', '<Types xmlns="x"/>');
    for (let i = 0; i < 5001; i += 1) bomb.file(`pad/${i}.txt`, 'x');
    const bombBuf = bomb.generate({ type: 'nodebuffer' });
    const dest2 = fs.mkdtempSync(path.join(os.tmpdir(), 'de-bomb-'));
    assert.throws(() => ooxml.unpackBuffer(bombBuf, dest2), /zip-bomb/);
  });

  it('fails when document r:id is missing from .rels', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rels-'));
    fs.mkdirSync(path.join(root, 'word', '_rels'), { recursive: true });
    fs.writeFileSync(path.join(root, '[Content_Types].xml'), '<Types xmlns="x"/>');
    fs.writeFileSync(
      path.join(root, 'word', 'document.xml'),
      `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p/><w:sectPr><w:headerReference w:type="default" r:id="rId99"/></w:sectPr></w:body></w:document>`,
    );
    fs.writeFileSync(
      path.join(root, 'word', '_rels', 'document.xml.rels'),
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    );
    assert.throws(() => ooxml.validateUnpacked(root), /rId99/);
  });
});

describe('doc-engine pipeline preview', () => {
  it('produces a PDF with at least one page', async () => {
    const { runPipeline } = require('../src/services/doc-engine/pipeline');
    const ran = await runPipeline({
      sourceBuffer: sourceDocx(),
      templateBuffer: templateDocx(),
      instructions: 'pasa este word al formato UPN',
      verifyDeps: { client: null },
    });
    assert.equal(ran.ok, true);
    assert.ok(ran.artifact.pdfPages >= 1);
  });
});

describe('doc-engine job store SSE stages', () => {
  before(() => resetStore());
  it('records unpack|map|edit|validate|render|verify|done', () => {
    const job = createJob({ userId: 'u1', instructions: 'formato UPN' });
    for (const t of ['unpack', 'map', 'edit', 'validate', 'render', 'verify', 'done']) {
      appendEvent(job.id, t, { label: t });
    }
    const stored = getJob(job.id);
    assert.deepEqual(stored.events.map((e) => e.type), [
      'unpack', 'map', 'edit', 'validate', 'render', 'verify', 'done',
    ]);
    assert.equal(stored.status, 'done');
  });
});
