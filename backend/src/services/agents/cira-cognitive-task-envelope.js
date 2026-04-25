/**
 * cira-cognitive-task-envelope
 *
 * Internal operating envelope for Cira. It compiles the already validated
 * UniversalTaskContract + ExecutionGraph into the richer runtime object used
 * by the chat backend: intent frame, plan frame, tool frame, artifact frame,
 * validation frame, permissions, memory policy, UI progress policy and
 * self-repair policy. This is deterministic and intentionally UI-agnostic.
 */

const crypto = require('crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const CIRA_TASK_ENVELOPE_VERSION = 'sira.task_envelope.v1';

const UNIVERSAL_INTENT_TAXONOMY = {
  conversation: [
    'general_question',
    'explanation',
    'translation',
    'summarization',
    'brainstorming',
    'comparison',
    'recommendation',
  ],
  document_artifacts: [
    'docx_generation',
    'pdf_generation',
    'report_generation',
    'academic_document',
    'legal_document',
    'business_proposal',
    'cv_resume',
    'contract_draft',
    'letter_or_email',
    'form_generation',
  ],
  spreadsheet_artifacts: [
    'xlsx_generation',
    'spreadsheet_analysis',
    'financial_model',
    'budget_template',
    'inventory_sheet',
    'dashboard_spreadsheet',
    'formula_generation',
  ],
  presentation_artifacts: [
    'pptx_generation',
    'pitch_deck',
    'academic_presentation',
    'business_presentation',
    'training_deck',
    'slide_redesign',
  ],
  coding: [
    'code_generation',
    'code_debugging',
    'code_review',
    'app_generation',
    'api_generation',
    'database_schema',
    'landing_page_generation',
    'frontend_component',
    'backend_service',
    'script_generation',
  ],
  design_visual: [
    'svg_generation',
    'logo_concept',
    'infographic',
    'chart_generation',
    'diagram_generation',
    'mermaid_diagram',
    'ui_mockup',
    'brand_kit',
  ],
  image: [
    'image_generation',
    'image_editing',
    'prompt_generation',
    'style_transfer',
    'product_mockup',
    'character_design',
  ],
  video: [
    'video_generation',
    'video_script',
    'storyboard',
    'shot_list',
    'video_prompt',
    'animation_plan',
  ],
  research: [
    'web_research',
    'scientific_research',
    'market_research',
    'competitive_analysis',
    'source_validation',
    'bibliography_generation',
    'doi_validation',
  ],
  data: [
    'data_analysis',
    'data_cleaning',
    'statistics',
    'forecasting',
    'visualization',
    'database_query',
    'data_pipeline',
    'csv_processing',
  ],
  automation: [
    'workflow_automation',
    'email_automation',
    'crm_update',
    'calendar_scheduling',
    'web_scraping',
    'browser_automation',
    'api_integration',
  ],
  business: [
    'business_plan',
    'marketing_plan',
    'sales_copy',
    'financial_analysis',
    'operations_process',
    'customer_support_response',
    'product_strategy',
  ],
  education: [
    'lesson_plan',
    'exam_generation',
    'rubric_generation',
    'study_guide',
    'course_design',
    'flashcards',
  ],
  high_risk_domains: [
    'medical_guidance',
    'legal_guidance',
    'financial_advice',
    'employment_decision',
    'safety_critical_instruction',
  ],
};

const SIRA_EXECUTION_LAW = {
  do_not_answer_freely: true,
  compile_request_to_contract: true,
  validate_contract_before_execution: true,
  select_tools_only_from_registry: true,
  execute_as_dag: true,
  persist_state: true,
  require_evidence_for_factual_claims: true,
  require_format_sovereignty: true,
  run_deterministic_validators: true,
  repair_before_delivery: true,
  block_release_if_validation_fails: true,
  never_fake_scores: true,
  never_fake_file_reading: true,
  never_fake_citations: true,
  never_fake_artifacts: true,
};

const ciraTaskEnvelopeSchema = {
  $id: 'https://siragpt.io/schemas/cira-task-envelope.v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'request_id',
    'conversation_id',
    'user_id',
    'created_at',
    'raw_input',
    'normalized_request',
    'intent_analysis',
    'goal_model',
    'task_classification',
    'entities',
    'context_requirements',
    'data_ingestion_plan',
    'output_contract',
    'model_execution_context',
    'tool_plan',
    'agent_plan',
    'workflow_graph',
    'clarification_policy',
    'safety_and_permissions',
    'quality_plan',
    'ui_response_plan',
    'memory_policy',
    'cost_latency_policy',
    'observability',
    'execution_law',
    'frames',
    'final_answer_contract',
  ],
  properties: {
    schema_version: { type: 'string', enum: [CIRA_TASK_ENVELOPE_VERSION] },
    request_id: { type: 'string', pattern: '^req_[a-f0-9]{16}$' },
    conversation_id: { type: 'string' },
    user_id: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    raw_input: { type: 'object', additionalProperties: true },
    normalized_request: { type: 'object', additionalProperties: true },
    intent_analysis: { type: 'object', additionalProperties: true },
    goal_model: { type: 'object', additionalProperties: true },
    task_classification: { type: 'object', additionalProperties: true },
    entities: { type: 'object', additionalProperties: true },
    context_requirements: { type: 'object', additionalProperties: true },
    data_ingestion_plan: { type: 'object', additionalProperties: true },
    output_contract: { type: 'object', additionalProperties: true },
    model_execution_context: { type: 'object', additionalProperties: true },
    tool_plan: { type: 'object', additionalProperties: true },
    agent_plan: { type: 'object', additionalProperties: true },
    workflow_graph: { type: 'object', additionalProperties: true },
    clarification_policy: { type: 'object', additionalProperties: true },
    safety_and_permissions: { type: 'object', additionalProperties: true },
    quality_plan: { type: 'object', additionalProperties: true },
    ui_response_plan: { type: 'object', additionalProperties: true },
    memory_policy: { type: 'object', additionalProperties: true },
    cost_latency_policy: { type: 'object', additionalProperties: true },
    observability: { type: 'object', additionalProperties: true },
    execution_law: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(SIRA_EXECUTION_LAW),
      properties: Object.fromEntries(Object.keys(SIRA_EXECUTION_LAW).map((key) => [key, { type: 'boolean', const: true }])),
    },
    frames: {
      type: 'object',
      additionalProperties: false,
      required: ['intent_frame', 'plan_frame', 'tool_call_frame', 'artifact_frame', 'validation_frame'],
      properties: {
        intent_frame: { type: 'object', additionalProperties: true },
        plan_frame: { type: 'object', additionalProperties: true },
        tool_call_frame: { type: 'object', additionalProperties: true },
        artifact_frame: { type: 'object', additionalProperties: true },
        validation_frame: { type: 'object', additionalProperties: true },
      },
    },
    final_answer_contract: { type: 'object', additionalProperties: true },
  },
};

let compiledValidator = null;

function getValidator() {
  if (compiledValidator) return compiledValidator;
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  compiledValidator = ajv.compile(ciraTaskEnvelopeSchema);
  return compiledValidator;
}

function stableId(prefix, parts) {
  return `${prefix}_${crypto.createHash('sha256').update(parts.filter(Boolean).join(':')).digest('hex').slice(0, 16)}`;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function fileTypeFromAttachment(file = {}) {
  const name = String(file.filename || file.name || file.originalname || file.id || '').toLowerCase();
  const mime = String(file.mime_type || file.mimetype || file.type || '').toLowerCase();
  if (mime.includes('spreadsheet') || /\.(xlsx|xls|csv|tsv)$/.test(name)) return 'spreadsheet';
  if (mime.includes('word') || /\.(docx|doc)$/.test(name)) return 'document';
  if (mime.includes('pdf') || /\.pdf$/.test(name)) return 'pdf';
  if (mime.includes('presentation') || /\.(pptx|ppt)$/.test(name)) return 'presentation';
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/.test(name)) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'unknown';
}

function normalizeAttachments(files = []) {
  return (Array.isArray(files) ? files : []).map((file, index) => ({
    file_id: String(file.file_id || file.fileId || file.id || file.openaiFileId || file.name || `file_${index + 1}`),
    filename: String(file.filename || file.name || file.originalname || `attachment_${index + 1}`),
    mime_type: file.mime_type || file.mimetype || file.type || null,
    detected_type: file.detected_type || fileTypeFromAttachment(file),
    size_bytes: Number(file.size_bytes || file.size || 0),
    status: file.status || 'available',
  }));
}

function labelForIntent(intent) {
  const labels = {
    professional_document_generation: 'Generacion de documento profesional',
    complex_academic_document_generation: 'Generacion academica compleja',
    spreadsheet_generation: 'Generacion o analisis de hoja de calculo',
    presentation_generation: 'Generacion de presentacion',
    landing_page_generation: 'Generacion de landing page',
    web_app_generation: 'Generacion de aplicacion web',
    web_app_build: 'Construccion de aplicacion web',
    image_generation: 'Generacion de imagen',
    image_editing: 'Edicion de imagen',
    video_generation: 'Generacion de video',
    research_question: 'Investigacion con fuentes',
    text_answer: 'Respuesta directa',
    agent_long_running_task: 'Tarea agentica compleja',
  };
  return labels[intent] || intent.replace(/_/g, ' ');
}

function inferPrimaryIntent({ contract, semanticProfile = {}, structuredIntent = {}, raw }) {
  const requestedFormats = requestedFormatsFromContract(contract);
  const n = normalizeText(raw);
  if (requestedFormats.includes('docx') && (contract?.source_requirements?.required || contract?.citations_required)) {
    return 'complex_academic_document_generation';
  }
  if (requestedFormats.includes('docx')) return 'professional_document_generation';
  if (requestedFormats.includes('xlsx')) return 'spreadsheet_generation';
  if (requestedFormats.includes('pptx')) return 'presentation_generation';
  if (requestedFormats.includes('pdf')) return 'pdf_generation';
  if (requestedFormats.includes('svg')) return 'svg_generation';
  if (contract?.pipeline === 'ImagePipeline') return contract?.primary_intent === 'image_editing' ? 'image_editing' : 'image_generation';
  if (/\b(video|clip|animacion|animation|mp4)\b/.test(n)) return 'video_generation';
  if (contract?.pipeline === 'CodePipeline' && /\b(web|landing|website|pagina web|sitio web|web app|saas)\b/.test(n)) return 'landing_page_generation';
  if (contract?.pipeline === 'CodePipeline') return 'code_generation';
  if (contract?.pipeline === 'ResearchGroundingPipeline') return 'scientific_research';
  if (contract?.pipeline === 'RAGDocumentUnderstandingPipeline') return 'document_understanding';
  return structuredIntent.intent_primary || semanticProfile.primary_intent || contract?.primary_intent || 'general_question';
}

function requestedFormatsFromContract(contract) {
  const formats = new Set();
  if (contract?.required_extension) formats.add(contract.required_extension.replace(/^\./, ''));
  for (const node of contract?.multi_intent_dag?.nodes || []) {
    if (node.required_extension) formats.add(node.required_extension.replace(/^\./, ''));
  }
  return Array.from(formats);
}

function outputKindFromExt(ext) {
  const clean = String(ext || '').replace(/^\./, '');
  if (clean === 'docx') return 'word_document';
  if (clean === 'xlsx') return 'spreadsheet';
  if (clean === 'pptx') return 'presentation';
  if (clean === 'pdf') return 'pdf_document';
  if (clean === 'svg') return 'svg_artifact';
  if (clean === 'html') return 'web_artifact';
  if (clean === 'csv') return 'csv_file';
  if (clean === 'md') return 'markdown_file';
  if (clean === 'png' || clean === 'jpg' || clean === 'jpeg') return 'image';
  return clean ? `${clean}_artifact` : 'inline_summary';
}

function mimeFromFormat(format, contract) {
  if (contract?.required_extension?.replace(/^\./, '') === format && contract?.mime_type) return contract.mime_type;
  const mimes = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
    svg: 'image/svg+xml',
    html: 'text/html',
    csv: 'text/csv',
    md: 'text/markdown',
    json: 'application/json',
    png: 'image/png',
    mp4: 'video/mp4',
  };
  return mimes[format] || null;
}

function filenameFor(format, primaryIntent) {
  const stem = primaryIntent
    .replace(/_generation$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'cira_artifact';
  return `${stem}.${format}`;
}

function buildOutputContract({ contract, primaryIntent }) {
  let formats = requestedFormatsFromContract(contract);
  if (contract?.pipeline === 'ImagePipeline') formats = ['png'];
  if (primaryIntent === 'video_generation' && formats.length === 0) formats = ['mp4'];
  const outputs = formats.map((format) => ({
    type: 'file',
    artifact_kind: outputKindFromExt(format),
    format,
    mime_type: mimeFromFormat(format, contract),
    filename_suggestion: filenameFor(format, primaryIntent),
    required: true,
  }));
  const primaryOutput = outputs[0] || {
    type: 'inline_summary',
    artifact_kind: 'chat_answer',
    format: 'markdown',
    mime_type: 'text/markdown',
    filename_suggestion: null,
    required: true,
  };
  const secondaryOutputs = [
    ...outputs.slice(1),
    { type: 'inline_summary', format: 'markdown', required: true },
  ];

  return {
    primary_output: primaryOutput,
    secondary_outputs: secondaryOutputs,
    document_specification: {
      include_cover_page: formats.includes('docx') || formats.includes('pdf'),
      include_table_of_contents: formats.includes('docx') || formats.includes('pdf'),
      include_introduction: formats.includes('docx') || formats.includes('pdf'),
      include_methodology: contract?.source_requirements?.required || formats.includes('docx'),
      include_results: contract?.artifact_required,
      include_discussion: contract?.source_requirements?.required,
      include_conclusions: formats.includes('docx') || formats.includes('pdf'),
      include_references: Boolean(contract?.citations_required),
      include_appendices: 'if_needed',
      include_charts: /graf|chart|dashboard|excel|xlsx|datos|data/i.test(contract?.raw_user_request || ''),
      include_tables: Boolean(contract?.artifact_required || contract?.source_requirements?.required),
      citation_style: contract?.citations_required ? 'APA7' : null,
      tone: 'formal_professional',
      language: contract?.detected_language || 'es',
    },
    visual_specification: {
      charts_required: /graf|chart|dashboard|visual/i.test(contract?.raw_user_request || ''),
      chart_types_allowed: ['bar', 'line', 'pie', 'scatter', 'histogram', 'boxplot'],
      chart_quality: 'publication_ready',
      chart_export_formats: ['png', 'svg'],
      include_chart_descriptions: true,
    },
    accessibility: {
      alt_text_for_images: true,
      clear_heading_structure: true,
      table_headers_required: true,
    },
  };
}

function buildGoalModel({ contract, primaryIntent, outputContract }) {
  const requested = [
    outputContract.primary_output,
    ...(outputContract.secondary_outputs || []).filter((item) => item.type === 'file'),
  ];
  return {
    user_goal: contract?.raw_user_request || contract?.normalized_request || 'Atender solicitud del usuario.',
    business_goal: contract?.artifact_required
      ? 'Entregar un artefacto profesional verificable listo para descarga, revision o presentacion.'
      : 'Entregar una respuesta correcta, grounded y util dentro del chat.',
    success_criteria: [
      ...requested.map((item) => `Debe entregar ${item.format.toUpperCase()} valido.`),
      ...(contract?.source_requirements?.required ? ['Debe usar fuentes reales y verificables.', 'No debe inventar DOI, autores ni enlaces.'] : []),
      ...(contract?.citations_required ? ['Debe aplicar citas/referencias en APA 7 salvo instruccion contraria.'] : []),
      ...(contract?.grounding_required ? ['Debe respetar el contexto documental del hilo y archivos cargados.'] : []),
      'Debe estar redactado en el idioma del usuario salvo instruccion contraria.',
      'Debe pasar validaciones deterministas antes de entregarse.',
    ],
    non_goals: [
      'No modificar archivos originales del usuario.',
      'No ejecutar acciones externas sin permisos.',
      'No cambiar el formato final solicitado.',
      'No mostrar razonamiento interno ni contratos completos al usuario final.',
    ],
    assumptions: [
      {
        assumption: 'Si se solicitan fuentes academicas y no se especifica estilo, usar APA 7.',
        confidence: contract?.citations_required ? 0.86 : 0.42,
        needs_user_confirmation: false,
      },
      {
        assumption: 'La prioridad de ejecucion es calidad sobre velocidad.',
        confidence: 0.9,
        needs_user_confirmation: false,
      },
    ],
    mapped_primary_intent: primaryIntent,
  };
}

function buildTaskClassification({ contract, primaryIntent }) {
  return {
    task_type: contract?.pipeline === 'DirectAnswerPipeline' ? 'direct_answer' : 'multi_step_agentic_workflow',
    execution_category: contract?.pipeline || 'DirectAnswerPipeline',
    output_category: contract?.artifact_type === 'multiple' ? 'multi_artifact' : contract?.artifact_required ? 'artifact' : 'inline_answer',
    interaction_pattern: contract?.artifact_required ? 'plan_execute_validate_deliver' : 'understand_ground_validate_answer',
    requires_tool_use: (contract?.required_tools || []).some((tool) => tool !== 'finalize'),
    requires_file_processing: Boolean(contract?.grounding_required),
    requires_external_research: Boolean(contract?.source_requirements?.required),
    requires_code_execution: ['CodePipeline', 'SpreadsheetPipeline'].includes(contract?.pipeline) || primaryIntent.includes('code'),
    requires_visual_generation: ['ImagePipeline', 'VisualArtifactPipeline'].includes(contract?.pipeline) || /chart|visual|svg|image|video/.test(primaryIntent),
    requires_human_approval: contract?.pipeline === 'ActionExecutionPipeline' || contract?.risk_level === 'critical',
    can_answer_directly: contract?.pipeline === 'DirectAnswerPipeline' && !contract?.artifact_required,
  };
}

function buildEntities({ contract, attachments, outputContract }) {
  const dataFiles = attachments
    .filter((file) => ['spreadsheet', 'csv'].includes(file.detected_type) || file.filename.match(/\.(xlsx|xls|csv|tsv)$/i))
    .map((file) => ({ file_id: file.file_id, role: 'primary_dataset', expected_use: 'analysis_and_charts' }));
  return {
    requested_formats: [
      outputContract.primary_output?.format,
      ...outputContract.secondary_outputs.filter((item) => item.type === 'file').map((item) => item.format),
    ].filter(Boolean),
    document_type: contract?.artifact_type === 'document' || contract?.artifact_type === 'pdf' ? 'professional_report' : null,
    citation_style: {
      value: contract?.citations_required ? 'APA7' : null,
      source: contract?.citations_required ? 'default_or_explicit' : 'not_required',
      confidence: contract?.citations_required ? 0.84 : 0.2,
    },
    topic: {
      value: extractTopic(contract?.raw_user_request),
      source: 'inferred_from_request',
      confidence: extractTopic(contract?.raw_user_request) ? 0.68 : 0,
    },
    data_files: dataFiles,
    target_audience: {
      value: contract?.source_requirements?.required ? 'academic_or_professional_reader' : 'general_user',
      source: 'inferred',
      confidence: 0.75,
    },
    deadline: null,
    length_requirement: null,
    style_requirement: contract?.source_requirements?.required ? 'professional_academic' : 'professional',
  };
}

function extractTopic(raw) {
  const text = String(raw || '').trim();
  const about = text.match(/\b(?:sobre|acerca de|de|about)\s+(.{4,120})$/i);
  if (!about) return null;
  return about[1].replace(/\b(en|con|y|para)\b.*$/i, '').trim() || null;
}

function buildContextRequirements({ contract, attachments }) {
  return {
    needs_conversation_history: true,
    needs_user_profile: true,
    needs_project_memory: true,
    needs_uploaded_files: attachments.length > 0 || Boolean(contract?.grounding_required),
    needs_web_search: Boolean(contract?.source_requirements?.required),
    needs_scientific_apis: Boolean(contract?.source_requirements?.required || contract?.citations_required),
    needs_database_access: /base de datos|postgres|sql|database/i.test(contract?.raw_user_request || ''),
    needs_browser_automation: /navegador|scrap|browser|web automation|places|mapa/i.test(contract?.raw_user_request || ''),
    needs_code_sandbox: ['CodePipeline', 'SpreadsheetPipeline'].includes(contract?.pipeline),
    freshness_required: contract?.source_requirements?.required ? 'medium' : 'low',
    minimum_source_quality: contract?.source_requirements?.required ? 'scientific_or_institutional' : 'not_required',
    citation_required: Boolean(contract?.citations_required),
    source_validation_required: Boolean(contract?.source_requirements?.required),
  };
}

function buildDataIngestionPlan({ contract, attachments }) {
  return {
    files_to_process: attachments.map((file) => ({
      file_id: file.file_id,
      processor: processorForDetectedType(file.detected_type),
      extraction_targets: extractionTargetsForType(file.detected_type),
      quality_checks: qualityChecksForType(file.detected_type),
    })),
    external_sources: (contract?.source_requirements?.providers || []).map((source) => ({
      source: source.toLowerCase().replace(/\s+/g, '_'),
      purpose: source.toLowerCase().includes('crossref') ? 'doi_validation' : 'scientific_literature',
      required: true,
    })),
    source_ranking_strategy: {
      prefer: ['peer_reviewed_articles', 'doi_available', 'recent_sources', 'indexed_journals', 'official_institutions'],
      avoid: ['blogs_without_authority', 'uncited_claims', 'broken_links', 'non_academic_sources_for_academic_claims'],
    },
  };
}

function processorForDetectedType(type) {
  return {
    spreadsheet: 'spreadsheet_reader',
    document: 'docx_reader',
    pdf: 'pdf_layout_reader',
    presentation: 'pptx_reader',
    image: 'image_analyzer',
    audio: 'audio_transcriber',
    video: 'video_analyzer',
  }[type] || 'generic_file_reader';
}

function extractionTargetsForType(type) {
  if (type === 'spreadsheet') return ['sheet_names', 'columns', 'data_types', 'missing_values', 'descriptive_statistics', 'possible_variables', 'chart_candidates'];
  if (type === 'pdf') return ['pages', 'headings', 'tables', 'figures', 'citations', 'page_spans'];
  if (type === 'document') return ['headings', 'paragraphs', 'tables', 'images', 'comments', 'styles'];
  if (type === 'presentation') return ['slides', 'speaker_notes', 'layouts', 'images', 'tables'];
  return ['metadata', 'content_summary'];
}

function qualityChecksForType(type) {
  if (type === 'spreadsheet') return ['detect_empty_rows', 'detect_duplicate_rows', 'detect_invalid_values', 'detect_outliers', 'detect_formula_cells'];
  if (type === 'pdf') return ['ocr_needed', 'detect_scanned_pages', 'table_integrity', 'page_count'];
  if (type === 'document') return ['detect_empty_document', 'extract_first_word', 'style_integrity', 'table_integrity'];
  return ['file_readable', 'mime_consistent'];
}

function buildToolPlan({ contract, semanticProfile = {}, graph, primaryIntent }) {
  const toolSet = new Set([
    ...(contract?.required_tools || []),
    ...(semanticProfile?.required_tools || []),
    ...((graph?.nodes || []).flatMap((node) => node.tools || [])),
    ...(contract?.pipeline === 'ImagePipeline' ? ['image_prompt_builder', 'image_generation_api', 'image_quality_checker'] : []),
    ...(primaryIntent === 'video_generation' ? ['video_prompt_builder', 'video_generation_api', 'video_quality_checker'] : []),
  ]);
  if (contract?.pipeline === 'ImagePipeline') {
    for (const toolName of ['create_document', 'verify_artifact', 'design.tokens.build', 'wcag.contrast.check', 'design_system_generate']) {
      toolSet.delete(toolName);
    }
  }
  const tools = Array.from(toolSet).filter(Boolean);
  return {
    required_tools: tools.map((toolName) => ({
      tool_name: toolName,
      tool_type: toolType(toolName),
      reason: reasonForTool(toolName),
      priority: criticalTool(toolName) ? 'critical' : 'high',
      risk_level: toolName.includes('sandbox') || toolName.includes('python') || toolName.includes('code') ? 'medium' : 'low',
      permission_required: permissionForTool(toolName),
      input_dependencies: [],
      expected_output: expectedOutputForTool(toolName),
    })),
    optional_tools: [
      { tool_name: 'grammar_style_reviewer', reason: 'Pulir redaccion profesional si hay documento o respuesta larga.' },
      { tool_name: 'similarity_checker', reason: 'Revisar similitud textual en entregables academicos si se exige.' },
    ],
    forbidden_tools: (contract?.forbidden_tools || []).map((toolName) => ({
      tool_name: toolName,
      reason: 'Bloqueado por UniversalTaskContract o politica de seguridad.',
    })),
  };
}

function toolType(toolName) {
  if (/search|doi|source|ground/i.test(toolName)) return 'external_api';
  if (/rag|docintel|reader/i.test(toolName)) return 'file_processor';
  if (/python|sandbox|run_tests|code/i.test(toolName)) return 'code_execution';
  if (/create_document|renderer|artifact/i.test(toolName)) return 'artifact_generator';
  if (/verify|validator|qa/i.test(toolName)) return 'validator';
  return 'internal_tool';
}

function reasonForTool(toolName) {
  const reasons = {
    web_search: 'Buscar informacion actualizada o fuentes reales.',
    rag_retrieve: 'Recuperar evidencia de archivos o memoria privada.',
    self_rag_answer: 'Responder preguntas sobre documentos cargados sin perder contexto.',
    create_document: 'Crear el artefacto exacto solicitado.',
    verify_artifact: 'Validar integridad tecnica del archivo antes de entrega.',
    python_exec: 'Ejecutar calculos deterministas y analisis de datos.',
    run_tests: 'Ejecutar pruebas o invariantes sobre codigo generado.',
    finalize: 'Liberar respuesta final aprobada por validaciones.',
  };
  return reasons[toolName] || `Ejecutar capacidad registrada ${toolName}.`;
}

function criticalTool(toolName) {
  return ['create_document', 'verify_artifact', 'web_search', 'self_rag_answer', 'run_tests'].includes(toolName);
}

function permissionForTool(toolName) {
  if (/search|doi|source/i.test(toolName)) return 'external_api_access';
  if (/rag|reader|docintel/i.test(toolName)) return 'read_uploaded_or_project_file';
  if (/python|sandbox|run_tests|code/i.test(toolName)) return 'execute_sandboxed_code';
  if (/create_document|renderer/i.test(toolName)) return 'write_new_artifact';
  if (/finalize/i.test(toolName)) return 'release_response';
  return 'internal_execution';
}

function expectedOutputForTool(toolName) {
  if (/search|doi|source/i.test(toolName)) return 'verified_source_candidates';
  if (/rag|reader|docintel/i.test(toolName)) return 'grounded_context';
  if (/python|sandbox/i.test(toolName)) return 'computed_results';
  if (/run_tests/i.test(toolName)) return 'test_report';
  if (/create_document|renderer/i.test(toolName)) return 'artifact_file';
  if (/verify/i.test(toolName)) return 'validation_report';
  return 'structured_result';
}

function buildAgentPlan({ contract, graph }) {
  const roles = new Map();
  const add = (key, role, active = true) => roles.set(key, { role, active });
  add('supervisor_agent', 'Coordina la tarea completa, valida dependencias y decide cuando entregar.');
  add('planner_agent', 'Divide el objetivo en pasos ejecutables y DAG persistente.');
  for (const step of contract?.execution_plan || []) {
    const key = String(step.agent_role || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || step.id;
    add(key, step.objective);
  }
  if ((contract?.source_requirements?.required)) add('research_agent', 'Busca fuentes confiables y recientes.');
  if (contract?.citations_required) add('citation_agent', 'Valida DOI, metadatos y referencias APA 7.');
  if (contract?.artifact_required) add('artifact_agent', 'Convierte contenido estructurado en archivos finales.');
  if (graph?.nodes?.some((node) => node.layer === 'SecurityGovernanceLayer')) add('security_agent', 'Revisa permisos, datos sensibles, path traversal y acciones externas.');
  add('quality_validator_agent', 'Revisa coherencia, formato, fuentes, herramientas y archivos finales.');
  add('telemetry_agent', 'Registra trazas, eventos, metricas y evidencia sin datos sensibles.');
  return Object.fromEntries(roles.entries());
}

function buildWorkflowGraph({ contract, graph }) {
  const nodes = (graph?.nodes || []).map((node) => ({
    id: node.id,
    label: node.objective,
    agent: node.agent_role,
    tools: node.tools || [],
    depends_on: node.dependencies || [],
    status: node.state || 'planned',
    validation_gate: node.validation_gate || null,
    release_gate: node.release_gate || null,
  }));
  return {
    execution_mode: graph?.durable_execution?.enabled ? 'durable_multi_step' : 'single_turn',
    graph_id: graph?.graph_id || null,
    nodes,
    edges: graph?.edges || [],
    retry_policy: {
      max_retries_per_node: contract?.self_repair_plan?.max_retries ?? 2,
      retry_on: contract?.self_repair_plan?.triggers || ['tool_error'],
    },
    fallback_policy: {
      if_scientific_api_fails: 'use_alternative_source_api_or_report_verified_gap',
      if_pdf_export_fails: 'render_pdf_from_html_or_block_release',
      if_chart_generation_fails: 'repair_chart_pipeline_then_revalidate',
      if_tool_timeout: 'retry_with_backoff_then_surface_blocked_failure',
    },
  };
}

function buildSafetyAndPermissions({ contract }) {
  return {
    overall_risk_level: contract?.risk_level || 'low',
    risk_categories: [
      ...(contract?.source_requirements?.required ? [{ category: 'external_research', risk: 'source_quality_or_hallucinated_citations', mitigation: 'validate_sources_and_doi' }] : []),
      ...(contract?.artifact_required ? [{ category: 'file_handling', risk: 'accidental_overwrite', mitigation: 'write_new_artifacts_only' }] : []),
      ...(contract?.pipeline === 'CodePipeline' ? [{ category: 'code_execution', risk: 'unsafe_generated_code', mitigation: 'execute_only_in_sandbox' }] : []),
    ],
    requires_user_confirmation: contract?.pipeline === 'ActionExecutionPipeline' || contract?.risk_level === 'critical',
    allowed_actions: [
      'read_uploaded_files',
      'execute_sandboxed_analysis',
      'call_registered_tools',
      'create_new_artifacts',
    ],
    blocked_actions: [
      'delete_user_files',
      'overwrite_original_files',
      'send_email_without_confirmation',
      'publish_online_without_confirmation',
      'make_payments',
      'access_private_external_accounts_without_permission',
      'bypass_captcha_paywall_or_authentication',
    ],
    privacy: {
      contains_sensitive_data: 'unknown',
      should_mask_personal_data: true,
      store_in_memory: 'only_summary_if_user_allows',
    },
  };
}

function buildQualityPlan({ contract }) {
  const validators = [
    {
      name: 'intent_fulfillment_validator',
      checks: ['all_requested_outputs_created', 'all_required_sections_present', 'user_goal_satisfied'],
    },
    {
      name: 'artifact_validator',
      checks: (contract?.validation_plan || []).map((item) => item.check),
    },
    {
      name: 'language_validator',
      checks: ['same_language_as_user', 'formal_professional', 'no_unwanted_language_switching'],
    },
  ];
  if (contract?.source_requirements?.required) {
    validators.splice(1, 0, {
      name: 'source_validator',
      checks: ['no_fake_references', 'doi_or_url_present_when_available', 'sources_match_claims', 'citation_style_correct'],
    });
  }
  return {
    quality_level: contract?.quality_bar?.level || 'professional',
    validators,
    minimum_acceptance_score: (contract?.quality_bar?.min_quality_score || 88) / 100,
    regenerate_if_below_score: true,
  };
}

function buildUiResponsePlan({ contract, outputContract }) {
  return {
    show_progress_steps: true,
    progress_labels: [
      'Analizando solicitud',
      ...(contract?.grounding_required ? ['Leyendo contexto'] : []),
      ...(contract?.source_requirements?.required ? ['Buscando fuentes', 'Validando evidencia'] : []),
      ...(contract?.artifact_required ? ['Generando archivos', 'Validando entrega'] : ['Preparando respuesta']),
      'Listo',
    ],
    show_tool_activity: 'summarized',
    show_intermediate_preview: Boolean(contract?.artifact_required),
    final_response_style: 'concise_with_artifact_links',
    artifact_cards: [
      outputContract.primary_output,
      ...(outputContract.secondary_outputs || []).filter((item) => item.type === 'file'),
    ].filter((item) => item?.type === 'file').map((item) => ({
      type: 'download_card',
      label: item.artifact_kind || item.format,
      format: item.format,
    })),
  };
}

function buildFrames({ envelope }) {
  const planSteps = envelope.workflow_graph.nodes.map((node) => ({
    id: node.id,
    name: node.label,
    agent: node.agent,
    depends_on: node.depends_on,
  }));
  const toolCalls = envelope.tool_plan.required_tools.map((tool) => ({
    tool: tool.tool_name,
    arguments: {
      permission_required: tool.permission_required,
      expected_output: tool.expected_output,
      risk_level: tool.risk_level,
    },
  }));
  const artifacts = [
    envelope.output_contract.primary_output,
    ...(envelope.output_contract.secondary_outputs || []).filter((item) => item.type === 'file'),
  ].filter(Boolean).map((item) => ({
    type: item.artifact_kind || item.type,
    format: item.format,
    name: item.filename_suggestion || item.label || item.format,
    required: Boolean(item.required),
  }));
  const checks = envelope.quality_plan.validators.flatMap((validator) => (
    validator.checks || []
  )).filter(Boolean);

  return {
    intent_frame: {
      frame_type: 'intent_frame',
      primary_intent: envelope.intent_analysis.primary_intent.id,
      secondary_intents: envelope.intent_analysis.secondary_intents.map((item) => item.id),
      goal: envelope.goal_model.user_goal,
      confidence: envelope.intent_analysis.primary_intent.confidence,
      needs_clarification: envelope.clarification_policy.needs_clarification,
    },
    plan_frame: {
      frame_type: 'plan_frame',
      workflow_type: envelope.task_classification.execution_category,
      steps: planSteps,
    },
    tool_call_frame: {
      frame_type: 'tool_call_frame',
      tool_calls: toolCalls,
    },
    artifact_frame: {
      frame_type: 'artifact_frame',
      artifacts,
    },
    validation_frame: {
      frame_type: 'validation_frame',
      checks: Array.from(new Set(checks)).map((name) => ({ name, status: 'planned' })),
      ready_to_deliver: false,
    },
  };
}

function buildCiraCognitiveTaskEnvelope({
  rawUserRequest = '',
  conversationHistory = [],
  files = [],
  userId = null,
  chatId = null,
  contract,
  graph,
  toolRuntimePlan,
  qaBoardReview,
  semanticProfile = {},
  structuredIntent = {},
  modelRouting = null,
  now = new Date(),
} = {}) {
  if (!contract) throw new Error('CiraTaskEnvelope requires a UniversalTaskContract');
  if (!graph) throw new Error('CiraTaskEnvelope requires an ExecutionGraph');

  const requestText = String(rawUserRequest || contract.raw_user_request || '');
  const attachments = normalizeAttachments(files);
  const primaryIntent = inferPrimaryIntent({ contract, semanticProfile, structuredIntent, raw: requestText });
  const secondaryIntents = Array.from(new Set([
    ...(semanticProfile.secondary_intents || []),
    ...(structuredIntent.intent_secondary || []),
    ...(contract.secondary_intents || []),
  ])).filter((item) => item && item !== primaryIntent).slice(0, 18);
  const outputContract = buildOutputContract({ contract, primaryIntent });
  const goalModel = buildGoalModel({ contract, primaryIntent, outputContract });
  const envelope = {
    schema_version: CIRA_TASK_ENVELOPE_VERSION,
    request_id: stableId('req', [requestText, chatId, userId, now.toISOString()]),
    conversation_id: String(chatId || 'unknown_conversation'),
    user_id: String(userId || 'unknown_user'),
    created_at: now.toISOString(),
    raw_input: {
      text: requestText,
      input_language: contract.detected_language || 'unknown',
      input_mode: 'text',
      attachments,
      links: [],
      images: attachments.filter((file) => file.detected_type === 'image'),
      audio: attachments.filter((file) => file.detected_type === 'audio'),
      video: attachments.filter((file) => file.detected_type === 'video'),
    },
    normalized_request: {
      clean_text: contract.normalized_request || normalizeText(requestText),
      detected_language: contract.detected_language || 'unknown',
      target_language: contract.user_constraints?.find((item) => item.startsWith('language:'))?.split(':')[1] || contract.detected_language || 'es',
      translated_query_en: null,
      user_tone: 'direct_request',
      spelling_quality: normalizeText(requestText) === requestText.toLowerCase().trim() ? 'clear' : 'noisy_but_understandable',
      requires_context_resolution: Boolean(contract.grounding_required || conversationHistory.length > 0),
    },
    intent_analysis: {
      primary_intent: {
        id: primaryIntent,
        label: labelForIntent(primaryIntent),
        confidence: semanticProfile.confidence || structuredIntent.confidence || 0.78,
      },
      secondary_intents: secondaryIntents.map((id) => ({
        id,
        label: labelForIntent(id),
        confidence: id === 'doi_validation' || id === 'apa7_citation' ? 0.92 : 0.82,
      })),
      excluded_intents: excludedIntentsFor(primaryIntent),
      task_family: contract.artifact_required ? 'artifact_creation' : 'knowledge_work',
      task_domain: contract.source_requirements?.required ? 'academic_professional' : inferTaskDomain(primaryIntent),
      complexity_level: complexityForContract(contract, graph),
      ambiguity_level: ambiguityLabel(contract.ambiguity_score),
      novelty_level: 'medium',
      user_effort_expected: contract.ambiguity_score >= 0.8 ? 'medium' : 'low',
      system_autonomy_expected: contract.ambiguity_score >= 0.8 ? 'medium' : 'high',
    },
    goal_model: goalModel,
    task_classification: buildTaskClassification({ contract, primaryIntent }),
    entities: buildEntities({ contract, attachments, outputContract }),
    context_requirements: buildContextRequirements({ contract, attachments }),
    data_ingestion_plan: buildDataIngestionPlan({ contract, attachments }),
    output_contract: outputContract,
    model_execution_context: {
      selected_model: {
        provider: modelRouting?.selection?.provider || 'user_selected',
        model_id: modelRouting?.selection?.model?.id || 'selected_by_user',
        modality: contract.pipeline === 'ImagePipeline' ? 'image' : primaryIntent === 'video_generation' ? 'video' : 'text',
      },
      model_role: 'reasoning_and_generation',
      backend_role: 'tool_execution_artifact_rendering_and_validation',
      should_model_generate_final_file_directly: false,
      should_backend_render_artifacts: true,
      structured_output_required: true,
      temperature_policy: {
        planning: 0.2,
        research_synthesis: 0.3,
        creative_writing: 0.6,
        final_answer: 0.3,
      },
    },
    tool_plan: buildToolPlan({ contract, semanticProfile, graph, toolRuntimePlan, primaryIntent }),
    agent_plan: buildAgentPlan({ contract, graph }),
    workflow_graph: buildWorkflowGraph({ contract, graph }),
    clarification_policy: {
      needs_clarification: contract.ambiguity_score >= 0.8,
      clarification_reason: contract.ambiguity_score >= 0.8 ? 'missing_critical_execution_detail' : null,
      questions: contract.ambiguity_score >= 0.8 ? ['Que formato exacto o resultado final quieres que entregue?'] : [],
      auto_assumptions_allowed: contract.ambiguity_score < 0.8,
      act_without_clarification_if_confidence_above: 0.82,
      ask_user_if_confidence_below: 0.55,
    },
    safety_and_permissions: buildSafetyAndPermissions({ contract }),
    quality_plan: buildQualityPlan({ contract, qaBoardReview }),
    ui_response_plan: buildUiResponsePlan({ contract, outputContract }),
    memory_policy: {
      read_memory: true,
      write_memory: true,
      memory_items_to_read: ['preferred_language', 'preferred_citation_style', 'preferred_document_style', 'previous_project_context'],
      memory_items_to_write: [
        { key: 'preferred_output_format', value: requestedFormatsFromContract(contract).join('_') || 'chat', confidence: 0.78 },
        { key: 'prefers_professional_outputs', value: contract.quality_bar?.level !== 'standard', confidence: 0.82 },
      ],
      do_not_store: ['raw_sensitive_dataset', 'private_identifiers_without_consent'],
    },
    cost_latency_policy: {
      priority: 'quality_over_speed',
      max_tool_calls: contract.risk_level === 'high' ? 40 : 25,
      max_research_sources: contract.source_requirements?.required ? 20 : 0,
      max_final_sources: contract.source_requirements?.required ? 10 : 0,
      prefer_parallel_execution: true,
      expensive_tools_allowed: contract.quality_bar?.level === 'critical',
      fallback_to_cheaper_tools: false,
    },
    observability: {
      trace_required: true,
      log_model_calls: true,
      log_tool_calls: true,
      log_artifact_generation: true,
      log_validation_scores: true,
      redact_sensitive_data_in_logs: true,
      metrics: [
        'latency',
        'tool_success_rate',
        'artifact_success_rate',
        'source_validation_rate',
        'validation_pass_rate',
        'self_repair_rate',
        'cost_estimate',
      ],
    },
    execution_law: SIRA_EXECUTION_LAW,
    frames: null,
    final_answer_contract: {
      must_include: ['breve_resumen_de_lo_realizado', 'archivos_generados_si_aplica', 'advertencias_si_existen', 'fuentes_usadas_si_aplica'],
      must_not_include: ['razonamiento_interno_completo', 'datos_privados_no_solicitados', 'promesas_de_trabajo_futuro', 'contratos_internos_completos'],
      delivery_mode: contract.delivery_mode === 'inline-chat' ? 'chat' : 'chat_plus_artifacts',
    },
  };

  envelope.frames = buildFrames({ envelope });
  const validation = validateCiraCognitiveTaskEnvelope(envelope);
  if (!validation.ok) {
    const message = validation.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`CiraTaskEnvelope validation failed: ${message}`);
  }
  return envelope;
}

function inferTaskDomain(primaryIntent) {
  if (/web|code|app|landing/.test(primaryIntent)) return 'software_product';
  if (/image|video|svg|design/.test(primaryIntent)) return 'visual_creative';
  if (/spreadsheet|data|analytics/.test(primaryIntent)) return 'data_professional';
  return 'general_professional';
}

function excludedIntentsFor(primaryIntent) {
  const excluded = [];
  if (!/image/.test(primaryIntent)) excluded.push({ id: 'image_generation', reason: 'El usuario no pidio crear imagen generativa.' });
  if (!/video/.test(primaryIntent)) excluded.push({ id: 'video_generation', reason: 'El usuario no pidio video.' });
  if (!/web|code|app|landing/.test(primaryIntent)) excluded.push({ id: 'web_app_generation', reason: 'El usuario no pidio crear una aplicacion web.' });
  return excluded.slice(0, 4);
}

function complexityForContract(contract, graph) {
  if (contract?.risk_level === 'critical' || (graph?.nodes || []).length >= 12) return 'very_high';
  if (contract?.source_requirements?.required && contract?.artifact_required) return 'high';
  if (contract?.artifact_required || contract?.grounding_required) return 'medium';
  return 'low';
}

function ambiguityLabel(score = 0) {
  if (score >= 0.8) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

function validateCiraCognitiveTaskEnvelope(envelope) {
  const validate = getValidator();
  const ok = validate(envelope);
  return {
    ok: Boolean(ok),
    errors: ok ? [] : (validate.errors || []).map((error) => ({
      instancePath: error.instancePath,
      message: error.message,
      params: error.params,
    })),
  };
}

function buildCiraIntentEnginePrompt() {
  return [
    'You are Sira Intent Engine, the task-understanding layer for an advanced agentic platform.',
    'Do not answer the final user. Do not execute tools. Do not invent files, citations, sources or results.',
    'Compile every request into CiraTaskEnvelopeV1, then into IntentFrame, PlanFrame, ToolCallFrame, ArtifactFrame and ValidationFrame.',
    'If critical information is missing, ask at most three concrete clarification questions. Otherwise proceed with explicit assumptions.',
    'The backend, not the model, renders artifacts and runs deterministic validation before release.',
  ].join('\n');
}

module.exports = {
  CIRA_TASK_ENVELOPE_VERSION,
  UNIVERSAL_INTENT_TAXONOMY,
  CIRA_EXECUTION_LAW: SIRA_EXECUTION_LAW,
  SIRA_EXECUTION_LAW,
  ciraTaskEnvelopeSchema,
  buildCiraCognitiveTaskEnvelope,
  validateCiraCognitiveTaskEnvelope,
  buildCiraIntentEnginePrompt,
  INTERNAL: {
    normalizeAttachments,
    requestedFormatsFromContract,
    inferPrimaryIntent,
    buildOutputContract,
    buildFrames,
  },
};
