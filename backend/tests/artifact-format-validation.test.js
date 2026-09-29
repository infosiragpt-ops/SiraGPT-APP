'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');
const { PDFDocument } = require('pdf-lib');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-format-validation-'));
process.env.AGENT_ARTIFACT_DIR = artifactDir;
const { validateArtifactStructure, validateArtifactBytes } = require('../src/services/agents/artifact-delivery-validation');
const { EXTENSION_TO_MIME } = require('../src/services/agents/artifact-format-registry');
const { INTERNAL, saveArtifact, saveVerifiedArtifact } = require('../src/services/agents/task-tools');
const { persistOutputs } = require('../src/services/agent-runner/artifacts');
const { collectValidOutputs } = require('../src/services/agent-runner');
const contracts = require('../src/services/agents/artifact-delivery-contract');

after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
const text = Buffer.from('Contenido de un informe profesional, con datos verificables.');
function officeFixture(ext) {
  return fs.readFileSync(path.join(__dirname, 'fixtures/office', { docx: 'tesis_demo.docx', xlsx: 'presupuesto_demo.xlsx', pptx: 'defensa_demo.pptx' }[ext]));
}
function odfFixture(ext) {
  const kind = { odt: 'text', ods: 'spreadsheet', odp: 'presentation' }[ext];
  const body = { odt: '<text:p>Informe profesional completo.</text:p>', ods: '<table:table table:name="Datos"><table:table-row><table:table-cell office:value-type="string"><text:p>Datos</text:p></table:table-cell></table:table-row></table:table>', odp: '<draw:page draw:name="Portada"><draw:frame><draw:text-box><text:p>Presentación profesional.</text:p></draw:text-box></draw:frame></draw:page>' }[ext];
  const zip = new PizZip();
  zip.file('mimetype', EXTENSION_TO_MIME[ext], { compression: 'STORE' });
  zip.file('content.xml', `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" office:version="1.2"><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`);
  zip.file('META-INF/manifest.xml', `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${EXTENSION_TO_MIME[ext]}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('readable text renamed to binary/structured/unknown documents never passes', async () => {
  for (const ext of ['docx', 'xlsx', 'pptx', 'pdf', 'sav', 'odt', 'ods', 'odp', 'rtf', 'json', 'html', 'svg', 'extension_desconocida']) {
    const verdict = await validateArtifactBytes(ext, text);
    assert.equal(verdict.passed, false, ext);
    assert.equal(verdict.code, 'E_PARAMS', ext);
  }
  assert.equal(INTERNAL.validateAgentArtifactBuffer('extension_desconocida', text).passed, false);
});

test('Office fixtures open with their exact type and reject renamed packages', async () => {
  for (const ext of ['docx', 'xlsx', 'pptx']) {
    const buffer = officeFixture(ext);
    const verdict = await validateArtifactBytes(ext, buffer);
    assert.equal(verdict.passed, true, `${ext}: ${verdict.reason}`);
    assert.equal(verdict.summary.reader, { docx: 'python-docx', xlsx: 'openpyxl', pptx: 'python-pptx' }[ext]);
    assert.equal(verdict.summary.readerThreads, 1);
    if (process.platform === 'linux') assert.equal(verdict.summary.addressSpaceLimitBytes, 512 * 1024 * 1024);
    assert.equal(verdict.scope, 'file_structure_only');
    assert.match(verdict.sha256, /^[a-f0-9]{64}$/);
    for (const wrong of ['docx', 'xlsx', 'pptx'].filter((name) => name !== ext)) {
      assert.equal((await validateArtifactBytes(wrong, buffer)).passed, false, `${ext} renamed ${wrong}`);
    }
  }
});

test('Office missing referenced worksheet cannot pass as a readable workbook', () => {
  const zip = new PizZip(officeFixture('xlsx'));
  zip.remove('xl/worksheets/sheet1.xml');
  assert.equal(validateArtifactStructure('xlsx', zip.generate({ type: 'nodebuffer' })).passed, false);
});

test('XLSX merged ranges and coordinates are bounded before the reader allocates cells', async () => {
  const sandbox = require('../src/services/doc-agent/sandbox');
  const original = sandbox.createSandbox;
  let readers = 0;
  sandbox.createSandbox = async () => { readers++; throw new Error('the prefilter must reject this first'); };
  try {
    for (const range of ['A1:XFD1048576', 'A1:XFE2', 'A1:B1048577']) {
      const zip = new PizZip(officeFixture('xlsx'));
      zip.file('xl/worksheets/sheet1.xml', zip.file('xl/worksheets/sheet1.xml').asText()
        .replace(/<mergeCells\b[\s\S]*?<\/mergeCells>/, '')
        .replace('</worksheet>', `<mergeCells count="1"><mergeCell ref="${range}"/></mergeCells></worksheet>`));
      const buffer = zip.generate({ type: 'nodebuffer' });
      assert.equal((await validateArtifactBytes('xlsx', buffer)).passed, false, range);
      assert.deepEqual(await persistOutputs({ outputs: [{ name: 'expansion.xlsx', buffer, valid: true, validation: { passed: true } }] }), []);
    }
    assert.equal(readers, 0);
  } finally { sandbox.createSandbox = original; }
});

test('direct Office storage cannot substitute XML structure for a real readback', async () => {
  const zip = new PizZip(officeFixture('pptx'));
  zip.file('ppt/slides/slide1.xml', zip.file('ppt/slides/slide1.xml').asText().replace('</p:spTree>', '<p:sp/></p:spTree>'));
  const malformed = zip.generate({ type: 'nodebuffer' });
  assert.equal(validateArtifactStructure('pptx', malformed).passed, true);
  const fake = saveArtifact({ filename: 'fake-structure.pptx', base64: malformed.toString('base64'), validation: { passed: true } });
  assert.equal(fake.validation.passed, false);
  assert.equal(fake.validation.reason, 'artifact_readback_missing');
  await assert.rejects(saveVerifiedArtifact({ filename: 'fake-reader.pptx', base64: malformed.toString('base64'), validation: { passed: true } }), /incompleto|dañado/);
  const real = await saveVerifiedArtifact({ filename: 'real-reader.pptx', base64: officeFixture('pptx').toString('base64'), validation: { passed: true } });
  assert.equal(real.validation.passed, true);
  assert.equal(real.validation.structure.summary.reader, 'python-pptx');
});

test('repeated Office readback removes its own temporary copies from a reused sandbox', async () => {
  const sandbox = await require('../src/services/doc-agent/sandbox').createSandbox({ driver: 'local' });
  try {
    const buffer = officeFixture('xlsx');
    for (let index = 0; index < 2; index++) assert.equal((await validateArtifactBytes('xlsx', buffer, { sandbox })).passed, true);
    const tmp = await fs.promises.readdir(path.join(sandbox.root, 'tmp'));
    assert.equal(tmp.some((name) => name.startsWith('format-readback-')), false);
  } finally { await sandbox.destroy(); }
});

test('a cancelled readback still cleans only its own copies from a reused sandbox', async () => {
  const controller = new AbortController();
  const sandbox = await require('../src/services/doc-agent/sandbox').createSandbox({ driver: 'local', signal: controller.signal });
  const exec = sandbox.exec.bind(sandbox);
  sandbox.exec = async (command, options) => {
    const result = await exec(command, options);
    if (command.startsWith('python3 ')) controller.abort();
    return result;
  };
  try {
    await validateArtifactBytes('xlsx', officeFixture('xlsx'), { sandbox });
    assert.equal(controller.signal.aborted, true);
    const tmp = await fs.promises.readdir(path.join(sandbox.root, 'tmp'));
    assert.equal(tmp.some((name) => name.startsWith('format-readback-')), false);
  } finally { await sandbox.destroy(); }
});

test('Office invalid cell data or missing slide shape structures cannot become validated cards', async () => {
  const badSheet = new PizZip(officeFixture('xlsx'));
  badSheet.file('xl/worksheets/sheet1.xml', badSheet.file('xl/worksheets/sheet1.xml').asText()
    .replace(/<c\b[^>]*r="B4"[^>]*>.*?<\/c>/s, '<c r="B4" t="n"><v>abc</v></c>'));
  const badSlide = new PizZip(officeFixture('pptx'));
  badSlide.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
  const badShape = new PizZip(officeFixture('pptx'));
  badShape.file('ppt/slides/slide1.xml', badShape.file('ppt/slides/slide1.xml').asText().replace(/<p:nvSpPr>.*?<\/p:nvSpPr>/s, ''));
  const malformed = [['xlsx', badSheet], ['pptx', badSlide], ['pptx', badShape]];
  // The last case survives the lightweight XML prefilter. A real Office
  // reader still rejects the missing shape identity when it opens the deck.
  assert.equal(validateArtifactStructure('pptx', badShape.generate({ type: 'nodebuffer' })).passed, true);
  for (const [ext, zip] of malformed) {
    const buffer = zip.generate({ type: 'nodebuffer' });
    assert.equal((await validateArtifactBytes(ext, buffer)).passed, false, ext);
    const events = [];
    const artifacts = await persistOutputs({ outputs: [{ name: `invalid.${ext}`, buffer, valid: true, validation: { passed: true } }],
      userId: 'format-user', onEvent: (event) => events.push(event) });
    assert.deepEqual(artifacts, []);
    assert.equal(events.some((event) => event.type === 'file_artifact'), false);
  }
});

test('ODF type, manifest, content kind and all XML parts must agree', () => {
  for (const ext of ['odt', 'ods', 'odp']) {
    const original = odfFixture(ext);
    assert.equal(validateArtifactStructure(ext, original).passed, true, ext);
    assert.equal(validateArtifactStructure(ext === 'odt' ? 'ods' : 'odt', original).passed, false);
    const manifestMismatch = new PizZip(original);
    manifestMismatch.file('mimetype', EXTENSION_TO_MIME.odt);
    if (ext !== 'odt') assert.equal(validateArtifactStructure(ext, manifestMismatch.generate({ type: 'nodebuffer' })).passed, false);
    const corrupt = new PizZip(original);
    corrupt.file('styles.xml', '<office:document-styles>');
    assert.equal(validateArtifactStructure(ext, corrupt.generate({ type: 'nodebuffer' })).passed, false);
    const wrongBody = new PizZip(original);
    wrongBody.file('content.xml', wrongBody.file('content.xml').asText().replace(`office:${{ odt: 'text', ods: 'spreadsheet', odp: 'presentation' }[ext]}`, 'office:unknown').replace(`office:${{ odt: 'text', ods: 'spreadsheet', odp: 'presentation' }[ext]}`, 'office:unknown'));
    assert.equal(validateArtifactStructure(ext, wrongBody.generate({ type: 'nodebuffer' })).passed, false);
  }
});

test('independently exported LibreOffice ODT/ODS/ODP/RTF fixtures are readable', async () => {
  for (const filename of ['tesis_demo.odt', 'presupuesto_demo.ods', 'defensa_demo.odp', 'tesis_demo.rtf']) {
    const buffer = fs.readFileSync(path.join(__dirname, 'fixtures/formats', filename));
    const verdict = await validateArtifactBytes(path.extname(filename).slice(1), buffer);
    assert.equal(verdict.passed, true, `${filename}: ${verdict.reason}`);
    if (filename.endsWith('.rtf')) assert.match(verdict.summary.firstChars, /universidad|tesis|investigaci/i);
  }
});

test('JSON is parsed, HTML is a document, and RTF must close groups and binary data', () => {
  assert.equal(validateArtifactStructure('json', Buffer.from('{"rows":[1,2]}')).passed, true);
  assert.equal(validateArtifactStructure('json', Buffer.from('{"rows":[1,2]')).passed, false);
  const html = Buffer.from('<!doctype html><html><head><title>Informe</title></head><body><h1>Resultado</h1></body></html>');
  assert.equal(validateArtifactStructure('html', html).passed, true);
  assert.equal(validateArtifactStructure('html', Buffer.from('<html><body>Informe')).passed, false);
  assert.equal(validateArtifactStructure('html', Buffer.from('<!-- <html><body>Informe</body></html> -->')).passed, false);
  const rtf = Buffer.from('{\\rtf1\\ansi Informe profesional con {\\b resultados} verificados.}');
  assert.equal(validateArtifactStructure('rtf', rtf).passed, true);
  assert.equal(validateArtifactStructure('rtf', rtf.subarray(0, -1)).passed, false);
  assert.equal(validateArtifactStructure('rtf', Buffer.from('{\\rtf1\\ansi Informe \\bin20 xyz}')).passed, false);
  assert.equal(validateArtifactStructure('rtf', Buffer.from('{\\rtf1\\ansi Informe profesional \\{literal\\}.}')).passed, true);
});

test('SVG parses safe XML and rejects entities, unclosed tags and active attributes', () => {
  const prefix = '<svg xmlns="http://www.w3.org/2000/svg">';
  assert.equal(validateArtifactStructure('svg', Buffer.from(`${prefix}<rect width="10" height="10"/></svg>`)).passed, true);
  for (const raw of [`${prefix}<g></svg>`, `${prefix}<unbound:rect/></svg>`, `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${prefix}&x;</svg>`, `${prefix}<a href="java&#x73;cript:alert(1)">a</a></svg>`, `${prefix}<rect onpointerdown="alert(1)"/></svg>`]) {
    assert.equal(validateArtifactStructure('svg', Buffer.from(raw)).passed, false);
  }
});

test('TXT/Markdown reject binary controls and invalid UTF8; CSV reads quoted and multiline cells', () => {
  const semicolon = validateArtifactStructure('csv', Buffer.from('"Nombre,apellido";Detalle\n"Carrera, Luis";Profesional\n'));
  assert.equal(semicolon.passed, true);
  assert.deepEqual(semicolon.summary.columns, ['Nombre,apellido', 'Detalle']);
  assert.equal(validateArtifactStructure('txt', text).passed, true);
  assert.equal(validateArtifactStructure('md', Buffer.from('# Informe\nContenido.')).passed, true);
  assert.equal(validateArtifactStructure('txt', Buffer.from([0xff, 0x00, 0x01])).passed, false);
  const csv = Buffer.from('Nombre,Detalle\n"Sira, GPT","Primera\nsegunda"\n');
  const verdict = validateArtifactStructure('csv', csv);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.summary.rowCount, 1);
  assert.equal(verdict.summary.columnCount, 2);
  assert.equal(validateArtifactStructure('csv', Buffer.from('A,B\n"sin cerrar,2')).passed, false);
});

test('SPSS syntax is delivered as readable UTF8 without claiming execution or SAV validation', async () => {
  const source = Buffer.from('* Sintaxis de análisis.\nDATA LIST LIST / ID P01.\nBEGIN DATA\n1 4\nEND DATA.\nFREQUENCIES VARIABLES=P01.\n');
  const artifacts = await persistOutputs({ outputs: [{ name: 'analisis.sps', buffer: source }] });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].mime, 'text/plain');
  assert.equal(artifacts[0].validation.scope, 'text_readability_only');
  assert.equal(artifacts[0].validation.summary.syntaxExecuted, false);
  assert.equal((await validateArtifactBytes('sps', Buffer.from([0xff, 0, 1]))).passed, false);
  const contract = contracts.buildArtifactDeliveryContract('Entrega sintaxis SPSS .sps y un Excel.', { multipleArtifacts: true });
  assert.deepEqual(contract.requested.map((item) => item.format), ['xlsx', 'sps']);
});

test('PDF needs an actual parser and ZIP verifies CRC instead of matching magic bytes', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  assert.equal((await validateArtifactBytes('pdf', Buffer.from(await pdf.save()))).passed, true);
  assert.equal((await validateArtifactBytes('pdf', Buffer.from('%PDF-1.7\ncontenido falso\n%%EOF'))).passed, false);
  const zip = new PizZip(); zip.file('informe.txt', text);
  const binary = zip.generate({ type: 'nodebuffer', compression: 'STORE' });
  assert.equal(validateArtifactStructure('zip', binary).passed, true);
  const index = binary.indexOf(text); const corrupt = Buffer.from(binary); corrupt[index] ^= 1;
  assert.equal(validateArtifactStructure('zip', corrupt).passed, false);
});

test('asynchronous formats require an in-process readback of the exact saved bytes', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const buffer = Buffer.from(await pdf.save());
  const proof = await validateArtifactBytes('pdf', buffer);
  const valid = saveArtifact({ filename: 'leido.pdf', base64: buffer.toString('base64'), validation: { passed: true, structure: proof } });
  assert.equal(valid.validation.passed, true);
  const invented = saveArtifact({ filename: 'no-leido.pdf', base64: buffer.toString('base64'), validation: JSON.parse(JSON.stringify(proof)) });
  assert.equal(invented.validation.passed, false);
  const changed = saveArtifact({ filename: 'cambio.pdf', base64: Buffer.from('%PDF-1.7 falso').toString('base64'), validation: { passed: true, structure: proof } });
  assert.equal(changed.validation.passed, false);
  for (const ext of ['pdf', 'png', 'ico', 'mp3', 'mp4', 'webm']) {
    const fake = saveArtifact({ filename: `texto.${ext}`, base64: text.toString('base64'), validation: { passed: true } });
    assert.equal(fake.validation.passed, false, ext);
  }
});

test('real PNG, ICO and PCM WAV survive delivery and malformed media never validates', async () => {
  const png = await require('sharp')({ create: { width: 32, height: 32, channels: 4, background: '#38bdf8' } }).png().toBuffer();
  const ico = Buffer.alloc(22 + png.length);
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = 32; ico[7] = 32;
  ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18); png.copy(ico, 22);
  const wav = Buffer.alloc(44 + 320);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(320, 40);
  const artifacts = await persistOutputs({ outputs: [{ name: 'real.png', buffer: png }, { name: 'real.ico', buffer: ico }, { name: 'real.wav', buffer: wav }] });
  assert.equal(artifacts.length, 3);
  assert.equal((await validateArtifactBytes('ico', ico.subarray(0, -5))).passed, false);
  assert.equal((await validateArtifactBytes('wav', wav.subarray(0, -1))).passed, false);
  assert.equal((await validateArtifactBytes('jpg', png)).passed, false);
  assert.equal((await validateArtifactBytes('png', Buffer.from(png.subarray(0, 35)))).passed, false);
  for (const ext of ['mp3', 'mp4', 'webm']) assert.equal((await validateArtifactBytes(ext, text)).passed, false);
});

test('structured text parsers enforce byte, depth and node budgets', () => {
  assert.equal(validateArtifactStructure('json', Buffer.from(`"${'x'.repeat(2 * 1024 * 1024)}"`)).passed, false);
  assert.equal(validateArtifactStructure('yaml', Buffer.from('x: [1, 2, 3]')).passed, true);
  assert.equal(validateArtifactStructure('yaml', Buffer.from(`${'['.repeat(80)}1${']'.repeat(80)}`)).passed, false);
  assert.equal(validateArtifactStructure('xml', Buffer.from(`${'<n>'.repeat(260)}dato${'</n>'.repeat(260)}`)).passed, false);
});

test('persistence refuses bogus/unknown bytes even with valid:true and a claimed passed score', async () => {
  let saves = 0; const events = [];
  const artifacts = await persistOutputs({ outputs: ['docx', 'odt', 'json', 'rtf', 'unknown'].map((ext) => ({ name: `fake.${ext}`, buffer: text, valid: true, validation: { passed: true } })),
    saveArtifact: () => { saves++; }, onEvent: (event) => events.push(event) });
  assert.equal(saves, 0);
  assert.deepEqual(artifacts, []);
  assert.equal(events.filter((event) => event.type === 'output_invalid').length, 5);
});

test('legitimate JSON/HTML/RTF/ODF deliveries persist real bytes, canonical MIME and reader proof', async () => {
  const outputs = [
    { name: 'informe.json', buffer: Buffer.from('{"completo":true}') },
    { name: 'informe.html', buffer: Buffer.from('<html><body>Informe profesional.</body></html>') },
    { name: 'informe.rtf', buffer: Buffer.from('{\\rtf1\\ansi Informe profesional completo.}') },
    ...['odt', 'ods', 'odp'].map((ext) => ({ name: `informe.${ext}`, buffer: odfFixture(ext) })),
  ];
  const artifacts = await persistOutputs({ outputs, userId: 'format-user', chatId: 'format-chat' });
  assert.equal(artifacts.length, outputs.length);
  for (const artifact of artifacts) {
    const ext = path.extname(artifact.filename).slice(1);
    assert.equal(artifact.mime, EXTENSION_TO_MIME[ext]);
    const verify = await INTERNAL.verifyArtifact.execute({ artifactId: artifact.id }, { userId: 'format-user' });
    assert.equal(verify.ok, true, artifact.filename);
    assert.equal(verify.validation.scope, 'file_structure_only');
    assert.equal(verify.validation.passed, true);
    assert.deepEqual(fs.readFileSync(artifact.path), outputs.find((item) => item.name === artifact.filename).buffer);
  }
});

test('verification reopens stored bytes; metadata cannot validate a corrupted JSON or unknown extension', async () => {
  for (const filename of ['corrupt.json', 'unknown.custom']) {
    const stored = saveArtifact({ filename, base64: text.toString('base64'), validation: { passed: true } });
    const metadata = JSON.parse(fs.readFileSync(INTERNAL.metadataPathFor(stored.id), 'utf8'));
    assert.equal(metadata.validation.passed, false);
    const result = await INTERNAL.verifyArtifact.execute({ artifactId: stored.id });
    assert.equal(result.ok, false);
    assert.equal(result.validation.passed, false);
  }
});

test('storage canonicalizes MIME, and verification rejects legacy mismatched MIME metadata', async () => {
  const artifact = saveArtifact({ filename: 'tipado.json', base64: Buffer.from('{"ok":true}').toString('base64'), mime: 'image/png' });
  assert.equal(artifact.mime, 'application/json');
  const metadataPath = INTERNAL.metadataPathFor(artifact.id);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.mime = 'image/png';
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const result = await INTERNAL.verifyArtifact.execute({ artifactId: artifact.id });
  assert.equal(result.ok, false);
  assert.equal(result.validation.reason, 'artifact_mime_mismatch');
});

test('an unavailable Office reader is a failure even when bytes and saved metadata look valid', async () => {
  const sandbox = require('../src/services/doc-agent/sandbox');
  const oldCreate = sandbox.createSandbox;
  const artifact = saveArtifact({ filename: 'lector.xlsx', base64: officeFixture('xlsx').toString('base64'), validation: { passed: true } });
  sandbox.createSandbox = async () => { throw new Error('Office runtime unavailable'); };
  try {
    const result = await INTERNAL.verifyArtifact.execute({ artifactId: artifact.id });
    assert.equal(result.ok, false);
    assert.equal(result.validation.passed, false);
    assert.equal(result.validation.reason, 'format_reader_required');
  } finally { sandbox.createSandbox = oldCreate; }
});

test('a trusted full SAV readback keeps its proof when TaskContract metadata is added', async () => {
  const sandbox = require('../src/services/agents/code-sandbox');
  const reviewer = require('../src/services/agents/artifact-reviewer');
  const oldRun = sandbox.run; const oldReview = reviewer.reviewArtifact;
  const buffer = Buffer.concat([Buffer.from('$FL2'), Buffer.alloc(512)]);
  sandbox.run = async ({ source }) => {
    if (source.includes('print("SPSS_READY")')) return { ok: true, stdout: 'SPSS_READY' };
    const outPath = source.match(/os\.environ\["OUT_PATH"\] = (.+)/);
    if (outPath) {
      fs.writeFileSync(JSON.parse(outPath[1]), buffer);
      return { ok: true, stdout: '', stderr: '' };
    }
    // This unit test injects the existing full reader's verdict to exercise
    // proof identity. It is not an acceptance claim about these fixture bytes.
    assert.match(source, /pyreadstat\.read_sav/);
    return { ok: true, stdout: JSON.stringify({ ok: true, rowCount: 20, columnCount: 20 }) };
  };
  reviewer.reviewArtifact = () => ({ passed: true, testsTotal: 1, testsPassed: 1, failedTests: [], tests: [] });
  try {
    const result = await INTERNAL.createDocument.execute({ filename: 'proof-identity.sav', python: 'print("test")' }, {
      userId: 'format-user', taskContract: { success_tests: [{ kind: 'file_exists' }] },
    });
    assert.equal(result.ok, true);
    assert.equal(result.validation.contractReview.passed, true);
    const metadata = JSON.parse(fs.readFileSync(INTERNAL.metadataPathFor(result.artifactId), 'utf8'));
    assert.equal(metadata.validation.passed, true);
    assert.equal(metadata.validation.spss.rowCount, 20);
  } finally { sandbox.run = oldRun; reviewer.reviewArtifact = oldReview; }
});

test('a conflicting format contract rejects before running code or reading generated bytes', async () => {
  const sandbox = require('../src/services/agents/code-sandbox');
  const oldRun = sandbox.run;
  let scripts = 0;
  sandbox.run = async () => { scripts++; throw new Error('a conflicting format must not run code'); };
  try {
    for (const success_tests of [
      [{ id: 'extension_match', type: 'deterministic', check: 'extension_match', parameters: { value: 'svg' } }],
      [{ id: 'non_empty', type: 'deterministic', check: 'non_empty' }],
    ]) {
      const events = [];
      const result = await INTERNAL.createDocument.execute({ filename: 'wrong.docx', python: 'print("must not run")' }, {
        userId: 'format-user', taskContract: { required_extension: 'svg', success_tests }, onEvent: event => events.push(event),
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /Format Sovereignty/);
      assert.equal(result.failureReport.expected_output, '.svg');
      assert.equal(result.failureReport.actual_output, '.docx');
      assert.equal(result.failureReport.release_decision, 'blocked');
      assert.equal(result.artifactId, undefined);
      assert.equal(events.some(event => event.type === 'file_artifact'), false);
      assert.equal(events.filter(event => event.type === 'contract_review').length, 1);
    }
    assert.equal(scripts, 0);
  } finally { sandbox.run = oldRun; }
});

test('matching format metadata cannot excuse corrupt bytes after the contract preflight', async () => {
  const sandbox = require('../src/services/agents/code-sandbox');
  const oldRun = sandbox.run;
  let scripts = 0;
  sandbox.run = async ({ source }) => {
    scripts++;
    const outPath = source.match(/os\.environ\["OUT_PATH"\] = (.+)/);
    fs.writeFileSync(JSON.parse(outPath[1]), text);
    return { ok: true, stdout: '', stderr: '' };
  };
  try {
    const result = await INTERNAL.createDocument.execute({ filename: 'same.docx', python: 'print("test")' }, {
      userId: 'format-user', taskContract: { required_extension: 'docx', success_tests: [
        { id: 'extension_match', type: 'deterministic', check: 'extension_match', parameters: { value: 'docx' } },
      ] },
    });
    assert.equal(scripts, 1);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PARAMS');
    assert.equal(result.validation.passed, false);
    assert.equal(result.artifactId, undefined);
  } finally { sandbox.run = oldRun; }
});

test('TaskContract success does not bypass a corrupt format in create_document', async () => {
  const sandbox = require('../src/services/agents/code-sandbox');
  const oldRun = sandbox.run;
  sandbox.run = async ({ source }) => {
    const outPath = source.match(/os\.environ\["OUT_PATH"\] = (.+)/);
    assert.ok(outPath);
    fs.writeFileSync(JSON.parse(outPath[1]), text);
    return { ok: true, stdout: '', stderr: '' };
  };
  try {
    for (const ext of ['docx', 'odt', 'rtf', 'json', 'html', 'unknown']) {
      const result = await INTERNAL.createDocument.execute({ filename: `fake.${ext}`, python: 'print("test")' }, {
        userId: 'format-user', taskContract: { success_tests: [{ kind: 'file_exists' }] },
      });
      assert.equal(result.ok, false, ext);
      assert.equal(result.code, 'E_PARAMS', ext);
      assert.equal(result.artifactId, undefined, ext);
    }
  } finally { sandbox.run = oldRun; }
});

test('extended formats are tracked in multi-file contracts and a size-only warning is not verification', () => {
  const contract = contracts.buildArtifactDeliveryContract('Entrega JSON, HTML, RTF, ODT, ODS y ODP.', { multipleArtifacts: true, maxArtifactsPerTurn: 6 });
  assert.equal(contract.expectedCount, 6);
  assert.deepEqual(contract.requested.map((request) => request.format), ['json', 'html', 'rtf', 'odt', 'ods', 'odp']);
  const artifacts = contract.requested.map((request, index) => ({ id: String(index), filename: `informe.${request.format}`, format: request.format, downloadUrl: `/file/${index}` }));
  const steps = artifacts.map((artifact) => ({ actions: [{ tool: 'verify_artifact', args: { artifactId: artifact.id }, observation: { ok: true, warning: 'size only' } }] }));
  assert.equal(contracts.validateArtifactDelivery(contract, { artifacts, steps }).ok, false);
});

test('ODF/RTF readable output is not a verified edit of an uploaded original', async () => {
  for (const ext of ['odt', 'ods', 'odp', 'rtf']) {
    const buffer = ext === 'rtf' ? Buffer.from('{\\rtf1\\ansi Documento original completo.}') : odfFixture(ext);
    const outputs = await collectValidOutputs({ collectOutputs: async () => [{ name: `informe.${ext}`, buffer }] }, () => {}, {
      isEdit: true, instruction: 'Cambia el título.', files: [{ name: `informe.${ext}`, buffer }],
    });
    assert.equal(outputs[0].valid, false);
    assert.equal(outputs[0].validation.reason, 'semantic_edit_verifier_unavailable');
  }
});
