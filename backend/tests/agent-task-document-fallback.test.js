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
    'S2 - Support - Severidad Alta - Mitigacion: reforzar cobertura de soporte premium - Fecha limite: 2026-07-20.',
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
  assert.match(answer, /Peru/);
  assert.match(answer, /Chile/);
  assert.match(answer, /P1 - Privacy - Severidad Critica/);
  assert.match(answer, /firmar addendum DPA regional/);
  assert.match(answer, /2026-07-12/);
  assert.match(answer, /Colombia/);
  assert.match(answer, /S2 - Support - Severidad Alta/);
  assert.match(answer, /2026-07-20/);
  assert.match(answer, /35000 USD/);
  assert.match(answer, /Delta \/ Integraciones/);
  assert.match(answer, /16/);
  assert.match(answer, /CSV/);
  assert.match(answer, /DOCX/);
  assert.match(answer, /PDF/);
});

test('buildAttachmentGroundedFallbackAnswer honors an explicit "2 párrafos" summary request', () => {
  clearAgentModules();
  const { buildAttachmentGroundedFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const ctx = [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    'Para analisis profesionales: sintetiza con criterio academico/ejecutivo, no copies el indice, no enumeres metadatos internos y no empieces con "Indice de contenidos".',
    'El usuario pidio 2 parrafos: la respuesta final debe tener exactamente 2 parrafos bien desarrollados, sin viñetas y sin tabla.',
    'Pregunta del usuario: dame un resumen en 2 parrafos',
    '',
    '### Archivo adjunto 1: informe.docx',
    'id: file-informe-1',
    'tipo: application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '',
    'La gestión administrativa integra planificación, organización, dirección y control para alcanzar objetivos institucionales.',
    'El estudio evidencia que la digitalización mejora la eficiencia operativa y reduce los tiempos de respuesta interna.',
    'Los autores señalan que la capacitación continua del personal es decisiva para sostener la mejora de procesos.',
    'Asimismo concluyen que el liderazgo participativo incrementa el compromiso y la productividad de los equipos.',
  ].join('\n');

  const answer = buildAttachmentGroundedFallbackAnswer({
    goal: 'dame un resumen en 2 parrafos',
    uploadedFileContext: ctx,
    reason: 'model_error: 429 insufficient_quota',
  });

  const paragraphs = answer
    .replace(/^###[^\n]*\n?/, '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  assert.equal(paragraphs.length, 2);
  assert.doesNotMatch(answer, /sintetiza con criterio|El usuario pidio|Pregunta del usuario|Lote grande detectado/);
});

test('buildAttachmentGroundedFallbackAnswer honors a word-form "dos párrafos" request', () => {
  clearAgentModules();
  const { buildAttachmentGroundedFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const ctx = [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    'El usuario pidio 2 parrafos: la respuesta final debe tener exactamente 2 parrafos bien desarrollados, sin viñetas y sin tabla.',
    'Pregunta del usuario: dame un resumen en dos parrafos',
    '',
    '### Archivo adjunto 1: informe.docx',
    'id: file-informe-1',
    'tipo: application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '',
    'La gestión administrativa integra planificación, organización, dirección y control para alcanzar objetivos institucionales.',
    'El estudio evidencia que la digitalización mejora la eficiencia operativa y reduce los tiempos de respuesta interna.',
    'Los autores señalan que la capacitación continua del personal es decisiva para sostener la mejora de procesos.',
    'Asimismo concluyen que el liderazgo participativo incrementa el compromiso y la productividad de los equipos.',
  ].join('\n');

  const answer = buildAttachmentGroundedFallbackAnswer({
    goal: 'dame un resumen en dos parrafos',
    uploadedFileContext: ctx,
    reason: 'model_error: 429 insufficient_quota',
  });

  const paragraphs = answer
    .replace(/^###[^\n]*\n?/, '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  assert.equal(paragraphs.length, 2);
  assert.doesNotMatch(answer, /El usuario pidio|Pregunta del usuario/);
});

test('buildAttachmentGroundedFallbackAnswer produces exactly N paragraphs for N>2 requests', () => {
  clearAgentModules();
  const { buildAttachmentGroundedFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const sentences = [
    'La gestión administrativa integra planificación, organización, dirección y control para alcanzar objetivos institucionales.',
    'El estudio evidencia que la digitalización mejora la eficiencia operativa y reduce los tiempos de respuesta interna.',
    'Los autores señalan que la capacitación continua del personal es decisiva para sostener la mejora de procesos.',
    'Asimismo concluyen que el liderazgo participativo incrementa el compromiso y la productividad de los equipos.',
    'El documento describe indicadores de desempeño que permiten monitorear la calidad del servicio prestado.',
    'Finalmente recomienda institucionalizar la mejora continua mediante revisiones periódicas y retroalimentación.',
    'También advierte que la resistencia al cambio puede frenar la adopción de nuevas herramientas tecnológicas.',
    'Por último propone alinear los incentivos del personal con los objetivos estratégicos de la organización.',
  ];

  for (const n of [3, 4]) {
    const ctx = [
      'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
      `El usuario pidio ${n} parrafos: la respuesta final debe tener exactamente ${n} parrafos bien desarrollados, sin viñetas y sin tabla.`,
      'Pregunta del usuario: dame un resumen',
      '',
      '### Archivo adjunto 1: informe.docx',
      'id: file-informe-1',
      'tipo: application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '',
      ...sentences,
    ].join('\n');

    const answer = buildAttachmentGroundedFallbackAnswer({
      goal: `dame un resumen en ${n} parrafos`,
      uploadedFileContext: ctx,
      reason: 'model_error: 429 insufficient_quota',
    });

    const paragraphs = answer
      .replace(/^###[^\n]*\n?/, '')
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
    assert.equal(paragraphs.length, n, `expected ${n} paragraphs, got ${paragraphs.length}`);
    assert.doesNotMatch(answer, /El usuario pidio|Pregunta del usuario/);
  }
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

test('buildLlmAttachmentRecoveryAnswer answers the concrete question via an injected client', async () => {
  clearAgentModules();
  const { buildLlmAttachmentRecoveryAnswer } = require('../src/services/agents/agent-task-runner');
  const calls = [];
  const fakeClient = {
    chat: {
      completions: {
        create: async (payload) => {
          calls.push(payload);
          return { choices: [{ message: { content: 'El título de la investigación es "Redes sociales y voto joven".' } }] };
        },
      },
    },
  };
  const ctx = [
    '### Archivo adjunto 1: metodo.docx',
    'Redes sociales y voto joven: estudio cuantitativo sobre TikTok como fuente de noticias.',
    'La muestra incluyó 582 estudiantes universitarios de Colombia durante 2026.',
    'Los resultados evidenciaron que las hipótesis planteadas fueron significativas.',
  ].join('\n');

  const answer = await buildLlmAttachmentRecoveryAnswer({
    goal: 'cual es el titulo de la investigacion?',
    uploadedFileContext: ctx,
    env: { OPENAI_API_KEY: 'test-key' },
    clientFactory: () => fakeClient,
  });

  assert.match(answer, /Redes sociales y voto joven/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gpt-4o-mini');
  assert.match(calls[0].messages[1].content, /cual es el titulo de la investigacion/);
  assert.match(calls[0].messages[1].content, /582 estudiantes/);
});

test('buildLlmAttachmentRecoveryAnswer returns null without provider keys or on empty output', async () => {
  clearAgentModules();
  const { buildLlmAttachmentRecoveryAnswer, pickAttachmentRecoveryRuntime } = require('../src/services/agents/agent-task-runner');

  // Sin keys configuradas → null sin llamada.
  const noKeys = await buildLlmAttachmentRecoveryAnswer({
    goal: 'cual es el titulo?',
    uploadedFileContext: 'Texto largo del documento con suficientes palabras para superar el umbral del guard.',
    env: {},
    clientFactory: () => { throw new Error('no debe llamarse'); },
  });
  assert.equal(noKeys, null);

  // Respuesta vacía del proveedor → null (cae al fallback determinista).
  const emptyClient = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '   ' } }] }) } } };
  const emptyAnswer = await buildLlmAttachmentRecoveryAnswer({
    goal: 'cual es el titulo?',
    uploadedFileContext: 'Texto largo del documento con suficientes palabras para superar el umbral del guard.',
    env: { OPENAI_API_KEY: 'test-key' },
    clientFactory: () => emptyClient,
  });
  assert.equal(emptyAnswer, null);

  // Flag de apagado y modo test sin opt-in → runtime null.
  assert.equal(pickAttachmentRecoveryRuntime({ OPENAI_API_KEY: 'k', AGENT_TASK_LLM_RECOVERY: '0' }), null);
  assert.equal(pickAttachmentRecoveryRuntime({ OPENAI_API_KEY: 'k', NODE_ENV: 'test' }), null);
  assert.deepEqual(
    pickAttachmentRecoveryRuntime({ OPENAI_API_KEY: 'k', NODE_ENV: 'test', AGENT_TASK_LLM_RECOVERY: '1' }),
    { provider: 'OpenAI', model: 'gpt-4o-mini' },
  );
});

test('agent model failover walks configured providers and detects unrecovered model errors', () => {
  clearAgentModules();
  const {
    agentModelFailoverEnabled,
    isUnrecoveredModelFailure,
    resolveAgentModelFailoverRuntime,
    resolveAgentModelFailoverRuntimes,
  } = require('../src/services/agents/agent-task-runner');

  assert.equal(agentModelFailoverEnabled({}), true);
  assert.equal(agentModelFailoverEnabled({ AGENT_TASK_MODEL_FAILOVER: '0' }), false);
  assert.equal(agentModelFailoverEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(agentModelFailoverEnabled({ NODE_ENV: 'test', AGENT_TASK_MODEL_FAILOVER: '1' }), true);

  // OpenRouter (kimi) falló → debe elegir OpenAI con el modelo de runtime.
  const profile = { detected: { provider: 'OpenRouter' }, runtimeModel: 'moonshotai/kimi-k2.6' };
  const picked = resolveAgentModelFailoverRuntime(profile, { OPENAI_API_KEY: 'k' });
  assert.equal(picked.provider, 'OpenAI');
  assert.equal(picked.model, 'gpt-4o-mini');
  assert.ok(picked.client);

  // El runner conserva una cadena completa: Cerebras primero y después
  // OpenAI, Gemini y DeepSeek si cada proveedor anterior falla.
  const chain = resolveAgentModelFailoverRuntimes(profile, {
    CEREBRAS_API_KEY: 'cerebras-key',
    OPENAI_API_KEY: 'openai-key',
    GEMINI_API_KEY: 'gemini-key',
    DEEPSEEK_API_KEY: 'deepseek-key',
  });
  assert.deepEqual(chain.map(({ provider }) => provider), ['Cerebras', 'OpenAI', 'Gemini', 'DeepSeek']);

  // El proveedor que falló se excluye aunque tenga key.
  const openaiFailed = resolveAgentModelFailoverRuntime(
    { detected: { provider: 'OpenAI' }, runtimeModel: 'gpt-4o' },
    { OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'g' },
  );
  assert.equal(openaiFailed.provider, 'Gemini');

  // Sin keys alternativas → null.
  assert.equal(resolveAgentModelFailoverRuntime(profile, {}), null);
  assert.deepEqual(resolveAgentModelFailoverRuntimes(profile, {}), []);

  assert.equal(isUnrecoveredModelFailure('model_error: 429 insufficient_quota'), true);
  assert.equal(isUnrecoveredModelFailure('completed'), false);
});

test('runAgentTaskJob continues to Gemini when Cerebras and OpenAI also fail', async () => {
  const restoreEnv = rememberEnv([
    'OPENROUTER_API_KEY',
    'CEREBRAS_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'DEEPSEEK_API_KEY',
    'AGENT_TASK_STORE_DIR',
    'AGENT_TASK_MODEL_FAILOVER',
    'NODE_ENV',
  ]);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-model-failover-chain-'));
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.CEREBRAS_API_KEY = 'test-cerebras-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  delete process.env.DEEPSEEK_API_KEY;
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.AGENT_TASK_MODEL_FAILOVER = '1';
  process.env.NODE_ENV = 'test';
  clearAgentModules();

  const persistence = require('../src/services/agents/agent-task-persistence');
  const reactAgent = require('../src/services/react-agent');
  const taskContractResolver = require('../src/services/agents/task-contract-resolver');
  const originalUpsert = persistence.upsertAgentTask;
  const originalAppend = persistence.appendAgentTaskEvent;
  const originalArtifact = persistence.persistGeneratedArtifact;
  const originalRun = reactAgent.run;
  const originalResolveTaskContract = taskContractResolver.resolveTaskContract;
  const models = [];

  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => null;
  taskContractResolver.resolveTaskContract = async ({ fallback }) => ({ contract: fallback(), source: 'test-fallback' });
  reactAgent.run = async (_client, args) => {
    models.push(args.model);
    if (models.length < 4) {
      return { finalAnswer: '', steps: [], stoppedReason: 'model_error: 429 insufficient_quota' };
    }
    return {
      finalAnswer: 'Respuesta recuperada correctamente mediante un proveedor alternativo.',
      steps: [],
      stoppedReason: 'completed',
    };
  };

  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    const result = await runAgentTaskJob({
      taskId: 'task-model-failover-chain-1',
      traceId: 'trace-model-failover-chain-1',
      user: { id: 'user-model-failover-chain-1', email: 'failover@example.com' },
      goal: 'Redacta una respuesta breve y responde solo en el chat.',
      displayGoal: 'Redacta una respuesta breve y responde solo en el chat.',
      files: [],
      fileMetadata: [],
      model: 'openai/gpt-5.5',
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
      maxSteps: 4,
      maxRuntimeMs: 60_000,
    });

    const snapshot = taskStore.getTaskSnapshotForUser('task-model-failover-chain-1', 'user-model-failover-chain-1');
    assert.equal(result.status, 'completed');
    assert.deepEqual(models, ['openai/gpt-5.5', 'gpt-oss-120b', 'gpt-4o-mini', 'gemini-2.5-flash']);
    assert.match(snapshot.streamState.finalText, /proveedor alternativo/);
    assert.equal(snapshot.streamState.stoppedReason, 'completed');
  } finally {
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

test('runAgentTaskJob never turns an unrecovered model error into a Word artifact', async () => {
  const restoreEnv = rememberEnv([
    'OPENROUTER_API_KEY',
    'CEREBRAS_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'DEEPSEEK_API_KEY',
    'AGENT_TASK_STORE_DIR',
    'AGENT_TASK_MODEL_FAILOVER',
    'NODE_ENV',
  ]);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-model-error-artifact-guard-'));
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.CEREBRAS_API_KEY = 'test-cerebras-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  delete process.env.DEEPSEEK_API_KEY;
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.AGENT_TASK_MODEL_FAILOVER = '1';
  process.env.NODE_ENV = 'test';
  clearAgentModules();

  const persistence = require('../src/services/agents/agent-task-persistence');
  const reactAgent = require('../src/services/react-agent');
  const taskContractResolver = require('../src/services/agents/task-contract-resolver');
  const originalUpsert = persistence.upsertAgentTask;
  const originalAppend = persistence.appendAgentTaskEvent;
  const originalArtifact = persistence.persistGeneratedArtifact;
  const originalRun = reactAgent.run;
  const originalResolveTaskContract = taskContractResolver.resolveTaskContract;
  let persistedArtifacts = 0;

  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => { persistedArtifacts += 1; };
  taskContractResolver.resolveTaskContract = async ({ fallback }) => ({ contract: fallback(), source: 'test-fallback' });
  reactAgent.run = async () => ({
    finalAnswer: 'Hubo un problema temporal con el modelo y no pude completar la respuesta.',
    steps: [],
    stoppedReason: 'model_error: 429 insufficient_quota',
  });

  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    const result = await runAgentTaskJob({
      taskId: 'task-model-error-artifact-guard-1',
      traceId: 'trace-model-error-artifact-guard-1',
      user: { id: 'user-model-error-artifact-guard-1', email: 'guard@example.com' },
      goal: 'Crea un documento Word profesional con introducción y conclusión.',
      displayGoal: 'Crea un documento Word profesional con introducción y conclusión.',
      files: [],
      fileMetadata: [],
      model: 'openai/gpt-5.5',
      documentPolicy: { mode: 'doc_required', format: 'docx', autoGenerate: true },
      maxSteps: 4,
      maxRuntimeMs: 60_000,
    });

    const snapshot = taskStore.getTaskSnapshotForUser('task-model-error-artifact-guard-1', 'user-model-error-artifact-guard-1');
    assert.equal(result.status, 'completed');
    assert.equal(result.artifacts, 0);
    assert.equal(persistedArtifacts, 0);
    assert.equal(snapshot.documentPolicy.autoGenerate, false);
    assert.equal(snapshot.documentPolicy.thresholds.modelFailure, true);
    assert.equal(snapshot.streamState.artifacts.length, 0);
  } finally {
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

test('runAgentTaskJob: recovers weak tool-unavailable attachment final answer', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV', 'AGENT_TASK_ATTACHMENT_FASTPATH', 'AGENT_TASK_LLM_RECOVERY']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-tool-unavailable-'));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  process.env.AGENT_TASK_ATTACHMENT_FASTPATH = '0';
  process.env.AGENT_TASK_LLM_RECOVERY = '0';
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
      goal: 'Qué cliente debe usarse como caso de éxito y por qué, con SLA, churn, real y contrato. No crees archivos; responde solo en chat.',
      files: ['file-docx-1', 'file-xlsx-1'],
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
    }),
    true,
  );
  assert.equal(
    shouldUseDeterministicAttachmentAnswer({
      goal: 'Crea un mapa de fuentes: enumera cada archivo adjunto y qué dato principal aporta. No inventes archivos.',
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

test('resolveAgentToolScopes: authenticated users receive safe document-read scopes', () => {
  clearAgentModules();
  const { resolveAgentToolScopes } = require('../src/services/agents/agent-task-runner');

  assert.deepEqual(resolveAgentToolScopes({ id: null, scopes: [] }), []);
  assert.deepEqual(
    new Set(resolveAgentToolScopes({ id: 'user-doc', scopes: ['ai.generate'] })),
    new Set(['ai.generate', 'files.read', 'rag.read']),
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
  const restoreEnv = rememberEnv(['OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV', 'AGENT_TASK_ATTACHMENT_FASTPATH', 'AGENT_TASK_LLM_RECOVERY']);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-empty-final-'));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  process.env.AGENT_TASK_ATTACHMENT_FASTPATH = '0';
  process.env.AGENT_TASK_LLM_RECOVERY = '0';
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

test('structured calc answer takes the over/under direction from the totals, not the parsed magnitude', () => {
  clearAgentModules();
  const { buildAttachmentGroundedFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  const mk = (contract, real, diff) => [
    `Total contrato\t${contract}`,
    `Total real\t${real}`,
    `Diferencia\t${diff}`,
  ].join('\n');

  // real < contract with an explicit (non-negative) "Diferencia:" line → must
  // report "por debajo" (the magnitude alone used to force "por encima").
  const below = buildAttachmentGroundedFallbackAnswer({
    goal: 'calcula la diferencia entre el contrato y lo real',
    uploadedFileContext: mk(100000, 80000, 20000),
  });
  assert.match(below, /por debajo/);
  assert.doesNotMatch(below, /20000 USD\*\* por encima/);

  // real > contract → still "por encima".
  const above = buildAttachmentGroundedFallbackAnswer({
    goal: 'calcula la diferencia entre el contrato y lo real',
    uploadedFileContext: mk(270000, 283000, 13000),
  });
  assert.match(above, /por encima/);
});
