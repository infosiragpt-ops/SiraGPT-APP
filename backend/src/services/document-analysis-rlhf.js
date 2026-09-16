'use strict';

/**
 * RLHF for document analysis in /agentes.
 *
 * Human thumbs on assistant answers that followed a document upload
 * are tagged agent=document. Later document turns retrieve those
 * preferred answers as few-shot. No GPU, no new UI, no vendor-model
 * training. TRL/KTO export stays on the existing preference-export path.
 */

const { hasDocumentSource, isDocumentAnalysisRequest } = require('./document-analysis-quality');
const { formatExemplarsBlock } = require('./agents/feedback-ledger');

function preferenceAgent({ files, prompt } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (hasDocumentSource(list) || isDocumentAnalysisRequest(prompt, list)) return 'document';
  return 'chat';
}

function formatDocumentRlhfBlock(exemplars) {
  const inner = formatExemplarsBlock(exemplars);
  if (!inner) return '';
  let extra = '';
  try {
    const rlcd = require('./rlcd');
    if (rlcd.isDocumentEnabled()) {
      extra = rlcd.prompt.formatCalibratedNotes(exemplars) || '';
    }
  } catch {
    extra = '';
  }
  return `\n\n## DOCUMENT ANALYSIS RLHF\n${inner}${extra}`;
}

module.exports = {
  preferenceAgent,
  formatDocumentRlhfBlock,
};
