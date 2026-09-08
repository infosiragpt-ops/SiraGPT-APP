'use strict';

/**
 * Claude-style live activity copy. One short Spanish line per tool /
 * thinking beat. Used by AgentRunner, agentic-chat-stream and the
 * document pipeline so the chat shows what is actually happening —
 * never a fake rotating placeholder.
 */

const TOOL_ACTIVITY = {
  create_docx: 'Creando el archivo Word…',
  create_document: (args) => activityForCreateDocument(args),
  document_pipeline: 'Construyendo el archivo…',
  document_edit: 'Editando el documento…',
  write_file: 'Creando el archivo…',
  read_file: 'Leyendo el archivo…',
  read_skill: 'Leyendo la skill de docx…',
  read_skill_file: 'Leyendo la skill de docx…',
  run_skill: (args) => {
    const skill = String(args?.skillId || args?.skill || '').toLowerCase();
    if (/docx|word|document/.test(skill)) return 'Leyendo la skill de docx…';
    if (/pptx|ppt|slide/.test(skill)) return 'Leyendo la skill de PowerPoint…';
    if (/xlsx|excel/.test(skill)) return 'Leyendo la skill de Excel…';
    return skill ? `Aplicando skill ${skill}…` : 'Aplicando una skill…';
  },
  run_skill_pipeline: 'Aplicando skills especializadas…',
  verify: 'Verificando que la librería docx está disponible…',
  verify_artifact: 'Verificando el archivo generado…',
  verify_docx: 'Verificando que la librería docx está disponible…',
  web_search: (args) => args?.query ? `Buscando “${truncate(args.query, 48)}”…` : 'Buscando información…',
  search: 'Buscando información…',
  deep_search: 'Buscando en profundidad…',
  read_url: (args) => args?.url ? `Leyendo ${prettyHost(args.url)}…` : 'Leyendo la fuente…',
  web_extract: 'Extrayendo contenido…',
  rag_retrieve: 'Consultando documentación…',
  self_rag_answer: 'Sintetizando evidencia…',
  python_exec: 'Ejecutando código…',
  execute_python: 'Ejecutando código…',
  python: 'Ejecutando código…',
  bash_exec: 'Ejecutando comando…',
  execute_bash: 'Ejecutando comando…',
  code_sandbox: 'Procesando datos…',
  sandbox_exec: 'Procesando datos…',
  run_tests: 'Ejecutando validaciones…',
  generate_image: 'Generando imagen…',
  generate_video: 'Generando video…',
  generate_speech: 'Generando audio…',
  generate_music: 'Componiendo música…',
  create_chart: 'Creando la gráfica…',
  presentation: 'Preparando la presentación…',
  create_presentation: 'Creando la presentación…',
  spreadsheet: 'Preparando la hoja de cálculo…',
  pdf: 'Preparando el PDF…',
  update_plan: 'Actualizando el plan…',
  search_tools: 'Buscando herramientas…',
  memory_recall: 'Recordando contexto…',
  finalize: 'Componiendo la respuesta…',
  glob: 'Buscando archivos…',
  grep: 'Buscando en el código…',
  edit_file: 'Editando el archivo…',
  list_files: 'Listando archivos…',
  render_preview: 'Generando la vista previa…',
  set_slide_background: 'Aplicando el fondo de la diapositiva…',
  host_file: 'Editando el archivo…',
  host_bash: 'Ejecutando comando…',
};

function truncate(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  if (!str) return '';
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

function prettyHost(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function activityForCreateDocument(args) {
  const name = String(args?.filename || args?.path || args?.format || '').toLowerCase();
  if (/\.docx?\b|word/.test(name)) return 'Creando el archivo Word…';
  if (/\.pptx?\b|ppt|power/.test(name)) return 'Creando la presentación…';
  if (/\.xlsx?\b|excel/.test(name)) return 'Creando la hoja de cálculo…';
  if (/\.pdf\b/.test(name)) return 'Creando el PDF…';
  return 'Creando el archivo…';
}

/**
 * AgentRunner mostly calls execute_python / execute_bash. Infer a
 * Claude-style Spanish line from the code or path so the UI does not
 * stay stuck on "Ejecutando código…".
 */
function inferFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const path = String(args.path || args.filename || args.file || args.skill || args.skillId || '');
  const code = String(args.code || args.command || args.script || args.source || '');
  const blob = `${path}\n${code}`.toLowerCase();
  if (!blob.trim()) return null;
  if (/skill/.test(blob) && /docx|word|document/.test(blob)) return 'Leyendo la skill de docx…';
  if (/skill/.test(blob) && /pptx|ppt|slide/.test(blob)) return 'Leyendo la skill de PowerPoint…';
  if (/skill/.test(blob) && /xlsx|excel/.test(blob)) return 'Leyendo la skill de Excel…';
  if (/import\s+.*\bdocx\b|require\(['"]docx['"]\)|from\s+['"]docx['"]|librer[ií]a docx/.test(blob)) {
    return 'Verificando que la librería docx está disponible…';
  }
  if (/\.docx\b/.test(blob) && /write|save|output|document\(/.test(blob)) return 'Creando el archivo Word…';
  if (/\.pptx\b/.test(blob) && /write|save|output/.test(blob)) return 'Creando la presentación…';
  if (/\.xlsx\b/.test(blob) && /write|save|output/.test(blob)) return 'Creando la hoja de cálculo…';
  if (/\.docx\b/.test(blob)) return 'Creando el archivo Word…';
  if (/outputs\/|\/workspace\/outputs/.test(blob) && /docx|word/.test(blob)) return 'Creando el archivo Word…';
  return null;
}

const TECHNICAL_RE =
  /\b(script|python|bash|shell|node|curl|json|payload|request|response|stdout|stderr|traceback|stack|taskupdate|comando)\b/i;
const STRUCTURAL_RE = /[{[\]}]|"[^"]+"\s*:|```/;

function sanitizeThought(raw) {
  let s = String(raw == null ? '' : raw);
  if (!s.trim()) return '';
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/\{[\s\S]*\}/g, ' ');
  s = s.replace(/<\/?[^>]+>/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (TECHNICAL_RE.test(s) || STRUCTURAL_RE.test(s)) return '';
  if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/i.test(s)) return '';
  if (s.length > 88) s = `${s.slice(0, 85).trim()}…`;
  return s;
}

function lookupTool(tool, args) {
  const name = String(tool || '').trim();
  const inferred = inferFromArgs(args);
  if (inferred && /python|bash|sandbox|exec|code/i.test(name || 'python')) return inferred;
  if (!name) return inferred;
  const mapped = TOOL_ACTIVITY[name] || TOOL_ACTIVITY[name.toLowerCase()];
  if (!mapped) return inferred;
  const resolved = typeof mapped === 'function' ? mapped(args || {}) : mapped;
  if (inferred && /Ejecutando c[oó]digo|Ejecutando comando/.test(resolved)) return inferred;
  return resolved;
}

/**
 * Resolve the single live-activity line for a tool call or thinking beat.
 * Preference: user-facing thought → mapped tool → sanitized label → fallback.
 */
function activityTextFor({ tool, args, thought, label } = {}) {
  const fromThought = sanitizeThought(thought);
  if (fromThought) return fromThought;

  const fromArgs = inferFromArgs(args);
  if (fromArgs) return fromArgs;

  const fromTool = lookupTool(tool, args);
  if (fromTool) return fromTool;

  const fromLabel = sanitizeThought(label);
  if (fromLabel) return fromLabel;

  if (tool) {
    const pretty = String(tool).replace(/[_-]+/g, ' ').trim();
    if (pretty && !TECHNICAL_RE.test(pretty)) return `Ejecutando ${pretty}…`;
  }
  return 'Pensando…';
}

function activityEvent(payload) {
  const text = activityTextFor(payload);
  const event = { type: 'activity', text };
  if (payload && payload.tool) event.tool = payload.tool;
  return event;
}

module.exports = {
  TOOL_ACTIVITY,
  activityTextFor,
  activityEvent,
  sanitizeThought,
  lookupTool,
  inferFromArgs,
};
