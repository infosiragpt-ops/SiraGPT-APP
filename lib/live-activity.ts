/**
 * Claude-style live activity line. Mirrors backend activity-labels.js
 * and agent-runner/trace.js STAGE_LABELS so the UI can map tool names
 * and F4 orchestrator stages even if an older event has no `text`.
 */

const TOOL_ACTIVITY: Record<string, string> = {
  create_docx: "Creando el archivo Word…",
  create_document: "Creando el archivo…",
  document_pipeline: "Construyendo el archivo…",
  document_edit: "Editando el documento…",
  write_file: "Creando el archivo…",
  read_file: "Leyendo el archivo…",
  read_skill: "Leyendo la skill de docx…",
  read_skill_file: "Leyendo la skill de docx…",
  run_skill: "Aplicando una skill…",
  run_skill_pipeline: "Aplicando skills especializadas…",
  verify: "Verificando que la librería docx está disponible…",
  verify_artifact: "Verificando el archivo generado…",
  verify_docx: "Verificando que la librería docx está disponible…",
  web_search: "Buscando información…",
  search: "Buscando información…",
  deep_search: "Buscando en profundidad…",
  read_url: "Leyendo la fuente…",
  web_extract: "Extrayendo contenido…",
  rag_retrieve: "Consultando documentación…",
  self_rag_answer: "Sintetizando evidencia…",
  python_exec: "Ejecutando código…",
  execute_python: "Ejecutando código…",
  python: "Ejecutando código…",
  bash_exec: "Ejecutando comando…",
  execute_bash: "Ejecutando comando…",
  code_sandbox: "Procesando datos…",
  sandbox_exec: "Procesando datos…",
  run_tests: "Ejecutando validaciones…",
  generate_image: "Generando imagen…",
  generate_video: "Generando video…",
  generate_speech: "Generando audio…",
  generate_music: "Componiendo música…",
  create_chart: "Creando la gráfica…",
  presentation: "Preparando la presentación…",
  create_presentation: "Creando la presentación…",
  spreadsheet: "Preparando la hoja de cálculo…",
  pdf: "Preparando el PDF…",
  update_plan: "Actualizando el plan…",
  finalize: "Componiendo la respuesta…",
  // Runner tools already emitted by AgentRunner (catalog FE #5)
  glob: "Buscando archivos…",
  grep: "Buscando en el código…",
  edit_file: "Editando el archivo…",
  list_files: "Listando archivos…",
  render_preview: "Generando la vista previa…",
  set_slide_background: "Aplicando el fondo de la diapositiva…",
  str_replace: "Editando el archivo…",
  add_slide: "Agregando una diapositiva…",
}

/** F4 orchestrator stages from backend/src/services/agent-runner/trace.js */
const STAGE_ACTIVITY: Record<string, string> = {
  planning: "Planificando",
  plan_start: "Planificando",
  orchestrator_start: "Planificando",
  planReady: "Plan listo",
  plan_ready: "Plan listo",
  delegating: "Delegando a sub-agente",
  node_start: "Delegando a sub-agente",
  subagentDone: "Sub-agente listo",
  node_done: "Sub-agente listo",
  replanning: "Replanificando",
  budgetExceeded: "Presupuesto agotado",
  budget_exceeded: "Presupuesto agotado",
  steered: "Instrucción recibida",
  cancelled: "Cancelado",
  job_cancelled: "Cancelado",
}

export function activityTextFromTool(tool?: string | null): string | null {
  if (!tool) return null
  const key = String(tool).trim()
  return TOOL_ACTIVITY[key] || TOOL_ACTIVITY[key.toLowerCase()] || null
}

export function activityTextFromStage(stage?: string | null): string | null {
  if (!stage) return null
  const key = String(stage).trim()
  return STAGE_ACTIVITY[key] || STAGE_ACTIVITY[key.toLowerCase()] || null
}

export function activityTextFromEvent(evt: {
  type?: string
  text?: string
  label?: string
  tool?: string
  name?: string
  step?: string
  stage?: string
}): string {
  const explicit = String(evt?.text || evt?.label || "").replace(/\s+/g, " ").trim()
  if (explicit && explicit.length <= 92) {
    // Generic fallback from an older client — prefer a real F4/tool label.
    if (!/^pensando/i.test(explicit)) return explicit
  }
  const fromStage = activityTextFromStage(evt?.stage || evt?.step || evt?.type)
  if (fromStage) return fromStage
  const fromTool = activityTextFromTool(evt?.tool || evt?.name)
  if (fromTool) return fromTool
  if (explicit) return explicit
  return "Pensando…"
}
