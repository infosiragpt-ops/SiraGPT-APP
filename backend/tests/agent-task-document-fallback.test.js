const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function rememberEnv(keys) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function clearAgentModules() {
  for (const modulePath of [
    '../src/services/agents/agent-task-runner',
    '../src/services/agents/task-store',
    '../src/routes/agent-task',
  ]) {
    try { delete require.cache[require.resolve(modulePath)]; } catch { /* ignore */ }
  }
}

test('buildAttachmentGroundedFallbackAnswer prefers document findings over internal scaffolding', () => {
  clearAgentModules();
  const { buildAttachmentGroundedFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const ctx = [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    'Para evidencia estructurada adicional llama docintel_retrieve/docintel_extract_tables; para busqueda semantica general llama rag_retrieve.',
    '',
    '### Archivo adjunto 1: articulos.docx',
    'id: file-articles-1',
    'tipo: application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '',
    '| N° | ***Título del articulo*** | ***Autores*** | ***Resultados*** |',
    '| 1 | Adicción a redes sociales y ansiedad en jóvenes | Equipo A | Se encontró que el uso compulsivo de redes sociales se asocia con mayores niveles de ansiedad, depresión y estrés en jóvenes universitarios. |',
    '| 2 | Salud mental digital | Equipo B | Se evidenció que la comparación social y el ciberacoso incrementan el malestar psicológico, mientras que la regulación del tiempo de pantalla reduce síntomas reportados. |',
  ].join('\n');

  const answer = buildAttachmentGroundedFallbackAnswer({
    goal: 'dame un resumen',
    uploadedFileContext: ctx,
    reason: 'model_error: 429 insufficient_quota',
  });

  assert.match(answer, /Análisis del documento adjunto/);
  assert.match(answer, /uso compulsivo de redes sociales se asocia/);
  assert.match(answer, /comparación social y el ciberacoso/);
  assert.doesNotMatch(answer, /docintel_retrieve|busqueda semantica general|Título del articulo/);
});

test('runAgentTaskJob: uploaded document receives local fallback answer without OPENAI_API_KEY', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-fallback-'));
  delete process.env.OPENAI_API_KEY;
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  clearAgentModules();

  const prisma = require('../src/config/database');
  const persistence = require('../src/services/agents/agent-task-persistence');
  const originalFindMany = prisma.file.findMany;
  const originalUpsert = persistence.upsertAgentTask;
  const originalAppend = persistence.appendAgentTaskEvent;
  const originalArtifact = persistence.persistGeneratedArtifact;
  prisma.file.findMany = async () => [{
    id: 'file-doc-1',
    userId: 'user-doc-1',
    filename: 'informe.pdf',
    originalName: 'informe.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    path: '/tmp/informe.pdf',
    extractedText: [
      'El informe describe un programa de vacunacion comunitaria con cobertura creciente durante tres trimestres consecutivos.',
      'Los resultados muestran reduccion de hospitalizaciones y mejor adherencia cuando se combinan brigadas moviles con recordatorios por SMS.',
      'La principal limitacion reportada es la falta de personal en zonas rurales y la necesidad de reforzar la cadena de frio.',
      'El documento recomienda monitoreo semanal, capacitacion del equipo local y priorizacion de adultos mayores.',
    ].join(' '),
    openaiFileId: null,
    documentAnalysis: {
      id: 'analysis-doc-1',
      status: 'completed',
      summary: 'Programa de vacunacion comunitaria',
      textCoverage: { status: 'ok' },
      ocr: null,
      warnings: [],
      pageCount: 3,
      sheetCount: null,
      slideCount: null,
      chunkCount: 2,
      tableCount: 0,
      chunks: [
        {
          id: 'chunk-1',
          ordinal: 1,
          sourceType: 'page',
          sourceLabel: 'pagina 1',
          pageNumber: 1,
          sheetName: null,
          slideNumber: null,
          sectionTitle: 'Resumen',
          text: 'El informe describe un programa de vacunacion comunitaria con cobertura creciente durante tres trimestres consecutivos.',
        },
      ],
      tables: [],
    },
  }];

  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => null;

  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    const result = await runAgentTaskJob({
      taskId: 'task-doc-fallback-1',
      traceId: 'trace-doc-fallback-1',
      user: { id: 'user-doc-1', email: 'doc@example.com' },
      goal: 'Qué dice este documento?',
      displayGoal: 'Qué dice este documento?',
      files: ['file-doc-1'],
      fileMetadata: [{ id: 'file-doc-1', name: 'informe.pdf', mimeType: 'application/pdf' }],
      model: 'gpt-4o',
      maxSteps: 4,
      maxRuntimeMs: 60_000,
    });

    const snapshot = taskStore.getTaskSnapshotForUser('task-doc-fallback-1', 'user-doc-1');
    assert.equal(result.status, 'completed');
    assert.equal(snapshot.status, 'completed');
    assert.match(snapshot.streamState.finalText, /Análisis del documento adjunto/);
    assert.match(snapshot.streamState.finalText, /programa de vacunacion comunitaria/);
    assert.equal(snapshot.streamState.error, undefined);
    assert.equal(snapshot.streamState.done, true);
  } finally {
    prisma.file.findMany = originalFindMany;
    persistence.upsertAgentTask = originalUpsert;
    persistence.appendAgentTaskEvent = originalAppend;
    persistence.persistGeneratedArtifact = originalArtifact;
    fs.rmSync(storeDir, { recursive: true, force: true });
    clearAgentModules();
    restoreEnv();
  }
});

test('runAgentTaskJob: uploaded document recovers when model runtime throws quota error', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-runtime-throw-'));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  clearAgentModules();

  const prisma = require('../src/config/database');
  const persistence = require('../src/services/agents/agent-task-persistence');
  const reactAgent = require('../src/services/react-agent');
  const taskContractResolver = require('../src/services/agents/task-contract-resolver');
  const originalFindMany = prisma.file.findMany;
  const originalUpsert = persistence.upsertAgentTask;
  const originalAppend = persistence.appendAgentTaskEvent;
  const originalArtifact = persistence.persistGeneratedArtifact;
  const originalRun = reactAgent.run;
  const originalResolveTaskContract = taskContractResolver.resolveTaskContract;

  prisma.file.findMany = async () => [{
    id: 'file-doc-throw-1',
    userId: 'user-doc-throw-1',
    filename: 'articulos.docx',
    originalName: 'articulos.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 4096,
    path: '/tmp/articulos.docx',
    extractedText: [
      'Se encontró que el uso compulsivo de redes sociales se asocia con mayores niveles de ansiedad, depresión y estrés en jóvenes universitarios.',
      'Se evidenció que la comparación social, el ciberacoso y el aislamiento incrementan el malestar psicológico.',
      'El documento recomienda regulación del tiempo de pantalla, apoyo psicoeducativo y seguimiento temprano de síntomas.',
      'Los hallazgos muestran una relación consistente entre adicción digital y deterioro de la salud mental.',
    ].join(' '),
    openaiFileId: null,
    documentAnalysis: {
      id: 'analysis-doc-throw-1',
      status: 'completed',
      summary: 'Redes sociales y salud mental',
      textCoverage: { status: 'ok' },
      ocr: null,
      warnings: [],
      pageCount: 1,
      sheetCount: null,
      slideCount: null,
      chunkCount: 0,
      tableCount: 0,
      chunks: [],
      tables: [],
    },
  }];

  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => null;
  taskContractResolver.resolveTaskContract = async ({ fallback }) => ({ contract: fallback(), source: 'test-fallback' });
  reactAgent.run = async () => {
    const err = new Error('429 insufficient_quota: You exceeded your current quota');
    err.status = 429;
    throw err;
  };

  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    const result = await runAgentTaskJob({
      taskId: 'task-doc-runtime-throw-1',
      traceId: 'trace-doc-runtime-throw-1',
      user: { id: 'user-doc-throw-1', email: 'throw@example.com' },
      goal: 'dame un resumen',
      displayGoal: 'dame un resumen',
      files: ['file-doc-throw-1'],
      fileMetadata: [{ id: 'file-doc-throw-1', name: 'articulos.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
      model: 'gpt-4o',
      maxSteps: 4,
      maxRuntimeMs: 60_000,
    });

    const snapshot = taskStore.getTaskSnapshotForUser('task-doc-runtime-throw-1', 'user-doc-throw-1');
    assert.equal(result.status, 'completed');
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.streamState.done, true);
    assert.equal(snapshot.streamState.error, undefined);
    assert.equal(snapshot.streamState.stoppedReason, 'attachment_runtime_recovery');
    assert.match(snapshot.streamState.finalText, /Análisis del documento adjunto/);
    assert.match(snapshot.streamState.finalText, /uso compulsivo de redes sociales se asocia/);
    assert.doesNotMatch(snapshot.streamState.finalText, /insufficient_quota|api[_ -]?key/i);
  } finally {
    prisma.file.findMany = originalFindMany;
    persistence.upsertAgentTask = originalUpsert;
    persistence.appendAgentTaskEvent = originalAppend;
    persistence.persistGeneratedArtifact = originalArtifact;
    reactAgent.run = originalRun;
    taskContractResolver.resolveTaskContract = originalResolveTaskContract;
    fs.rmSync(storeDir, { recursive: true, force: true });
    clearAgentModules();
    restoreEnv();
  }
});

test('runAgentTaskJob: uploaded document recovers when model runtime completes with empty final text', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-empty-final-'));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  clearAgentModules();

  const prisma = require('../src/config/database');
  const persistence = require('../src/services/agents/agent-task-persistence');
  const reactAgent = require('../src/services/react-agent');
  const taskContractResolver = require('../src/services/agents/task-contract-resolver');
  const originalFindMany = prisma.file.findMany;
  const originalUpsert = persistence.upsertAgentTask;
  const originalAppend = persistence.appendAgentTaskEvent;
  const originalArtifact = persistence.persistGeneratedArtifact;
  const originalRun = reactAgent.run;
  const originalResolveTaskContract = taskContractResolver.resolveTaskContract;

  prisma.file.findMany = async () => [{
    id: 'file-doc-empty-1',
    userId: 'user-doc-empty-1',
    filename: 'prediccion.txt',
    originalName: 'prediccion.txt',
    mimeType: 'text/plain',
    size: 1024,
    path: '/tmp/prediccion.txt',
    extractedText: [
      'La prediccion indica que las ventas del proximo trimestre subiran 18 por ciento si se mantiene una campania digital semanal.',
      'Tambien exige seguimiento de clientes con alta intencion de compra y respuesta comercial en menos de cuatro horas.',
      'Los riesgos principales son baja conversion rural, aumento de costos publicitarios y retrasos de soporte.',
      'La recomendacion es priorizar clientes calientes, medir CAC semanalmente y preparar un plan B si la conversion cae por debajo de siete por ciento.',
    ].join(' '),
    openaiFileId: null,
    documentAnalysis: null,
  }];

  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => null;
  taskContractResolver.resolveTaskContract = async ({ fallback }) => ({ contract: fallback(), source: 'test-fallback' });
  reactAgent.run = async () => ({ finalAnswer: '', steps: [], stoppedReason: 'model_error: upstream returned empty' });

  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    const result = await runAgentTaskJob({
      taskId: 'task-doc-empty-final-1',
      traceId: 'trace-doc-empty-final-1',
      user: { id: 'user-doc-empty-1', email: 'empty@example.com' },
      goal: 'Revisa esta prediccion y dime resumen, riesgos y recomendacion profesional.',
      displayGoal: 'Revisa esta prediccion y dime resumen, riesgos y recomendacion profesional.',
      files: ['file-doc-empty-1'],
      fileMetadata: [{ id: 'file-doc-empty-1', name: 'prediccion.txt', mimeType: 'text/plain' }],
      model: 'gpt-4o',
      maxSteps: 4,
      maxRuntimeMs: 60_000,
    });

    const snapshot = taskStore.getTaskSnapshotForUser('task-doc-empty-final-1', 'user-doc-empty-1');
    assert.equal(result.status, 'completed');
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.streamState.done, true);
    assert.equal(snapshot.streamState.error, undefined);
    assert.equal(snapshot.streamState.stoppedReason, 'attachment_empty_response_recovery');
    assert.match(snapshot.streamState.finalText, /Análisis del documento adjunto/);
    assert.match(snapshot.streamState.finalText, /ventas del proximo trimestre subiran 18/);
    assert.match(snapshot.streamState.finalText, /Siguiente paso recomendado/);
  } finally {
    prisma.file.findMany = originalFindMany;
    persistence.upsertAgentTask = originalUpsert;
    persistence.appendAgentTaskEvent = originalAppend;
    persistence.persistGeneratedArtifact = originalArtifact;
    reactAgent.run = originalRun;
    taskContractResolver.resolveTaskContract = originalResolveTaskContract;
    fs.rmSync(storeDir, { recursive: true, force: true });
    clearAgentModules();
    restoreEnv();
  }
});
