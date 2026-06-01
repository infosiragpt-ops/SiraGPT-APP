/**
 * agentic-execution-profile
 *
 * Deterministic operating model distilled from the local DOCSIRA corpus:
 * RAG, ReAct/Reflexion, code agents, tool use/MCP, prompt engineering,
 * document generation and evaluation benchmarks.
 *
 * The purpose is not to "prompt harder"; it is to make the backend enforce
 * minimum tool-use gates before an autonomous chat task may finalize.
 */

const PROFILE_VERSION = 'docsira-agentic-profile-2026-04';
const { detectMediaIntent } = require('./media-intent');

const PATTERNS = {
  research: /\b(investiga(?:r|cion)?|research|busca(?:r)?|recopila(?:r)?|fuentes|citas|referencias|art[ií]culos?|papers?|literatura|acad[eé]mic[oa]s?|cient[ií]fic[oa]s?|mercado|benchmark|estado del arte|revision sistem[aá]tica|metaan[aá]lisis|scielo|redalyc|dialnet|openalex|crossref|pubmed|doi|semantic scholar|doaj|scopus|web of science|wos)\b/i,
  document: /\b(docx|xlsx|pptx?|word|excel|power\s*point|powerpoint|pdf\b|csv\b|markdown|html\b|informe|reporte|presentaci[oó]n|diapositivas|slides|hoja de c[aá]lculo|spreadsheet|archivo|documento|matriz|descargar|exporta(?:r|me)?)\b/i,
  privateFiles: /\b(adjunt[oa]s?|archivo(?:s)? cargad[oa]s?|documento(?:s)? cargad[oa]s?|seg[uú]n (mis|el) archivo|seg[uú]n (mis|el) documento|este documento|esta tesis|pdf cargado|word cargado|docx cargado|mis archivos|mi proyecto)\b/i,
  code: /\b(c[oó]digo|code|programa|script|funci[oó]n|clase|debug|bug|corrige(?:r)?|repara(?:r)?|test(?:s)?|prueba(?:s)?|unit test|typescript|javascript|python|react|next\.?js|backend|frontend|web app|autocorrige|auto corrige)\b/i,
  computation: /\b(calcula(?:r)?|analiza(?:r)?|procesa(?:r)?|limpia(?:r)?|estad[ií]stica|cronbach|spearman|anova|regresi[oó]n|correlaci[oó]n|likert|dataset|csv|datos|tabla|f[oó]rmula|matriz|integral|derivada|probabilidad)\b/i,
  strictEvidence: /\b(100%|extremadamente preciso|precisi[oó]n|verifica(?:r)?|validar|reales|doi|open access|acceso abierto|20|30|40|50|100|miles|202[0-9]|art[ií]culos cient[ií]ficos)\b/i,
  transcription: /\b(transcrib(?:e|ir|eme|irme|elo|elo|alo|al[oó]|irlo)?|transcripci[oó]n|transcript|transcribe)\b/i,
  explicitTranscriptionArtifact: /\b(?:en|como|a|formato)\s+(?:un|una|el|la)?\s*(?:word|docx|pdf|excel|xlsx|pptx?|power\s*point|powerpoint|csv|markdown|html|archivo|documento)\b|\b(?:genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|exporta(?:r|me)?|descarga(?:r|me)?|prepara(?:r|me)?)\b.*\b(?:word|docx|pdf|excel|xlsx|pptx?|power\s*point|powerpoint|csv|markdown|html)\b/i,
  explicitDeliverable: /\b(?:en|como|a|formato)\s+(?:un|una|el|la)?\s*(?:word|docx|pdf|excel|xlsx|pptx?|power\s*point|powerpoint|csv|markdown|html)\b|\bdame\s+(?:un|una|el|la)?\s*(?:word|docx|pdf|excel|xlsx|pptx?|power\s*point|powerpoint|csv|markdown|html)\b|\b(?:genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|exporta(?:r|me)?|descarga(?:r|me)?|prepara(?:r|me)?|elabora(?:r|me)?|redacta(?:r|me)?|arma(?:r|me)?|construye(?:r|me)?)\b[^.?!]{0,140}\b(?:word|docx|pdf|excel|xlsx|pptx?|power\s*point|powerpoint|csv|markdown|html|archivo|documento|informe|reporte|presentaci[oó]n)\b/i,
};

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i;

/**
 * Classify attachments into image vs document buckets from client/file
 * metadata. Used to decide whether the document-intelligence required-tool
 * gate applies: a chat image (photo/screenshot) is consumed by the
 * multimodal model directly and must NOT force docintel_analyze/rag_retrieve,
 * which fail on images and trap the agent in a retry loop.
 */
function classifyAttachmentKinds(fileMetadata = []) {
  let imageCount = 0;
  let documentCount = 0;
  for (const file of Array.isArray(fileMetadata) ? fileMetadata : []) {
    if (!file || typeof file !== 'object') continue;
    const mime = String(file.mimeType || file.type || file.contentType || '').toLowerCase();
    const name = String(file.name || file.originalName || file.filename || file.path || '');
    const isImage = mime.startsWith('image/') || (!mime.startsWith('application/') && IMAGE_FILE_EXT_RE.test(name));
    if (isImage) imageCount += 1;
    else documentCount += 1;
  }
  return { imageCount, documentCount, total: imageCount + documentCount };
}

function buildExecutionProfile({ goal, fileIds = [], fileMetadata = [] } = {}) {
  const rawGoal = String(goal || '');
  const normalized = normalize(rawGoal);
  const hasFiles = Array.isArray(fileIds) && fileIds.length > 0;
  const attachmentKinds = classifyAttachmentKinds(fileMetadata);
  // We only relax the document gate when we POSITIVELY know every attachment
  // is an image. When metadata is missing (older callers), behaviour is
  // unchanged — hasFiles still drives needsPrivateContext.
  const onlyImageAttachments =
    attachmentKinds.total > 0 && attachmentKinds.documentCount === 0 && attachmentKinds.imageCount > 0;
  const mentionsPrivateFiles = PATTERNS.privateFiles.test(rawGoal) || PATTERNS.privateFiles.test(normalized);
  const mediaIntent = detectMediaIntent(rawGoal);
  const needsMedia = !!(mediaIntent && mediaIntent.kind && mediaIntent.tool && mediaIntent.confidence === 'high');
  const plainTranscription =
    (PATTERNS.transcription.test(rawGoal) || PATTERNS.transcription.test(normalized))
    && !(PATTERNS.explicitTranscriptionArtifact.test(rawGoal) || PATTERNS.explicitTranscriptionArtifact.test(normalized));
  const documentMentioned = PATTERNS.document.test(rawGoal) || PATTERNS.document.test(normalized);
  const explicitDeliverableRequested = PATTERNS.explicitDeliverable.test(rawGoal) || PATTERNS.explicitDeliverable.test(normalized);
  const mentionsAttachedPrivateFile = hasFiles && (
    PATTERNS.privateFiles.test(rawGoal)
    || PATTERNS.privateFiles.test(normalized)
    || /\b(?:este|esta|ese|esa|el|la|mi|mis|del|de\s+la)\s+(?:word|documento|archivo|adjunto|docx?|pdf|excel|xlsx|power\s*point|powerpoint|pptx?)\b/i.test(rawGoal)
    || /\b(?:word|documento|archivo|adjunto|docx?|pdf|excel|xlsx|pptx?)\s+(?:adjunto|subido|cargado|anterior)\b/i.test(rawGoal)
  );
  const documentRequested = documentMentioned && !(mentionsAttachedPrivateFile && !explicitDeliverableRequested);
  const capabilities = {
    needsResearch: PATTERNS.research.test(rawGoal) || PATTERNS.research.test(normalized),
    needsDocument: documentRequested && !plainTranscription,
    // Image-only attachments are answered by the multimodal model directly
    // (vision); they must NOT trigger the document-intelligence gate, which
    // fails on images and dead-ends the agent. Explicit private-file wording
    // ("según el documento adjunto") still forces the gate even with an image,
    // because the user may have photographed a document for OCR.
    needsPrivateContext: (hasFiles && !onlyImageAttachments) || mentionsPrivateFiles,
    needsCodeOrRepair: PATTERNS.code.test(rawGoal) || PATTERNS.code.test(normalized),
    needsComputation: PATTERNS.computation.test(rawGoal) || PATTERNS.computation.test(normalized),
    strictEvidence: PATTERNS.strictEvidence.test(rawGoal) || PATTERNS.strictEvidence.test(normalized),
    needsMedia,
    mediaKind: needsMedia ? mediaIntent.kind : null,
    mediaTool: needsMedia ? mediaIntent.tool : null,
    mediaConfidence: mediaIntent?.confidence || 'low',
    plainTranscription,
  };

  const requiredTools = [];
  const minimumToolCalls = {};
  const qualityGates = [];

  if (capabilities.needsPrivateContext) {
    requiredTools.push('docintel_analyze', 'rag_retrieve');
    qualityGates.push('Analyze uploaded files and retrieve private context before answering about private files.');
  }
  if (capabilities.needsResearch) {
    requiredTools.push('web_search');
    minimumToolCalls.web_search = capabilities.strictEvidence ? 2 : 1;
    qualityGates.push('Use live/source search and keep DOI/URL/year/source metadata intact.');
  }
  if (capabilities.needsComputation) {
    requiredTools.push('python_exec');
    qualityGates.push('Verify numeric/statistical/data-heavy work with executable computation.');
  }
  if (capabilities.needsMedia) {
    requiredTools.push(mediaIntent.tool);
    const count = mediaIntent.kind === 'image' ? Number(mediaIntent.specs?.count || 1) : 1;
    minimumToolCalls[mediaIntent.tool] = Math.max(1, Number.isFinite(count) ? Math.round(count) : 1);
    qualityGates.push(`Use the media generation tool ${mediaIntent.tool} before claiming the ${mediaIntent.kind} was created.`);
  }
  if (capabilities.needsDocument) {
    requiredTools.push('create_document', 'verify_artifact');
    qualityGates.push('Generate a real artifact and verify it technically before delivery.');
  }
  if (capabilities.needsCodeOrRepair) {
    requiredTools.push('run_tests');
    qualityGates.push('Run tests or invariant checks for generated or repaired code.');
  }

  return {
    version: PROFILE_VERSION,
    capabilities,
    requiredTools: unique(requiredTools),
    minimumToolCalls,
    qualityGates,
  };
}

function successfulToolCalls(steps = []) {
  const counts = new Map();
  for (const step of steps || []) {
    for (const action of step.actions || []) {
      const tool = action.tool;
      if (!tool) continue;
      const obs = action.observation || {};
      const ok = !obs.error && obs.ok !== false;
      if (ok) counts.set(tool, (counts.get(tool) || 0) + 1);
    }
  }
  return counts;
}

function validateFinalize(profile, steps = [], options = {}) {
  const counts = successfulToolCalls(steps);
  // Tools the agent loop has declared unavailable (they exhausted their
  // consecutive-error budget). A required-but-unavailable tool must not block
  // finalize forever — otherwise the whole task dead-ends. We waive it and let
  // the agent answer with whatever it could gather. Backward-compatible: with
  // no options the set is empty and behaviour is identical to before.
  const unavailableTools = new Set(
    (Array.isArray(options?.unavailableTools) ? options.unavailableTools : []).map((tool) => String(tool))
  );
  const missingTools = [];
  const waivedTools = [];
  for (const tool of profile.requiredTools || []) {
    const min = profile.minimumToolCalls?.[tool] || 1;
    if ((counts.get(tool) || 0) < min) {
      if (unavailableTools.has(tool)) waivedTools.push(tool);
      else missingTools.push(tool);
    }
  }

  if (missingTools.length === 0) {
    return {
      ok: true,
      missingTools: [],
      waivedTools,
      requiredTools: profile.requiredTools || [],
      successfulTools: Object.fromEntries(counts.entries()),
    };
  }

  return {
    ok: false,
    missingTools,
    waivedTools,
    requiredTools: profile.requiredTools || [],
    successfulTools: Object.fromEntries(counts.entries()),
    message: `Finalization blocked by siraGPT execution gates. Missing required tools: ${missingTools.join(', ')}.`,
    repairInstructions: [
      'Do not explain this internal gate to the user.',
      'Call the missing tools, inspect their observations, repair any failures, then call finalize again.',
      'If evidence cannot satisfy the request, finalize only after using the required tools and state the verified gap clearly.',
    ].join(' '),
  };
}

function buildExecutionProfilePrompt(profile) {
  const tools = profile.requiredTools.length ? profile.requiredTools.join(', ') : 'none';
  const gates = profile.qualityGates.length
    ? profile.qualityGates.map((gate, index) => `${index + 1}. ${gate}`).join('\n')
    : 'No mandatory tool gates inferred; still verify non-trivial claims.';

  return [
    `Deterministic execution profile: ${profile.version}`,
    `Required tools before finalize: ${tools}`,
    `Minimum tool calls: ${JSON.stringify(profile.minimumToolCalls || {})}`,
    'Quality gates:',
    gates,
    'If a finalize call is rejected, read the tool observation, execute the missing tools, then finalize again.',
  ].join('\n');
}

module.exports = {
  PROFILE_VERSION,
  buildExecutionProfile,
  buildExecutionProfilePrompt,
  classifyAttachmentKinds,
  successfulToolCalls,
  validateFinalize,
};
