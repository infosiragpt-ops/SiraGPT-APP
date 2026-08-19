'use strict';

const professionalAnalyzer = require('./professional-document-analyzer');
const smartPaste = require('./smart-paste-bridge');
const fidelityEngine = require('./fidelity-verification-engine');
const evidenceEngine = require('./multi-document-evidence-engine');

const STAGES = Object.freeze({
  IDLE: 'idle',
  DETECTING_FORMAT: 'detecting_format',
  DETECTING_DOMAIN: 'detecting_domain',
  EXTRACTING_ENTITIES: 'extracting_entities',
  BUILDING_STRUCTURE: 'building_structure',
  ASSESSING_RISKS: 'assessing_risks',
  COMPUTING_QUALITY: 'computing_quality',
  BUILDING_DIMENSIONS: 'building_dimensions',
  MAPPING_RISKS: 'mapping_risks',
  CROSS_REFERENCING: 'cross_referencing',
  VERIFYING_FIDELITY: 'verifying_fidelity',
  BUILDING_REPORT: 'building_report',
  COMPLETE: 'complete',
});

const STAGE_LABELS = {
  [STAGES.IDLE]: 'Inactivo',
  [STAGES.DETECTING_FORMAT]: 'Detectando formato',
  [STAGES.DETECTING_DOMAIN]: 'Analizando dominio profesional',
  [STAGES.EXTRACTING_ENTITIES]: 'Extrayendo entidades y PII',
  [STAGES.BUILDING_STRUCTURE]: 'Mapeando estructura del documento',
  [STAGES.ASSESSING_RISKS]: 'Evaluando riesgos por dimensión',
  [STAGES.COMPUTING_QUALITY]: 'Calculando métricas de calidad',
  [STAGES.BUILDING_DIMENSIONS]: 'Construyendo análisis dimensional',
  [STAGES.MAPPING_RISKS]: 'Mapeando cobertura de riesgos',
  [STAGES.CROSS_REFERENCING]: 'Cruzando referencias entre documentos',
  [STAGES.VERIFYING_FIDELITY]: 'Verificando fidelidad de datos',
  [STAGES.BUILDING_REPORT]: 'Generando informe profesional',
  [STAGES.COMPLETE]: 'Análisis completo',
};

function runAnalysisPipeline(text, opts = {}) {
  const startTime = Date.now();
  const stages = [];

  stages.push({ stage: STAGES.DETECTING_FORMAT, result: professionalAnalyzer.detectFormat(text) });
  stages.push({ stage: STAGES.DETECTING_DOMAIN, result: professionalAnalyzer.detectDomain(text, opts.fileName, opts.mimeType) });
  const entities = professionalAnalyzer.extractEntities(text);
  stages.push({ stage: STAGES.EXTRACTING_ENTITIES, result: { count: entities.length, piiCount: entities.filter(e => e.pii).length } });
  const structure = professionalAnalyzer.extractStructure(text);
  stages.push({ stage: STAGES.BUILDING_STRUCTURE, result: { headings: structure.headings.length, words: structure.wordCount } });
  const domain = stages[1].result.primary;
  const risks = professionalAnalyzer.assessRisks(text, domain, entities);
  stages.push({ stage: STAGES.ASSESSING_RISKS, result: { count: risks.items.length, severity: risks.severity } });
  const quality = professionalAnalyzer.computeQualityMetrics(text, domain, entities, risks);
  stages.push({ stage: STAGES.COMPUTING_QUALITY, result: { grade: quality.grade, overall: quality.overall } });
  const dimensions = professionalAnalyzer.buildDimensionReport(text, domain, entities, structure);
  stages.push({ stage: STAGES.BUILDING_DIMENSIONS, result: { count: dimensions.length } });
  const riskMapping = professionalAnalyzer.buildRiskMapping(text, domain, entities, risks);
  stages.push({ stage: STAGES.MAPPING_RISKS, result: { coverage: riskMapping.coveragePercent } });
  const autoTags = professionalAnalyzer.generateAutoTags(text, domain, entities, structure);

  const result = {
    ok: true,
    format: stages[0].result,
    domain: stages[1].result,
    entities: entities.map(e => ({
      type: e.type,
      value: e.sensitivity === 'critical' ? (e.redacted ? e.value : e.value.slice(0, 3) + '****') : e.value,
      sensitivity: e.sensitivity,
      pii: e.pii,
    })),
    piiSummary: {
      total: entities.filter(e => e.pii).length,
      critical: entities.filter(e => e.sensitivity === 'critical').length,
      high: entities.filter(e => e.sensitivity === 'high').length,
      medium: entities.filter(e => e.sensitivity === 'medium').length,
      low: entities.filter(e => e.sensitivity === 'low').length,
    },
    structure: {
      headingCount: structure.headings.length,
      hasToc: structure.hasToc,
      paragraphCount: structure.paragraphCount,
      wordCount: structure.wordCount,
      sections: structure.sections.slice(0, 20),
    },
    risks,
    quality,
    dimensions,
    riskMapping,
    autoTags,
    stages,
    metadata: {
      analyzedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startTime,
      pipelineVersion: '3.0.0',
      fileName: opts.fileName || null,
      mimeType: opts.mimeType || null,
    },
  };

  return result;
}

function runMultiDocumentAnalysis(documents, opts = {}) {
  const analyses = documents.map(d => {
    const text = d.text || d.extractedText || d.content || '';
    return runAnalysisPipeline(text, {
      fileName: d.name || d.originalName || d.fileName,
      mimeType: d.mimeType || d.type,
    });
  });
  const crossReport = evidenceEngine.buildCrossAnalysisReport(documents, analyses);
  return {
    ok: true,
    documentCount: documents.length,
    analyses,
    crossAnalysis: crossReport,
    metadata: {
      analyzedAt: new Date().toISOString(),
      pipelineVersion: '3.0.0',
    },
  };
}

function buildAnalysisSystemPrompt(analysis, opts = {}) {
  if (!analysis || !analysis.ok) return '';
  const parts = [];
  parts.push('## ANÁLISIS PROFESIONAL DEL DOCUMENTO');
  parts.push('');
  parts.push(`**Formato:** ${analysis.format}`);
  parts.push(`**Dominio:** ${analysis.domain.primary} (confianza: ${Math.round((analysis.domain.confidence || 0) * 100)}%)`);
  parts.push(`**Calidad:** ${analysis.quality.grade} (${analysis.quality.overall}/100)`);
  parts.push(`**Riesgo:** ${analysis.risks.severity} (${analysis.risks.items.length} factores)`);
  parts.push(`**PII:** ${analysis.piiSummary.total} entidades (${analysis.piiSummary.critical} críticas)`);
  parts.push(`**Estructura:** ${analysis.structure.headingCount} secciones, ${analysis.structure.wordCount} palabras`);
  if (analysis.autoTags.length > 0) {
    parts.push(`**Tags:** ${analysis.autoTags.slice(0, 10).join(', ')}`);
  }
  parts.push('');
  if (analysis.dimensions && analysis.dimensions.length > 0) {
    parts.push('### Dimensiones de Análisis');
    for (const dim of analysis.dimensions.slice(0, 4)) {
      parts.push(`- **${dim.label}** (peso: ${dim.weight}): ${dim.findings.length} hallazgos`);
    }
    parts.push('');
  }
  if (analysis.riskMapping && analysis.riskMapping.uncovered && analysis.riskMapping.uncovered.length > 0) {
    parts.push('### Riesgos No Cubiertos');
    for (const rc of analysis.riskMapping.uncovered.slice(0, 5)) {
      parts.push(`- ⚠️ ${rc.replace(/_/g, ' ')}`);
    }
    parts.push('');
  }
  if (analysis.risks && analysis.risks.items && analysis.risks.items.length > 0) {
    parts.push('### Riesgos Identificados');
    for (const r of analysis.risks.items.slice(0, 5)) {
      parts.push(`- **[${r.severity.toUpperCase()}]** ${r.description}`);
      if (r.recommendation) parts.push(`  → ${r.recommendation}`);
    }
    parts.push('');
  }
  parts.push('### Instrucciones para la Respuesta');
  parts.push('- Responde como un analista profesional del dominio detectado');
  parts.push('- Cita números, fechas y entidades directamente del documento');
  parts.push('- Si detectas inconsistencias, señálalas con evidencia');
  parts.push('- Ofrece recomendaciones accionables específicas al dominio');
  parts.push('- Estructura la respuesta con las dimensiones de análisis identificadas');
  return parts.join('\n');
}

module.exports = {
  runAnalysisPipeline,
  runMultiDocumentAnalysis,
  buildAnalysisSystemPrompt,
  STAGES,
  STAGE_LABELS,
  professionalAnalyzer,
  smartPaste,
  fidelityEngine,
  evidenceEngine,
};
