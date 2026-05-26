'use strict';

const crypto = require('crypto');

function tokenize(text) {
  return (text || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function buildEvidenceChain(documents, analysisResults) {
  if (!Array.isArray(documents) || documents.length < 2) return { chains: [], crossReferences: [] };
  const chains = [];
  const crossReferences = [];
  const docTokens = documents.map(d => tokenize(d.text || d.extractedText || ''));
  for (let i = 0; i < documents.length; i++) {
    for (let j = i + 1; j < documents.length; j++) {
      const sim = jaccard(docTokens[i], docTokens[j]);
      const ai = analysisResults[i] || {};
      const aj = analysisResults[j] || {};
      const sharedEntities = [];
      if (ai.entities && aj.entities) {
        const eSet = new Set(ai.entities.map(e => `${e.type}:${e.value.toLowerCase()}`));
        for (const e of aj.entities) {
          if (eSet.has(`${e.type}:${e.value.toLowerCase()}`)) {
            sharedEntities.push({ type: e.type, value: e.value });
          }
        }
      }
      const contradictions = detectContradictions(ai, aj);
      const complementary = detectComplementary(ai, aj);
      const chain = {
        docA: { id: documents[i].id || `doc-${i}`, name: documents[i].name || documents[i].originalName || `Document ${i + 1}` },
        docB: { id: documents[j].id || `doc-${j}`, name: documents[j].name || documents[j].originalName || `Document ${j + 1}` },
        similarity: Number(sim.toFixed(4)),
        sharedEntities: sharedEntities.slice(0, 15),
        contradictions,
        complementary,
        alignmentScore: computeAlignment(ai, aj, sim),
      };
      chains.push(chain);
      if (sharedEntities.length > 0 || contradictions.length > 0) {
        crossReferences.push({
          from: chain.docA,
          to: chain.docB,
          type: contradictions.length > 0 ? 'contradiction' : sharedEntities.length > 0 ? 'shared_context' : 'weak',
          evidence: sharedEntities.slice(0, 10),
          contradictions: contradictions.slice(0, 5),
        });
      }
    }
  }
  return { chains, crossReferences };
}

function detectContradictions(a, b) {
  const contradictions = [];
  if (!a || !b) return contradictions;
  const aNumbers = extractNumberContext(a);
  const bNumbers = extractNumberContext(b);
  for (const an of aNumbers) {
    for (const bn of bNumbers) {
      if (an.label === bn.label && an.value !== bn.value) {
        contradictions.push({
          type: 'numeric_conflict',
          label: an.label,
          docAValue: an.value,
          docBValue: bn.value,
          severity: Math.abs(parseFloat(an.value.replace(/[^\d.]/g, '') || 0) - parseFloat(bn.value.replace(/[^\d.]/g, '') || 0)) > 100 ? 'high' : 'medium',
        });
      }
    }
  }
  if (a.domain?.primary && b.domain?.primary && a.domain.primary !== b.domain.primary) {
    contradictions.push({
      type: 'domain_conflict',
      label: 'domain',
      docAValue: a.domain.primary,
      docBValue: b.domain.primary,
      severity: 'low',
    });
  }
  return contradictions.slice(0, 10);
}

function extractNumberContext(analysis) {
  if (!analysis || !analysis.entities) return [];
  return analysis.entities
    .filter(e => e.type === 'money' || e.type === 'percentage')
    .map(e => ({ label: e.type, value: e.value }));
}

function detectComplementary(a, b) {
  const complementary = [];
  if (!a || !b) return complementary;
  if (a.domain?.primary !== b.domain?.primary) {
    complementary.push({
      type: 'cross_domain_insight',
      description: `Documento A es "${a.domain?.primary || 'general'}", Documento B es "${b.domain?.primary || 'general'}" — análisis multidisciplinario posible`,
    });
  }
  if (a.risks?.items?.length > 0 && b.risks?.items?.length === 0) {
    complementary.push({
      type: 'risk_asymmetry',
      description: 'Documento A tiene riesgos identificados, Documento B no — verificar si B mitiga riesgos de A',
    });
  }
  return complementary;
}

function computeAlignment(a, b, similarity) {
  let score = similarity * 0.3;
  if (a.domain?.primary === b.domain?.primary) score += 0.2;
  if (a.quality?.grade === b.quality?.grade) score += 0.15;
  const aRisk = a.risks?.overallScore || 100;
  const bRisk = b.risks?.overallScore || 100;
  score += (1 - Math.abs(aRisk - bRisk) / 100) * 0.15;
  if (a.entities && b.entities) {
    const aTypes = new Set(a.entities.map(e => e.type));
    const bTypes = new Set(b.entities.map(e => e.type));
    const overlap = [...aTypes].filter(t => bTypes.has(t)).length;
    const union = new Set([...aTypes, ...bTypes]).size;
    score += (union > 0 ? overlap / union : 0) * 0.2;
  }
  return Number(Math.min(1, score).toFixed(3));
}

function buildCrossAnalysisReport(documents, analysisResults) {
  const evidence = buildEvidenceChain(documents, analysisResults);
  const highContradictions = evidence.chains.filter(c => c.contradictions.length > 0);
  const strongAlignments = evidence.chains.filter(c => c.alignmentScore >= 0.7);
  const synthesis = {
    documentCount: documents.length,
    highRiskPairs: highContradictions.length,
    strongAlignmentPairs: strongAlignments.length,
    overallAssessment: highContradictions.length > 0 ? 'conflicts_detected' : strongAlignments.length > 0 ? 'well_aligned' : 'neutral',
    recommendation: highContradictions.length > 0
      ? `Se detectaron ${highContradictions.length} par(es) de documentos con contradicciones. Verificar las discrepancias antes de tomar decisiones.`
      : strongAlignments.length > 0
        ? 'Los documentos están bien alineados. Se puede proceder con confianza.'
        : 'Los documentos tienen alineación moderada. Considerar verificación adicional.',
  };
  return {
    evidenceChains: evidence.chains,
    crossReferences: evidence.crossReferences,
    synthesis,
    analyzedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildEvidenceChain,
  detectContradictions,
  detectComplementary,
  computeAlignment,
  buildCrossAnalysisReport,
  jaccard,
};
