'use strict';

const crypto = require('crypto');

const DOMAIN_RULES = {
  legal: {
    keywords: ['contrato', 'contract', 'acuerdo', 'agreement', 'clausula', 'clause', 'ley', 'law', 'jurisdiccion', 'jurisdiction', 'demanda', 'litigio', 'arbitraje', 'arbitration', 'indemnizacion', 'indemnity', 'licitacion', 'tender', 'regulacion', 'regulation', 'compliance', 'normativa', 'legislacion', 'legislation', 'tribunal', 'court', 'notarial', 'escritura', 'deed', 'poder', 'power of attorney', 'fiduciario', 'fiduciary', 'arrendamiento', 'lease'],
    analysisDepth: 'exhaustive',
    riskCategories: ['liability', 'termination', 'force_majeure', 'ip_rights', 'confidentiality', 'penalties', 'jurisdiction', 'warranty_disclaimer'],
    extractors: ['obligations', 'parties', 'dates', 'amounts', 'penalties', 'termination_clauses', 'ip_clauses', 'confidentiality_clauses'],
  },
  financial: {
    keywords: ['balance', 'ingreso', 'revenue', 'egreso', 'expense', 'flujo', 'cash flow', 'margen', 'margin', 'rentabilidad', 'profitability', 'depreciacion', 'depreciation', 'amortizacion', 'amortization', 'pasivo', 'liability', 'activo', 'asset', 'patrimonio', 'equity', 'fiscal', 'tributario', 'impuesto', 'tax', 'auditoria', 'audit', 'eeff', 'financial statements', 'cuenta', 'account', 'presupuesto', 'budget', 'roi', 'ebitda', 'nozzle'],
    analysisDepth: 'quantitative',
    riskCategories: ['liquidity', 'solvency', 'market_risk', 'operational_risk', 'credit_risk', 'regulatory_risk'],
    extractors: ['amounts', 'percentages', 'dates', 'accounts', 'ratios', 'trends', 'anomalies'],
  },
  academic: {
    keywords: ['investigacion', 'research', 'hipotesis', 'hypothesis', 'metodologia', 'methodology', 'universidad', 'university', 'tesis', 'thesis', 'doi', 'arxiv', 'peer-reviewed', 'bibliografia', 'bibliography', 'referencia', 'reference', 'abstract', 'marco teorico', 'theoretical framework', 'variables', 'correlacion', 'correlation', 'significancia', 'significance', 'p-valor', 'p-value'],
    analysisDepth: 'critical',
    riskCategories: ['methodological_flaws', 'citation_gaps', 'bias', 'reproducibility', 'statistical_validity'],
    extractors: ['claims', 'evidence', 'citations', 'methodology', 'findings', 'limitations', 'assumptions'],
  },
  medical: {
    keywords: ['paciente', 'patient', 'diagnostico', 'diagnosis', 'tratamiento', 'treatment', 'sintoma', 'symptom', 'medicamento', 'medication', 'dosis', 'dosage', 'clinica', 'clinical', 'laboratorio', 'laboratory', 'patologia', 'pathology', 'pronostico', 'prognosis', 'farmacologia', 'pharmacology', 'ensayo clinico', 'clinical trial', 'contraindicacion', 'contraindication'],
    analysisDepth: 'safety-critical',
    riskCategories: ['dosage_errors', 'contraindications', 'drug_interactions', 'allergies', 'off_label_use', 'missing_consent'],
    extractors: ['dosages', 'diagnoses', 'medications', 'allergies', 'procedures', 'dates', 'lab_values'],
  },
  technical: {
    keywords: ['api', 'endpoint', 'servidor', 'server', 'base de datos', 'database', 'arquitectura', 'architecture', 'deploy', 'configuracion', 'configuration', 'protocolo', 'protocol', 'latencia', 'latency', 'throughput', 'escalabilidad', 'scalability', 'microservicio', 'microservice', 'docker', 'kubernetes', 'ci/cd', 'pipeline', 'repository', 'framework'],
    analysisDepth: 'structural',
    riskCategories: ['security_vulnerabilities', 'performance_bottlenecks', 'dependency_risks', 'scalability_limits', 'single_points_of_failure'],
    extractors: ['components', 'interfaces', 'dependencies', 'configs', 'endpoints', 'metrics', 'error_handling'],
  },
  business: {
    keywords: ['estrategia', 'strategy', 'kpi', 'okr', 'mercado', 'market', 'competidor', 'competitor', 'cliente', 'customer', 'ventas', 'sales', 'marketing', 'operaciones', 'operations', 'supply chain', 'cadena de suministro', 'stakeholder', 'roadmap', 'pivot', 'mvp', 'churn', 'retention'],
    analysisDepth: 'strategic',
    riskCategories: ['market_risk', 'competitive_threat', 'operational_gap', 'resource_constraint', 'regulatory_change'],
    extractors: ['kpis', 'milestones', 'stakeholders', 'budgets', 'timelines', 'risks', 'dependencies'],
  },
};

// Pre-compile the per-keyword word-boundary regexes once at module load.
// detectDomain() used to rebuild ~180 RegExp objects on every call (6 domains
// × ~30 keywords), and it runs on every computeQualityMetrics() — an avoidable
// O(keywords) allocation per call. The regexes are reused via String.match(),
// which ignores/resets lastIndex, so sharing them across calls is safe.
const COMPILED_DOMAIN_KEYWORDS = Object.fromEntries(
  Object.entries(DOMAIN_RULES).map(([domain, rules]) => [
    domain,
    rules.keywords.map((kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')),
  ]),
);

const ENTITY_PATTERNS = [
  { type: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, sensitivity: 'high' },
  { type: 'phone', pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g, sensitivity: 'medium' },
  { type: 'url', pattern: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g, sensitivity: 'low' },
  { type: 'date', pattern: /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b/g, sensitivity: 'low' },
  { type: 'money', pattern: /[\$€£¥]\s?[\d,]+(?:\.\d{1,2})?|\b\d+(?:,\d{3})*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|MXN|COP|ARS|CLP|PEN|BRL)\b/gi, sensitivity: 'medium' },
  { type: 'percentage', pattern: /\b\d+(?:\.\d+)?%/g, sensitivity: 'low' },
  { type: 'ip_address', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, sensitivity: 'high' },
  { type: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, sensitivity: 'critical' },
  { type: 'credit_card', pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, sensitivity: 'critical' },
  { type: 'doi', pattern: /\b10\.\d{4,9}\/[^\s]+\b/g, sensitivity: 'low' },
  { type: 'iban', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g, sensitivity: 'critical' },
];

const METRIC_THRESHOLDS = {
  readability: { min: 0, max: 100, weight: 0.15 },
  completeness: { min: 0, max: 100, weight: 0.20 },
  coherence: { min: 0, max: 100, weight: 0.15 },
  domainRelevance: { min: 0, max: 100, weight: 0.20 },
  riskScore: { min: 0, max: 100, weight: 0.15 },
  informationDensity: { min: 0, max: 100, weight: 0.15 },
};

function detectDomain(text, fileName, mimeType) {
  const combined = `${text || ''} ${fileName || ''}`.toLowerCase();
  const scores = {};

  for (const domain of Object.keys(DOMAIN_RULES)) {
    let score = 0;
    for (const regex of COMPILED_DOMAIN_KEYWORDS[domain]) {
      const matches = combined.match(regex);
      if (matches) score += matches.length;
    }
    scores[domain] = score;
  }

  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const topDomain = sorted[0]?.[1] > 0 ? sorted[0][0] : 'general';
  const topScore = sorted[0]?.[1] || 0;
  const secondDomain = sorted[1]?.[1] > 0 ? sorted[1][0] : null;

  return {
    primary: topDomain,
    secondary: secondDomain,
    confidence: Math.min(topScore / 10, 1),
    scores,
  };
}

function extractEntities(text) {
  if (!text || typeof text !== 'string') return [];

  const entities = [];
  for (const { type, pattern, sensitivity } of ENTITY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      entities.push({
        type,
        value: match[0],
        index: match.index,
        sensitivity,
        redacted: sensitivity === 'critical' ? redactValue(match[0]) : null,
      });
    }
  }

  return entities.sort((a, b) => a.index - b.index);
}

function redactValue(value) {
  if (value.length <= 4) return '****';
  return value.slice(0, 2) + '*'.repeat(Math.min(value.length - 4, 8)) + value.slice(-2);
}

function extractKeyPhrases(text, domain) {
  if (!text || typeof text !== 'string') return [];

  const sentences = text.split(/[.!?\n]+/).filter(s => s.trim().length > 20);
  const phrases = [];

  for (const sentence of sentences.slice(0, 50)) {
    const trimmed = sentence.trim();
    const words = trimmed.split(/\s+/);
    if (words.length >= 3 && words.length <= 15) {
      phrases.push({
        text: trimmed,
        wordCount: words.length,
        domainRelevant: isDomainRelevant(trimmed, domain),
      });
    }
  }

  return phrases.sort((a, b) => {
    const aScore = a.domainRelevant ? 1 : 0;
    const bScore = b.domainRelevant ? 1 : 0;
    return bScore - aScore;
  }).slice(0, 30);
}

function isDomainRelevant(text, domain) {
  if (!domain || domain === 'general') return false;
  const rules = DOMAIN_RULES[domain];
  if (!rules) return false;
  const lower = text.toLowerCase();
  return rules.keywords.some(kw => lower.includes(kw.toLowerCase()));
}

function assessRisks(text, domain, entities) {
  const risks = [];
  const rules = DOMAIN_RULES[domain] || DOMAIN_RULES.business;

  const criticalEntities = entities.filter(e => e.sensitivity === 'critical');
  if (criticalEntities.length > 0) {
    risks.push({
      category: 'data_exposure',
      severity: 'critical',
      description: `Document contains ${criticalEntities.length} sensitive data point(s): ${criticalEntities.map(e => e.type).join(', ')}`,
      recommendation: 'Apply data masking before sharing. Consider encryption at rest.',
    });
  }

  const highSensitivity = entities.filter(e => e.sensitivity === 'high');
  if (highSensitivity.length > 3) {
    risks.push({
      category: 'pii_density',
      severity: 'high',
      description: `High density of personally identifiable information (${highSensitivity.length} instances)`,
      recommendation: 'Review GDPR/privacy compliance requirements.',
    });
  }

  if (domain === 'legal') {
    const hasTermination = /\b(terminaci[oó]n|resoluci[oó]n|termination|resoluti)\b/i.test(text);
    const hasPenalty = /\b(multa|penalty|sanci[oó]n|sanction|indemnizaci[oó]n|liquidated damages)\b/i.test(text);
    if (!hasTermination) {
      risks.push({
        category: 'missing_termination_clause',
        severity: 'medium',
        description: 'No termination clause detected in legal document',
        recommendation: 'Add explicit termination conditions and notice periods.',
      });
    }
    if (hasPenalty) {
      risks.push({
        category: 'penalty_exposure',
        severity: 'high',
        description: 'Penalty/indemnity clauses detected — review financial exposure',
        recommendation: 'Quantify maximum liability exposure and ensure it aligns with risk appetite.',
      });
    }
  }

  if (domain === 'financial') {
    const moneyEntities = entities.filter(e => e.type === 'money');
    const percentageEntities = entities.filter(e => e.type === 'percentage');
    if (moneyEntities.length > 0) {
      risks.push({
        category: 'financial_amounts',
        severity: 'medium',
        description: `${moneyEntities.length} monetary amounts detected — verify consistency`,
        recommendation: 'Cross-reference amounts against source documents for discrepancies.',
      });
    }
    if (percentageEntities.length > 5) {
      risks.push({
        category: 'rate_complexity',
        severity: 'low',
        description: 'Multiple percentage rates detected — verify calculations',
        recommendation: 'Ensure compound rates and effective rates are correctly stated.',
      });
    }
  }

  if (domain === 'medical') {
    const dosageEntities = entities.filter(e => e.type === 'dosage' || /\b(mg|ml|mcg|IU)\b/i.test(e.value));
    risks.push({
      category: 'dosage_verification',
      severity: 'high',
      description: 'Medical document detected — verify all dosages and contraindications',
      recommendation: 'Cross-check dosages against standard references. Verify patient allergies.',
    });
  }

  if (domain === 'technical') {
    const ipEntities = entities.filter(e => e.type === 'ip_address');
    if (ipEntities.length > 0) {
      risks.push({
        category: 'infrastructure_exposure',
        severity: 'high',
        description: `${ipEntities.length} IP address(es) found — potential security exposure`,
        recommendation: 'Remove internal IPs before external distribution. Use hostnames instead.',
      });
    }
  }

  const overallScore = risks.reduce((acc, r) => {
    const weight = { critical: 25, high: 15, medium: 8, low: 3 }[r.severity] || 5;
    return acc + weight;
  }, 0);

  return {
    items: risks,
    overallScore: Math.min(overallScore, 100),
    severity: risks.some(r => r.severity === 'critical') ? 'critical'
      : risks.some(r => r.severity === 'high') ? 'high'
      : risks.some(r => r.severity === 'medium') ? 'medium' : 'low',
  };
}

function computeQualityMetrics(text, domain, entities, risks) {
  const charCount = (text || '').length;
  const wordCount = (text || '').split(/\s+/).filter(Boolean).length;
  const sentenceCount = (text || '').split(/[.!?]+/).filter(s => s.trim()).length;
  const paragraphCount = (text || '').split(/\n\s*\n/).filter(s => s.trim()).length;

  const avgSentenceLength = sentenceCount > 0 ? wordCount / sentenceCount : 0;
  const readability = Math.max(0, Math.min(100, 100 - (avgSentenceLength - 15) * 3));

  const hasStructure = /^(#{1,6}\s|[-*]\s|\d+\.\s)/m.test(text);
  const completeness = Math.min(100, Math.round(
    (hasStructure ? 20 : 0) +
    (paragraphCount > 1 ? 20 : 0) +
    (wordCount > 100 ? 20 : 0) +
    (sentenceCount > 5 ? 20 : 0) +
    (entities.length > 0 ? 20 : 0)
  ));

  const hasTransitions = /\b(sin embargo|however|además|furthermore|por lo tanto|therefore|en conclusión|in conclusion|no obstante|nevertheless)\b/i.test(text);
  const coherence = Math.min(100, Math.round(
    (hasTransitions ? 30 : 0) +
    (paragraphCount > 2 ? 30 : 0) +
    (avgSentenceLength > 8 && avgSentenceLength < 25 ? 40 : 20)
  ));

  const domainDetection = detectDomain(text, '', '');
  const domainRelevance = Math.round(domainDetection.confidence * 100);

  const riskScore = risks?.overallScore || 0;

  const uniqueWords = new Set((text || '').toLowerCase().split(/\s+/).filter(Boolean));
  const informationDensity = wordCount > 0 ? Math.min(100, Math.round((uniqueWords.size / wordCount) * 150)) : 0;

  const metrics = {
    readability,
    completeness,
    coherence,
    domainRelevance,
    riskScore,
    informationDensity,
  };

  const overall = Object.entries(METRIC_THRESHOLDS).reduce((acc, [key, config]) => {
    return acc + (metrics[key] || 0) * config.weight;
  }, 0);

  return {
    individual: metrics,
    overall: Math.round(overall),
    grade: overall >= 80 ? 'A' : overall >= 60 ? 'B' : overall >= 40 ? 'C' : overall >= 20 ? 'D' : 'F',
    wordCount,
    charCount,
    sentenceCount,
    paragraphCount,
    uniqueWordCount: uniqueWords.size,
  };
}

function extractStructure(text) {
  if (!text || typeof text !== 'string') return { sections: [], hasToc: false, headingCount: 0 };

  const lines = text.split('\n');
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    const mdHeading = line.match(/^(#{1,6})\s+(.+)/);
    const numberedHeading = line.match(/^(\d+(?:\.\d+)*)[.)]\s+([\w].*)/);

    if (mdHeading) {
      currentSection = {
        level: mdHeading[1].length,
        title: mdHeading[2].trim(),
        type: 'markdown',
      };
      sections.push(currentSection);
    } else if (numberedHeading && numberedHeading[1].split('.').length <= 3) {
      currentSection = {
        level: numberedHeading[1].split('.').length,
        title: numberedHeading[2].trim(),
        number: numberedHeading[1],
        type: 'numbered',
      };
      sections.push(currentSection);
    }
  }

  const hasToc = sections.length > 0 && sections.length >= 3;

  return {
    sections,
    hasToc,
    headingCount: sections.length,
    maxDepth: sections.reduce((max, s) => Math.max(max, s.level), 0),
  };
}

async function analyzeDeep(text, opts = {}) {
  const fileName = opts.fileName || '';
  const mimeType = opts.mimeType || '';
  const userId = opts.userId || null;

  const domain = detectDomain(text, fileName, mimeType);
  const entities = extractEntities(text);
  const structure = extractStructure(text);
  const keyPhrases = extractKeyPhrases(text, domain.primary);
  const risks = assessRisks(text, domain.primary, entities);
  const quality = computeQualityMetrics(text, domain.primary, entities, risks);

  const rules = DOMAIN_RULES[domain.primary];
  const applicableExtractors = rules?.extractors || [];

  const piiSummary = {
    total: entities.length,
    critical: entities.filter(e => e.sensitivity === 'critical').length,
    high: entities.filter(e => e.sensitivity === 'high').length,
    medium: entities.filter(e => e.sensitivity === 'medium').length,
    low: entities.filter(e => e.sensitivity === 'low').length,
    types: [...new Set(entities.map(e => e.type))],
  };

  const autoTags = generateAutoTags(text, domain, entities, keyPhrases);

  const summary = buildAnalysisSummary(domain, quality, risks, piiSummary, structure);

  return {
    domain,
    entities: entities.map(e => ({
      type: e.type,
      value: e.sensitivity === 'critical' ? e.redacted : e.value,
      sensitivity: e.sensitivity,
    })),
    piiSummary,
    structure,
    keyPhrases: keyPhrases.slice(0, 15),
    risks,
    quality,
    applicableExtractors,
    autoTags,
    summary,
    analyzedAt: new Date().toISOString(),
    version: '2.0.0',
  };
}

function generateAutoTags(text, domain, entities, keyPhrases) {
  const tags = new Set();

  tags.add(domain.primary);
  if (domain.secondary) tags.add(domain.secondary);

  const entityTypes = [...new Set(entities.map(e => e.type))];
  for (const et of entityTypes) {
    tags.add(`entity:${et}`);
  }

  const topPhrases = keyPhrases
    .filter(p => p.domainRelevant)
    .slice(0, 5)
    .map(p => p.text.split(/\s+/).slice(0, 3).join(' ').toLowerCase());
  for (const phrase of topPhrases) {
    tags.add(phrase);
  }

  return [...tags].slice(0, 20);
}

function buildAnalysisSummary(domain, quality, risks, pii, structure) {
  const parts = [];

  parts.push(`Domain: ${domain.primary}${domain.secondary ? `/${domain.secondary}` : ''} (confidence: ${Math.round(domain.confidence * 100)}%)`);
  parts.push(`Quality: ${quality.grade} (${quality.overall}/100) — ${quality.wordCount} words, ${structure.headingCount} sections`);
  parts.push(`Risk: ${risks.severity} (${risks.overallScore}/100) — ${risks.items.length} risk factor(s)`);
  parts.push(`PII: ${pii.total} entities (${pii.critical} critical, ${pii.high} high)`);

  if (risks.items.length > 0) {
    const topRisk = risks.items[0];
    parts.push(`Top risk: [${topRisk.severity}] ${topRisk.category} — ${topRisk.description}`);
  }

  return parts.join('\n');
}

module.exports = {
  analyzeDeep,
  detectDomain,
  extractEntities,
  extractStructure,
  extractKeyPhrases,
  assessRisks,
  computeQualityMetrics,
  generateAutoTags,
  buildAnalysisSummary,
  DOMAIN_RULES,
  ENTITY_PATTERNS,
};
