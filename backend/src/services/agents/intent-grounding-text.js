'use strict';

/**
 * intent-grounding-text
 *
 * Para tareas de alto coste (presentaciones, deep research, video,
 * generación de apps web completas, código grande), inyecta una
 * instrucción al system prompt que pide al LLM iniciar su respuesta
 * con un preámbulo natural "Entendí: …" que diga qué interpretó y
 * qué va a producir.
 *
 * Beneficio: si la interpretación está mal, el usuario puede
 * corregir en una palabra ANTES de que se gaste el cómputo costoso.
 * Si está bien, el usuario tiene confianza inmediata y el resto del
 * stream procede sin fricción.
 *
 * Esto NO añade un componente UI nuevo — solo es texto al inicio del
 * stream existente. Cumple la restricción de CLAUDE.md de no tocar
 * componentes visuales.
 *
 * Detección de "alto coste":
 *   - primary_intent ∈ {presentation, research_grounding, video_generation,
 *                       long_running_task, web_app_build, complex_*}
 *   - required_extension ∈ {.pptx, .mp4, .webm}
 *   - cost_class explícito >= 'medium' si el contrato lo provee
 *   - secondary_intents incluye research_grounding o multi-step
 *
 * Idempotente: si el contrato no es de alto coste, devuelve null y el
 * caller no añade el bloque.
 */

const HIGH_COST_INTENTS = new Set([
  'presentation_generation',
  'presentation',
  'research_question',
  'research_grounding',
  'scientific_research',
  'web_app_build',
  'agent_long_running_task',
  'complex_academic_document_generation',
  'video_generation',
  'audio_generation',
]);

const HIGH_COST_EXTENSIONS = new Set([
  '.pptx',
  '.mp4',
  '.webm',
  '.mov',
  '.mp3',
  '.wav',
]);

const HIGH_COST_PIPELINES = new Set([
  'SlidePipeline',
  'ResearchGroundingPipeline',
  'MultiIntentPipeline',
]);

const HIGH_COST_SECONDARY = new Set([
  'scientific_research',
  'multi_provider_search',
  'citation_grounding',
  'doi_validation',
]);

/**
 * detectHighCost — pure. Returns { isHighCost: boolean, reasons: string[] }
 */
function detectHighCost({ contract, structuredIntent, requiredTools = [] } = {}) {
  const reasons = [];
  const primary = structuredIntent?.intent_primary || contract?.primary_intent;
  if (primary && HIGH_COST_INTENTS.has(primary)) reasons.push(`intent:${primary}`);

  const ext = contract?.required_extension;
  if (ext && HIGH_COST_EXTENSIONS.has(ext)) reasons.push(`extension:${ext}`);

  const pipeline = contract?.pipeline;
  if (pipeline && HIGH_COST_PIPELINES.has(pipeline)) reasons.push(`pipeline:${pipeline}`);

  const secondary = Array.isArray(structuredIntent?.intent_secondary) ? structuredIntent.intent_secondary : [];
  for (const s of secondary) {
    if (HIGH_COST_SECONDARY.has(s)) reasons.push(`secondary:${s}`);
  }

  const tools = Array.isArray(requiredTools) ? requiredTools : [];
  const expensiveTools = ['generate_video', 'create_video', 'research-agent', 'code-gen', 'generate_ppt'];
  for (const t of tools) {
    if (expensiveTools.includes(t)) reasons.push(`tool:${t}`);
  }

  // Cost_class explícito (no siempre presente)
  const costClass = contract?.cost_class;
  if (costClass && ['medium', 'high', 'critical'].includes(costClass)) {
    reasons.push(`cost_class:${costClass}`);
  }

  return { isHighCost: reasons.length > 0, reasons };
}

/**
 * buildGroundingPromptBlock — pure. Returns a string block to append
 * to the system prompt, or null if not high-cost.
 *
 * El bloque instruye al LLM a producir 1-2 frases iniciales tipo:
 *   "Entendí: vas a generar un informe Q3 en .docx con análisis de
 *   ventas. Si me equivoco, dímelo en una palabra y rehago. Procedo."
 *
 * Esto se renderiza al inicio del stream y le da al usuario la
 * oportunidad de cancelar/corregir antes de que se complete el
 * trabajo costoso.
 */
function buildGroundingPromptBlock(detection) {
  if (!detection || !detection.isHighCost) return null;
  const lines = [
    '## GROUNDING_PREFACE',
    'La petición del usuario activa un trabajo de alto coste (' + (detection.reasons || []).slice(0, 4).join(', ') + ').',
    'ANTES de generar el artefacto, escribe en 1-2 frases:',
    '  1) Qué entendiste exactamente (formato, scope, fuentes si aplica).',
    '  2) Qué vas a producir.',
    'Cierra el preámbulo con: "Si me equivoco, dímelo en una palabra y rehago. Procedo."',
    '',
    'Reglas:',
    '- Máximo 2 frases en el preámbulo, idioma del usuario.',
    '- NO pidas confirmación bloqueante — ejecuta inmediatamente después del preámbulo.',
    '- Si la petición es ambigua, infiere razonablemente y declara los supuestos en el preámbulo.',
    '- NO repitas el preámbulo en respuestas siguientes del mismo chat (solo turno inicial de la tarea).',
  ];
  return lines.join('\n');
}

/**
 * shouldInject — convenience wrapper that combines detection + build.
 * Returns the block string or null.
 */
function shouldInjectGrounding(args) {
  const det = detectHighCost(args || {});
  return buildGroundingPromptBlock(det);
}

module.exports = {
  detectHighCost,
  buildGroundingPromptBlock,
  shouldInjectGrounding,
  HIGH_COST_INTENTS,
  HIGH_COST_EXTENSIONS,
  HIGH_COST_PIPELINES,
  HIGH_COST_SECONDARY,
};
