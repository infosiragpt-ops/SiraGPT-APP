'use strict';

const CATEGORIES = [
  'chat',
  'scientific_search',
  'documents',
  'presentations',
  'voice_audio',
  'agents_skills',
  'memory_context',
  'files_library',
  'admin_models',
  'production_quality',
];

const PHASES = [
  { id: 'p0', name: 'Foundation', description: 'Shared contracts, routing, metrics, and quality gates.' },
  { id: 'p1', name: 'User-critical flows', description: 'Chat latency, search precision, documents, PPT, voice, and cancellation.' },
  { id: 'p2', name: 'Professional workflows', description: 'Editable artifacts, citation quality, agent skills, memory, and library.' },
  { id: 'p3', name: 'Scale and operations', description: 'Cost controls, health, rollout safety, monitoring, and admin governance.' },
];

function item(id, category, phase, title, impact, effort, surfaces, acceptance) {
  return Object.freeze({ id, category, phase, title, impact, effort, surfaces, acceptance });
}

const IMPROVEMENTS = Object.freeze([
  item('chat-001', 'chat', 'p1', 'Reduce visible typing and send latency', 'high', 'm', ['chat'], 'P95 first local UI response is tracked and stays under the configured target.'),
  item('chat-002', 'chat', 'p1', 'Smooth token streaming lifecycle', 'high', 'm', ['chat', 'streaming'], 'Assistant messages expose pending, streaming, completed, failed, and cancelled states.'),
  item('chat-003', 'chat', 'p0', 'Clear generation stage labels', 'medium', 's', ['chat', 'agent_runs'], 'Long tasks show searching, planning, generating, validating, and delivering stages.'),
  item('chat-004', 'chat', 'p1', 'Always-visible stop button', 'high', 'm', ['chat', 'agent_runs'], 'Stop is available for model, file, audio, and agent generations.'),
  item('chat-005', 'chat', 'p2', 'Recover interrupted answers', 'high', 'l', ['chat', 'stream_resume'], 'A disconnected stream can resume or show a deterministic recovery action.'),
  item('chat-006', 'chat', 'p1', 'Adaptive chat width by panel state', 'medium', 's', ['chat_ui'], 'Main answer column keeps a readable width when side panels are open.'),
  item('chat-007', 'chat', 'p1', 'Compact activity panel', 'medium', 's', ['activity_panel'], 'Activity panel has bounded width and does not consume half the viewport.'),
  item('chat-008', 'chat', 'p2', 'Step-by-step agent activity', 'high', 'm', ['agent_runs', 'activity_panel'], 'Agent runs expose ordered tool steps with status and timestamps.'),
  item('chat-009', 'chat', 'p1', 'Visible sources for grounded answers', 'high', 'm', ['chat', 'sources'], 'Grounded answers include sources and confidence metadata.'),
  item('chat-010', 'chat', 'p2', 'Focus mode', 'medium', 'm', ['chat_ui'], 'User can collapse sidebars and panels without losing context.'),

  item('sci-011', 'scientific_search', 'p1', 'Multi-source scientific search engine', 'critical', 'm', ['scientific_search'], 'Queries can fan out across configured scientific providers with partial-result resilience.'),
  item('sci-012', 'scientific_search', 'p1', 'Crossref metadata grounding', 'high', 's', ['scientific_search', 'doi'], 'DOI and citation metadata are normalized from Crossref where available.'),
  item('sci-013', 'scientific_search', 'p1', 'OpenAlex coverage and ranking', 'high', 's', ['scientific_search'], 'OpenAlex results are deduped and ranked with provenance.'),
  item('sci-014', 'scientific_search', 'p1', 'PubMed biomedical coverage', 'high', 's', ['scientific_search'], 'Biomedical queries route PubMed near the front.'),
  item('sci-015', 'scientific_search', 'p1', 'Semantic Scholar enrichment', 'high', 's', ['scientific_search'], 'Semantic Scholar citations and abstracts enrich duplicate records.'),
  item('sci-016', 'scientific_search', 'p1', 'arXiv preprint coverage', 'medium', 's', ['scientific_search'], 'Technical queries include arXiv results and direct PDF URLs.'),
  item('sci-017', 'scientific_search', 'p1', 'Discipline, year, language, and study filters', 'high', 'm', ['scientific_search'], 'Search plans expose discipline and filter recommendations.'),
  item('sci-018', 'scientific_search', 'p1', 'Quality ranking for research results', 'critical', 'm', ['scientific_search', 'ranking'], 'Ranking considers relevance, DOI, abstract, open access, citations, recency, and source diversity.'),
  item('sci-019', 'scientific_search', 'p1', 'DOI and metadata validation', 'critical', 'm', ['scientific_search', 'citations'], 'Citation verifier flags missing or malformed DOI evidence.'),
  item('sci-020', 'scientific_search', 'p1', 'Nonexistent article detection', 'critical', 'm', ['scientific_search', 'citations'], 'Generated references are checked against provider metadata before being presented as real.'),

  item('doc-021', 'documents', 'p1', 'Direct DOCX editing without format loss', 'critical', 'l', ['documents', 'docx_edit'], 'DOCX edits preserve paragraphs, tables, styles, images, and numbering when possible.'),
  item('doc-022', 'documents', 'p1', 'APA 7 correction engine', 'high', 'm', ['documents', 'citations'], 'APA 7 output can be validated with deterministic citation checks.'),
  item('doc-023', 'documents', 'p1', 'Citation-to-bibliography cross-check', 'critical', 'm', ['documents', 'citations'], 'Inline citations and references are reconciled both ways.'),
  item('doc-024', 'documents', 'p1', 'Orphan citation detection', 'high', 's', ['documents'], 'Inline citations without bibliography entries are reported.'),
  item('doc-025', 'documents', 'p1', 'Uncited bibliography detection', 'high', 's', ['documents'], 'Bibliography entries not cited in text are reported.'),
  item('doc-026', 'documents', 'p2', 'Academic chapter rewriting', 'high', 'm', ['documents'], 'Sections can be improved by chapter while preserving academic tone.'),
  item('doc-027', 'documents', 'p1', 'Preserve tables, margins, and styles', 'critical', 'm', ['documents'], 'Validated DOCX output keeps core layout markers.'),
  item('doc-028', 'documents', 'p2', 'Annex generation', 'medium', 'm', ['documents'], 'Document pipeline can add structured annexes requested by prompt.'),
  item('doc-029', 'documents', 'p2', 'Exportable change summary', 'high', 'm', ['documents'], 'Every edit can include a concise list of changed sections.'),
  item('doc-030', 'documents', 'p1', 'Final validation before download', 'critical', 's', ['documents', 'download'], 'Artifact downloads are blocked or warned when validation fails.'),

  item('ppt-031', 'presentations', 'p1', 'Prompt-faithful PPT generation', 'critical', 'm', ['presentations'], 'Generated decks preserve requested topic, audience, and constraints.'),
  item('ppt-032', 'presentations', 'p1', 'Exact slide count enforcement', 'critical', 's', ['presentations'], 'Deck validation confirms exact slide count when requested.'),
  item('ppt-033', 'presentations', 'p1', 'Professional deck structure', 'high', 'm', ['presentations'], 'Decks include title, agenda, content, recommendation, and closing when appropriate.'),
  item('ppt-034', 'presentations', 'p2', 'Domain-specific presentation styles', 'high', 'm', ['presentations'], 'Templates adapt to thesis, business, sales, class, and report use cases.'),
  item('ppt-035', 'presentations', 'p1', 'Slide-by-slide preview', 'high', 'm', ['presentations', 'preview'], 'Preview exposes each slide in correct order and ratio.'),
  item('ppt-036', 'presentations', 'p2', 'Instructional slide repair', 'high', 'l', ['presentations', 'edit'], 'User can ask to revise a specific slide without regenerating the full deck.'),
  item('ppt-037', 'presentations', 'p2', 'Professional charts', 'medium', 'm', ['presentations', 'charts'], 'Charts are generated only when grounded data or user intent supports them.'),
  item('ppt-038', 'presentations', 'p2', 'Relevant image selection', 'medium', 'm', ['presentations', 'images'], 'Images match the subject and do not obscure content.'),
  item('ppt-039', 'presentations', 'p1', 'Editable PPTX export', 'critical', 'm', ['presentations', 'download'], 'PPTX opens as a native editable PowerPoint file.'),
  item('ppt-040', 'presentations', 'p1', 'Prompt validation report', 'high', 's', ['presentations'], 'Deck response exposes prompt-fidelity validation.'),

  item('voice-041', 'voice_audio', 'p1', 'Playable and downloadable audio', 'critical', 'm', ['voice', 'audio'], 'TTS output returns a playable URL and a download action.'),
  item('voice-042', 'voice_audio', 'p1', 'Keep voice tool active while generating', 'critical', 's', ['voice', 'chat_ui'], 'Voice mode remains selected until generation completes or is cancelled.'),
  item('voice-043', 'voice_audio', 'p1', 'Cancel audio generation', 'critical', 'm', ['voice', 'agent_runs'], 'Stop button cancels audio work and marks the task cancelled.'),
  item('voice-044', 'voice_audio', 'p2', 'Audio generation queue', 'high', 'm', ['voice', 'queues'], 'Concurrent audio generations are queued with clear status.'),
  item('voice-045', 'voice_audio', 'p1', 'Audio player card', 'high', 'm', ['voice', 'chat_ui'], 'Generated audio shows play, waveform/duration, share, and download controls.'),
  item('voice-046', 'voice_audio', 'p2', 'Favorite voices', 'medium', 'm', ['voice', 'settings'], 'Users can persist preferred voices.'),
  item('voice-047', 'voice_audio', 'p2', 'Persistent language and accent', 'medium', 'm', ['voice', 'settings'], 'Language and accent carry across voice turns.'),
  item('voice-048', 'voice_audio', 'p2', 'Speech-to-text transcription', 'high', 'm', ['voice', 'transcription'], 'Uploaded or recorded audio can become editable text.'),
  item('voice-049', 'voice_audio', 'p2', 'Document narration', 'high', 'l', ['voice', 'documents'], 'Documents can be narrated in sections.'),
  item('voice-050', 'voice_audio', 'p2', 'Audio history', 'medium', 'm', ['voice', 'library'], 'Generated audio artifacts are discoverable later.'),

  item('agent-051', 'agents_skills', 'p1', 'Automatic skill need detection', 'critical', 'm', ['agents', 'skills'], 'Agent routing recommends skills based on intent and artifact type.'),
  item('agent-052', 'agents_skills', 'p1', 'Skill registry by user/workspace', 'high', 'm', ['agents', 'skills'], 'Available skills are listed with scope and safety policy.'),
  item('agent-053', 'agents_skills', 'p1', 'Visible multi-step execution', 'high', 'm', ['agents'], 'Agent runs expose plan, tool calls, result, and verification.'),
  item('agent-054', 'agents_skills', 'p1', 'Scientific research agent', 'critical', 'm', ['agents', 'scientific_search'], 'Scientific prompts route to research-grounding with provider evidence.'),
  item('agent-055', 'agents_skills', 'p1', 'Academic document agent', 'critical', 'm', ['agents', 'documents'], 'Document prompts route to document pipeline with source preservation.'),
  item('agent-056', 'agents_skills', 'p1', 'Presentation agent', 'high', 'm', ['agents', 'presentations'], 'PPT prompts route to presentation pipeline with slide validation.'),
  item('agent-057', 'agents_skills', 'p2', 'Legal/notarial analysis agent', 'medium', 'l', ['agents', 'legal'], 'Legal document tasks expose jurisdiction-aware caveats and formatting checks.'),
  item('agent-058', 'agents_skills', 'p2', 'Marketing and sales agent', 'medium', 'm', ['agents', 'marketing'], 'Marketing prompts use campaign, copy, and conversion skills.'),
  item('agent-059', 'agents_skills', 'p2', 'Programming agent', 'high', 'm', ['agents', 'code'], 'Code tasks use repo search, tests, and patch verification.'),
  item('agent-060', 'agents_skills', 'p2', 'Project/company memory routing', 'high', 'm', ['agents', 'memory'], 'Agent context can be scoped to company/project memory.'),

  item('mem-061', 'memory_context', 'p1', 'User-editable memory', 'high', 'm', ['memory'], 'Users can inspect and remove saved memories.'),
  item('mem-062', 'memory_context', 'p1', 'Visible memory provenance', 'high', 'm', ['memory', 'activity_panel'], 'Memory cards show why they were used.'),
  item('mem-063', 'memory_context', 'p1', 'Delete single memory', 'high', 's', ['memory'], 'A single memory can be removed without clearing all context.'),
  item('mem-064', 'memory_context', 'p2', 'Separate personal, company, and chat memory', 'critical', 'l', ['memory', 'orgs'], 'Memory scope is explicit and enforced.'),
  item('mem-065', 'memory_context', 'p1', 'Duplicate memory suppression', 'medium', 's', ['memory'], 'Similar memories are collapsed or deduped.'),
  item('mem-066', 'memory_context', 'p1', 'Recency-aware memory ranking', 'medium', 's', ['memory'], 'Recent and high-confidence memories are ranked first.'),
  item('mem-067', 'memory_context', 'p2', 'Contradiction detection', 'high', 'm', ['memory', 'context'], 'Conflicting instructions are flagged before answer generation.'),
  item('mem-068', 'memory_context', 'p2', 'Professional profile per user', 'medium', 'm', ['memory', 'settings'], 'User profile supports tone, domain, and formatting preferences.'),
  item('mem-069', 'memory_context', 'p1', 'Document-scoped context', 'critical', 'm', ['memory', 'documents'], 'Document Q&A prefers the uploaded file context before global memory.'),
  item('mem-070', 'memory_context', 'p2', 'Conversation summary per chat', 'high', 'm', ['memory', 'chats'], 'Long chats produce compact durable summaries.'),

  item('file-071', 'files_library', 'p2', 'Advanced library search', 'high', 'm', ['library'], 'Files can be searched by title, text, type, date, and source.'),
  item('file-072', 'files_library', 'p2', 'Automatic file labels', 'medium', 'm', ['library'], 'Uploaded/generated files receive useful type labels.'),
  item('file-073', 'files_library', 'p1', 'Fast preview for office files', 'high', 'm', ['library', 'preview'], 'DOCX/PDF/PPTX/XLSX preview loads with bounded latency.'),
  item('file-074', 'files_library', 'p2', 'Chat with full folders', 'high', 'l', ['library', 'rag'], 'Folder-level RAG retrieves from all selected files.'),
  item('file-075', 'files_library', 'p2', 'PDF table extraction', 'high', 'm', ['library', 'pdf'], 'Tabular content is extracted with source page metadata.'),
  item('file-076', 'files_library', 'p2', 'Compare documents', 'high', 'm', ['library', 'documents'], 'Two documents can be compared with differences and summary.'),
  item('file-077', 'files_library', 'p2', 'Basic similarity/plagiarism signals', 'medium', 'm', ['library', 'documents'], 'Similarity warnings are separated from plagiarism claims.'),
  item('file-078', 'files_library', 'p2', 'Export reports', 'medium', 'm', ['library', 'reports'], 'Analysis output can be downloaded as DOCX/PDF/Markdown.'),
  item('file-079', 'files_library', 'p2', 'Generated file version history', 'high', 'l', ['library', 'artifacts'], 'Artifact versions are discoverable and restorable.'),
  item('file-080', 'files_library', 'p2', 'Recover previous artifacts', 'high', 'm', ['library', 'artifacts'], 'Users can access recently generated files from history.'),

  item('admin-081', 'admin_models', 'p2', 'Clear model catalog', 'medium', 'm', ['admin', 'models'], 'Admin model rows show provider, status, pricing, and capability.'),
  item('admin-082', 'admin_models', 'p2', 'Cost per conversation', 'high', 'm', ['admin', 'billing'], 'Conversation cost estimates are visible and auditable.'),
  item('admin-083', 'admin_models', 'p1', 'Model recommendation by task', 'high', 'm', ['models', 'routing'], 'Router recommends model tier from task complexity and modality.'),
  item('admin-084', 'admin_models', 'p1', 'Provider fallback on failure', 'critical', 'm', ['models', 'failover'], 'Provider errors trigger safe fallback when policy allows.'),
  item('admin-085', 'admin_models', 'p2', 'User and plan limits', 'high', 'm', ['admin', 'billing'], 'Usage limits are enforced and explained.'),
  item('admin-086', 'admin_models', 'p2', 'Company usage metrics', 'medium', 'l', ['admin', 'orgs'], 'Organizations can see aggregated usage and cost.'),
  item('admin-087', 'admin_models', 'p2', 'Safe provider activation', 'high', 'm', ['admin', 'providers'], 'Provider toggles validate required keys and health.'),
  item('admin-088', 'admin_models', 'p2', 'Internal model quality ranking', 'medium', 'l', ['admin', 'models'], 'Model quality is tracked by task outcome signals.'),
  item('admin-089', 'admin_models', 'p0', 'Secret-safe logs', 'critical', 's', ['logging', 'security'], 'Logs redact tokens, keys, cookies, and private URLs.'),
  item('admin-090', 'admin_models', 'p1', 'Provider outage alerts', 'high', 'm', ['admin', 'health'], 'Degraded provider state is visible before users hit it.'),

  item('ops-091', 'production_quality', 'p0', 'Automated pre-deploy tests', 'critical', 'm', ['ci', 'deploy'], 'Deploys require configured quality gates.'),
  item('ops-092', 'production_quality', 'p0', 'Visible admin health checks', 'high', 'm', ['health', 'admin'], 'Health report includes db, redis, queues, auth, and providers.'),
  item('ops-093', 'production_quality', 'p0', 'Backups before risky deploys', 'critical', 'm', ['deploy', 'backups'], 'Production deploy runbook includes backup path and no-volume-delete rule.'),
  item('ops-094', 'production_quality', 'p0', 'Fast rollback', 'critical', 'm', ['deploy'], 'Frontend/backend rollback path is documented and tested.'),
  item('ops-095', 'production_quality', 'p1', 'Real-time error monitoring', 'high', 'm', ['observability'], 'Operational errors are aggregated without leaking secrets.'),
  item('ops-096', 'production_quality', 'p1', 'Route performance dashboard', 'high', 'm', ['observability'], 'Key API latency metrics are captured per route.'),
  item('ops-097', 'production_quality', 'p2', 'Professional onboarding', 'medium', 'l', ['onboarding'], 'New users can reach first successful task quickly.'),
  item('ops-098', 'production_quality', 'p2', 'Plan and limit clarity', 'medium', 'm', ['billing', 'ui'], 'Plan limits appear before failure states.'),
  item('ops-099', 'production_quality', 'p1', 'Feedback per response/artifact', 'high', 'm', ['feedback'], 'Users can rate answer and generated artifact quality.'),
  item('ops-100', 'production_quality', 'p2', 'In-app help center', 'medium', 'm', ['help'], 'Users can discover help by task type and failure state.'),
]);

const PIPELINE_CATEGORY_MAP = Object.freeze({
  'direct-answer': ['chat', 'memory_context'],
  'research-grounding': ['scientific_search', 'agents_skills', 'documents'],
  document: ['documents', 'files_library', 'memory_context'],
  presentation: ['presentations', 'files_library', 'agents_skills'],
  pdf: ['documents', 'files_library'],
  spreadsheet: ['documents', 'files_library'],
  code: ['agents_skills', 'production_quality'],
  'visual-artifact': ['files_library', 'production_quality'],
  'rag-document-understanding': ['documents', 'memory_context', 'files_library'],
  'action-execution': ['agents_skills', 'production_quality'],
  'multi-intent': CATEGORIES,
  unknown: ['production_quality'],
});

const QUALITY_PROFILES = Object.freeze({
  chat: ['latency', 'stream_state', 'cancelability', 'source_visibility', 'layout_stability'],
  scientific_search: ['provider_diversity', 'doi_validation', 'relevance_ranking', 'source_quality', 'nonexistent_reference_detection'],
  documents: ['format_preservation', 'citation_integrity', 'layout_validation', 'artifact_openability', 'change_summary'],
  presentations: ['prompt_fidelity', 'exact_slide_count', 'editable_pptx', 'slide_preview', 'grounded_visuals'],
  voice_audio: ['playable_audio', 'downloadable_audio', 'cancelability', 'mode_persistence', 'artifact_history'],
  agents_skills: ['skill_routing', 'tool_trace', 'step_status', 'verification', 'safe_fallback'],
  memory_context: ['scope_control', 'provenance', 'dedupe', 'recency_ranking', 'contradiction_detection'],
  files_library: ['preview_latency', 'type_labels', 'versioning', 'folder_retrieval', 'download_integrity'],
  admin_models: ['provider_health', 'cost_visibility', 'model_capabilities', 'fallback_policy', 'redacted_logs'],
  production_quality: ['ci_gates', 'health_checks', 'rollback', 'backup_policy', 'observability'],
});

function listImprovements(filters = {}) {
  const categories = normalizeList(filters.category || filters.categories);
  const phases = normalizeList(filters.phase || filters.phases);
  const surfaces = normalizeList(filters.surface || filters.surfaces);
  let items = IMPROVEMENTS;
  if (categories.length) items = items.filter((x) => categories.includes(x.category));
  if (phases.length) items = items.filter((x) => phases.includes(x.phase));
  if (surfaces.length) items = items.filter((x) => x.surfaces.some((surface) => surfaces.includes(surface)));
  return applyLimit(items, filters.limit);
}

function getImprovement(id) {
  return IMPROVEMENTS.find((x) => x.id === id) || null;
}

function summarizeImprovements() {
  const byCategory = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  const byPhase = Object.fromEntries(PHASES.map((phase) => [phase.id, 0]));
  for (const improvement of IMPROVEMENTS) {
    byCategory[improvement.category] += 1;
    byPhase[improvement.phase] += 1;
  }
  return {
    total: IMPROVEMENTS.length,
    categories: CATEGORIES,
    phases: PHASES,
    byCategory,
    byPhase,
  };
}

function categoriesForPipeline(pipelineId) {
  return PIPELINE_CATEGORY_MAP[pipelineId] || PIPELINE_CATEGORY_MAP.unknown;
}

function qualityProfileForPipeline(pipelineId) {
  const categories = categoriesForPipeline(pipelineId);
  const checks = [];
  for (const category of categories) {
    for (const check of QUALITY_PROFILES[category] || []) {
      if (!checks.includes(check)) checks.push(check);
    }
  }
  return { pipelineId, categories, checks };
}

function recommendImprovements({ pipelineId, category, phase, surface, limit = 10 } = {}) {
  const categories = category ? normalizeList(category) : (pipelineId ? categoriesForPipeline(pipelineId) : []);
  return listImprovements({ categories, phase, surface, limit });
}

function normalizeList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

function applyLimit(items, limit) {
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return [...items];
  return items.slice(0, Math.min(n, 100));
}

module.exports = {
  CATEGORIES,
  PHASES,
  IMPROVEMENTS,
  QUALITY_PROFILES,
  PIPELINE_CATEGORY_MAP,
  listImprovements,
  getImprovement,
  summarizeImprovements,
  categoriesForPipeline,
  qualityProfileForPipeline,
  recommendImprovements,
};
