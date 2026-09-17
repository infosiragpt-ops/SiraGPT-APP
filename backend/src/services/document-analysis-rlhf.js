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

const DOCUMENT_CONFIDENCE_FOOTER_RE = /(?:\n+|^)\s*(?:Nivel de confianza|_Confianza(?: baja| media)?):[^\n]*\s*$/i;

function isCodingOrPreviewTurn(prompt) {
  const text = String(prompt || '');
  if (!text.trim()) return false;
  try {
    const gh = require('./agents/github-pr-intent');
    if (gh.isGithubRepoWorkRequest(text) || gh.isGithubLocalRunRequest(text) || gh.isGithubPrRequest(text)) {
      return true;
    }
  } catch {
    /* fail-open */
  }
  try {
    const { isSoftwareBuildRequest } = require('./agents/software-build-intent');
    if (isSoftwareBuildRequest(text)) return true;
  } catch {
    /* fail-open */
  }
  try {
    const { detectCodeTaskIntent } = require('./codex/codex-run-orchestrator');
    const intent = detectCodeTaskIntent(text);
    if (intent && intent.isCodeTask && Number(intent.confidence) >= 0.75) return true;
  } catch {
    /* fail-open */
  }
  return false;
}

function preferenceAgent({ files, prompt } = {}) {
  if (isCodingOrPreviewTurn(prompt)) return 'chat';
  const list = Array.isArray(files) ? files : [];
  if (hasDocumentSource(list) || isDocumentAnalysisRequest(prompt, list)) return 'document';
  return 'chat';
}

function stripDocumentConfidenceFooter(text) {
  return String(text || '').replace(DOCUMENT_CONFIDENCE_FOOTER_RE, '').replace(/\s+$/g, '');
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
  isCodingOrPreviewTurn,
  stripDocumentConfidenceFooter,
  DOCUMENT_CONFIDENCE_FOOTER_RE,
};
