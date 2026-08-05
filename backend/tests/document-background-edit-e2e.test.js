'use strict';

// Hermetic integration proof for the production chat document-edit path:
// real DOCX uploads -> real source-preserving editor -> artifact events ->
// durable reducer state -> authenticated HTTP downloads -> OOXML assertions.
// No document editor, artifact store, route, or content provider is mocked.

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-document-background-e2e-'));
const ARTIFACT_DIR = path.join(TEST_ROOT, 'agent-artifacts');
const UPLOAD_DIR = path.join(TEST_ROOT, 'uploads');
const ENV_KEYS = [
  'AGENT_ARTIFACT_DIR', 'NODE_ENV', 'JWT_SECRET', 'WRITE_BEHIND_DISABLED',
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_BUCKET',
  'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY',
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

process.env.AGENT_ARTIFACT_DIR = ARTIFACT_DIR;
process.env.NODE_ENV = 'test';
process.env.WRITE_BEHIND_DISABLED = 'true';
for (const key of [
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_BUCKET',
  'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY',
]) delete process.env[key];

const request = require('supertest');
const PizZip = require('pizzip');
const {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} = require('docx');
const { buildDocumentEditTool } = require('../src/services/agent-harness/tools/document-edit-tool');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

after(() => {
  delete require.cache[require.resolve('../src/routes/agent-task')];
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function writeRealUpload({ folder, title, sentinel, tableSentinel }) {
  const targetDir = path.join(UPLOAD_DIR, folder);
  fs.mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, 'Modelo Informe.docx');
  const buffer = Buffer.from(await Packer.toBuffer(new Document({
    sections: [{
      children: [
        new Paragraph({
          style: 'Title',
          children: [new TextRun({ text: title, bold: true, color: '1F4E79' })],
        }),
        new Paragraph({ children: [new TextRun({ text: sentinel, italics: true })] }),
        new Table({
          rows: [new TableRow({
            children: [new TableCell({ children: [new Paragraph(tableSentinel)] })],
          })],
        }),
      ],
    }],
  })));
  fs.writeFileSync(filePath, buffer);
  return { filePath, buffer, title, sentinel, tableSentinel };
}

function fakePrisma(rows) {
  const versionAttempts = [];
  return {
    versionAttempts,
    file: {
      async findMany(query = {}) {
        const wanted = new Set((query.where?.id?.in || []).map(String));
        const userId = String(query.where?.userId || '');
        // Deliberately return DB order opposite to attachment order. The real
        // loader must restore the order supplied by the chat turn.
        return [...rows].reverse().filter((row) => wanted.has(String(row.id)) && String(row.userId) === userId);
      },
    },
    generatedArtifact: { async findMany() { return []; } },
    message: { async findMany() { return []; } },
    fileVersion: {
      async findFirst({ where } = {}) {
        versionAttempts.push(where?.fileId);
        throw new Error('simulated version-history outage');
      },
    },
  };
}

function parseBinary(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
}

function readDocumentXml(buffer) {
  const entry = new PizZip(buffer).file('word/document.xml');
  assert.ok(entry, 'the downloaded artifact must be a real DOCX package');
  return entry.asText();
}

test('edits two real DOCX uploads in background and downloads both authenticated artifacts', async () => {
  const userId = 'document-e2e-user';
  const chatId = 'document-e2e-chat';
  const north = await writeRealUpload({
    folder: 'north',
    title: 'Informe Norte 2026',
    sentinel: 'CENTINELA-CUERPO-NORTE-9101',
    tableSentinel: 'TABLA-FIJA-NORTE-9201',
  });
  const south = await writeRealUpload({
    folder: 'south',
    title: 'Informe Sur 2026',
    sentinel: 'CENTINELA-CUERPO-SUR-9102',
    tableSentinel: 'TABLA-FIJA-SUR-9202',
  });
  const rows = [
    {
      id: 'upload-north', userId, path: north.filePath,
      filename: 'Modelo Informe.docx', originalName: 'Modelo Informe.docx',
      mimeType: DOCX_MIME, size: north.buffer.length,
      extractedText: `${north.title}. ${north.sentinel}. ${north.tableSentinel}.`,
    },
    {
      id: 'upload-south', userId, path: south.filePath,
      filename: 'Modelo Informe.docx', originalName: 'Modelo Informe.docx',
      mimeType: DOCX_MIME, size: south.buffer.length,
      extractedText: `${south.title}. ${south.sentinel}. ${south.tableSentinel}.`,
    },
  ];
  const prisma = fakePrisma(rows);
  const events = [];
  const prompt = 'quiero que en ambos Word el título le coloques 2027; solo modifica eso y devuélveme ambos archivos';
  const tool = buildDocumentEditTool({ prisma });

  const result = await tool.execute({ instruction: prompt }, {
    userId,
    chatId,
    fileIds: rows.map((row) => row.id),
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.engine, 'in-process');
  assert.equal(result.batch, true);
  assert.equal(result.partial, false);
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.edited.length, 2);
  assert.equal(new Set(result.artifacts.map((artifact) => artifact.id)).size, 2);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.sourceFileId), rows.map((row) => row.id));
  assert.deepEqual(new Set(prisma.versionAttempts), new Set(rows.map((row) => row.id)),
    'version persistence should be attempted without blocking artifact delivery when it is unavailable');
  assert.ok(result.artifacts.every((artifact) => artifact.documentVersion === null));

  const artifactEvents = events.filter((event) => event.type === 'file_artifact');
  assert.equal(artifactEvents.length, 2, 'chat must receive one download card per edited upload');
  assert.equal(artifactEvents[0].artifact.filename, artifactEvents[1].artifact.filename,
    'the proof intentionally uses equal upload names to guard batch-card collapsing');

  const auth = installAuthSessionMock({ id: userId, email: 'document-e2e@example.com' });
  try {
    const router = reloadModule('../src/routes/agent-task');
    const app = buildRouteTestApp('/api/agent', router);
    const { INTERNAL } = router;

    const durableState = artifactEvents.reduce(
      (state, event) => INTERNAL.reduceAgentState(state, event),
      INTERNAL.initialAgentState(),
    );
    assert.equal(durableState.artifacts.length, 2,
      'same-name batch artifacts with distinct sourceFileId values must survive durable replay');

    const unauthenticated = await request(app).get(artifactEvents[0].artifact.downloadUrl);
    assert.equal(unauthenticated.status, 401, 'artifact bytes must not be public');

    const proofs = [
      { source: north, ownId: 'upload-north', other: south },
      { source: south, ownId: 'upload-south', other: north },
    ];
    for (let index = 0; index < artifactEvents.length; index += 1) {
      const event = artifactEvents[index];
      const proof = proofs[index];
      assert.equal(event.artifact.sourceFileId, proof.ownId);

      const response = await request(app)
        .get(event.artifact.downloadUrl)
        .set('Authorization', auth.authHeader)
        .buffer(true)
        .parse(parseBinary);

      assert.equal(response.status, 200);
      assert.match(response.headers['content-disposition'] || '', /^attachment;/);
      assert.ok(Buffer.isBuffer(response.body));
      assert.equal(response.body.length, event.artifact.sizeBytes);

      const xml = readDocumentXml(response.body);
      assert.match(xml, /<w:t[^>]*>2027<\/w:t>/, 'the requested title must be applied exactly');
      assert.equal(xml.includes(proof.source.title), false, 'the old title must be gone');
      assert.equal(xml.includes(proof.source.sentinel), true, 'the original body must remain');
      assert.equal(xml.includes(proof.source.tableSentinel), true, 'the original table must remain');
      assert.equal(xml.includes(proof.other.sentinel), false, 'documents must never leak into each other');
      assert.equal(xml.includes('ANEXOS'), false, 'the editor must not append a regenerated annex');
    }
  } finally {
    auth.restore();
  }

  assert.equal(fs.readFileSync(north.filePath).equals(north.buffer), true,
    'the first original upload must stay byte-identical');
  assert.equal(fs.readFileSync(south.filePath).equals(south.buffer), true,
    'the second original upload must stay byte-identical');
});
