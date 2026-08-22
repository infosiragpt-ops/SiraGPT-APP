'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const PizZip = require('pizzip');

const flags = require('../src/services/doc-engine/flags');
const ooxml = require('../src/services/doc-engine/ooxml');
const { transformBuffers, classifyTemplateVsContent } = require('../src/services/doc-engine/transform-to-template');
const { buildHardenedRunArgs } = require('../src/services/doc-engine/runner');
const { runVerifyLoop, pickDeepSeekModel } = require('../src/services/doc-engine/verify-loop');
const { tryDocEngineAfterSelection } = require('../src/services/doc-engine/chat-bridge');
const { tryGenerateSourcePreservingDocumentEdit } = require('../src/services/source-preserving-document-edit');
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
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Portada original UPN</w:t></w:r></w:p><w:p><w:r><w:t>Capitulo 1 contenido real del source investigacion metodologica y resultados del RSN.</w:t></w:r></w:p><w:sectPr><w:pgMar w:top="1"/></w:sectPr></w:body></w:document>`,
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

describe('classifyTemplateVsContent', () => {
  it('picks the XXXX/UPN file as plantilla even when it is first (chip order)', () => {
    const plantilla = {
      originalName: 'aaaa.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: templateDocx(),
    };
    const rsn = {
      originalName: 'zzzz.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: sourceDocx(),
    };
    const pair = classifyTemplateVsContent([plantilla, rsn]);
    assert.equal(pair.template, plantilla);
    assert.equal(pair.content, rsn);
    assert.equal(pair.reason, 'content');
  });

  it('prefers XXXX/UPN body over a misleading formato-*.docx name', () => {
    const fakeNameRealBody = {
      originalName: 'formato-upn.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: sourceDocx(),
    };
    const realPlantilla = {
      originalName: 'rsn.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: templateDocx(),
    };
    const pair = classifyTemplateVsContent([fakeNameRealBody, realPlantilla]);
    assert.equal(pair.template, realPlantilla);
    assert.equal(pair.content, fakeNameRealBody);
  });
});

describe('doc-engine transform request cues', () => {
  it('matches pasalo / formato / UPN with 2 file ids (chat preloop)', () => {
    assert.equal(flags.isTemplateTransformRequest('pasalo a UPN', ['a', 'b']), true);
    assert.equal(flags.isTemplateTransformRequest('usa esta plantilla', ['a', 'b']), true);
    assert.equal(flags.isTemplateTransformRequest('formato', ['a', 'b']), true);
    assert.equal(flags.isTemplateTransformRequest('hola', ['a', 'b']), false);
    assert.equal(flags.isTemplateTransformRequest('pasalo a mi format de la upn', ['a', 'b']), true);
    assert.equal(flags.isTemplateTransformRequest(
      'este word ## RSN_tesis.docx pasalo a mi format ## Formato_upn.docx',
      ['a', 'b'],
    ), true);
  });
});

describe('classify best-effort without XXXX', () => {
  it('still pairs formato-named empty-ish file vs long body', () => {
    const plantilla = {
      originalName: 'Formato_para_el_articulo.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: makeDocx({
        'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
        'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Titulo</w:t></w:r></w:p>${SECT}</w:body></w:document>`,
      }),
    };
    const rsn = {
      originalName: 'rsn.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: sourceDocx(),
    };
    const pair = classifyTemplateVsContent([plantilla, rsn]);
    assert.equal(pair.template, plantilla);
    assert.equal(pair.content, rsn);
    assert.ok(pair.reason === 'content' || pair.reason === 'best_effort');
  });
});

describe('doc-engine chat hook', () => {
  const prev = process.env.FEATURE_DOC_ENGINE;
  after(() => {
    if (prev === undefined) delete process.env.FEATURE_DOC_ENGINE;
    else process.env.FEATURE_DOC_ENGINE = prev;
  });

  it('returns null when flag is off', async () => {
    delete process.env.FEATURE_DOC_ENGINE;
    const hit = await tryDocEngineAfterSelection({
      prompt: 'pasa este word al formato UPN',
      files: [
        { name: 'src.docx', buffer: sourceDocx() },
        { name: 'formato-upn.docx', buffer: templateDocx() },
      ],
      env: {},
    });
    assert.equal(hit, null);
  });

  it('transplants when flag is on even if plantilla is first', async () => {
    const hit = await tryDocEngineAfterSelection({
      prompt: 'pasa este word al formato UPN',
      files: [
        { name: 'formato-upn.docx', buffer: templateDocx(), originalName: 'formato-upn.docx' },
        { name: 'tesis.docx', buffer: sourceDocx(), originalName: 'tesis.docx' },
      ],
      env: { FEATURE_DOC_ENGINE: '1' },
      readBuffer: async (f) => f.buffer,
    });
    assert.ok(hit);
    assert.equal(hit.engine, 'doc-engine');
    assert.equal(hit.format, 'docx');
    assert.equal(hit.validation.passed, true);
    const xml = new PizZip(hit.file.buffer).file('word/document.xml').asText();
    assert.match(xml, /Portada original UPN/);
    assert.doesNotMatch(xml.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, ''), /XXXXXXXX/);
  });

  it('tryGenerate hook after select transplants when plantilla is fileIds[0]', async () => {
    const prevFlag = process.env.FEATURE_DOC_ENGINE;
    process.env.FEATURE_DOC_ENGINE = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'de-hook-'));
    const plantillaPath = path.join(tmp, 'formato-upn.docx');
    const rsnPath = path.join(tmp, 'rsn.docx');
    fs.writeFileSync(plantillaPath, templateDocx());
    fs.writeFileSync(rsnPath, sourceDocx());
    const prisma = {
      file: {
        async findMany() {
          return [
            {
              id: 'plantilla-first',
              filename: 'formato-upn.docx',
              originalName: 'formato-upn.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              path: plantillaPath,
              extractedText: 'XXXXXXXX',
            },
            {
              id: 'rsn-second',
              filename: 'rsn.docx',
              originalName: 'rsn.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              path: rsnPath,
              extractedText: 'Portada original UPN capitulo contenido real del source investigacion',
            },
          ];
        },
      },
      generatedArtifact: { async findMany() { return []; } },
      message: { async findMany() { return []; } },
    };
    try {
      const result = await tryGenerateSourcePreservingDocumentEdit({
        prisma,
        userId: 'user-upn',
        chatId: 'chat-upn',
        fileIds: ['plantilla-first', 'rsn-second'],
        prompt: 'pasa este word al formato UPN',
        displayPrompt: 'pasa este word al formato UPN',
      });
      assert.ok(result);
      assert.equal(result.engine, 'doc-engine');
      assert.equal(result.validation.passed, true);
      const xml = new PizZip(result.file.buffer).file('word/document.xml').asText();
      assert.match(xml, /Portada original UPN/);
      assert.doesNotMatch(xml.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, ''), /XXXXXXXX/);
    } finally {
      if (prevFlag === undefined) delete process.env.FEATURE_DOC_ENGINE;
      else process.env.FEATURE_DOC_ENGINE = prevFlag;
    }
  });
});

describe('doc-engine hook recent_attachment + pasalo', () => {
  it('tryGenerate transplants when files are recent_attachment and prompt is pasalo', async () => {
    const prevFlag = process.env.FEATURE_DOC_ENGINE;
    process.env.FEATURE_DOC_ENGINE = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'de-hook2-'));
    const plantillaPath = path.join(tmp, 'formato-upn.docx');
    const rsnPath = path.join(tmp, 'rsn.docx');
    fs.writeFileSync(plantillaPath, templateDocx());
    fs.writeFileSync(rsnPath, sourceDocx());
    const prisma = {
      file: {
        async findMany() {
          return [
            {
              id: 'p1',
              filename: 'formato-upn.docx',
              originalName: 'formato-upn.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              path: plantillaPath,
              extractedText: 'XXXXXXXX',
            },
            {
              id: 'c1',
              filename: 'rsn.docx',
              originalName: 'rsn.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              path: rsnPath,
              extractedText: 'Portada original UPN capitulo contenido real del source investigacion',
            },
          ];
        },
      },
      generatedArtifact: { async findMany() { return []; } },
      message: {
        async findMany() {
          return [{
            id: 'm1',
            timestamp: new Date(),
            files: [
              { id: 'p1', name: 'formato-upn.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
              { id: 'c1', name: 'rsn.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            ],
          }];
        },
      },
    };
    try {
      const { isSourcePreservingEditRequest } = require('../src/services/source-preserving-document-edit');
      assert.equal(isSourcePreservingEditRequest('pasalo a formato UPN', ['p1', 'c1']), true);
      assert.equal(isSourcePreservingEditRequest('pasalo a formato UPN', []), true);
      const result = await tryGenerateSourcePreservingDocumentEdit({
        prisma,
        userId: 'user-upn',
        chatId: 'chat-upn',
        fileIds: [],
        prompt: 'pasalo a formato UPN',
        displayPrompt: 'pasalo a formato UPN',
      });
      // fileIds empty → recent_attachment; hook must still fire via allDocx + cue
      assert.ok(result);
      assert.equal(result.engine, 'doc-engine');
      const xml = new PizZip(result.file.buffer).file('word/document.xml').asText();
      assert.match(xml, /Portada original UPN/);
      assert.doesNotMatch(xml.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, ''), /XXXXXXXX/);
    } finally {
      if (prevFlag === undefined) delete process.env.FEATURE_DOC_ENGINE;
      else process.env.FEATURE_DOC_ENGINE = prevFlag;
    }
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

describe('extractSectPr last wins', () => {
  it('returns the document-level (last) sectPr not a mid-body break', () => {
    const xml = `<w:document><w:body><w:p><w:pPr><w:sectPr><w:pgMar w:top="1"/></w:sectPr></w:pPr></w:p>${SECT}</w:body></w:document>`;
    assert.equal(ooxml.extractSectPr(xml), SECT);
  });
});

describe('classify prompt ## names', () => {
  it('uses formato/plantilla as template when prompt names both files', () => {
    const { classifyTemplateVsContent } = require('../src/services/doc-engine/transform-to-template');
    const plantilla = {
      originalName: 'Formato para el articulo de revision narrativa.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: templateDocx(),
    };
    const rsn = {
      originalName: 'RSN_Comunicacion_publicitaria_redes_sociales_posicionamiento_calzados.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: sourceDocx(),
    };
    const prompt = 'este word ## RSN_Comunicacion_publicitaria_redes_sociales_posicionamiento_calzados.docx pasalo a mi format de la upn tal cual ## Formato para el articulo de revision narrativa.docx';
    const pair = classifyTemplateVsContent([rsn, plantilla], prompt);
    assert.equal(pair.template, plantilla);
    assert.equal(pair.content, rsn);
    assert.equal(pair.reason, 'prompt_names');
  });
});

describe('doc-engine hook keeps transplant when mid-body sectPr differs', () => {
  it('does not drop a real transplant if first sectPr != last', async () => {
    const mid = makeDocx({
      'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
      'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:sectPr><w:pgMar w:top="1"/></w:sectPr></w:pPr><w:r><w:t>Portada original UPN seccion interna del source con bastante texto de investigacion metodologica.</w:t></w:r></w:p><w:p><w:r><w:t>Capitulo 1 contenido real del source investigacion metodologica y resultados del RSN para no quedar vacio.</w:t></w:r></w:p>${SECT}</w:body></w:document>`,
    });
    const hit = await tryDocEngineAfterSelection({
      prompt: 'pasalo a mi format de la upn',
      files: [
        { name: 'Formato_upn.docx', buffer: templateDocx(), originalName: 'Formato_upn.docx' },
        { name: 'RSN_tesis.docx', buffer: mid, originalName: 'RSN_tesis.docx' },
      ],
      env: { FEATURE_DOC_ENGINE: '1' },
      readBuffer: async (f) => f.buffer,
    });
    assert.ok(hit);
    assert.equal(hit.validation.passed, true);
    const xml = new PizZip(hit.file.buffer).file('word/document.xml').asText();
    assert.match(xml, /Portada original UPN/);
    assert.doesNotMatch(xml.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/g, ''), /XXXXXXXX/);
  });
});

describe('doc-engine page geometry from template', () => {
  it('output pgSz w/h and pgMar equal template; source sectPr never copied; tables clamped', () => {
    const tmplSect = '<w:sectPr><w:pgSz w:w="11910" w:h="16840" w:orient="portrait" w:code="9"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
    const srcMid = '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>';
    const srcLast = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
    const wideTbl = '<w:tbl><w:tblPr><w:tblW w:w="14000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="10000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="10000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>B wide</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const template = makeDocx({
      'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:styleId="TituloUPN"><w:name w:val="heading 1"/></w:style></w:styles>`,
      'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>XXXXXXXX</w:t></w:r></w:p>${tmplSect}</w:body></w:document>`,
    });
    const source = makeDocx({
      'word/styles.xml': `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
      'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:pPr>${srcMid}</w:pPr><w:r><w:t>Portada original UPN seccion landscape del source con texto de investigacion.</w:t></w:r></w:p><w:p><w:r><w:t>Capitulo 1 contenido real del source investigacion metodologica y resultados del RSN.</w:t></w:r></w:p>${wideTbl}${srcLast}</w:body></w:document>`,
    });
    const out = transformBuffers(source, template);
    const geomT = ooxml.parsePageGeometry(out.templateSectPr);
    const geomR = ooxml.parsePageGeometry(out.resultSectPr);
    assert.equal(geomT.w, 11910);
    assert.equal(geomT.h, 16840);
    assert.equal(geomR.w, 11910);
    assert.equal(geomR.h, 16840);
    assert.equal(geomR.left, 1440);
    assert.equal(geomR.right, 1440);
    assert.equal(geomR.top, 1440);
    assert.equal(geomR.bottom, 1440);
    assert.equal(out.templateSectPr, tmplSect);
    assert.equal(out.resultSectPr, tmplSect);
    assert.equal(ooxml.pageGeometryEqual(out.templateSectPr, out.resultSectPr), true);
    const sects = out.documentXml.match(/<w:sectPr[\s>][\s\S]*?<\/w:sectPr>/g) || [];
    assert.equal(sects.length, 1);
    assert.equal(sects[0], tmplSect);
    assert.doesNotMatch(out.documentXml, /w:w="16838"/);
    assert.doesNotMatch(out.documentXml, /w:w="12240"/);
    assert.doesNotMatch(out.documentXml, /w:orient="landscape"/);
    assert.match(out.documentXml, /Portada original UPN/);
    const tblW = Number((out.documentXml.match(/<w:tblW\b[^>]*w:w="(\d+)"/) || [])[1] || 0);
    assert.ok(tblW > 0);
    assert.ok(tblW <= 9030, `tblW ${tblW} should be <= 9030 printable twips`);
  });
});
