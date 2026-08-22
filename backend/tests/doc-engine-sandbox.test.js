'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const express = require('express');
const request = require('supertest');
const PizZip = require('pizzip');

// documents.js → authenticateToken → Prisma. Stub auth so this file stays offline.
const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    authenticateToken(req, _res, next) {
      req.user = req.user || { id: 'test-user' };
      next();
    },
  },
};

const flags = require('../src/services/doc-engine/flags');
const ooxml = require('../src/services/doc-engine/ooxml');
const { buildHardenedRunArgs, WORKSPACE_TMPFS } = require('../src/services/doc-engine/runner');
const { assertNoBinaryPayload } = require('../src/services/doc-engine/queue');
const { parseClosedDsl, looksLikeXmlOrCode } = require('../src/services/doc-engine/visual-dsl');
const { registerDocumentsRoutes, replayFrom } = require('../src/routes/documents');
const { createJob, appendEvent, resetStore } = require('../src/services/doc-engine/job-store');
const { transformBuffers } = require('../src/services/doc-engine/transform-to-template');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SCRIPTS = path.resolve(__dirname, '../../packages/doc-skills/scripts');

function makeDocx(parts) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const SECT = '<w:sectPr><w:pgMar w:top="1701" w:right="1418" w:bottom="1418" w:left="1985"/></w:sectPr>';
const NUMBERING = `<?xml version="1.0"?><w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum></w:numbering>`;

function templateDocx() {
  return makeDocx({
    'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:styleId="TituloUPN"><w:name w:val="heading 1"/></w:style></w:styles>`,
    'word/header1.xml': `<?xml version="1.0"?><w:hdr xmlns:w="${W}"><w:p><w:r><w:t>H</w:t></w:r></w:p></w:hdr>`,
    'word/footer1.xml': `<?xml version="1.0"?><w:ftr xmlns:w="${W}"><w:p><w:r><w:t>F</w:t></w:r></w:p></w:ftr>`,
    'word/numbering.xml': NUMBERING,
    'word/_rels/document.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>XXXXXXXX</w:t></w:r></w:p>${SECT}</w:body></w:document>`,
  });
}

function sourceDocx() {
  return makeDocx({
    'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Portada original UPN</w:t></w:r></w:p><w:p><w:r><w:t>Capitulo 1 contenido real del source investigacion metodologica y resultados del RSN.</w:t></w:r></w:p><w:sectPr><w:pgMar w:top="1"/></w:sectPr></w:body></w:document>`,
  });
}

describe('FEATURE_DOC_ENGINE router registration', () => {
  it('does not mount routes when the flag is off', async () => {
    const app = express();
    const mounted = registerDocumentsRoutes(app, { enabled: false });
    assert.equal(mounted, false);
    const res = await request(app).get('/api/documents/healthz');
    assert.equal(res.status, 404);
  });

  it('serves healthz when the flag is on', async () => {
    const app = express();
    const mounted = registerDocumentsRoutes(app, { enabled: true });
    assert.equal(mounted, true);
    const res = await request(app).get('/api/documents/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.image, flags.getDocEngineConfig({}).image);
  });
});

describe('isolated runner flags', () => {
  it('matches the ephemeral sandbox contract', () => {
    const args = buildHardenedRunArgs({
      name: 't',
      image: 'siragpt-sandbox:doc-engine',
      jobId: 'abc',
      hostIn: '/tmp/in',
      hostOut: '/tmp/out',
    });
    const joined = args.join(' ');
    assert.ok(args.includes('--rm'));
    assert.ok(args.includes('--network') && args.includes('none'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--cap-drop') && args.includes('ALL'));
    assert.ok(args.includes('--security-opt') && args.includes('no-new-privileges'));
    assert.ok(args.includes('10001:10001'));
    assert.ok(args.includes('--pids-limit') && args.includes('256'));
    assert.ok(args.includes('--memory') && args.includes('768m'));
    assert.ok(args.includes('--cpus') && args.includes('1'));
    assert.ok(joined.includes(WORKSPACE_TMPFS));
    assert.ok(joined.includes('nosuid'));
    assert.ok(joined.includes('noexec'));
    assert.doesNotMatch(joined, /openrouter/i);
    assert.doesNotMatch(joined, /unconfined/);
  });
});

describe('doc-jobs payload', () => {
  it('rejects binary buffers', () => {
    assert.throws(() => assertNoBinaryPayload({ jobId: 'x', sourceB64: 'abc' }), /binary/);
    assert.throws(() => assertNoBinaryPayload({ jobId: 'x', sourceBuffer: Buffer.from('x') }), /binary/);
    assert.doesNotThrow(() => assertNoBinaryPayload({ jobId: 'x', userId: 'u', instructions: 'upn' }));
  });
});

describe('closed visual DSL', () => {
  it('accepts replace_text and rejects XML/code', () => {
    const ops = parseClosedDsl({ ops: [{ op: 'replace_text', find: 'XXXXXXXX', replace: 'Titulo' }] });
    assert.equal(ops[0].op, 'replace_text');
    assert.throws(() => parseClosedDsl({ ops: [{ op: 'replace_text', find: '<w:p>', replace: 'x' }] }), /XML|closed DSL/);
    assert.throws(() => parseClosedDsl({ ops: [{ op: 'exec', find: 'a', replace: 'b' }] }), /unknown op/);
    assert.equal(looksLikeXmlOrCode('<w:document><w:p/></w:document>'), true);
    assert.equal(looksLikeXmlOrCode('{"ok":true}'), false);
  });
});

describe('Last-Event-ID replay', () => {
  after(() => resetStore());
  it('replays only events after the last id', () => {
    resetStore();
    const job = createJob({ userId: 'u' });
    appendEvent(job.id, 'unpack', { label: 'a' });
    appendEvent(job.id, 'map', { label: 'b' });
    appendEvent(job.id, 'edit', { label: 'c' });
    const replayed = replayFrom(job.events, `${job.id}:0`);
    assert.deepEqual(replayed.map((e) => e.type), ['map', 'edit']);
  });
});

describe('UPN fixture hashes + C14N', () => {
  it('keeps sectPr SHA, header/footer counts and numbering hash', () => {
    const template = templateDocx();
    const source = sourceDocx();
    const numberingBefore = ooxml.hashZipPart(template, 'word/numbering.xml');
    const out = transformBuffers(source, template);
    assert.equal(ooxml.sha256Hex(out.templateSectPr), ooxml.sha256Hex(out.resultSectPr));
    assert.equal(out.headerFooterBefore.length, out.headerFooterAfter.length);
    assert.equal(ooxml.hashZipPart(out.buffer, 'word/numbering.xml'), numberingBefore);
    const c14n = ooxml.c14nXml(out.documentXml);
    assert.match(c14n, /Portada original UPN/);
    assert.match(c14n, /<w:sectPr/);
    assert.equal(ooxml.countPdfPages(ooxml.makeStubPdf()), 1);
  });
});

describe('python unpack guards', () => {
  it('rejects path traversal and symlink entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-py-'));
    const trav = path.join(dir, 'trav.docx');
    const zip = new PizZip();
    zip.file('[Content_Types].xml', '<Types xmlns="x"/>');
    zip.file('../escape.txt', 'nope');
    fs.writeFileSync(trav, zip.generate({ type: 'nodebuffer' }));
    const r = spawnSync('python3', [path.join(SCRIPTS, 'ooxml_unpack.py'), trav, path.join(dir, 'out')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(String(r.stderr), /path traversal|ooxml_unpack/);

    const linkPy = `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('[Content_Types].xml', '<Types xmlns="x"/>')
info = zipfile.ZipInfo('word/evil')
info.create_system = 3
info.external_attr = 0o120777 << 16
z.writestr(info, '/tmp/target')
z.close()
`;
    const linkZip = path.join(dir, 'link.docx');
    const py = spawnSync('python3', ['-c', linkPy, linkZip], { encoding: 'utf8' });
    assert.equal(py.status, 0);
    const r2 = spawnSync('python3', [path.join(SCRIPTS, 'ooxml_unpack.py'), linkZip, path.join(dir, 'out2')], { encoding: 'utf8' });
    assert.notEqual(r2.status, 0);
    assert.match(String(r2.stderr), /symlink/);
  });

  it('rejects missing Content_Types and zip-bomb declared size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-py2-'));
    const noCt = path.join(dir, 'noct.docx');
    const zip = new PizZip();
    zip.file('word/document.xml', '<w:document/>');
    fs.writeFileSync(noCt, zip.generate({ type: 'nodebuffer' }));
    const r = spawnSync('python3', [path.join(SCRIPTS, 'ooxml_unpack.py'), noCt, path.join(dir, 'out')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(String(r.stderr), /Content_Types|ooxml_unpack/);

    const bombPy = `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_STORED)
z.writestr('[Content_Types].xml', '<Types xmlns="x"/>')
for i in range(5001):
    z.writestr(f'pad/{i}.txt', 'x')
z.close()
`;
    const bomb = path.join(dir, 'bomb.docx');
    const py = spawnSync('python3', ['-c', bombPy, bomb], { encoding: 'utf8' });
    assert.equal(py.status, 0);
    const r2 = spawnSync('python3', [path.join(SCRIPTS, 'ooxml_unpack.py'), bomb, path.join(dir, 'out3')], { encoding: 'utf8' });
    assert.notEqual(r2.status, 0);
    assert.match(String(r2.stderr), /zip-bomb|ooxml_unpack/);
  });
});
