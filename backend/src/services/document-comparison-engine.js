'use strict';

const crypto = require('crypto');

function compareDocuments(documents, opts = {}) {
  if (!Array.isArray(documents) || documents.length < 2) {
    return { ok: false, error: 'At least two documents required' };
  }

  const focus = opts.query || opts.focus || '';
  const focusTerms = focus.toLowerCase().split(/\s+/).filter(Boolean);

  const analyses = documents.map(doc => ({
    id: doc.id || doc.fileId,
    name: doc.name || doc.originalName || 'Document',
    text: doc.text || doc.extractedText || '',
    mimeType: doc.mimeType || '',
    entities: doc.entities || [],
    domain: doc.domain || 'general',
    quality: doc.quality || {},
    structure: doc.structure || {},
    risks: doc.risks || {},
  }));

  const sharedEntities = findSharedEntities(analyses);
  const contradictions = findContradictions(analyses, focusTerms);
  const complementary = findComplementary(analyses);
  const differences = findStructuralDifferences(analyses);
  const crossReferences = findCrossReferences(analyses);
  const alignmentScore = computeAlignment(analyses);

  const comparisonMatrix = buildComparisonMatrix(analyses, focusTerms);

  const synthesis = buildSynthesis(analyses, {
    sharedEntities,
    contradictions,
    complementary,
    alignmentScore,
  });

  return {
    ok: true,
    documentCount: analyses.length,
    documents: analyses.map(a => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      qualityGrade: a.quality?.grade || 'N/A',
      riskLevel: a.risks?.severity || 'unknown',
    })),
    sharedEntities,
    contradictions,
    complementary,
    differences,
    crossReferences,
    alignmentScore,
    comparisonMatrix,
    synthesis,
  };
}

function findSharedEntities(analyses) {
  const entityMap = new Map();

  for (const doc of analyses) {
    const docEntities = (doc.entities || []).map(e =>
      typeof e === 'object' ? { type: e.type, value: e.value || e.redacted } : { type: 'unknown', value: String(e) }
    );
    for (const ent of docEntities) {
      const key = `${ent.type}::${String(ent.value).toLowerCase()}`;
      if (!entityMap.has(key)) {
        entityMap.set(key, { type: ent.type, value: ent.value, documents: [] });
      }
      entityMap.get(key).documents.push(doc.id || doc.name);
    }
  }

  return [...entityMap.values()]
    .filter(e => e.documents.length >= 2 && new Set(e.documents).size >= 2)
    .map(e => ({
      type: e.type,
      value: e.value,
      documentCount: new Set(e.documents).size,
      documents: [...new Set(e.documents)],
    }))
    .sort((a, b) => b.documentCount - a.documentCount)
    .slice(0, 30);
}

function findContradictions(analyses, focusTerms) {
  const contradictions = [];

  const moneyEntities = analyses.flatMap(doc =>
    (doc.entities || [])
      .filter(e => e.type === 'money')
      .map(e => ({ docId: doc.id, docName: doc.name, value: e.value }))
  );

  const moneyByContext = new Map();
  for (const me of moneyEntities) {
    const normalized = String(me.value).replace(/[,\s]/g, '').toLowerCase();
    if (!moneyByContext.has(normalized)) moneyByContext.set(normalized, []);
    moneyByContext.get(normalized).push(me);
  }

  const numericValues = analyses.flatMap(doc => {
    const matches = (doc.text || '').matchAll(/\$?([\d,]+(?:\.\d{1,2})?)\s*(?:USD|EUR|MXN|COP|ARS|GBP)?/gi);
    return [...matches].map(m => ({
      docId: doc.id,
      docName: doc.name,
      raw: m[0],
      numeric: parseFloat(m[1].replace(/,/g, '')),
    }));
  });

  const dateEntities = analyses.flatMap(doc =>
    (doc.entities || [])
      .filter(e => e.type === 'date')
      .map(e => ({ docId: doc.id, docName: doc.name, value: e.value }))
  );

  const sameFactDifferentValues = [];
  for (const [key, entries] of moneyByContext) {
    if (entries.length > 1) {
      const uniqueDocs = new Set(entries.map(e => e.docId));
      if (uniqueDocs.size > 1) {
        sameFactDifferentValues.push({
          type: 'monetary_discrepancy',
          description: `Different monetary references for similar amounts across documents`,
          documents: entries.map(e => ({ docId: e.docId, docName: e.docName, value: e.value })),
          severity: 'high',
        });
      }
    }
  }

  contradictions.push(...sameFactDifferentValues);

  for (const ft of focusTerms) {
    const mentionsPerDoc = analyses.map(doc => {
      const regex = new RegExp(ft.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const count = (doc.text.match(regex) || []).length;
      return { docId: doc.id, docName: doc.name, count };
    });

    const withMentions = mentionsPerDoc.filter(m => m.count > 0);
    const withoutMentions = mentionsPerDoc.filter(m => m.count === 0);

    if (withMentions.length > 0 && withoutMentions.length > 0) {
      contradictions.push({
        type: 'coverage_gap',
        description: `"${ft}" is mentioned in ${withMentions.length} document(s) but absent from ${withoutMentions.length}`,
        present: withMentions,
        absent: withoutMentions,
        severity: 'medium',
      });
    }
  }

  return contradictions.slice(0, 20);
}

function findComplementary(analyses) {
  const complementary = [];
  const domains = new Set(analyses.map(a => a.domain));

  if (domains.size > 1) {
    complementary.push({
      type: 'cross_domain',
      description: `Documents span ${domains.size} domains: ${[...domains].join(', ')}`,
      domains: [...domains],
      insight: 'Cross-domain analysis may reveal connections not visible within a single domain',
    });
  }

  const entityTypes = new Map();
  for (const doc of analyses) {
    for (const ent of (doc.entities || [])) {
      const type = ent.type;
      if (!entityTypes.has(type)) entityTypes.set(type, new Set());
      entityTypes.get(type).add(doc.id || doc.name);
    }
  }

  const typesInMultipleDocs = [...entityTypes.entries()]
    .filter(([_, docs]) => docs.size >= 2)
    .map(([type, docs]) => ({ type, documentCount: docs.size }));

  if (typesInMultipleDocs.length > 0) {
    complementary.push({
      type: 'entity_overlap',
      description: `${typesInMultipleDocs.length} entity type(s) appear across multiple documents`,
      entityTypes: typesInMultipleDocs,
      insight: 'Shared entity types enable cross-referencing and verification',
    });
  }

  return complementary;
}

function findStructuralDifferences(analyses) {
  return analyses.map(doc => ({
    id: doc.id,
    name: doc.name,
    headingCount: doc.structure?.headingCount || 0,
    hasToc: doc.structure?.hasToc || false,
    wordCount: doc.quality?.wordCount || 0,
    grade: doc.quality?.grade || 'N/A',
    riskSeverity: doc.risks?.severity || 'unknown',
  }));
}

function findCrossReferences(analyses) {
  const refs = [];

  for (let i = 0; i < analyses.length; i++) {
    for (let j = i + 1; j < analyses.length; j++) {
      const docA = analyses[i];
      const docB = analyses[j];

      const sentencesA = (docA.text || '').split(/[.!?\n]+/).filter(s => s.trim().length > 20);
      const sentencesB = (docB.text || '').split(/[.!?\n]+/).filter(s => s.trim().length > 20);

      let overlap = 0;
      for (const sA of sentencesA.slice(0, 30)) {
        const wordsA = new Set(sA.toLowerCase().split(/\s+/).filter(w => w.length > 4));
        for (const sB of sentencesB.slice(0, 30)) {
          const wordsB = new Set(sB.toLowerCase().split(/\s+/).filter(w => w.length > 4));
          const intersection = [...wordsA].filter(w => wordsB.has(w));
          if (intersection.length >= 3) overlap++;
        }
      }

      if (overlap > 0) {
        refs.push({
          docA: docA.id || docA.name,
          docB: docB.id || docB.name,
          overlapScore: overlap,
          relationship: overlap >= 5 ? 'highly_related' : overlap >= 2 ? 'partially_related' : 'loosely_related',
        });
      }
    }
  }

  return refs.sort((a, b) => b.overlapScore - a.overlapScore).slice(0, 15);
}

function computeAlignment(analyses) {
  if (analyses.length < 2) return 1;

  let totalScore = 0;
  let comparisons = 0;

  for (let i = 0; i < analyses.length; i++) {
    for (let j = i + 1; j < analyses.length; j++) {
      const domainMatch = analyses[i].domain === analyses[j].domain ? 0.3 : 0;
      const qualityRange = Math.abs(
        (analyses[i].quality?.overall || 50) - (analyses[j].quality?.overall || 50)
      );
      const qualityScore = Math.max(0, 1 - qualityRange / 100) * 0.3;
      const riskAlignment = (analyses[i].risks?.severity || 'low') === (analyses[j].risks?.severity || 'low') ? 0.2 : 0.1;
      const structureSimilarity = Math.abs(
        (analyses[i].structure?.headingCount || 0) - (analyses[j].structure?.headingCount || 0)
      );
      const structureScore = Math.max(0, 1 - structureSimilarity / 20) * 0.2;

      totalScore += domainMatch + qualityScore + riskAlignment + structureScore;
      comparisons++;
    }
  }

  return comparisons > 0 ? Math.round((totalScore / comparisons) * 100) / 100 : 0;
}

function buildComparisonMatrix(analyses, focusTerms) {
  const dimensions = ['domain', 'quality', 'risk', 'structure', 'length'];
  const matrix = [];

  for (const dim of dimensions) {
    const row = { dimension: dim, values: {} };
    for (const doc of analyses) {
      switch (dim) {
        case 'domain': row.values[doc.id || doc.name] = doc.domain; break;
        case 'quality': row.values[doc.id || doc.name] = doc.quality?.grade || 'N/A'; break;
        case 'risk': row.values[doc.id || doc.name] = doc.risks?.severity || 'unknown'; break;
        case 'structure': row.values[doc.id || doc.name] = `${doc.structure?.headingCount || 0} sections`; break;
        case 'length': row.values[doc.id || doc.name] = `${doc.quality?.wordCount || 0} words`; break;
      }
    }
    matrix.push(row);
  }

  return matrix;
}

function buildSynthesis(analyses, { sharedEntities, contradictions, complementary, alignmentScore }) {
  const parts = [];

  parts.push(`Cross-document analysis of ${analyses.length} document(s).`);
  parts.push(`Alignment score: ${(alignmentScore * 100).toFixed(0)}%`);

  if (sharedEntities.length > 0) {
    parts.push(`Shared entities: ${sharedEntities.length} entity/ies appear across multiple documents (${sharedEntities.slice(0, 5).map(e => `${e.type}: ${e.value}`).join('; ')}).`);
  }

  if (contradictions.length > 0) {
    parts.push(`Contradictions found: ${contradictions.length} — ${contradictions.slice(0, 3).map(c => c.description).join('; ')}.`);
  }

  if (complementary.length > 0) {
    parts.push(`Complementary insights: ${complementary.map(c => c.description).join('; ')}.`);
  }

  const domains = [...new Set(analyses.map(a => a.domain))];
  if (domains.length > 1) {
    parts.push(`Documents span multiple domains (${domains.join(', ')}). Cross-domain synthesis recommended.`);
  }

  return parts.join(' ');
}

function renderComparisonBlock(report) {
  if (!report || !report.ok) return '';

  const lines = [];
  lines.push('## Cross-Document Comparison');
  lines.push(`**Documents:** ${report.documentCount}`);
  lines.push(`**Alignment:** ${Math.round((report.alignmentScore || 0) * 100)}%`);

  if (report.sharedEntities && report.sharedEntities.length > 0) {
    lines.push('');
    lines.push('### Shared Entities');
    for (const ent of report.sharedEntities.slice(0, 10)) {
      lines.push(`- **${ent.type}**: ${ent.value} (${ent.documentCount} docs)`);
    }
  }

  if (report.contradictions && report.contradictions.length > 0) {
    lines.push('');
    lines.push('### Contradictions');
    for (const c of report.contradictions.slice(0, 8)) {
      lines.push(`- [${c.severity}] ${c.description}`);
    }
  }

  if (report.complementary && report.complementary.length > 0) {
    lines.push('');
    lines.push('### Complementary Insights');
    for (const comp of report.complementary) {
      lines.push(`- ${comp.description}`);
    }
  }

  if (report.crossReferences && report.crossReferences.length > 0) {
    lines.push('');
    lines.push('### Cross-References');
    for (const ref of report.crossReferences.slice(0, 8)) {
      lines.push(`- ${ref.docA} ↔ ${ref.docB}: ${ref.relationship} (overlap: ${ref.overlapScore})`);
    }
  }

  if (report.synthesis) {
    lines.push('');
    lines.push('### Synthesis');
    lines.push(report.synthesis);
  }

  return lines.join('\n');
}

module.exports = {
  compareDocuments,
  renderComparisonBlock,
  findSharedEntities,
  findContradictions,
  findComplementary,
  findCrossReferences,
  computeAlignment,
};
