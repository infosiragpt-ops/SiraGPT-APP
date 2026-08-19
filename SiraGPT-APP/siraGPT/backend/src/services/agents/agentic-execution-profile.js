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

const PATTERNS = {
  research: /\b(investiga(?:r|cion)?|research|busca(?:r)?|recopila(?:r)?|fuentes|citas|referencias|art[ií]culos?|papers?|literatura|acad[eé]mic[oa]s?|cient[ií]fic[oa]s?|mercado|benchmark|estado del arte|revision sistem[aá]tica|metaan[aá]lisis|scielo|redalyc|dialnet|openalex|crossref|pubmed|doi|semantic scholar|doaj|scopus|web of science|wos)\b/i,
  document: /\b(docx|xlsx|pptx|word|excel|power\s*point|powerpoint|pdf\b|csv\b|markdown|html\b|informe|reporte|presentaci[oó]n|diapositivas|slides|hoja de c[aá]lculo|spreadsheet|archivo|documento|matriz|descargar|exporta(?:r|me)?|genera(?:r|me)?|crea(?:r|me)?)\b/i,
  privateFiles: /\b(adjunt[oa]s?|archivo(?:s)? cargad[oa]s?|documento(?:s)? cargad[oa]s?|seg[uú]n (mis|el) archivo|seg[uú]n (mis|el) documento|este documento|esta tesis|pdf cargado|word cargado|docx cargado|mis archivos|mi proyecto)\b/i,
  code: /\b(c[oó]digo|code|programa|script|funci[oó]n|clase|debug|bug|corrige(?:r)?|repara(?:r)?|test(?:s)?|prueba(?:s)?|unit test|typescript|javascript|python|react|next\.?js|backend|frontend|web app|autocorrige|auto corrige)\b/i,
  computation: /\b(calcula(?:r)?|analiza(?:r)?|procesa(?:r)?|limpia(?:r)?|estad[ií]stica|cronbach|spearman|anova|regresi[oó]n|correlaci[oó]n|likert|dataset|csv|datos|tabla|f[oó]rmula|matriz|integral|derivada|probabilidad)\b/i,
  strictEvidence: /\b(100%|extremadamente preciso|precisi[oó]n|verifica(?:r)?|validar|reales|doi|open access|acceso abierto|20|30|40|50|100|miles|202[0-9]|art[ií]culos cient[ií]ficos)\b/i,
  transcription: /\b(transcrib(?:e|ir|eme|irme|elo|elo|alo|al[oó]|irlo)?|transcripci[oó]n|transcript|transcribe)\b/i,
  explicitTranscriptionArtifact: /\b(?:en|como|a|formato)\s+(?:un|una|el|la)?\s*(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|csv|markdown|html|archivo|documento)\b|\b(?:genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|exporta(?:r|me)?|descarga(?:r|me)?|prepara(?:r|me)?)\b.*\b(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|csv|markdown|html)\b/i,
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

function buildExecutionProfile({ goal, fileIds = [] } = {}) {
  const rawGoal = String(goal || '');
  const normalized = normalize(rawGoal);
  const hasFiles = Array.isArray(fileIds) && fileIds.length > 0;
  const plainTranscription =
    (PATTERNS.transcription.test(rawGoal) || PATTERNS.transcription.test(normalized))
    && !(PATTERNS.explicitTranscriptionArtifact.test(rawGoal) || PATTERNS.explicitTranscriptionArtifact.test(normalized));
  const documentRequested = PATTERNS.document.test(rawGoal) || PATTERNS.document.test(normalized);
  const capabilities = {
    needsResearch: PATTERNS.research.test(rawGoal) || PATTERNS.research.test(normalized),
    needsDocument: documentRequested && !plainTranscription,
    needsPrivateContext: hasFiles || PATTERNS.privateFiles.test(rawGoal) || PATTERNS.privateFiles.test(normalized),
    needsCodeOrRepair: PATTERNS.code.test(rawGoal) || PATTERNS.code.test(normalized),
    needsComputation: PATTERNS.computation.test(rawGoal) || PATTERNS.computation.test(normalized),
    strictEvidence: PATTERNS.strictEvidence.test(rawGoal) || PATTERNS.strictEvidence.test(normalized),
    plainTranscription,
  };

  const requiredTools = [];
  const minimumToolCalls = {};
  const qualityGates = [];

  if (capabilities.needsPrivateContext) {
    requiredTools.push('rag_retrieve');
    qualityGates.push('Retrieve uploaded/project context before answering about private files.');
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

function validateFinalize(profile, steps = []) {
  const counts = successfulToolCalls(steps);
  const missingTools = [];
  for (const tool of profile.requiredTools || []) {
    const min = profile.minimumToolCalls?.[tool] || 1;
    if ((counts.get(tool) || 0) < min) missingTools.push(tool);
  }

  if (missingTools.length === 0) {
    return {
      ok: true,
      missingTools: [],
      successfulTools: Object.fromEntries(counts.entries()),
    };
  }

  return {
    ok: false,
    missingTools,
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
  successfulToolCalls,
  validateFinalize,
};
