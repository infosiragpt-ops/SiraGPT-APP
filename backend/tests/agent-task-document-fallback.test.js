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

test('buildAttachmentGroundedFallbackAnswer synthesizes cross-document business evidence', () => {
  clearAgentModules();
  const { buildAttachmentGroundedFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const ctx = [
    '### Archivo adjunto 1: operaciones-memo.txt',
    'El total real combinado validado es 283000 USD frente a 270000 USD contratados.',
    'La retencion ponderada validada es 92.8%.',
    'Riesgo R1: Legal, severidad Alta, mitigacion: firmar DPA antes del 15 de junio.',
    'Recomendaciones: priorizar retencion en Cliente Sur; no expandir presupuesto hasta cerrar R1; usar Cliente Norte como caso de exito.',
    '',
    '### Archivo adjunto 2: informe-ejecutivo-q2.docx',
    'Este documento corrige cifras preliminares del PDF. Si hay conflicto, usar este informe ejecutivo como fuente primaria para churn total.',
    'Correccion clave: el churn total oficial es 6.2%, no 9.8%.',
    '',
    '### Archivo adjunto 3: metricas-clientes-q2.xlsx',
    'Cliente\tContrato_USD\tReal_USD\tSatisfaccion\tChurn\tRegion',
    'Norte\t120000\t138000\t92\t3\tBolivia',
    'Sur\t90000\t76000\t71\t11\tPeru',
    'Este\t60000\t69000\t88\t4\tChile',
    'Total contrato\t270000',
    'Total real\t283000',
    'Diferencia\t13000',
    'Retencion ponderada\t92.8',
    '',
    '### Archivo adjunto 4: riesgos-preliminar.pdf',
    'Churn total preliminar: 9.8% (no oficial).',
    'R1 - Legal - Severidad Alta - Mitigacion: firmar DPA antes del 15 de junio.',
  ].join('\n');

  const answer = buildAttachmentGroundedFallbackAnswer({
    goal: 'Analiza todos los documentos adjuntos. Calcula totales, identifica brecha, resuelve conflicto PDF/DOCX, identifica el riesgo que bloquea presupuesto y cita fuentes por documento. No crees archivos; responde solo en chat.',
    uploadedFileContext: ctx,
    reason: 'attachment_empty_response_recovery',
  });

  assert.match(answer, /283000 USD/);
  assert.match(answer, /270000 USD/);
  assert.match(answer, /13000 USD/);
  assert.match(answer, /Sur/);
  assert.match(answer, /92\.8%/);
  assert.match(answer, /6\.2%/);
  assert.match(answer, /9\.8%/);
  assert.match(answer, /fuente primaria/i);
  assert.match(answer, /R1 - Legal - Severidad Alta/);
  assert.match(answer, /firmar DPA antes del 15 de junio/);
  assert.match(answer, /no expandir/);
  assert.match(answer, /DOCX/);
  assert.match(answer, /PDF/);
  assert.doesNotMatch(answer, /No crees archivos|responde solo en chat/);
});

test('buildAttachmentGroundedFallbackAnswer handles alphanumeric risks, launch conflicts and CSV ticket evidence', () => {
  clearAgentModules();
  const { buildAttachmentGroundedFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const ctx = [
    '### Archivo adjunto 1: memo-orion-q3.txt',
    'Total contratado aprobado: 480000 USD.',
    'Total real validado: 484500 USD.',
    'Varianza neta: 4500 USD por encima del contrato.',
    'SLA ponderado validado: 94.0%.',
    'Contingencia disponible: 35000 USD, pero no debe liberarse hasta cerrar P1 y subir SLA de Andina y Delta por encima de 95%.',
    'Recomendacion: priorizar Andina y Delta, pausar Colombia y usar Bosque como caso de exito.',
    '',
    '### Archivo adjunto 2: tickets-orion.csv',
    'Cliente,Modulo,Tickets,Severidad,Nota',
    'Delta,Integraciones,16,Critica,bloqueo de integracion regional',
    'Delta,Billing,25,Alta,SLA bajo 95',
    '',
    '### Archivo adjunto 3: metricas-orion-q3.xlsx',
    'Andina Peru 180000 165000 91.2 12.4 38',
    'Bosque Chile 140000 151500 97.5 4.8 12',
    'Cumbre Bolivia 90000 104000 96.1 5.2 9',
    'Delta Colombia 70000 64000 89.4 15.8 41',
    '',
    '### Archivo adjunto 4: acta-comite-orion.docx',
    'Fecha oficial de lanzamiento: 2026-09-05. Si el PDF o el TXT indican 2026-08-30, esa fecha es preliminar y no debe usarse.',
    'Decision: lanzar Peru y Chile; pausar Colombia hasta cerrar P1.',
    '',
    '### Archivo adjunto 5: riesgos-orion-preliminar.pdf',
    'Fecha preliminar de lanzamiento: 2026-08-30 (no oficial).',
    'Total real preliminar: 472000 USD (no oficial).',
    'P1 - Privacy - Severidad Critica - Mitigacion: firmar addendum DPA regional - Fecha limite: 2026-07-12 - Bloquea: Colombia.',
  ].join('\n');

  const answer = buildAttachmentGroundedFallbackAnswer({
    goal: 'Calcula totales, resuelve conflicto de fecha, riesgo bloqueante, contingencia, tickets criticos y fuentes por documento. No crees archivos; responde solo en chat.',
    uploadedFileContext: ctx,
    reason: 'attachment_empty_response_recovery',
  });

  assert.match(answer, /484500 USD/);
  assert.match(answer, /480000 USD/);
  assert.match(answer, /4500 USD/);
  assert.match(answer, /Andina/);
  assert.match(answer, /94\.0%|94%/);
  assert.match(answer, /2026-09-05/);
  assert.match(answer, /2026-08-30/);
  assert.match(answer, /P1 - Privacy - Severidad Critica/);
  assert.match(answer, /firmar addendum DPA regional/);
  assert.match(answer, /2026-07-12/);
  assert.match(answer, /Colombia/);
  assert.match(answer, /35000 USD/);
  assert.match(answer, /Delta \/ Integraciones/);
  assert.match(answer, /16/);
  assert.match(answer, /CSV/);
  assert.match(answer, /DOCX/);
  assert.match(answer, /PDF/);
});

test('parseSpreadsheetCitationRows reads fileProcessor Excel tab-separated blocks', () => {
  clearAgentModules();
  const { parseSpreadsheetCitationRows, buildBibliographyFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const ctx = [
    'Excel workbook — 1 sheet(s): Hoja1',
    '',
    'Sheet: Hoja1',
    'Columns (3): Título del articulo | Autores | Año de publicacion',
    'Total data rows: 2',
    '---',
    'Sucesión intestada y herederos\tGarcía López, M.\t2021',
    'Derecho sucesorio comparado\tPérez, A. & Ruiz, B.\t2019',
  ].join('\n');

  const sources = parseSpreadsheetCitationRows(ctx);
  assert.equal(sources.length, 2);

  const answer = buildBibliographyFallbackAnswer({
    goal: 'cita la bibliografia en apa 7ma edicion',
    uploadedFileContext: ctx,
  });
  assert.match(answer, /Referencias \(APA 7\)/);
  assert.match(answer, /García López, M\. \(2021\)\./);
  assert.match(answer, /Pérez, A\., & Ruiz, B\. \(2019\)\./);
  assert.match(answer, /Sucesión intestada y herederos/);
});

test('buildBibliographyFallbackAnswer formats APA references from spreadsheet rows', () => {
  clearAgentModules();
  const { buildBibliographyFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const ctx = [
    '### Archivo adjunto 1: base_sucesion.xlsx',
    'tipo: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '',
    '| Título del articulo | Autores | Año de publicacion |',
    '| Sucesión intestada y herederos | García López, M. | 2021 |',
    '| Derecho sucesorio comparado | Pérez, A. & Ruiz, B. | 2019 |',
  ].join('\n');

  const answer = buildBibliographyFallbackAnswer({
    goal: 'dame la bibliografia en apa 7ma edición porfavor',
    uploadedFileContext: ctx,
  });

  assert.match(answer, /Referencias \(APA 7\)/);
  assert.match(answer, /Sucesión intestada y herederos/);
  assert.match(answer, /Derecho sucesorio comparado/);
  assert.doesNotMatch(answer, /Nota operativa|runtime principal|respuesta segura/i);
});

test('buildAttachmentUnavailableFallbackAnswer: bibliography request without rows is actionable', () => {
  clearAgentModules();
  const { buildAttachmentUnavailableFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const answer = buildAttachmentUnavailableFallbackAnswer({
    goal: 'dame la bibliografia en apa 7',
    uploadedFileContext: '',
  });

  assert.match(answer, /bibliografía en APA 7/i);
  assert.match(answer, /Título.*Autor/i);
  assert.doesNotMatch(answer, /Nota operativa|runtime principal|respuesta segura/i);
});

test('buildAttachmentGroundedFallbackAnswer respects one-paragraph XLSX summaries', () => {
  clearAgentModules();
  const { buildAttachmentGroundedFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const ctx = [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    '',
    '### Archivo adjunto 1: seleccionados_autorregulacion_aprendizaje.xlsx',
    'id: file-xlsx-1',
    'tipo: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '',
    '| Título del articulo | Autores | Año de publicacion | Resultados |',
    '| Autorregulación y aprendizaje autonomo | Equipo A | 2024 | Se encontró que la planificación del estudio y la autoevaluación mejoran el rendimiento academico en secundaria. |',
    '| Aula invertida y autonomia | Equipo B | 2026 | Los resultados muestran que actividades previas con recursos digitales incrementan la participación y la autonomia del estudiante. |',
    '| Metacognicion escolar | Equipo C | 2025 | El documento recomienda seguimiento docente, metas semanales y retroalimentacion para sostener habitos de aprendizaje autorregulado. |',
  ].join('\n');

  const answer = buildAttachmentGroundedFallbackAnswer({
    goal: 'dame un resumen en un solo parrafo',
    uploadedFileContext: ctx,
    reason: '401 Incorrect API key provided',
  });

  assert.match(answer, /planificación del estudio|planificacion del estudio/);
  assert.match(answer, /autonomia del estudiante/);
  assert.match(answer, /retroalimentacion/);
  assert.doesNotMatch(answer, /^###/m);
  assert.doesNotMatch(answer, /^- /m);
  assert.equal(answer.split(/\n{2,}/).length, 1);
  assert.doesNotMatch(answer, /Incorrect API key|401/);
});

test('runAgentTaskJob: recovers weak tool-unavailable attachment final answer', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV', 'AGENT_TASK_ATTACHMENT_FASTPATH']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-tool-unavailable-'));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  process.env.AGENT_TASK_ATTACHMENT_FASTPATH = '0';
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
    id: 'file-doc-tool-unavailable-1',
    userId: 'user-doc-tool-unavailable-1',
    filename: 'metricas.xlsx',
    originalName: 'metricas.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 4096,
    path: '/tmp/metricas.xlsx',
    extractedText: [
      'Total contrato 270000.',
      'Total real 283000.',
      'Diferencia 13000.',
      'Retencion ponderada 92.8.',
      'El DOCX oficial dice churn final 6.2 y el PDF preliminar dice 9.8.',
    ].join(' '),
    openaiFileId: null,
    documentAnalysis: null,
  }];

  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => null;
  taskContractResolver.resolveTaskContract = async ({ fallback }) => ({ contract: fallback(), source: 'test-fallback' });
  reactAgent.run = async () => ({
    finalAnswer: 'No pude usar docintel_retrieve en esta tarea (falló de forma repetida). Te respondo con la información disponible; si necesitas más precisión, vuelve a intentarlo o reformula la solicitud.',
    stoppedReason: 'tool_unavailable:docintel_retrieve',
    steps: [],
  });

  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    const result = await runAgentTaskJob({
      taskId: 'task-doc-tool-unavailable-1',
      traceId: 'trace-doc-tool-unavailable-1',
      user: { id: 'user-doc-tool-unavailable-1', email: 'tool@example.com' },
      goal: 'calcula el total real, contratado y contradiccion PDF DOCX',
      displayGoal: 'calcula el total real, contratado y contradiccion PDF DOCX',
      files: ['file-doc-tool-unavailable-1'],
      fileMetadata: [{ id: 'file-doc-tool-unavailable-1', name: 'metricas.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
      model: 'gpt-4o',
      maxSteps: 6,
      maxRuntimeMs: 60_000,
    });

    const snapshot = taskStore.getTaskSnapshotForUser('task-doc-tool-unavailable-1', 'user-doc-tool-unavailable-1');
    assert.equal(result.status, 'completed');
    assert.equal(snapshot.streamState.stoppedReason, 'attachment_empty_response_recovery');
    assert.match(snapshot.streamState.finalText, /283000/);
    assert.match(snapshot.streamState.finalText, /270000/);
    assert.match(snapshot.streamState.finalText, /6\.2/);
    assert.doesNotMatch(snapshot.streamState.finalText, /vuelve a intentarlo|reformula/i);
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

test('shouldUseDeterministicAttachmentAnswer: routes simple attachment summaries without agent tools', () => {
  clearAgentModules();
  const { shouldUseDeterministicAttachmentAnswer } = require('../src/services/agents/agent-task-runner');

  assert.equal(
    shouldUseDeterministicAttachmentAnswer({
      goal: 'dame un resumen en 2 parrafos de este DOCX',
      files: ['file-docx-1'],
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
    }),
    true,
  );
  assert.equal(
    shouldUseDeterministicAttachmentAnswer({
      goal: 'genera una matriz en Word con este documento',
      files: ['file-docx-1'],
      documentPolicy: { mode: 'doc_required', autoGenerate: true },
    }),
    false,
  );
  assert.equal(
    shouldUseDeterministicAttachmentAnswer({
      goal: 'resume este documento pero busca fuentes externas recientes',
      files: ['file-docx-1'],
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
    }),
    false,
  );
  assert.equal(
    shouldUseDeterministicAttachmentAnswer({
      goal: 'Qué país queda bloqueado y qué riesgo lo bloquea. No uses internet ni crees archivos; responde solo en chat.',
      files: ['file-docx-1', 'file-pdf-1'],
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
    }),
    true,
  );
  assert.equal(
    shouldUseDeterministicAttachmentAnswer({
      goal: 'calcula el total real y compara la contradiccion entre PDF y DOCX adjuntos',
      files: ['file-docx-1', 'file-pdf-1'],
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
    }),
    true,
  );
  assert.equal(
    shouldUseDeterministicAttachmentAnswer({
      goal: 'exporta una matriz descargable con este documento',
      files: ['file-docx-1'],
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
    }),
    false,
  );
  assert.equal(
    shouldUseDeterministicAttachmentAnswer({
      goal: 'describe esta imagen',
      files: ['file-image-1'],
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
      env: { AGENT_TASK_ATTACHMENT_FASTPATH: '0' },
    }),
    false,
  );
});

test('runAgentTaskJob: uploaded document receives local fallback answer without OPENAI_API_KEY', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-fallback-'));
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
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

test('runAgentTaskJob: simple uploaded document summary bypasses ReAct and completes terminally', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-fastpath-'));
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
  let reactInvoked = false;
  let contractInvoked = false;

  prisma.file.findMany = async () => [{
    id: 'file-doc-fast-1',
    userId: 'user-doc-fast-1',
    filename: 'matrices.docx',
    originalName: 'matrices.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 4096,
    path: '/tmp/matrices.docx',
    extractedText: [
      'El documento presenta una introduccion sobre salud mental universitaria y su relacion con habitos digitales persistentes.',
      'Los resultados citados muestran que la exposicion prolongada a redes sociales se asocia con ansiedad, estres y dificultades de concentracion.',
      'Tambien propone matrices de analisis para organizar antecedentes, metodologia, resultados y recomendaciones por autor.',
      'La conclusion operativa es priorizar intervenciones psicoeducativas, seguimiento temprano y regulacion del tiempo de pantalla.',
    ].join(' '),
    openaiFileId: null,
    documentAnalysis: null,
  }];

  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => null;
  taskContractResolver.resolveTaskContract = async ({ fallback }) => {
    contractInvoked = true;
    return { contract: fallback(), source: 'test-fallback' };
  };
  reactAgent.run = async () => {
    reactInvoked = true;
    throw new Error('react agent should not run for simple attachment summaries');
  };

  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    const result = await runAgentTaskJob({
      taskId: 'task-doc-fastpath-1',
      traceId: 'trace-doc-fastpath-1',
      user: { id: 'user-doc-fast-1', email: 'fast@example.com' },
      goal: 'dame un resumen en 2 parrafos',
      displayGoal: 'dame un resumen en 2 parrafos',
      files: ['file-doc-fast-1'],
      fileMetadata: [{ id: 'file-doc-fast-1', name: 'matrices.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
      model: 'gpt-4o',
      maxSteps: 12,
      maxRuntimeMs: 60_000,
    });

    const snapshot = taskStore.getTaskSnapshotForUser('task-doc-fastpath-1', 'user-doc-fast-1');
    assert.equal(result.status, 'completed');
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.streamState.done, true);
    assert.equal(snapshot.streamState.error, undefined);
    assert.equal(snapshot.streamState.stoppedReason, 'attachment_chat_fast_path');
    assert.equal(reactInvoked, false);
    assert.equal(contractInvoked, false);
    assert.match(snapshot.streamState.finalText, /Análisis del documento adjunto/);
    assert.match(snapshot.streamState.finalText, /salud mental universitaria/);
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

test('runAgentTaskJob: complex uploaded document analysis bypasses ReAct and completes terminally', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-complex-fastpath-'));
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
  let reactInvoked = false;
  let contractInvoked = false;

  const extractedText = [
    'Total contratado aprobado: 480000 USD.',
    'Total real validado: 484500 USD.',
    'Varianza neta: 4500 USD por encima del contrato.',
    'SLA ponderado validado: 94.0%.',
    'Contingencia disponible: 35000 USD, pero no debe liberarse hasta cerrar P1 y subir SLA de Andina y Delta por encima de 95%.',
    'Andina Peru 180000 165000 91.2 12.4 38',
    'Bosque Chile 140000 151500 97.5 4.8 12',
    'Cumbre Bolivia 90000 104000 96.1 5.2 9',
    'Delta Colombia 70000 64000 89.4 15.8 41',
    'Fecha oficial de lanzamiento: 2026-09-05. Si el PDF indica 2026-08-30, esa fecha es preliminar.',
    'P1 - Privacy - Severidad Critica - Mitigacion: firmar addendum DPA regional - Fecha limite: 2026-07-12 - Bloquea: Colombia.',
  ].join('\n');

  prisma.file.findMany = async () => [{
    id: 'file-doc-complex-1',
    userId: 'user-doc-complex-1',
    filename: 'orion-paquete.txt',
    originalName: 'orion-paquete.txt',
    mimeType: 'text/plain',
    size: Buffer.byteLength(extractedText),
    path: '/tmp/orion-paquete.txt',
    extractedText,
    openaiFileId: null,
    documentAnalysis: null,
  }];

  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => null;
  taskContractResolver.resolveTaskContract = async ({ fallback }) => {
    contractInvoked = true;
    return { contract: fallback(), source: 'test-fallback' };
  };
  reactAgent.run = async () => {
    reactInvoked = true;
    throw new Error('react agent should not run for complex attachment analysis');
  };

  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    const result = await runAgentTaskJob({
      taskId: 'task-doc-complex-fastpath-1',
      traceId: 'trace-doc-complex-fastpath-1',
      user: { id: 'user-doc-complex-1', email: 'complex@example.com' },
      goal: 'Calcula total real, total contratado, varianza neta, resuelve contradiccion de fecha y riesgo bloqueante. No crees archivos; responde solo en chat.',
      displayGoal: 'Calcula total real, total contratado, varianza neta, resuelve contradiccion de fecha y riesgo bloqueante. No crees archivos; responde solo en chat.',
      files: ['file-doc-complex-1'],
      fileMetadata: [{ id: 'file-doc-complex-1', name: 'orion-paquete.txt', mimeType: 'text/plain' }],
      model: 'gpt-4o',
      maxSteps: 12,
      maxRuntimeMs: 60_000,
    });

    const snapshot = taskStore.getTaskSnapshotForUser('task-doc-complex-fastpath-1', 'user-doc-complex-1');
    assert.equal(result.status, 'completed');
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.streamState.done, true);
    assert.equal(snapshot.streamState.error, undefined);
    assert.equal(snapshot.streamState.stoppedReason, 'attachment_chat_fast_path');
    assert.equal(reactInvoked, false);
    assert.equal(contractInvoked, false);
    assert.match(snapshot.streamState.finalText, /484500 USD/);
    assert.match(snapshot.streamState.finalText, /480000 USD/);
    assert.match(snapshot.streamState.finalText, /4500 USD/);
    assert.match(snapshot.streamState.finalText, /2026-09-05/);
    assert.match(snapshot.streamState.finalText, /P1 - Privacy - Severidad Critica/);
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

test('runAgentTaskJob: uploaded document recovers when model runtime throws quota error', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV', 'AGENT_TASK_ATTACHMENT_FASTPATH']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-runtime-throw-'));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  process.env.AGENT_TASK_ATTACHMENT_FASTPATH = '0';
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
    assert.ok(snapshot.streamState.steps.length >= 1, 'runtime recovery should emit at least one visible step');
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
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV', 'AGENT_TASK_ATTACHMENT_FASTPATH']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-empty-final-'));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  process.env.AGENT_TASK_ATTACHMENT_FASTPATH = '0';
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
    assert.ok(snapshot.streamState.steps.length >= 1, 'empty response recovery should emit at least one visible step');
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
