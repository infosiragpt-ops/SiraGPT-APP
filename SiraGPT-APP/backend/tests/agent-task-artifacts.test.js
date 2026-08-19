const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-artifacts-'));

const { saveArtifact, INTERNAL } = require('../src/services/agents/task-tools');

test('agent task artifacts: writes owner metadata next to each file', () => {
  const artifact = saveArtifact({
    filename: 'report.txt',
    base64: Buffer.from('private report').toString('base64'),
    mime: 'text/plain',
    ownerUserId: 'user-a',
    chatId: 'chat-a',
    validation: { passed: true, technicalScore: 100, qualityScore: 100 },
  });

  const metadataPath = INTERNAL.metadataPathFor(artifact.id);
  assert.equal(fs.existsSync(metadataPath), true);

  const metadataText = fs.readFileSync(metadataPath, 'utf8');
  assert.match(metadataText, /\n  "ownerUserId": "user-a"/);

  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.ownerUserId, 'user-a');
  assert.equal(metadata.chatId, 'chat-a');
  assert.equal(metadata.filename, 'report.txt');
  assert.equal(metadata.validation.passed, true);
});

test('agent task artifacts: metadata sidecar write is atomic on commit failure', () => {
  const filename = 'atomic-report.txt';
  const ownerUserId = 'user-atomic';
  const chatId = 'chat-atomic';
  const payload = Buffer.from('metadata commit failure payload');
  const scope = `${ownerUserId}:${chatId}:`;
  const id = INTERNAL.artifactIdFor(Buffer.concat([Buffer.from(filename), payload]), scope);
  const artifactPath = path.join(process.env.AGENT_ARTIFACT_DIR, `${id}-${filename}`);
  const metadataPath = INTERNAL.metadataPathFor(id);
  const originalRenameSync = fs.renameSync;

  try {
    fs.renameSync = (tmpPath, targetPath) => {
      if (targetPath === metadataPath && tmpPath.endsWith('.tmp')) {
        throw new Error('simulated metadata atomic rename failure');
      }
      return originalRenameSync(tmpPath, targetPath);
    };

    assert.throws(() => saveArtifact({
      filename,
      base64: payload.toString('base64'),
      ownerUserId,
      chatId,
    }), /simulated metadata atomic rename failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(fs.existsSync(artifactPath), false);
  assert.equal(fs.existsSync(metadataPath), false);

  const tmpMetadataFiles = fs.readdirSync(process.env.AGENT_ARTIFACT_DIR)
    .filter((entry) => entry.startsWith(`${id}.`) && entry.endsWith('.tmp'));
  assert.deepEqual(tmpMetadataFiles, []);
});

test('agent task artifacts: ids are scoped per owner and chat', () => {
  const payload = Buffer.from('same bytes').toString('base64');
  const first = saveArtifact({ filename: 'same.txt', base64: payload, ownerUserId: 'user-a', chatId: 'chat-a' });
  const second = saveArtifact({ filename: 'same.txt', base64: payload, ownerUserId: 'user-b', chatId: 'chat-a' });

  assert.notEqual(first.id, second.id);
});

test('agent task artifacts: normalizes dangerous executable extensions before saving', () => {
  const artifact = saveArtifact({
    filename: 'quarterly-report.pdf.exe',
    base64: Buffer.from('not actually an executable').toString('base64'),
    ownerUserId: 'user-a',
    chatId: 'chat-a',
  });

  assert.equal(artifact.filename, 'quarterly-report.pdf.exe.txt');
  assert.equal(artifact.format, 'txt');
  assert.equal(artifact.mime, 'text/plain');
  assert.match(artifact.downloadUrl, /quarterly-report\.pdf\.exe\.txt/);

  const storedName = path.basename(artifact.path);
  assert.ok(storedName.endsWith('-quarterly-report.pdf.exe.txt'));

  const metadata = JSON.parse(fs.readFileSync(INTERNAL.metadataPathFor(artifact.id), 'utf8'));
  assert.equal(metadata.filename, 'quarterly-report.pdf.exe.txt');
  assert.equal(metadata.format, 'txt');
  assert.equal(metadata.mime, 'text/plain');
});

test('agent task artifacts: blocks oversized active text artifacts before disk write', () => {
  const maxBytes = INTERNAL.ACTIVE_TEXT_ARTIFACT_MAX_BYTES || 2 * 1024 * 1024;
  const payload = `${'<svg>'.padEnd(maxBytes + 1, 'x')}</svg>`;

  assert.throws(() => saveArtifact({
    filename: 'huge.svg',
    base64: Buffer.from(payload).toString('base64'),
    ownerUserId: 'user-a',
    chatId: 'chat-a',
  }), /artifact size limit exceeded.*svg/i);

  const stored = fs.readdirSync(process.env.AGENT_ARTIFACT_DIR)
    .filter((entry) => entry.endsWith('-huge.svg') || entry === 'huge.svg');
  assert.deepEqual(stored, []);
});

test('agent task create_document: validates and returns artifact ids for downstream verification', async () => {
  const events = [];
  const result = await INTERNAL.createDocument.execute({
    filename: 'sources.csv',
    python: [
      'import os',
      'with open(os.environ["OUT_PATH"], "w", encoding="utf-8") as f:',
      '    f.write("Authors,Title,Year,DOI\\n")',
      '    f.write("A. Uno,Articulo real,2024,https://doi.org/10.1000/test\\n")',
    ].join('\n'),
    description: 'CSV verificable',
  }, {
    userId: 'user-a',
    chatId: 'chat-a',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifactId);
  assert.equal(result.id, result.artifactId);
  assert.equal(result.validation.passed, true);
  assert.ok(events.some((event) => event.type === 'file_artifact' && event.artifact.id === result.artifactId));

  const verify = await INTERNAL.verifyArtifact.execute({ artifactId: result.artifactId }, {
    onEvent: () => {},
  });
  assert.equal(verify.ok, true);
  assert.equal(verify.validation.passed, true);
  assert.deepEqual(verify.columns, ['Authors', 'Title', 'Year', 'DOI']);
});

test('agent task create_document: creates and verifies a professional DOCX artifact', async () => {
  const events = [];
  const result = await INTERNAL.createDocument.execute({
    filename: 'informe-profesional-validado.docx',
    python: [
      'import os',
      'from docx import Document',
      'from docx.shared import Pt',
      'from docx.enum.text import WD_ALIGN_PARAGRAPH',
      'doc = Document()',
      'doc.core_properties.title = "Informe Profesional de Validación"',
      'normal = doc.styles["Normal"]',
      'normal.font.name = "Arial"',
      'normal.font.size = Pt(10.5)',
      'title = doc.add_heading("Informe Profesional de Validación", 0)',
      'title.alignment = WD_ALIGN_PARAGRAPH.CENTER',
      'doc.add_paragraph("Resumen ejecutivo: este documento valida que SiraGPT produce un Word editable, estructurado y verificable antes de entregarlo al usuario.")',
      'doc.add_heading("1. Alcance", level=1)',
      'doc.add_paragraph("La prueba cubre creación, registro, descarga y lectura posterior del archivo DOCX generado por el agente.")',
      'doc.add_heading("2. Criterios de calidad", level=1)',
      'for item in ["estructura clara", "contenido suficiente", "tabla editable", "conclusiones accionables"]:',
      '    doc.add_paragraph(item, style="List Bullet")',
      'table = doc.add_table(rows=1, cols=3)',
      'table.style = "Table Grid"',
      'hdr = table.rows[0].cells',
      'hdr[0].text = "Criterio"',
      'hdr[1].text = "Evidencia"',
      'hdr[2].text = "Estado"',
      'for criterio, evidencia, estado in [',
      '    ("Formato", "Extensión .docx y MIME Office", "Cumple"),',
      '    ("Contenido", "Párrafos y secciones verificables", "Cumple"),',
      '    ("Edición", "Tabla nativa editable", "Cumple"),',
      ']:',
      '    row = table.add_row().cells',
      '    row[0].text = criterio',
      '    row[1].text = evidencia',
      '    row[2].text = estado',
      'doc.add_heading("3. Conclusión", level=1)',
      'doc.add_paragraph("El artefacto cumple el contrato mínimo para respuestas Word profesionales: no está vacío, contiene estructura y puede ser inspeccionado automáticamente.")',
      'doc.save(os.environ["OUT_PATH"])',
    ].join('\n'),
    description: 'DOCX verificable',
  }, {
    userId: 'user-docx',
    chatId: 'chat-docx',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.format, 'docx');
  assert.equal(result.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(result.validation.passed, true);
  assert.ok(events.some((event) => event.type === 'file_artifact' && event.artifact.id === result.artifactId));

  const verify = await INTERNAL.verifyArtifact.execute({ artifactId: result.artifactId }, {
    userId: 'user-docx',
    onEvent: () => {},
  });
  assert.equal(verify.ok, true);
  assert.equal(verify.ext, 'docx');
  assert.equal(verify.validation.passed, true);
  assert.ok(verify.paragraphCount >= 7);
  assert.match(verify.firstParagraphs.join('\n'), /Informe Profesional de Validaci[oó]n/);
});

test('agent task create_document: blocks invalid deliverables before artifact registration', async () => {
  const result = await INTERNAL.createDocument.execute({
    filename: 'broken.csv',
    python: [
      'import os',
      'with open(os.environ["OUT_PATH"], "w", encoding="utf-8") as f:',
      '    f.write("bad")',
    ].join('\n'),
  }, {
    userId: 'user-a',
    chatId: 'chat-a',
    onEvent: () => {},
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /artifact validation failed/);
  assert.equal(result.validation.passed, false);
});
