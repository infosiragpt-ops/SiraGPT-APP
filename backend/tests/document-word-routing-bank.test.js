const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildDocumentDeliveryPolicy } = require('../src/services/agents/document-delivery-policy');
const {
  buildPlan,
  detectFormat: detectAdvancedDocumentFormat,
} = require('../src/services/document-pipeline/advanced-document-pipeline');

function buildWordBank() {
  const verbs = [
    'Genera',
    'Crea',
    'Hazme',
    'Prepara',
    'Redacta',
    'Elabora',
    'Devuélveme',
    'Entrégame',
    'Necesito',
    'Quiero',
  ];
  const domains = [
    'un Word profesional para una tesis APA 7',
    'un Word ejecutivo de auditoría financiera',
    'un Word legal con cláusulas y matriz de riesgos',
    'un Word académico con marco teórico y referencias',
    'un Word de inteligencia de mercado con KPIs',
    'un Word pedagógico con rúbrica y anexos',
    'un Word médico con tabla de evidencia clínica',
    'un Word técnico con arquitectura y decisiones',
    'un Word de investigación cualitativa con categorías',
    'un Word corporativo para comité directivo',
  ];
  const requirements = [
    'con índice, resumen ejecutivo y conclusiones accionables',
    'con tabla Excel comparativa dentro del documento',
    'con análisis de un PDF citado como fuente secundaria',
    'con cronograma, presupuesto y matriz de trazabilidad',
    'con anexos, limitaciones y recomendaciones priorizadas',
    'con método, resultados esperados y criterios de calidad',
    'con síntesis crítica, hipótesis y contraargumentos',
    'con plan de implementación, responsables y riesgos',
    'con indicadores, fórmulas explicadas y glosario',
    'con estilo minimalista, portada y bibliografía',
  ];
  const constraints = [
    'sin convertirlo a Excel aunque incluya tablas',
    'aunque mencione PDF como insumo',
  ];

  const prompts = [];
  for (const verb of verbs) {
    for (const domain of domains) {
      for (const requirement of requirements) {
        for (const constraint of constraints) {
          prompts.push(`${verb} ${domain} ${requirement}, ${constraint}.`);
        }
      }
    }
  }
  assert.equal(prompts.length, 2000);
  return prompts;
}

test('document delivery policy: 2000 complex Word requests require docx auto-generation', () => {
  for (const prompt of buildWordBank()) {
    const policy = buildDocumentDeliveryPolicy({
      goal: prompt,
      displayGoal: prompt,
      finalText: 'Respuesta extensa con análisis, tablas internas y recomendaciones.',
      files: [{ id: 'file-docx', name: 'insumo.docx' }],
      requestedFormat: 'xlsx',
    });

    assert.equal(policy.mode, 'doc_required', prompt);
    assert.equal(policy.format, 'docx', prompt);
    assert.equal(policy.autoGenerate, true, prompt);
    assert.match(policy.reason, /Word requerido|documental expl[ií]cito/i, prompt);
  }
});

test('advanced document pipeline: 2000 complex Word requests still resolve to DOCX plans', () => {
  for (const prompt of buildWordBank()) {
    assert.equal(detectAdvancedDocumentFormat(prompt), 'docx', prompt);
    assert.equal(detectAdvancedDocumentFormat(prompt, 'xlsx'), 'docx', prompt);
    const plan = buildPlan({
      prompt,
      format: 'docx',
      template: 'business',
      complexity: 'high',
    });
    assert.equal(plan.format, 'docx', prompt);
    assert.ok(plan.sections.length >= 7, prompt);
    if (/metod|m[eé]todo/i.test(prompt)) {
      assert.ok(plan.sections.includes('Metodología'), prompt);
    }
    if (/matriz/i.test(prompt)) {
      assert.ok(plan.sections.includes('Matriz de riesgos'), prompt);
    }
    if (/recomend/i.test(prompt)) {
      assert.ok(plan.sections.includes('Recomendaciones'), prompt);
    }
  }
});

test('document delivery policy: questions about an existing Word stay in chat unless output is explicit', () => {
  const prompts = [
    '¿Cuál es el título del Word que subí?',
    'Resume el Word adjunto en el chat.',
    'Lee el documento y dime sus conclusiones principales.',
    '¿Qué dice el PDF sobre la muestra?',
    'Explícame de qué trata el archivo adjunto.',
  ];

  for (const prompt of prompts) {
    const policy = buildDocumentDeliveryPolicy({
      goal: prompt,
      displayGoal: prompt,
      files: [{ id: 'file-docx', name: 'informe.docx' }],
    });
    assert.equal(policy.mode, 'chat_only', prompt);
    assert.equal(policy.autoGenerate, false, prompt);
  }
});

test('document delivery policy: source Word converted to PDF keeps PDF as the target format', () => {
  const policy = buildDocumentDeliveryPolicy({
    goal: 'Convierte mi Word a PDF profesional sin cambiar la estructura.',
    displayGoal: 'Convierte mi Word a PDF profesional sin cambiar la estructura.',
    files: [{ id: 'file-docx', name: 'contrato.docx' }],
  });

  assert.equal(policy.mode, 'doc_required');
  assert.equal(policy.format, 'pdf');
  assert.equal(policy.autoGenerate, true);
});
