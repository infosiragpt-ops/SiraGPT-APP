'use strict';

// Full HTTP proof for chat background editing. The upload route, agent route,
// source-preserving editor, task reducer/store, artifact store and authenticated
// download route are real. Only external OpenAI I/O and durable DB/queue writes
// are replaced with deterministic in-memory boundaries.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-document-http-e2e-'));
const ENV_KEYS = [
  'UPLOAD_DIR', 'AGENT_ARTIFACT_DIR', 'AGENT_TASK_STORE_DIR', 'ENTERPRISE_EXECUTION_STORE_DIR',
  'AGENT_TASK_INLINE', 'AGENT_RATE_LIMIT_DISABLED', 'NODE_ENV', 'WRITE_BEHIND_DISABLED',
  'OPENAI_API_KEY', 'CEREBRAS_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY',
  'MISTRAL_API_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME', 'R2_BUCKET',
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

process.env.UPLOAD_DIR = path.join(TEST_ROOT, 'uploads');
process.env.AGENT_ARTIFACT_DIR = path.join(TEST_ROOT, 'agent-artifacts');
process.env.AGENT_TASK_STORE_DIR = path.join(TEST_ROOT, 'agent-tasks');
process.env.ENTERPRISE_EXECUTION_STORE_DIR = path.join(TEST_ROOT, 'enterprise-execution');
process.env.AGENT_TASK_INLINE = '1';
process.env.AGENT_RATE_LIMIT_DISABLED = '1';
process.env.NODE_ENV = 'test';
process.env.WRITE_BEHIND_DISABLED = 'true';
for (const key of [
  'OPENAI_API_KEY', 'CEREBRAS_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY',
  'MISTRAL_API_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME', 'R2_BUCKET',
]) delete process.env[key];

const express = require('express');
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
const prisma = require('../src/config/database');
const {
  installAuthSessionMock,
  mockResolvedModule,
  reloadModule,
} = require('./http-test-utils');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseBinary(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
}

function parseSse(text = '') {
  return String(text)
    .split(/\n\n+/)
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));
}

async function makeDocx({ title, sentinel, tableSentinel }) {
  return Buffer.from(await Packer.toBuffer(new Document({
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
}

function artifactDirectoryEntries() {
  try {
    return fs.readdirSync(process.env.AGENT_ARTIFACT_DIR).sort();
  } catch {
    return [];
  }
}

function installInMemoryPrisma() {
  const files = new Map();
  const versions = [];
  const analyses = new Map();
  const chunks = [];
  const tables = [];
  const restores = [];
  let fileCounter = 0;
  let versionCounter = 0;
  let analysisCounter = 0;

  const patch = (target, key, replacement) => {
    const original = target[key];
    target[key] = replacement;
    restores.push(() => { target[key] = original; });
  };
  const matches = (row, where = {}) => {
    if (where.id && typeof where.id === 'string' && row.id !== where.id) return false;
    if (where.id?.in && !where.id.in.map(String).includes(String(row.id))) return false;
    if (where.userId && String(row.userId) !== String(where.userId)) return false;
    if (where.fileId && String(row.fileId) !== String(where.fileId)) return false;
    if (where.validationPassed !== undefined && row.validationPassed !== where.validationPassed) return false;
    return true;
  };

  patch(prisma.file, 'create', async ({ data }) => {
    const now = new Date();
    const row = { id: `http-upload-${++fileCounter}`, createdAt: now, updatedAt: now, ...data };
    files.set(row.id, row);
    return { ...row };
  });
  patch(prisma.file, 'update', async ({ where, data }) => {
    const current = files.get(String(where.id));
    if (!current) throw new Error('file not found');
    const next = { ...current, ...data, updatedAt: new Date() };
    files.set(next.id, next);
    return { ...next };
  });
  patch(prisma.file, 'findMany', async ({ where = {} } = {}) => (
    Array.from(files.values()).filter((row) => matches(row, where)).map((row) => ({ ...row }))
  ));
  patch(prisma.file, 'findFirst', async ({ where = {} } = {}) => {
    const row = Array.from(files.values()).find((candidate) => matches(candidate, where));
    return row ? { ...row } : null;
  });
  patch(prisma.file, 'findUnique', async ({ where = {} } = {}) => {
    const row = files.get(String(where.id));
    return row ? { ...row } : null;
  });
  patch(prisma.file, 'count', async ({ where = {} } = {}) => (
    Array.from(files.values()).filter((row) => matches(row, where)).length
  ));

  patch(prisma.fileVersion, 'findFirst', async ({ where = {}, orderBy } = {}) => {
    let found = versions.filter((row) => matches(row, where));
    if (orderBy?.version === 'desc') found = found.sort((a, b) => b.version - a.version);
    return found[0] ? { ...found[0] } : null;
  });
  patch(prisma.fileVersion, 'findMany', async ({ where = {}, orderBy } = {}) => {
    let found = versions.filter((row) => matches(row, where));
    if (orderBy?.version === 'desc') found = found.sort((a, b) => b.version - a.version);
    return found.map((row) => ({ ...row }));
  });
  patch(prisma.fileVersion, 'create', async ({ data }) => {
    const row = { id: `http-version-${++versionCounter}`, createdAt: new Date(), ...data };
    versions.push(row);
    return { ...row };
  });

  patch(prisma.documentAnalysis, 'findUnique', async ({ where = {} } = {}) => {
    const row = analyses.get(String(where.fileId));
    return row ? { ...row } : null;
  });
  patch(prisma.documentAnalysis, 'findFirst', async ({ where = {} } = {}) => {
    const row = Array.from(analyses.values()).find((candidate) => matches(candidate, where));
    return row ? { ...row } : null;
  });
  patch(prisma.documentAnalysis, 'upsert', async ({ where, create, update }) => {
    const existing = analyses.get(String(where.fileId));
    const row = existing
      ? { ...existing, ...update, updatedAt: new Date() }
      : { id: `http-analysis-${++analysisCounter}`, createdAt: new Date(), updatedAt: new Date(), ...create };
    analyses.set(String(row.fileId), row);
    return { ...row };
  });

  patch(prisma.documentChunk, 'deleteMany', async ({ where = {} } = {}) => {
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      if (!where.analysisId || chunks[index].analysisId === where.analysisId) chunks.splice(index, 1);
    }
    return { count: 0 };
  });
  patch(prisma.documentChunk, 'createMany', async ({ data = [] }) => {
    chunks.push(...data.map((row, index) => ({ id: `http-chunk-${chunks.length + index + 1}`, ...row })));
    return { count: data.length };
  });
  patch(prisma.documentChunk, 'findMany', async ({ where = {}, take } = {}) => (
    chunks.filter((row) => !where.analysisId || row.analysisId === where.analysisId).slice(0, take || chunks.length)
  ));
  patch(prisma.documentTable, 'deleteMany', async ({ where = {} } = {}) => {
    for (let index = tables.length - 1; index >= 0; index -= 1) {
      if (!where.analysisId || tables[index].analysisId === where.analysisId) tables.splice(index, 1);
    }
    return { count: 0 };
  });
  patch(prisma.documentTable, 'createMany', async ({ data = [] }) => {
    tables.push(...data.map((row, index) => ({ id: `http-table-${tables.length + index + 1}`, ...row })));
    return { count: data.length };
  });
  patch(prisma.documentTable, 'findMany', async ({ where = {}, take } = {}) => (
    tables.filter((row) => !where.analysisId || row.analysisId === where.analysisId).slice(0, take || tables.length)
  ));
  patch(prisma, '$transaction', async (operations) => Promise.all(operations));

  patch(prisma.generatedArtifact, 'findMany', async () => []);
  patch(prisma.message, 'findMany', async () => []);

  return {
    files,
    versions,
    restore() {
      for (const restore of restores.reverse()) restore();
    },
  };
}

test('real HTTP upload -> background edit -> authenticated download preserves two DOCX files', { timeout: 120_000 }, async (t) => {
  const openAiCalls = { files: 0, content: 0 };
  class FakeOpenAI {
    constructor() {
      this.files = {
        create: async () => {
          openAiCalls.files += 1;
          return { id: `openai-file-${openAiCalls.files}` };
        },
      };
      this.chat = { completions: { create: async () => { openAiCalls.content += 1; throw new Error('unexpected content call'); } } };
      this.embeddings = { create: async () => { throw new Error('unexpected embeddings call'); } };
    }
  }
  FakeOpenAI.OpenAI = FakeOpenAI;
  FakeOpenAI.default = FakeOpenAI;
  const restoreOpenAI = mockResolvedModule(require.resolve('openai'), FakeOpenAI);
  const database = installInMemoryPrisma();
  const persistence = require('../src/services/agents/agent-task-persistence');
  const persistenceRestores = [];
  for (const name of ['upsertAgentTask', 'appendAgentTaskEvent', 'persistGeneratedArtifact']) {
    const original = persistence[name];
    persistence[name] = async () => null;
    persistenceRestores.push(() => { persistence[name] = original; });
  }
  // Indexing is an asynchronous persistence queue unrelated to editing. Keep
  // this gate hermetic and prove the upload/editor path without allowing a
  // post-response embedding job to outlive the test.
  const operationalRag = require('../src/services/rag/operational-runtime');
  const originalNormaliseDocs = operationalRag.normaliseDocs;
  operationalRag.normaliseDocs = () => [];
  persistenceRestores.push(() => { operationalRag.normaliseDocs = originalNormaliseDocs; });
  const auth = installAuthSessionMock({ id: 'document-http-user', email: 'document-http@example.com', plan: 'ENTERPRISE' });

  t.after(() => {
    auth.restore();
    for (const restore of persistenceRestores.reverse()) restore();
    database.restore();
    restoreOpenAI();
    for (const modulePath of [
      '../src/middleware/upload', '../src/routes/files', '../src/routes/agent-task',
      '../src/services/agents/task-store', '../src/services/agents/task-tools',
      '../src/services/source-preserving-document-edit', '../src/services/agents/agent-task-runner',
    ]) {
      try { delete require.cache[require.resolve(modulePath)]; } catch { /* optional */ }
    }
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  delete require.cache[require.resolve('../src/middleware/upload')];
  const filesRouter = reloadModule('../src/routes/files');
  const agentRouter = reloadModule('../src/routes/agent-task');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/files', filesRouter);
  app.use('/api/agent', agentRouter);
  app.use((error, _req, res, _next) => res.status(error?.status || 500).json({ error: error?.message || 'request failed' }));

  const sourceProofs = [
    { title: 'Norte 2026', sentinel: 'NORTE-101', tableSentinel: 'TN-1' },
    { title: 'Sur 2026', sentinel: 'SUR-202', tableSentinel: 'TS-2' },
  ];
  const sourceBuffers = await Promise.all(sourceProofs.map(makeDocx));
  const sourceHashes = sourceBuffers.map(sha256);

  let uploadRequest = request(app)
    .post('/api/files/upload')
    .set('Authorization', auth.authHeader);
  for (const buffer of sourceBuffers) {
    uploadRequest = uploadRequest.attach('files', buffer, { filename: 'Modelo Informe.docx', contentType: DOCX_MIME });
  }
  const uploaded = await uploadRequest;
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body, null, 2));
  assert.equal(uploaded.body.files.length, 2);
  assert.ok(uploaded.body.files.every((file) => file.success === true));
  const fileIds = uploaded.body.files.map((file) => file.id);
  assert.equal(new Set(fileIds).size, 2);
  assert.equal(openAiCalls.files, 2, 'only the external OpenAI Files boundary is stubbed');
  assert.equal(openAiCalls.content, 0, 'the deterministic editor must not call a content model');

  const editResponse = await request(app)
    .post('/api/agent/task')
    .set('Authorization', auth.authHeader)
    .send({
      scopeMode: 'global',
      files: fileIds,
      goal: 'edita los documentos adjuntos y cambia el título a 2027; solo modifica eso y devuélveme ambos archivos',
      maxSteps: 2,
      maxRuntimeMs: 60_000,
    });
  assert.equal(editResponse.status, 200, editResponse.text);
  const events = parseSse(editResponse.text);
  const terminal = events.findLast((event) => event.type === 'done' || event.type === 'error');
  assert.equal(terminal?.type, 'done', JSON.stringify(events.slice(-8), null, 2));
  const artifacts = events.filter((event) => event.type === 'file_artifact').map((event) => event.artifact);
  assert.equal(artifacts.length, 2, JSON.stringify(events.slice(-12), null, 2));
  assert.deepEqual(artifacts.map((artifact) => artifact.sourceFileId), fileIds);
  assert.equal(new Set(artifacts.map((artifact) => artifact.id)).size, 2);
  assert.ok(artifacts.every((artifact) => artifact.validation?.passed === true));

  const unauthenticated = await request(app).get(artifacts[0].downloadUrl);
  assert.equal(unauthenticated.status, 401);
  for (let index = 0; index < artifacts.length; index += 1) {
    const downloaded = await request(app)
      .get(artifacts[index].downloadUrl)
      .set('Authorization', auth.authHeader)
      .buffer(true)
      .parse(parseBinary);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers['content-disposition'] || '', /^attachment;/);
    const xml = new PizZip(downloaded.body).file('word/document.xml')?.asText() || '';
    assert.match(xml, /<w:t[^>]*>2027<\/w:t>/);
    assert.equal(xml.includes(sourceProofs[index].title), false);
    assert.equal(xml.includes(sourceProofs[index].sentinel), true);
    assert.equal(xml.includes(sourceProofs[index].tableSentinel), true);
    assert.equal(xml.includes(sourceProofs[1 - index].sentinel), false);
    assert.equal(xml.includes('ANEXOS'), false);
  }
  fileIds.forEach((fileId, index) => {
    const row = database.files.get(fileId);
    assert.equal(sha256(fs.readFileSync(row.path)), sourceHashes[index], 'the uploaded original must remain byte-identical');
  });
  assert.equal(database.versions.length, 2);
  assert.ok(database.versions.every((version) => version.validationPassed === true));

  database.versions.push({
    id: 'legacy-invalid-version',
    fileId: fileIds[0],
    userId: auth.user.id,
    version: 99,
    artifactId: 'legacy-invalid-artifact',
    filename: 'legacy-invalid.docx',
    validationPassed: false,
    createdAt: new Date(),
  });
  const versionHistory = await request(app)
    .get(`/api/files/${fileIds[0]}/versions`)
    .set('Authorization', auth.authHeader);
  assert.equal(versionHistory.status, 200);
  assert.equal(versionHistory.body.versions.length, 1);
  assert.ok(versionHistory.body.versions.every((version) => version.validationPassed === true));
  assert.equal(versionHistory.text.includes('legacy-invalid-artifact'), false, 'invalid history must expose no download URL');
  const invalidRestore = await request(app)
    .post(`/api/files/${fileIds[0]}/versions/legacy-invalid-version/restore`)
    .set('Authorization', auth.authHeader)
    .send({});
  assert.equal(invalidRestore.status, 404, 'an invalid legacy version must never be restorable');
  assert.equal(database.versions.length, 3, 'rejected restore must not create a new head');

  // Fail-closed HTTP regression: a no-op replacement is an invalid edited
  // candidate. It must produce no URL, artifact bytes or version row.
  const invalidUpload = await request(app)
    .post('/api/files/upload')
    .set('Authorization', auth.authHeader)
    .attach('files', Buffer.from('MISMO', 'utf8'), { filename: 'mismo.txt', contentType: 'text/plain' });
  assert.equal(invalidUpload.status, 200, JSON.stringify(invalidUpload.body, null, 2));
  const entriesBeforeInvalidTask = artifactDirectoryEntries();
  const versionsBeforeInvalidTask = database.versions.length;
  const invalidEdit = await request(app)
    .post('/api/agent/task')
    .set('Authorization', auth.authHeader)
    .send({
      scopeMode: 'global',
      files: [invalidUpload.body.files[0].id],
      goal: 'en el archivo adjunto reemplaza "MISMO" por "MISMO"; solo modifica eso y devuelve el mismo archivo',
      maxSteps: 2,
      maxRuntimeMs: 60_000,
    });
  assert.equal(invalidEdit.status, 200, invalidEdit.text);
  const invalidEvents = parseSse(invalidEdit.text);
  assert.equal(invalidEvents.filter((event) => event.type === 'file_artifact').length, 0);
  assert.equal(invalidEvents.findLast((event) => event.type === 'done')?.stats?.artifacts, 0);
  assert.deepEqual(artifactDirectoryEntries(), entriesBeforeInvalidTask, 'failed validation must not persist bytes or metadata');
  assert.equal(database.versions.length, versionsBeforeInvalidTask, 'failed validation must not create a version');
});
