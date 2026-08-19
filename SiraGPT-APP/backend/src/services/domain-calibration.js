'use strict';

/**
 * domain-calibration.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-domain calibration of attribution thresholds. Different domains
 * have different cost-of-error profiles:
 *
 *   • Legal / Medical / Financial:
 *       Strict faithfulness — a single hallucinated number can cost
 *       real money or legal liability. Higher accept threshold, lower
 *       novelty tolerance, mandatory citation coverage.
 *   • Code / Engineering:
 *       Higher novelty tolerance (we want the model to *write* new
 *       code), but plan-step coverage matters because skipped steps
 *       leave broken implementations.
 *   • Creative / Marketing:
 *       Lowest accept threshold; novelty is the *point*. Citation
 *       coverage less important.
 *   • Research / Academic:
 *       Very strict citation coverage and groundedness; tolerates
 *       longer responses.
 *
 * The module exposes per-domain thresholds for the modules already
 * built (faithfulness-scorer, self-reflection-loop, anomaly-detector,
 * cross-modal-attribution, prompt-budget-allocator). Detection is
 * heuristic — it inspects the prompt + history for domain markers and
 * returns the best-fit domain name; callers then lookup the calibrated
 * thresholds.
 *
 * Public API:
 *   detectDomain(text, opts?)              → DomainHit
 *   getCalibration(domain)                 → Calibration
 *   getCalibrationFor(text)                → Calibration   (convenience)
 *   listDomains()                          → Domain[]
 *   buildCalibrationBlock(domain, opts?)   → string         (prompt hint)
 */

const DOMAIN_KEYWORDS = Object.freeze({
  legal: ['contract', 'contrato', 'nda', 'clause', 'cláusula', 'liability', 'msa', 'sla', 'compliance', 'gdpr', 'hipaa', 'ccpa', 'patent', 'trademark', 'jurisdiction', 'jurisdicción', 'license', 'governing law', 'plaintiff', 'demandante', 'court', 'tribunal'],
  medical: ['diagnosis', 'diagnóstico', 'symptom', 'síntoma', 'treatment', 'tratamiento', 'dosage', 'dosis', 'patient', 'paciente', 'clinical', 'clínico', 'mg', 'mcg', 'icu', 'er', 'pathology', 'patología', 'pharma'],
  financial: ['revenue', 'ingresos', 'profit', 'utilidad', 'margin', 'margen', 'budget', 'presupuesto', 'invoice', 'factura', 'tax', 'impuesto', 'gaap', 'ifrs', 'pnl', 'p&l', 'audit', 'auditoría', 'arr', 'mrr', 'cogs', 'capex', 'opex', 'ebitda'],
  code: ['function', 'función', 'class', 'clase', 'method', 'método', 'variable', 'method', 'api', 'endpoint', 'controller', 'controlador', 'middleware', 'database', 'base de datos', 'query', 'consulta', 'react', 'vue', 'node', 'python', 'typescript', 'docker', 'kubernetes', 'commit', 'pull request', 'pr', 'merge', 'branch', 'rama'],
  research: ['hypothesis', 'hipótesis', 'thesis', 'tesis', 'literature review', 'revisión de literatura', 'methodology', 'metodología', 'p-value', 'significance', 'significancia', 'cohort', 'control group', 'sample size', 'experiment', 'experimento', 'arxiv', 'doi', 'citation', 'cita', 'preprint', 'meta-analysis'],
  creative: ['poem', 'poema', 'story', 'historia', 'novel', 'novela', 'song', 'canción', 'lyric', 'letra', 'creative', 'creativo', 'fiction', 'ficción', 'verse', 'verso', 'metaphor', 'metáfora', 'tone', 'tono', 'mood', 'ambiente', 'narrative', 'narrativa'],
  marketing: ['campaign', 'campaña', 'audience', 'audiencia', 'brand', 'marca', 'positioning', 'posicionamiento', 'cta', 'call to action', 'landing page', 'seo', 'cpc', 'cpm', 'funnel', 'embudo', 'persona', 'lead', 'cliente potencial'],
});

const DOMAIN_CALIBRATIONS = Object.freeze({
  legal: {
    domain: 'legal',
    label: 'Legal / Compliance',
    faithfulnessAcceptThreshold: 0.85,
    faithfulnessSoftThreshold: 0.70,
    reflectionMaxRetries: 3,
    anomalyZThreshold: 1.5,
    citationCoverageMin: 0.80,
    noveltyMax: 0.25,
    requireCitation: true,
    promptBudgetTokens: 16_000,
    notes: 'Cita siempre la cláusula / fuente. Evita interpretaciones sin respaldo.',
  },
  medical: {
    domain: 'medical',
    label: 'Medical / Clinical',
    faithfulnessAcceptThreshold: 0.85,
    faithfulnessSoftThreshold: 0.70,
    reflectionMaxRetries: 3,
    anomalyZThreshold: 1.5,
    citationCoverageMin: 0.75,
    noveltyMax: 0.25,
    requireCitation: true,
    promptBudgetTokens: 14_000,
    notes: 'Información médica: cita guías oficiales, no diagnostiques sin contexto clínico.',
  },
  financial: {
    domain: 'financial',
    label: 'Financial / Accounting',
    faithfulnessAcceptThreshold: 0.80,
    faithfulnessSoftThreshold: 0.65,
    reflectionMaxRetries: 2,
    anomalyZThreshold: 1.8,
    citationCoverageMin: 0.70,
    noveltyMax: 0.30,
    requireCitation: true,
    promptBudgetTokens: 14_000,
    notes: 'No alucines cifras. Identifica fuentes (informe anual, factura, libro).',
  },
  research: {
    domain: 'research',
    label: 'Research / Academic',
    faithfulnessAcceptThreshold: 0.80,
    faithfulnessSoftThreshold: 0.65,
    reflectionMaxRetries: 3,
    anomalyZThreshold: 1.8,
    citationCoverageMin: 0.85,
    noveltyMax: 0.30,
    requireCitation: true,
    promptBudgetTokens: 18_000,
    notes: 'Cita papers con DOI / arXiv ID cuando sea posible.',
  },
  code: {
    domain: 'code',
    label: 'Code / Engineering',
    faithfulnessAcceptThreshold: 0.60,
    faithfulnessSoftThreshold: 0.45,
    reflectionMaxRetries: 2,
    anomalyZThreshold: 2.2,
    citationCoverageMin: 0.30,
    noveltyMax: 0.65,
    requireCitation: false,
    promptBudgetTokens: 16_000,
    notes: 'Novedad alta permitida (generar código). Plan-step coverage estricto.',
  },
  marketing: {
    domain: 'marketing',
    label: 'Marketing / Brand',
    faithfulnessAcceptThreshold: 0.55,
    faithfulnessSoftThreshold: 0.40,
    reflectionMaxRetries: 1,
    anomalyZThreshold: 2.5,
    citationCoverageMin: 0.20,
    noveltyMax: 0.75,
    requireCitation: false,
    promptBudgetTokens: 10_000,
    notes: 'Tono y voz importan; cita métricas cuando aparezcan.',
  },
  creative: {
    domain: 'creative',
    label: 'Creative / Narrative',
    faithfulnessAcceptThreshold: 0.45,
    faithfulnessSoftThreshold: 0.30,
    reflectionMaxRetries: 1,
    anomalyZThreshold: 3.0,
    citationCoverageMin: 0.10,
    noveltyMax: 0.85,
    requireCitation: false,
    promptBudgetTokens: 10_000,
    notes: 'Novedad alta; la creatividad es el objetivo. No cites a menos que se pida.',
  },
  general: {
    domain: 'general',
    label: 'General',
    faithfulnessAcceptThreshold: 0.65,
    faithfulnessSoftThreshold: 0.45,
    reflectionMaxRetries: 2,
    anomalyZThreshold: 2.0,
    citationCoverageMin: 0.40,
    noveltyMax: 0.55,
    requireCitation: false,
    promptBudgetTokens: 12_000,
    notes: 'Calibración por defecto para conversación general.',
  },
});

function detectDomain(text, opts = {}) {
  if (!text || typeof text !== 'string') return { domain: 'general', confidence: 0, evidence: [] };
  const lower = text.toLowerCase();
  const scores = {};
  const evidence = {};
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let hits = 0;
    const matched = [];
    for (const kw of keywords) {
      // boundary-aware contains — scan ALL occurrences, not just the first: a
      // decoy substring (e.g. "syntax" for "tax") at the first position used to
      // fail the boundary check and skip the keyword entirely, dropping a real
      // standalone hit later in the text.
      let from = 0;
      let idx;
      let found = false;
      while ((idx = lower.indexOf(kw, from)) !== -1) {
        const before = idx === 0 ? ' ' : lower[idx - 1];
        const after = lower[idx + kw.length] || ' ';
        if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) { found = true; break; }
        from = idx + kw.length;
      }
      if (found) { hits += 1; matched.push(kw); }
    }
    if (hits > 0) {
      scores[domain] = hits;
      evidence[domain] = matched.slice(0, 6);
    }
  }
  const entries = Object.entries(scores);
  if (entries.length === 0) return { domain: 'general', confidence: 0, evidence: [] };
  entries.sort((a, b) => b[1] - a[1]);
  const [top, topHits] = entries[0];
  const runnerUp = entries[1] ? entries[1][1] : 0;
  const minHits = Math.max(1, Number(opts.minHits) || 2);
  if (topHits < minHits) {
    return { domain: 'general', confidence: 0.3, evidence: evidence[top] || [] };
  }
  // confidence = clear-margin / total-hits, capped at 0.99
  const total = entries.reduce((acc, [, v]) => acc + v, 0);
  const margin = (topHits - runnerUp) / Math.max(1, total);
  const confidence = Math.min(0.99, 0.5 + margin);
  return { domain: top, confidence: Number(confidence.toFixed(3)), evidence: evidence[top] };
}

function getCalibration(domain) {
  const key = String(domain || '').toLowerCase();
  return DOMAIN_CALIBRATIONS[key] || DOMAIN_CALIBRATIONS.general;
}

function getCalibrationFor(text, opts = {}) {
  const hit = detectDomain(text, opts);
  const calibration = getCalibration(hit.domain);
  return { ...calibration, detected: hit };
}

function listDomains() {
  return Object.values(DOMAIN_CALIBRATIONS).map((c) => ({
    domain: c.domain,
    label: c.label,
    requireCitation: c.requireCitation,
    faithfulnessAcceptThreshold: c.faithfulnessAcceptThreshold,
    noveltyMax: c.noveltyMax,
  }));
}

function buildCalibrationBlock(domain, opts = {}) {
  const cal = getCalibration(domain);
  if (!cal) return '';
  const lines = ['\n\n<domain_calibration>'];
  lines.push(`Dominio detectado: ${cal.label} (faithfulness ≥ ${cal.faithfulnessAcceptThreshold}, novelty ≤ ${cal.noveltyMax}, cita ${cal.requireCitation ? 'REQUERIDA' : 'opcional'}).`);
  if (cal.notes) lines.push(`Nota: ${cal.notes}`);
  lines.push('</domain_calibration>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 600;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  detectDomain,
  getCalibration,
  getCalibrationFor,
  listDomains,
  buildCalibrationBlock,
  DOMAIN_KEYWORDS,
  DOMAIN_CALIBRATIONS,
};
