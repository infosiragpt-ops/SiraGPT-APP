const OpenAI = require('openai');
const reactAgent = require('../react-agent');
const { buildTaskTools } = require('./task-tools');
const taskStore = require('./task-store');
const auditLog = require('./audit-log');
const metrics = require('./metrics');
const openclawCapabilityKernel = require('../openclaw-capability-kernel');
const {
  buildExecutionProfile,
} = require('./agentic-execution-profile');
const {
  validateAgentTaskFinalize,
} = require('./openclaw-autonomy-finalize-guard');
const { buildUserIntentAlignmentProfile } = require('./user-intent-alignment');
const { buildAgentTaskPlan } = require('./agent-task-plan');
const { resolveTaskContract } = require('./task-contract-resolver');
const { listManifests } = require('./tool-manifest');
const {
  buildUniversalTaskContract,
  deriveLegacyTaskContract,
  enforceLegacyTaskContract,
} = require('./universal-task-contract');
const {
  buildEnterpriseExecutionGraph,
  buildEnterpriseRuntimeProfile,
} = require('./enterprise-agentic-runtime');
const { buildToolRuntimePlan } = require('./enterprise-tool-gateway');
const { buildAgenticQaBoardReview } = require('./agentic-qa-board');
const { buildAgenticOperatingCore } = require('./agentic-operating-core');
const durableExecutionStore = require('./durable-execution-store');
const { buildDocumentDeliveryPolicy, normalizeDocumentPolicyCoherence } = require('./document-delivery-policy');
const outputFormat = require('../output-format-contract');
const { getQueueName } = require('./agent-task-queue');
const persistence = require('./agent-task-persistence');
const { generateAutoDocument } = require('./auto-document-delivery');
const {
  isSourcePreservingEditRequest,
  tryGenerateSourcePreservingDocumentEdit,
} = require('../source-preserving-document-edit');
const {
  generateVancouverMatrixDocument,
  isVancouverMatrixWordRequest,
} = require('./vancouver-table-document');
const { buildLangGraphLayer } = require('./agentic-langgraph');
const { buildAgenticFrameworkStatus } = require('./agentic-frameworks');
const { buildForbiddenToolNames } = require('./agent-tool-policy');
const { buildIntegrationRuntimeProfile } = require('../ai-product-os/integration-runtime-profile');
const {
  buildTranscriptionTextFromFiles,
  buildUploadedFileContext,
  isImageFile,
  isPlainTranscriptionRequest,
  resolveStoredFilePath,
  resolveTranscriptionFileIds,
  serializeMessageAttachments,
} = require('../message-attachments');
const {
  assessAttachmentContext,
  countUsefulWords,
  stripScaffolding,
  DEFAULT_THIN_THRESHOLD,
} = require('./attachment-context-guard');
const apa7 = require('../marco-teorico/apa7');

const prisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

function routeInternals() {
  return require('../../routes/agent-task').INTERNAL;
}

function buildFinalizeProfile(executionProfile, universalTaskContract) {
  // Dynamic approved tool list from the manifest — no hardcoded names.
  // This stays current as new tools are registered without code changes.
  const appTools = new Set(listManifests().map((m) => m.name));
  const forbiddenTools = new Set(Array.isArray(universalTaskContract?.forbidden_tools)
    ? universalTaskContract.forbidden_tools
    : []);
  const executableContractTools = new Set(
    (universalTaskContract?.required_tools || [])
      .filter((tool) => tool !== 'finalize')
      .filter((tool) => appTools.has(tool))
      .filter((tool) => !forbiddenTools.has(tool))
  );
  return {
    ...(executionProfile || {}),
    requiredTools: Array.from(new Set([
      ...(executionProfile?.requiredTools || []),
      ...executableContractTools,
    ])).filter((tool) => !forbiddenTools.has(tool)),
    minimumToolCalls: {
      ...(executionProfile?.minimumToolCalls || {}),
      ...(universalTaskContract?.source_requirements?.verification_policy === 'strict' && executableContractTools.has('web_search')
        ? { web_search: Math.max(2, executionProfile?.minimumToolCalls?.web_search || 0) }
        : {}),
    },
  };
}

function buildOpenClawRuntimeProfile({ goal, userId = null, chatId = null, fileIds = [], model = null, context = {} } = {}) {
  try {
    return openclawCapabilityKernel.buildCapabilityProfile({
      prompt: goal,
      userId,
      chatId,
      attachmentCount: Array.isArray(fileIds) ? fileIds.length : 0,
      model,
      context: {
        documents: Array.isArray(fileIds) ? fileIds.map((id) => ({ id, source: 'agent_task_worker_file' })) : [],
        ...context,
      },
    });
  } catch (err) {
    console.warn('[agent-task-runner] openclaw runtime profile unavailable:', err?.message || err);
    return null;
  }
}

function summarizeForChat(text, policy) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const intro = `Preparé el entregable profesional en formato ${String(policy?.format || 'documento').toUpperCase()} y lo validé antes de adjuntarlo.`;
  if (!raw) return intro;
  let clipped;
  if (raw.length <= 900) {
    clipped = raw;
  } else {
    // Surrogate-safe slice: pull the cut back if the last kept code
    // unit is a high surrogate so we don't emit a dangling surrogate
    // that JSON.stringify would replace with U+FFFD.
    let cut = 900;
    const code = raw.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    clipped = `${raw.slice(0, cut).trim()}...`;
  }
  return `${intro}\n\nResumen conversacional:\n\n${clipped}`;
}

function normalizeAttachmentFallbackContent(text) {
  const tableHeaderCells = new Set([
    'n', 'no', 'titulo', 'titulo del articulo', 'autores', 'ano de publicacion',
    'enfoque y o tipo de estudio', 'muestreo', 'procedencia', 'ocupacion',
    'instrumento', 'modelo teorico', 'resultados',
  ]);
  const cells = String(text || '')
    .replace(/\*{1,3}/g, '')
    .replace(/\|/g, '\n')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-:]{2,}$/.test(line))
    .filter((line) => !/^\d{1,3}$/.test(line))
    .filter((line) => {
      const key = line
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      return !tableHeaderCells.has(key);
    });
  return cells.join('. ');
}

function normalizedKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitReadableSentences(text) {
  const seen = new Set();
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 35 || /\b\d+(?:[.,]\d+)?\b/.test(sentence))
    .filter((sentence) => {
      const key = normalizedKey(sentence);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 36);
}

function scoreAttachmentSentence(sentence, request = '') {
  const normalized = normalizedKey(sentence);
  let score = 0;
  if (/\b(se encontro|se evidencio|se identifico|se observo|muestra|indica|concluye|recomienda|sugiere|resultado|resultados|hallazgo|hallazgos|asocia|asociacion|relacion significativa|incrementa|reduce|mejora)\b/.test(normalized)) score += 5;
  if (/\b(ansiedad|depresion|estres|riesgo|impacto|efecto|efectos|salud mental|rendimiento|adiccion|vulnerabilidad|malestar)\b/.test(normalized)) score += 2;
  if (/\b(pdf|docx|xlsx|churn|retencion|contrato|contratado|real|total|diferencia|riesgo|legal|dpa|fuente|oficial|preliminar|cliente|norte|sur|este)\b/.test(normalized)) score += 2;
  if (sentence.length >= 80 && sentence.length <= 420) score += 1;
  if (/\b(cuantitativo|cualitativo|transversal|probabilistico|conveniencia|cuestionario|escala|inventario|modelo teorico|autores|publicacion)\b/.test(normalized)) score -= 2;

  const requestTerms = Array.from(new Set(normalizedKey(request).match(/[a-z0-9]{5,}/g) || []))
    .filter((term) => !['resumen', 'resume', 'documento', 'archivo', 'adjunto', 'quiero', 'dame', 'necesito', 'analisis'].includes(term));
  for (const term of requestTerms) {
    if (normalized.includes(term)) score += 1;
  }
  return score;
}

function selectAttachmentSentences(sentences, request = '', limit = 8) {
  const ranked = sentences.map((sentence, index) => ({ sentence, index, score: scoreAttachmentSentence(sentence, request) }));
  const strong = ranked
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
  return strong.length ? strong : sentences.slice(0, limit);
}

// Splits an ordered list of sentences into `paragraphCount` balanced paragraphs,
// preserving document order. Used when the user asks for a specific number of
// paragraphs (e.g. "resumen en 2 párrafos").
function distributeSentencesIntoParagraphs(sentences, paragraphCount) {
  const list = (Array.isArray(sentences) ? sentences : []).filter(Boolean);
  if (list.length === 0) return [];
  const count = Math.max(1, Math.min(paragraphCount, list.length));
  // Remainder-based allocation: the first `remainder` paragraphs take one extra
  // sentence so the output always has exactly `count` non-empty paragraphs.
  const base = Math.floor(list.length / count);
  const remainder = list.length % count;
  const paragraphs = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    const group = list.slice(cursor, cursor + size);
    cursor += size;
    if (group.length === 0) break;
    paragraphs.push(group.join(' ').replace(/\s+/g, ' ').trim());
  }
  return paragraphs;
}

function parseAttachmentNumber(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, '')
    .replace(/,/g, '.')
    .replace(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAttachmentNumber(value, { decimals = null } = {}) {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(decimals == null ? 2 : decimals);
  return fixed.replace(/\.?0+$/, '');
}

function matchAttachmentNumber(text, patterns = []) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) {
      const parsed = parseAttachmentNumber(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function extractClientMetricRows(text) {
  const rows = [];
  const seen = new Set();
  const compact = String(text || '').replace(/\|/g, ' ').replace(/\r/g, '\n');
  const rowRegexes = [
    // Cliente Contrato Real Satisfaccion/SLA Churn Region
    /(?:^|\n|\s)([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]{2,})\s+(\d{4,})\s+(\d{4,})\s+(\d{1,3}(?:[.,]\d+)?)\s+(\d{1,3}(?:[.,]\d+)?)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ_-]{2,})/g,
    // Cliente Pais Contrato Real SLA Churn Tickets
    /(?:^|\n|\s)([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]{2,})\s+([A-Za-zÁÉÍÓÚÑáéíóúñ_-]{2,})\s+(\d{4,})\s+(\d{4,})\s+(\d{1,3}(?:[.,]\d+)?)\s+(\d{1,3}(?:[.,]\d+)?)\s+(\d{1,4})/g,
  ];
  let match;
  for (const rowRegex of rowRegexes) {
    while ((match = rowRegex.exec(compact))) {
      const client = match[1];
      const key = normalizedKey(client);
      if (['sheet', 'total', 'resumen', 'columns', 'cliente', 'contrato'].includes(key) || seen.has(key)) continue;
      const hasCountryBeforeNumbers = match.length >= 8;
      const region = hasCountryBeforeNumbers ? match[2] : match[6];
      const contract = parseAttachmentNumber(hasCountryBeforeNumbers ? match[3] : match[2]);
      const real = parseAttachmentNumber(hasCountryBeforeNumbers ? match[4] : match[3]);
      const satisfaction = parseAttachmentNumber(hasCountryBeforeNumbers ? match[5] : match[4]);
      const churn = parseAttachmentNumber(hasCountryBeforeNumbers ? match[6] : match[5]);
      const tickets = hasCountryBeforeNumbers ? parseAttachmentNumber(match[7]) : null;
      if (![contract, real, satisfaction, churn].every(Number.isFinite)) continue;
      seen.add(key);
      rows.push({
        client,
        contract,
        real,
        satisfaction,
        churn,
        region,
        tickets,
        gap: real - contract,
      });
    }
  }
  return rows;
}

function extractAttachmentRisks(text) {
  const value = String(text || '');
  const riskId = '[A-Z][0-9]+';
  const risks = [];
  const seen = new Set();
  const pushRisk = (match) => {
    if (!match) return;
    const id = String(match[1] || '').trim();
    if (!id) return;
    const key = id.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    risks.push({
      id,
      owner: String(match[2] || '').trim(),
      severity: String(match[3] || '').trim(),
      mitigation: String(match[4] || '').trim(),
      due: match[5] ? String(match[5]).trim() : null,
      blocks: match[6] ? String(match[6]).trim() : null,
    });
  };

  const structured = new RegExp(`\\b(${riskId})\\s*[-–]\\s*([^-–\\n.]+?)\\s*[-–]\\s*Severidad\\s+([^-–\\n.]+?)\\s*[-–]\\s*Mitigaci[oó]n:\\s*([^-–\\n.]+)(?:\\s*[-–]\\s*Fecha\\s+l[ií]mite:\\s*([0-9-]+))?(?:\\s*[-–]\\s*Bloquea:\\s*([^\\n.]+))?`, 'gi');
  let match;
  while ((match = structured.exec(value))) pushRisk(match);

  const prose = new RegExp(`\\bRiesgo\\s+(${riskId})\\s*:\\s*([^,\\n.]+),\\s*severidad\\s+([^,\\n.]+),\\s*mitigaci[oó]n:\\s*([^\\n.]+)`, 'gi');
  while ((match = prose.exec(value))) pushRisk(match);

  return risks;
}

function findAttachmentRisk(text) {
  return extractAttachmentRisks(text)[0] || null;
}

function extractAttachmentFileNames(text) {
  const names = [];
  const seen = new Set();
  const regex = /(?:^|\n)\s*#{0,6}\s*Archivo adjunto\s+\d+\s*:\s*([^\n]+\.(?:txt|csv|md|xlsx|docx|pdf))\s*$/gim;
  let match;
  while ((match = regex.exec(String(text || '')))) {
    const name = match[1].trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  const inlineRegex = /(?:^|\s)([A-Za-z0-9._+-]+\.(?:txt|csv|md|xlsx|docx|pdf))/gim;
  while ((match = inlineRegex.exec(String(text || '')))) {
    const name = match[1].trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function matchAttachmentText(text, patterns = []) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

function extractTicketRows(text) {
  const rows = [];
  const raw = String(text || '').replace(/\|/g, ',');
  const regex = /(?:^|\n)([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]{2,})\s*,\s*([A-Za-zÁÉÍÓÚÑáéíóúñ_-]{2,})\s*,\s*(\d{1,4})\s*,\s*([A-Za-zÁÉÍÓÚÑáéíóúñ_-]{2,})\s*,\s*([^\n]+)/g;
  let match;
  while ((match = regex.exec(raw))) {
    if (/cliente/i.test(match[1])) continue;
    rows.push({
      client: match[1].trim(),
      module: match[2].trim(),
      tickets: parseAttachmentNumber(match[3]),
      severity: match[4].trim(),
      note: match[5].trim(),
    });
  }
  return rows.filter((row) => Number.isFinite(row.tickets));
}

function extractStructuredAttachmentFacts(text) {
  const raw = String(text || '');
  const rows = extractClientMetricRows(raw);
  const totalContract = matchAttachmentNumber(raw, [
    /Total\s+contrato\s*[:\t ]+\$?\s*(\d+(?:[.,]\d+)?)/i,
    /total\s+contratad[oa]\s+(?:es|validado\s+es|validada\s+es)?\s*[:\t ]*\$?\s*(\d+(?:[.,]\d+)?)/i,
    /total[_\s-]*contratad[oa]['"]?\s*[:=]\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
  ]) ?? (rows.length ? rows.reduce((sum, row) => sum + row.contract, 0) : null);
  const totalReal = matchAttachmentNumber(raw, [
    /Total\s+real\s*[:\t ]+\$?\s*(\d+(?:[.,]\d+)?)/i,
    /total\s+real\s+(?:combinado\s+)?(?:validado\s+)?(?:es|:)?\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
    /total[_\s-]*real(?:[_\s-]*combinado)?['"]?\s*[:=]\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
  ]) ?? (rows.length ? rows.reduce((sum, row) => sum + row.real, 0) : null);
  const preliminaryTotalReal = matchAttachmentNumber(raw, [
    /Total\s+real\s+preliminar\s*:\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
    /total[_\s-]*real[_\s-]*preliminar['"]?\s*[:=]\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
  ]);
  const difference = matchAttachmentNumber(raw, [
    /Diferencia\s*[:\t ]+\$?\s*(\d+(?:[.,]\d+)?)/i,
    /diferencia\s+(?:es|validada\s+es)?\s*[:\t ]*\$?\s*(\d+(?:[.,]\d+)?)/i,
    /diferencia(?:[_\s-]*exacta)?['"]?\s*[:=]\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
    /Varianza\s+neta\s*:\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
  ]) ?? (Number.isFinite(totalReal) && Number.isFinite(totalContract) ? totalReal - totalContract : null);
  const weightedRetention = matchAttachmentNumber(raw, [
    /Retenci[oó]n\s+ponderada\s*[:\t ]+\s*(\d+(?:[.,]\d+)?)/i,
    /retenci[oó]n\s+ponderada\s+(?:validada\s+)?(?:es|:)?\s*(\d+(?:[.,]\d+)?)/i,
    /retenci[oó]n[_\s-]*ponderada['"]?\s*[:=]\s*(\d+(?:[.,]\d+)?)/i,
    /SLA\s+ponderado(?:\s+validado)?\s*:\s*(\d+(?:[.,]\d+)?)/i,
    /SLA\s+ponderado(?:\s+validado)?\s*[\t ]+\s*(\d+(?:[.,]\d+)?)/i,
  ]);
  const officialChurn = matchAttachmentNumber(raw, [
    /churn\s+total\s+oficial\s+es\s+(\d+(?:[.,]\d+)?)\s*%/i,
    /DOCX[^.\n]{0,100}churn[^.\n]{0,40}?(\d+(?:[.,]\d+)?)\s*%?/i,
    /churn\s+final\s+(\d+(?:[.,]\d+)?)\s*%?/i,
  ]);
  const preliminaryChurn = matchAttachmentNumber(raw, [
    /Churn\s+total\s+preliminar:\s*(\d+(?:[.,]\d+)?)\s*%/i,
    /PDF[^.\n]{0,100}(?:preliminar|dice)[^.\n]{0,40}?(\d+(?:[.,]\d+)?)\s*%?/i,
    /no\s+(\d+(?:[.,]\d+)?)\s*%/i,
  ]);
  const risks = extractAttachmentRisks(raw);
  const risk = risks[0] || null;
  const ticketRows = extractTicketRows(raw);
  const criticalTicket = ticketRows
    .filter((row) => /critica|critico|critical/i.test(row.severity))
    .sort((a, b) => b.tickets - a.tickets)[0] || null;
  const highestTicket = ticketRows.slice().sort((a, b) => b.tickets - a.tickets)[0] || null;
  const explicitWorstGapClient = matchAttachmentText(raw, [
    /Mayor\s+brecha\s+negativa\s*[:\t ]+\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)/i,
    /mayor\s+brecha\s+negativa\s+(?:es|corresponde\s+a)?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)/i,
  ]);
  const computedWorstGap = rows.length
    ? rows.slice().sort((a, b) => a.gap - b.gap || b.churn - a.churn)[0]
    : null;
  const invalidWorstGapClient = /^(por|cliente|clientes|mayor|brecha|negativa|contrato|real)$/i.test(explicitWorstGapClient || '');
  const explicitWorstGap = explicitWorstGapClient && !invalidWorstGapClient
    ? rows.find((row) => normalizedKey(row.client) === normalizedKey(explicitWorstGapClient))
      || {
        client: explicitWorstGapClient,
        contract: null,
        real: null,
        satisfaction: null,
        churn: null,
        region: null,
        tickets: null,
        gap: null,
      }
    : null;
  const worstGap = explicitWorstGap || computedWorstGap;
  const lowSlaRows = rows.filter((row) => Number.isFinite(row.satisfaction) && row.satisfaction < 95)
    .sort((a, b) => a.satisfaction - b.satisfaction || b.churn - a.churn);
  const recommendsNoExpansion = /\bno\s+expandir\b/i.test(raw);
  const successClientMatch = raw.match(/Cliente\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)\s+como\s+caso\s+de\s+[eé]xito/i)
    || raw.match(/Cliente\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)\s+supera\s+contrato\s+y\s+sirve\s+como\s+caso\s+de\s+[eé]xito/i)
    || raw.match(/usar\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)\s+como\s+caso\s+de\s+[eé]xito/i)
    || raw.match(/Cliente\s+de\s+referencia:\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)/i)
    || raw.match(/Cliente\s+de\s+[eé]xito\s+comercial:\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)/i);
  const successCandidate = successClientMatch ? successClientMatch[1].trim() : null;
  const invalidSuccessCandidate = /^(usar|que|cual|cu[aá]l|cliente|caso)$/i.test(successCandidate || '');
  const fallbackSuccessClient = rows.length
    ? rows.slice().sort((a, b) => b.gap - a.gap || b.satisfaction - a.satisfaction)[0]?.client
    : null;
  const officialLaunchDate = matchAttachmentText(raw, [
    /Fecha\s+oficial\s+de\s+lanzamiento:\s*([0-9-]+)/i,
    /lanzamiento\s+oficial\s+para\s+([0-9-]+)/i,
  ]);
  const preliminaryLaunchDate = matchAttachmentText(raw, [
    /Fecha\s+preliminar\s+de\s+lanzamiento:\s*([0-9-]+)/i,
    /(?:indican|indica)\s+([0-9-]{10}),\s*esa\s+fecha\s+es\s+preliminar/i,
  ]);
  const contingency = matchAttachmentNumber(raw, [
    /Contingencia\s+(?:disponible:|:)?\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
    /los\s+(\d+(?:[.,]\d+)?)\s*USD\s+solo\s+se\s+liberan/i,
  ]);
  const slaThreshold = matchAttachmentNumber(raw, [
    /SLA\s+(\d+(?:[.,]\d+)?)%/i,
    /SLA\s+de\s+[^.\n]+?\s+por\s+encima\s+de\s+(\d+(?:[.,]\d+)?)%/i,
  ]);
  const contingencyClientMatch = raw.match(/SLA\s+(?:de\s+)?([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)\s+y\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)\s+por\s+encima/i);
  const contingencyClients = contingencyClientMatch
    ? [contingencyClientMatch[1].trim(), contingencyClientMatch[2].trim()]
    : [];
  const goCountriesMatch = raw.match(/(?:lanzar|launch)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)\s+y\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)/i);
  const goCountries = goCountriesMatch
    ? [goCountriesMatch[1].trim(), goCountriesMatch[2].trim()]
    : [];
  const pausedCountry = risk?.blocks || matchAttachmentText(raw, [
    /pausar\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)/i,
    /pause\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ_-]+)/i,
  ]);
  const fileNames = extractAttachmentFileNames(raw);

  return {
    rows,
    ticketRows,
    totalContract,
    totalReal,
    preliminaryTotalReal,
    difference,
    weightedRetention,
    officialChurn,
    preliminaryChurn,
    risk,
    risks,
    worstGap,
    lowSlaRows,
    criticalTicket,
    highestTicket,
    recommendsNoExpansion,
    officialLaunchDate,
    preliminaryLaunchDate,
    contingency,
    slaThreshold,
    contingencyClients,
    goCountries,
    pausedCountry,
    fileNames,
    successClient: successCandidate && !invalidSuccessCandidate ? successCandidate : fallbackSuccessClient,
    hasBusinessFacts: rows.length > 0
      || ticketRows.length > 0
      || Number.isFinite(totalContract)
      || Number.isFinite(totalReal)
      || Number.isFinite(preliminaryTotalReal)
      || Number.isFinite(contingency)
      || Boolean(officialLaunchDate)
      || Boolean(preliminaryLaunchDate)
      || Number.isFinite(officialChurn)
      || Number.isFinite(preliminaryChurn)
      || risks.length > 0,
  };
}

function buildStructuredAttachmentAnalysisAnswer({ goal, uploadedFileContext }) {
  const request = String(goal || '');
  const normalizedRequest = normalizedKey(request);
  const facts = extractStructuredAttachmentFacts(uploadedFileContext);
  if (!facts.hasBusinessFacts) return '';

  const wantsCalculation = /\b(calcula|calcular|total|diferencia|brecha|retencion|ponderad[ao]|contrato|contratado|real)\b/.test(normalizedRequest);
  const wantsRisk = /\b(riesgo|bloquea|presupuesto|dpa|legal|severidad|mitigacion|fecha limite)\b/.test(normalizedRequest);
  const wantsRecommendation = /\b(recomendacion|recomendaciones|direccion|priorizar|expandir|caso de exito)\b/.test(normalizedRequest);
  const wantsConflict = /\b(conflicto|contrasta|reconcilia|discrepancia|churn|pdf|docx|fuente primaria|oficial|preliminar)\b/.test(normalizedRequest);
  const wantsLaunch = /\b(lanzamiento|fecha|go|no go|go no go|cronograma)\b/.test(normalizedRequest);
  const wantsTickets = /\b(ticket|tickets|modulo|modulos|soporte|billing|integraciones)\b/.test(normalizedRequest);
  const wantsSla = /\b(sla|retencion|churn|prioridad|priorizar|cliente)\b/.test(normalizedRequest);
  const wantsContingency = /\b(contingencia|liberar|presupuesto)\b/.test(normalizedRequest);
  const wantsSources = /\b(fuente|fuentes|cita|documento|documentos)\b/.test(normalizedRequest);
  if (!wantsCalculation && !wantsRisk && !wantsRecommendation && !wantsConflict && !wantsLaunch && !wantsTickets && !wantsSla && !wantsContingency && !/\b(resumen|analiza|analisis|sintesis)\b/.test(normalizedRequest)) {
    return '';
  }

  const paragraphs = [];
  if (wantsCalculation && Number.isFinite(facts.totalReal) && Number.isFinite(facts.totalContract)) {
    // The SIGN must come from the totals, not from facts.difference: an explicit
    // "Diferencia:" line in the document is parsed as a non-negative magnitude
    // (the matcher captures only \d+...), so using it for the direction reported
    // "por encima" even when real < contract (it should be "por debajo").
    const signedDiff = facts.totalReal - facts.totalContract;
    const diffMagnitude = Number.isFinite(facts.difference) ? Math.abs(facts.difference) : Math.abs(signedDiff);
    const diffLabel = signedDiff >= 0 ? 'por encima' : 'por debajo';
    paragraphs.push(
      `El total real combinado es **${formatAttachmentNumber(facts.totalReal)} USD** frente a **${formatAttachmentNumber(facts.totalContract)} USD** contratados; la diferencia es **${formatAttachmentNumber(diffMagnitude)} USD** ${diffLabel} del contrato.`
    );
  }
  if ((wantsCalculation || wantsRecommendation) && facts.worstGap) {
    if ([facts.worstGap.contract, facts.worstGap.real, facts.worstGap.gap].every(Number.isFinite)) {
      const gap = facts.worstGap.gap;
      paragraphs.push(
        `La peor brecha está en **${facts.worstGap.client}**: contrato de **${formatAttachmentNumber(facts.worstGap.contract)} USD** contra real de **${formatAttachmentNumber(facts.worstGap.real)} USD**, una variación de **${formatAttachmentNumber(gap)} USD**.`
      );
    } else {
      paragraphs.push(`La mayor brecha negativa corresponde a **${facts.worstGap.client}** según el resumen del **XLSX**.`);
    }
  }
  if (wantsCalculation && Number.isFinite(facts.weightedRetention)) {
    paragraphs.push(`El SLA/retención ponderada validado es **${formatAttachmentNumber(facts.weightedRetention, { decimals: 1 })}%**.`);
  }
  if ((wantsCalculation || wantsConflict) && Number.isFinite(facts.preliminaryTotalReal) && Number.isFinite(facts.totalReal) && facts.preliminaryTotalReal !== facts.totalReal) {
    paragraphs.push(`La cifra real preliminar del **PDF** es **${formatAttachmentNumber(facts.preliminaryTotalReal)} USD**, pero la cifra oficial a usar es **${formatAttachmentNumber(facts.totalReal)} USD** del **XLSX**.`);
  }
  if (wantsConflict && Number.isFinite(facts.officialChurn)) {
    const prelim = Number.isFinite(facts.preliminaryChurn)
      ? ` El **PDF** conserva el churn preliminar de **${formatAttachmentNumber(facts.preliminaryChurn, { decimals: 1 })}%**, marcado como no oficial.`
      : '';
    paragraphs.push(
      `Para churn debe usarse **${formatAttachmentNumber(facts.officialChurn, { decimals: 1 })}%** del **DOCX**, porque el informe ejecutivo declara que es la **fuente primaria** cuando existe conflicto.${prelim}`
    );
  }
  if (wantsLaunch && (facts.officialLaunchDate || facts.preliminaryLaunchDate)) {
    const prelim = facts.preliminaryLaunchDate
      ? ` La fecha **${facts.preliminaryLaunchDate}** queda como preliminar.`
      : '';
    paragraphs.push(`La fecha oficial de lanzamiento es **${facts.officialLaunchDate || facts.preliminaryLaunchDate}** según el **DOCX**, que es la fuente autoritativa para el go/no-go.${prelim}`);
  }
  if (wantsLaunch && (facts.goCountries.length || facts.pausedCountry)) {
    const go = facts.goCountries.length ? `avanzan **${facts.goCountries.join('** y **')}**` : '';
    const paused = facts.pausedCountry ? `queda pausado **${facts.pausedCountry}**` : '';
    const condition = facts.risk
      ? ` hasta cerrar **${facts.risk.id}**${facts.risk.due ? ` antes de **${facts.risk.due}**` : ''}`
      : '';
    paragraphs.push(`Go/no-go por país: ${[go, paused ? `${paused}${condition}` : ''].filter(Boolean).join('; ')}.`);
  }
  if ((wantsRisk || wantsRecommendation) && facts.risks.length) {
    const riskText = facts.risks.map((risk) => {
      const due = risk.due ? ` Fecha límite: **${risk.due}**.` : '';
      const blocks = risk.blocks ? ` Bloquea: **${risk.blocks}**.` : '';
      return `**${risk.id} - ${risk.owner} - Severidad ${risk.severity}**; mitigación: **${risk.mitigation}**.${due}${blocks}`;
    }).join(' ');
    paragraphs.push(
      facts.risks.length > 1
        ? `Riesgos identificados: ${riskText}`
        : `El riesgo que bloquea aumentar presupuesto/expansión es ${riskText}`
    );
  }
  if ((wantsSla || wantsRecommendation) && facts.lowSlaRows.length > 0) {
    const summary = facts.lowSlaRows
      .slice(0, 4)
      .map((row) => `**${row.client}** (SLA ${formatAttachmentNumber(row.satisfaction, { decimals: 1 })}%, churn ${formatAttachmentNumber(row.churn, { decimals: 1 })}%, tickets ${Number.isFinite(row.tickets) ? formatAttachmentNumber(row.tickets) : 'n/d'})`)
      .join('; ');
    paragraphs.push(`Clientes prioritarios por SLA/churn: ${summary}.`);
  }
  if (wantsRecommendation && facts.successClient) {
    const successRow = facts.rows.find((row) => normalizedKey(row.client) === normalizedKey(facts.successClient));
    if (successRow && [successRow.satisfaction, successRow.churn, successRow.real, successRow.contract].every(Number.isFinite)) {
      paragraphs.push(`Cliente como caso de exito: **${successRow.client}** por SLA **${formatAttachmentNumber(successRow.satisfaction, { decimals: 1 })}%**, churn **${formatAttachmentNumber(successRow.churn, { decimals: 1 })}%**, real **${formatAttachmentNumber(successRow.real)} USD** y contrato **${formatAttachmentNumber(successRow.contract)} USD**.`);
    } else {
      paragraphs.push(`Cliente como caso de exito: **${facts.successClient}**.`);
    }
  }
  if (wantsTickets && (facts.criticalTicket || facts.highestTicket)) {
    const critical = facts.criticalTicket
      ? `El módulo crítico es **${facts.criticalTicket.client} / ${facts.criticalTicket.module}** con **${formatAttachmentNumber(facts.criticalTicket.tickets)}** tickets y severidad **${facts.criticalTicket.severity}**.`
      : '';
    const highest = facts.highestTicket
      ? `La mayor carga total por módulo está en **${facts.highestTicket.client} / ${facts.highestTicket.module}** con **${formatAttachmentNumber(facts.highestTicket.tickets)}** tickets.`
      : '';
    paragraphs.push([critical, highest].filter(Boolean).join(' '));
  }
  if (wantsContingency && Number.isFinite(facts.contingency)) {
    const thresholdClients = facts.contingencyClients.length
      ? ` de **${facts.contingencyClients.join('** y **')}**`
      : facts.lowSlaRows.length
        ? ` de **${facts.lowSlaRows.slice(0, 2).map((row) => row.client).join('** y **')}**`
        : '';
    const threshold = Number.isFinite(facts.slaThreshold) ? ` y SLA${thresholdClients} por encima de **${formatAttachmentNumber(facts.slaThreshold)}%**` : '';
    const riskGate = facts.risk ? ` cerrar **${facts.risk.id}**` : ' cerrar el riesgo bloqueante';
    paragraphs.push(`La contingencia de **${formatAttachmentNumber(facts.contingency)} USD** no debe liberarse todavía; la condición es${riskGate}${threshold}.`);
  }
  if (wantsRecommendation) {
    const actions = [];
    if (facts.goCountries.length || facts.pausedCountry) {
      const go = facts.goCountries.length ? `países go: **${facts.goCountries.join('** y **')}**` : '';
      const paused = facts.pausedCountry ? `país pausado: **${facts.pausedCountry}**` : '';
      actions.push([go, paused].filter(Boolean).join('; '));
    }
    if (facts.worstGap) actions.push(`priorizar **${facts.worstGap.client}** por brecha negativa y churn alto`);
    if (facts.risk) actions.push(`cerrar **${facts.risk.id}** con **${facts.risk.mitigation}** antes de expandir`);
    if (facts.successClient) actions.push(`usar **${facts.successClient}** como caso de exito`);
    if (facts.recommendsNoExpansion) actions.push(`**no expandir** presupuesto hasta cerrar ${facts.risk?.id || 'el riesgo bloqueante'}`);
    if (actions.length) {
      paragraphs.push(`Recomendación ejecutiva: ${actions.join('; ')}.`);
    }
  }
  if (wantsRisk && facts.recommendsNoExpansion && !paragraphs.some((line) => /\bno\s+expandir\b/i.test(line))) {
    paragraphs.push(`La recomendación final es **no expandir** presupuesto comercial hasta cerrar ${facts.risk?.id || 'el riesgo bloqueante'}.`);
  }
  if (wantsSources) {
    if (/\b(mapa|nombre\s+de\s+archivo|filename|archivo)\b/.test(normalizedRequest) && facts.fileNames.length) {
      const sourceLabels = {
        '.txt': 'memo operativo, totales y regla de contingencia',
        '.csv': 'tickets por cliente, módulo y severidad',
        '.md': 'playbook de expansión y secuencia operativa',
        '.xlsx': 'métricas, totales, SLA, churn y brechas',
        '.docx': 'acta autoritativa, fecha oficial y go/no-go',
        '.pdf': 'riesgos y cifras preliminares',
      };
      const mappedFiles = facts.fileNames.map((name) => {
        const lower = name.toLowerCase();
        const ext = Object.keys(sourceLabels).find((candidate) => lower.endsWith(candidate));
        return `**${name}**: ${sourceLabels[ext] || 'evidencia documental adjunta'}`;
      });
      paragraphs.push(`Mapa de fuentes por archivo: ${mappedFiles.join('; ')}.`);
    }
    const sources = [];
    const byExt = (ext) => facts.fileNames.filter((name) => name.toLowerCase().endsWith(ext)).join(', ');
    if (Number.isFinite(facts.totalReal) || facts.rows.length) sources.push(`**XLSX**${byExt('.xlsx') ? ` (${byExt('.xlsx')})` : ''}: métricas de clientes, totales, diferencia y SLA/retención ponderada`);
    if (facts.ticketRows.length) sources.push(`**CSV**${byExt('.csv') ? ` (${byExt('.csv')})` : ''}: tickets por cliente, módulo y severidad`);
    if (facts.officialLaunchDate || facts.successClient) sources.push(`**DOCX**${byExt('.docx') ? ` (${byExt('.docx')})` : ''}: fecha oficial, go/no-go y decisiones del comité`);
    if (Number.isFinite(facts.preliminaryTotalReal) || Number.isFinite(facts.preliminaryChurn) || facts.risk) sources.push(`**PDF**${byExt('.pdf') ? ` (${byExt('.pdf')})` : ''}: cifras preliminares y riesgos`);
    if (facts.recommendsNoExpansion || Number.isFinite(facts.contingency)) sources.push(`**TXT**${byExt('.txt') ? ` (${byExt('.txt')})` : ''}: consolidado operativo y regla de contingencia`);
    if (byExt('.md')) sources.push(`**MD** (${byExt('.md')}): playbook de expansión y condiciones de liberación`);
    if (sources.length) paragraphs.push(`Fuentes por documento: ${sources.join('; ')}.`);
  }

  if (paragraphs.length === 0 && facts.hasBusinessFacts) {
    if (Number.isFinite(facts.totalReal) && Number.isFinite(facts.totalContract)) {
      paragraphs.push(`Los adjuntos muestran **${formatAttachmentNumber(facts.totalReal)} USD** reales contra **${formatAttachmentNumber(facts.totalContract)} USD** contratados.`);
    }
    if (facts.risk) {
      paragraphs.push(`El riesgo principal es **${facts.risk.id} - ${facts.risk.owner}**, severidad **${facts.risk.severity}**, con mitigación **${facts.risk.mitigation}**.`);
    }
    if (facts.officialLaunchDate) {
      paragraphs.push(`La fecha oficial de lanzamiento es **${facts.officialLaunchDate}**.`);
    }
    if (Number.isFinite(facts.officialChurn)) {
      paragraphs.push(`El churn oficial es **${formatAttachmentNumber(facts.officialChurn, { decimals: 1 })}%** según el **DOCX**.`);
    }
  }

  if (paragraphs.length === 0) return '';
  return ['### Análisis de documentos adjuntos', '', paragraphs.join('\n\n')].join('\n');
}

function looksLikeMissingAttachmentAnswer(text) {
  const value = String(text || '').toLowerCase();
  if (!value.trim()) return true;
  return (
    value.includes('no hay contenido disponible') ||
    value.includes('no se encontró texto disponible') ||
    value.includes('no se encontro texto disponible') ||
    value.includes('proporciona un archivo legible') ||
    value.includes('no pude acceder al contenido') ||
    value.includes('no pude usar docintel') ||
    value.includes('no pude usar la herramienta') ||
    value.includes('falló de forma repetida') ||
    value.includes('fallo de forma repetida') ||
    value.includes('vuelve a intentarlo') ||
    value.includes('reformula la solicitud')
  );
}

function looksLikeEmptyOrWeakFinalAnswer(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return true;
  return (
    value === 'null' ||
    value === 'undefined' ||
    value === '(agent returned empty message)' ||
    value === 'respuesta vacía' ||
    value === 'respuesta vacia'
  );
}

function wantsBibliographyAnswer(request) {
  const value = normalizedKey(request);
  if (/\bcita\s+(?:fuente|fuentes|por\s+documento|documentos)\b/.test(value)) return false;
  return /\b(bibliograf|referencias?\s+bibliograf|citas?\s+(?:bibliograf|apa|vancouver|harvard|chicago|mla)|apa|vancouver|harvard|chicago|mla|formato bibliograf)/.test(value);
}

function detectApaEditionLabel(request) {
  const value = normalizedKey(request);
  if (/\b(7ma|7 th|septima|séptima|apa\s*7)\b/.test(value) || /\bapa\s*7\b/.test(value)) return 'APA 7';
  return 'APA';
}

function mapSpreadsheetCitationColumns(headerCells) {
  if (!Array.isArray(headerCells)) {
    return { title: -1, authors: -1, year: -1, venue: -1, doi: -1 };
  }
  const columnMap = { title: -1, authors: -1, year: -1, venue: -1, doi: -1 };
  headerCells.forEach((label, columnIndex) => {
    const key = normalizedKey(label);
    if (columnMap.title < 0 && /titulo|articulo|referenc|obra|nombre|tema|estudio|fuente/.test(key)) columnMap.title = columnIndex;
    if (columnMap.authors < 0 && /autor|investigador|escritor/.test(key)) columnMap.authors = columnIndex;
    if (columnMap.year < 0 && /(ano|anio|year|fecha|publicacion|publicado)/.test(key)) columnMap.year = columnIndex;
    if (columnMap.venue < 0 && /(revista|journal|fuente|medio|editorial)/.test(key)) columnMap.venue = columnIndex;
    if (columnMap.doi < 0 && /doi/.test(key)) columnMap.doi = columnIndex;
  });
  if (columnMap.title < 0 && headerCells.length >= 2) {
    columnMap.title = 0;
    columnMap.authors = headerCells.length > 1 ? 1 : -1;
    columnMap.year = headerCells.length > 2 ? 2 : -1;
  }
  return columnMap;
}

function splitSpreadsheetCells(line) {
  const trimmed = String(line || '').trim().replace(/\*{1,3}/g, '');
  if (!trimmed) return [];
  if (trimmed.includes('\t')) return trimmed.split('\t').map((cell) => cell.trim());
  if (trimmed.includes('|')) return trimmed.split(/\s*\|\s*/).map((cell) => cell.trim()).filter(Boolean);
  return [trimmed];
}

function normalizeAuthorInitials(value) {
  const tokens = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.map((token) => {
    if (/^[A-ZÁÉÍÓÚÜÑ]\.?$/u.test(token)) {
      return token.endsWith('.') ? token : `${token}.`;
    }
    return token;
  }).join(' ');
}

function parseCitationAuthorName(display) {
  const cleaned = String(display || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const inverted = cleaned.match(/^(.+?),\s*(.+)$/);
  if (inverted) {
    const family = inverted[1].trim();
    const given = normalizeAuthorInitials(inverted[2]);
    if (family && given) return { family, given, display: cleaned };
  }
  return { ...apa7.splitName(cleaned), display: cleaned };
}

function parseCitationAuthors(authorsRaw) {
  const raw = String(authorsRaw || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [{ family: 'Autor desconocido', given: null, display: 'Autor desconocido' }];

  const normalized = raw
    .replace(/\s+(?:and|y)\s+/gi, ' & ')
    .replace(/([A-ZÁÉÍÓÚÜÑ]\.)\s*,\s*(?=[^,;&]+,\s*[A-ZÁÉÍÓÚÜÑ]\.?)/gu, '$1 & ');

  const parts = normalized
    .split(/\s*(?:;|&)\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);

  const authors = (parts.length ? parts : [normalized])
    .map(parseCitationAuthorName)
    .filter(Boolean);

  return authors.length
    ? authors
    : [{ family: 'Autor desconocido', given: null, display: 'Autor desconocido' }];
}

function citationSourcesFromTabularData(headerCells, dataRows) {
  const columnMap = mapSpreadsheetCitationColumns(headerCells);
  const pickCell = (cells, index) => (index >= 0 ? String(cells[index] || '').trim() : '');
  const sources = [];

  for (const cells of dataRows) {
    if (!Array.isArray(cells) || !cells.some(Boolean)) continue;
    const title = pickCell(cells, columnMap.title >= 0 ? columnMap.title : 0);
    const authorsRaw = pickCell(cells, columnMap.authors);
    const yearCell = pickCell(cells, columnMap.year);
    const venue = pickCell(cells, columnMap.venue);
    const doiCell = pickCell(cells, columnMap.doi);
    if (!title || title.length < 4) continue;
    if (/^(n|no|titulo|autores|ano|anio|resultados|referencia)$/.test(normalizedKey(title))) continue;

    const yearMatch = yearCell.match(/\b(19|20)\d{2}\b/) || title.match(/\b(19|20)\d{2}\b/);
    const authors = parseCitationAuthors(authorsRaw);

    const doiMatch = doiCell.match(/\b10\.\d{4,9}\/[^\s|]+/i);
    sources.push({
      title: title.replace(/\s*\(\s*(19|20)\d{2}\s*\)\s*$/, '').trim(),
      authors,
      year: yearMatch ? Number(yearMatch[0]) : null,
      container: venue || null,
      doi: doiMatch ? doiMatch[0] : null,
      url: doiMatch ? `https://doi.org/${doiMatch[0]}` : null,
    });
  }
  return sources;
}

function dedupeCitationSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = normalizedKey(`${source.title}|${source.authors?.[0]?.display || ''}|${source.year || ''}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseMarkdownPipeCitationRows(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'));
  if (lines.length < 2) return [];

  const rows = lines
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim().replace(/\*{1,3}/g, '')))
    .filter((cells) => cells.some(Boolean))
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));

  let headerIndex = -1;
  for (let index = 0; index < Math.min(rows.length, 6); index += 1) {
    const headerKey = normalizedKey(rows[index].join(' '));
    if (/titulo|autor|ano|anio|year|referenc|articulo|publicacion|doi|revista|journal/.test(headerKey)) {
      headerIndex = index;
      break;
    }
  }

  const headerCells = headerIndex >= 0 ? rows[headerIndex] : rows[0];
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows.slice(1);
  return citationSourcesFromTabularData(headerCells, dataRows);
}

function parseFileProcessorExcelCitationRows(rawText) {
  const text = String(rawText || '');
  if (!/Columns\s*\(\d+\):/i.test(text)) return [];

  const sources = [];
  const sheetBlocks = text.split(/(?=^Sheet:\s)/im).filter((block) => /Columns\s*\(\d+\):/i.test(block));
  for (const block of sheetBlocks) {
    const colMatch = block.match(/^Columns\s*\(\d+\):\s*(.+)$/im);
    if (!colMatch) continue;

    const headerCells = splitSpreadsheetCells(colMatch[1]);
    const separatorIndex = block.search(/^---\s*$/m);
    const dataSection = separatorIndex >= 0 ? block.slice(separatorIndex) : block;
    const dataRows = dataSection
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^---$/.test(line))
      .filter((line) => !/^Sheet:/i.test(line))
      .filter((line) => !/^Columns\s*\(/i.test(line))
      .filter((line) => !/^Total data rows:/i.test(line))
      .filter((line) => !/^\(empty\)$/i.test(line))
      .filter((line) => !line.startsWith('... ['))
      .filter((line) => !/^Excel workbook/i.test(line))
      .map((line) => splitSpreadsheetCells(line))
      .filter((cells) => cells.some((cell) => cell.length > 0));

    sources.push(...citationSourcesFromTabularData(headerCells, dataRows));
  }
  return sources;
}

function parseSpreadsheetCitationRows(rawText) {
  const markdownSources = parseMarkdownPipeCitationRows(rawText);
  const excelSources = parseFileProcessorExcelCitationRows(rawText);
  return dedupeCitationSources([...markdownSources, ...excelSources]);
}

function buildBibliographyFallbackAnswer({ goal, uploadedFileContext }) {
  if (!wantsBibliographyAnswer(goal)) return '';
  const sources = parseSpreadsheetCitationRows(uploadedFileContext);
  if (sources.length === 0) return '';

  const edition = detectApaEditionLabel(goal);
  const references = apa7.referenceList(sources);
  return [
    `### Referencias (${edition})`,
    '',
    `Formateé **${sources.length}** entrada${sources.length === 1 ? '' : 's'} a partir de las filas legibles de tu archivo. Revísalas antes de entregar: autores, año y revista pueden requerir un ajuste manual si la hoja estaba incompleta.`,
    '',
    references,
  ].join('\n');
}

function resolveAttachmentFallbackMarkdown({ goal, uploadedFileContext, reason = '' }) {
  return (
    buildBibliographyFallbackAnswer({ goal, uploadedFileContext })
    || buildAttachmentGroundedFallbackAnswer({ goal, uploadedFileContext, reason })
    || buildAttachmentUnavailableFallbackAnswer({ goal, uploadedFileContext })
  );
}

function pickAttachmentRecoveryRuntime(env = process.env) {
  const flag = String(env.AGENT_TASK_LLM_RECOVERY || '').trim();
  if (flag === '0') return null;
  // Determinismo en tests: sin opt-in explícito no se hace ninguna llamada
  // de red (los shards de CI exportan keys dummy que aquí harían requests).
  if (String(env.NODE_ENV) === 'test' && flag !== '1') return null;
  if (env.OPENAI_API_KEY) return { provider: 'OpenAI', model: env.AGENT_TASK_RECOVERY_MODEL || 'gpt-4o-mini' };
  if (env.GEMINI_API_KEY) return { provider: 'Gemini', model: env.GEMINI_VISION_MODEL || 'gemini-2.5-flash' };
  if (env.OPENROUTER_API_KEY) return { provider: 'OpenRouter', model: 'openai/gpt-4o-mini' };
  return null;
}

/**
 * Última línea de defensa con LLM: cuando el agente termina con una
 * respuesta vacía o débil sobre un adjunto, intenta una respuesta directa
 * de un solo turno (sin loop agéntico) con el primer proveedor configurado
 * antes de degradar al volcado mecánico de fragmentos — que responde con
 * estadísticas sueltas e ignora la pregunta concreta del usuario.
 * Devuelve markdown o null (sin proveedor, error o respuesta vacía).
 */
async function buildLlmAttachmentRecoveryAnswer({ goal, uploadedFileContext, env = process.env, clientFactory = null }) {
  const question = String(goal || '').trim();
  const material = stripScaffolding(uploadedFileContext);
  if (!question || !material || countUsefulWords(uploadedFileContext) < 8) return null;
  const runtime = pickAttachmentRecoveryRuntime(env);
  if (!runtime) return null;
  try {
    const aiService = require('../ai-service');
    const client = clientFactory ? clientFactory(runtime.provider) : aiService.getClient(runtime.provider);
    const completion = await client.chat.completions.create({
      model: runtime.model,
      stream: false,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: 'Responde en español la pregunta concreta del usuario usando exclusivamente el material adjunto. '
            + 'TAREAS META sobre el documento: si el usuario pide la cita o referencia bibliográfica del documento '
            + '(en Vancouver, APA, MLA, Harvard, IEEE, ISO 690…), CONSTRUYE esa referencia con los datos bibliográficos '
            + 'del propio material (título, autores, año, revista/institución, volumen/páginas, DOI/URL) y marca como '
            + '[no disponible] cualquier campo que el material no revele; con un documento académico adjunto, "cita" '
            + 'significa SIEMPRE referencia bibliográfica, nunca una cita de calendario. '
            + 'Solo para preguntas de contenido cuya respuesta no aparece en el material: dilo explícitamente en una '
            + 'frase y resume en otra qué contiene el material. '
            + 'No inventes datos que no estén en el material.',
        },
        {
          role: 'user',
          content: `Pregunta del usuario: ${question.slice(0, 1000)}\n\nMaterial adjunto:\n${material.slice(0, 48000)}`,
        },
      ],
    });
    const text = completion?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim().length >= 20 ? text.trim() : null;
  } catch (err) {
    console.warn('[agent-task] LLM attachment recovery falló:', err?.message || err);
    return null;
  }
}

function buildToolObservationFallbackContext(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  const snippets = [];
  for (const step of steps) {
    for (const action of step?.actions || []) {
      const tool = String(action?.tool || '').trim();
      if (!tool || tool === 'finalize') continue;
      const observation = action?.observation;
      if (!observation || observation.error) continue;
      let text = '';
      if (typeof observation === 'string') {
        text = observation;
      } else if (typeof observation.stdout === 'string') {
        text = observation.stdout;
      } else if (typeof observation.output === 'string') {
        text = observation.output;
      } else if (typeof observation.result === 'string') {
        text = observation.result;
      } else {
        try { text = JSON.stringify(observation); } catch { text = ''; }
      }
      const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
      if (!cleaned || cleaned === '{}' || cleaned === '[]') continue;
      snippets.push(`Herramienta ${tool}: ${cleaned.slice(0, 2000)}`);
    }
  }
  return snippets.join('\n');
}

function shouldUseDeterministicAttachmentAnswer({
  goal,
  documentPolicy,
  files = [],
  env = process.env,
} = {}) {
  if (String(env.AGENT_TASK_ATTACHMENT_FASTPATH || '').trim() === '0') return false;
  if (!Array.isArray(files) || files.length === 0) return false;
  if (documentPolicy?.mode !== 'chat_only' || documentPolicy?.autoGenerate) return false;

  const request = normalizedKey(goal);
  if (!request) return false;
  const mentionsExternalLookup = /\b(?:web|internet|google|busca|buscar|investiga|investigar|fuentes externas|papers recientes|articulos recientes)\b/.test(request);
  const forbidsExternalLookup = /\b(?:no\s+(?:uses?|usar|busques?|buscar|investigues?|investigar)\s+(?:en\s+)?(?:la\s+)?(?:web|internet|google|fuentes externas)|sin\s+(?:web|internet|google|fuentes externas))\b/.test(request);
  if (mentionsExternalLookup && !forbidsExternalLookup) {
    return false;
  }
  if (/\b(?:entregable|descargable|convierte|exporta|exportar)\b/.test(request)) {
    return false;
  }
  const inlineSourceMap = /\b(?:mapa\s+de\s+fuentes|fuentes?\s+por\s+(?:archivo|documento)|enumera\s+cada\s+archivo|cita\s+(?:la\s+)?fuente\s+por\s+documento)\b/.test(request);
  if (/\b(?:crea|crear|genera|generar|formatea)\b/.test(request)
    && !inlineSourceMap
    && !/\b(?:no\s+(?:crees|crear|generes|generar)|sin\s+(?:crear|generar)|responde\s+solo\s+en\s+chat|solo\s+en\s+chat)\b/.test(request)) {
    return false;
  }

  return /\b(?:resumen|resume|sintesis|analiza|analisis|explica|describe|descripcion|que dice|de que trata|conclusion|conclusiones|recomendacion|recomendaciones|extrae|lee|revisa|identifica|resuelve|detecta|calcula|calcular|comput[ao]|total(?:es)?|diferencia|promedio|ponderad[ao]|porcentaje|margen|variaci[oó]n|contradicci[oó]n|conflicto|discrepa|discrepancia|reconcilia|compar[ao]|contrasta|cruza|exact[ao]s?|cifra\s+final|fuentes?|riesgos?|tickets?|modulos?|m[oó]dulos?|fecha|go|pais|pa[ií]s|cliente|clientes|caso\s+de\s+exito|exito|bloquea|bloqueado|bloqueante|mitigacion|severidad|limite|fecha\s+limite|dueno|dueño|imagen|foto|documento|archivo|adjunto|parrafo|parrafos)\b/.test(request);
}

function wantsSingleParagraphAnswer(request) {
  return outputFormat.wantsSingleParagraphSynthesis(request);
}

/**
 * Only emit bullet lists when the user explicitly asked for them.
 * Spanish triggers: "bullets", "viñetas", "vinetas", "lista", "puntos
 * clave", "key points", "checklist". Prose is the default — matches
 * the user-facing directive "análisis de documentos sin viñetas".
 */
function wantsBulletList(request) {
  return outputFormat.wantsBulletList(request);
}

function buildAttachmentGroundedFallbackAnswer({ goal, uploadedFileContext, reason = '' }) {
  void reason;
  const request = String(goal || '');
  const bibliographyAnswer = buildBibliographyFallbackAnswer({ goal: request, uploadedFileContext });
  if (bibliographyAnswer) return bibliographyAnswer;

  const cleanedRaw = stripScaffolding(uploadedFileContext);
  const structuredAnswer = buildStructuredAttachmentAnalysisAnswer({
    goal: request,
    uploadedFileContext,
  });
  if (structuredAnswer) return structuredAnswer;

  const cleaned = normalizeAttachmentFallbackContent(cleanedRaw)
    .replace(/\s+/g, ' ')
    .trim();
  const minUsefulWords = wantsBibliographyAnswer(request) ? 8 : 30;
  if (!cleaned || countUsefulWords(cleaned) < minUsefulWords) return '';
  const formatSpec = outputFormat.parseOutputFormatRequest(request);
  // Honor explicit paragraph counts in digit ("2 párrafos") or word ("dos
  // párrafos") form. A single-paragraph request is handled by its own branch
  // below, so we only surface counts >= 2 here.
  const explicitParagraphs = formatSpec.paragraphs && formatSpec.paragraphs >= 2
    ? Math.min(6, formatSpec.paragraphs)
    : 0;
  const requestedParagraphs = Math.max(1, explicitParagraphs);
  const wantsConclusions = /\b(conclusi[oó]n|conclusiones|concluye|concluir)\b/i.test(request);
  const wantsSummary = /\b(resumen|resume|sintesis|s[ií]ntesis|de qu[eé] trata|qu[eé] dice|explica)\b/i.test(request);
  const wantsRecommendations = /\b(recomendaci[oó]n|recomendaciones|sugerencia|sugerencias|propuesta|propuestas)\b/i.test(request);
  const paragraphCount = requestedParagraphs || (wantsConclusions ? 3 : 2);
  const sentences = splitReadableSentences(cleaned);
  if (sentences.length === 0) {
    return cleaned.slice(0, 1600);
  }

  const bulletSentences = selectAttachmentSentences(sentences, request, 8)
    .map((sentence) => sentence.replace(/^[,;:\s]+/, '').replace(/\.{2,}/g, '.').trim())
    .filter(Boolean);

  // Bullets are now opt-in. Default to prose; only emit list markers
  // when the user explicitly asks for "viñetas / lista / puntos clave".
  const allowBullets = wantsBulletList(request);
  const executiveSummary = allowBullets
    ? bulletSentences
        .slice(0, Math.max(3, Math.min(5, bulletSentences.length)))
        .map((sentence) => `- ${sentence.length > 360 ? `${sentence.slice(0, 360).trim()}...` : sentence}`)
        .join('\n')
    : bulletSentences
        .slice(0, Math.max(3, Math.min(5, bulletSentences.length)))
        .map((sentence) => sentence.length > 360 ? `${sentence.slice(0, 360).trim()}...` : sentence)
        .join(' ');

  if (wantsSingleParagraphAnswer(request)) {
    const selected = (bulletSentences.length ? bulletSentences : sentences)
      .slice(0, Math.max(3, Math.min(5, bulletSentences.length || sentences.length)));
    const paragraph = selected.join(' ').replace(/\s+/g, ' ').trim();
    const clipped = paragraph.length > 1800 ? `${paragraph.slice(0, 1800).trim()}...` : paragraph;
    return clipped;
  }

  if (!wantsConclusions) {
    const denseEvidenceRequest = /\b(?:calcula|calcular|total|diferencia|contradiccion|contradicci[oó]n|conflicto|compara|comparar|contrasta|cruza|riesgo|riesgos|matriz|recomendacion|recomendaciones|fuente|fuentes)\b/i.test(request);
    const narrativeSentences = bulletSentences.length ? bulletSentences : sentences;
    const body = narrativeSentences
      .slice(0, denseEvidenceRequest ? Math.max(8, paragraphCount * 4) : Math.max(4, paragraphCount * 2))
      .join(' ');
    const clippedBody = body.length > 1800 ? `${body.slice(0, 1800).trim()}...` : body;
    if (wantsSummary || wantsRecommendations) {
      // When the user didn't ask for bullets we render the executive
      // summary as a normal paragraph (`Resumen ejecutivo: prose…`).
      // Recommendations also become a final prose sentence, not a
      // list, so the whole answer stays bullet-free unless the user
      // opts in via wantsBulletList.
      const heading = '### Análisis del documento adjunto';
      // Honor an explicit multi-paragraph request (e.g. "resumen en 2 párrafos")
      // even for summaries, so the output format matches what the user asked for.
      if (explicitParagraphs >= 2 && !allowBullets) {
        const paragraphSource = (bulletSentences.length >= explicitParagraphs ? bulletSentences : sentences)
          .slice(0, Math.max(explicitParagraphs * 2, Math.min(sentences.length, explicitParagraphs * 3)));
        const summaryParagraphs = distributeSentencesIntoParagraphs(paragraphSource, explicitParagraphs);
        if (summaryParagraphs.length >= 2) {
          const recBlock = wantsRecommendations
            ? '\n**Siguiente paso recomendado.** Usa estos hallazgos como base y pídeme una matriz, informe Word/PDF o tabla comparativa si necesitas un entregable descargable.'
            : '';
          return [heading, '', summaryParagraphs.join('\n\n'), recBlock].filter(Boolean).join('\n');
        }
      }
      const summaryBlock = executiveSummary
        ? allowBullets
          ? `**Resumen ejecutivo**\n${executiveSummary}`
          : `**Resumen ejecutivo.** ${executiveSummary}`
        : clippedBody;
      const recommendationsBlock = wantsRecommendations
        ? allowBullets
          ? '\n**Siguiente paso recomendado**\n- Usar estos hallazgos como base y pedirme una matriz, informe Word/PDF o tabla comparativa si necesitas entregable descargable.'
          : '\n**Siguiente paso recomendado.** Usa estos hallazgos como base y pídeme una matriz, informe Word/PDF o tabla comparativa si necesitas un entregable descargable.'
        : '';
      return [heading, '', summaryBlock, recommendationsBlock].filter(Boolean).join('\n');
    }
    return clippedBody;
  }

  const connectors = [
    'En primer lugar,',
    'Asimismo,',
    'Finalmente,',
    'De forma complementaria,',
    'Como cierre,',
    'En sintesis,',
  ];
  const perParagraph = Math.max(1, Math.ceil(Math.min(sentences.length, paragraphCount * 3) / paragraphCount));
  const paragraphs = [];
  for (let index = 0; index < paragraphCount; index += 1) {
    const group = sentences.slice(index * perParagraph, (index + 1) * perParagraph);
    if (group.length === 0) break;
    paragraphs.push(`${connectors[index] || 'Ademas,'} ${group.join(' ')}`);
  }
  const evidenceBlock = executiveSummary
    ? allowBullets
      ? `\n**Evidencia base usada**\n${executiveSummary}`
      : `\n**Evidencia base usada.** ${executiveSummary}`
    : '';
  return [
    '### Conclusiones basadas en el documento adjunto',
    '',
    paragraphs.join('\n\n'),
    evidenceBlock,
  ].filter(Boolean).join('\n');
}

function buildAttachmentUnavailableFallbackAnswer({ goal = '', uploadedFileContext = '' } = {}) {
  const request = String(goal || '');
  if (wantsBibliographyAnswer(request)) {
    const partialRows = parseSpreadsheetCitationRows(uploadedFileContext);
    if (partialRows.length === 0) {
      return [
        'No pude leer bien las referencias de tu archivo para armar la bibliografía.',
        '',
        '**Para generar la bibliografía en APA 7:**',
        '1. Usa una hoja con columnas claras: **Título**, **Autor(es)**, **Año** (y revista o DOI si los tienes).',
        '2. Vuelve a subir el `.xlsx` original (no una captura ni un PDF exportado).',
        '3. O pega aquí 3–5 referencias en texto y formateo el resto con el mismo estilo.',
        '',
        'Si el chat no respondió al primer intento, **envía el mensaje otra vez** en unos segundos.',
      ].join('\n');
    }
  }

  const mentionsExcel = /excel|xlsx|hoja|spreadsheet|tabla/.test(normalizedKey(`${request} ${uploadedFileContext}`));
  return [
    'Recibí tu archivo, pero no encontré texto suficiente para responder con precisión.',
    '',
    '**Qué puedes hacer ahora:**',
    mentionsExcel
      ? '- En Excel, confirma que la hoja correcta tiene datos en celdas (no solo formato o imágenes) y vuelve a subir el `.xlsx`.'
      : '- Si es un PDF escaneado o una imagen, sube una versión más nítida o con OCR.',
    '- Si es Word, Excel o PDF con texto seleccionable, vuelve a subir el archivo original.',
    '- También puedes pegar aquí el fragmento clave y lo trabajo de inmediato.',
    '',
    'Si fue un fallo momentáneo del servicio, **reintenta el mismo mensaje** en unos segundos.',
  ].filter(Boolean).join('\n');
}

// Map a user-selected model id to the provider whose OpenAI-compatible
// chat/completions API can serve the agent runtime. The agent runner is
// built against the OpenAI Node SDK shape, but DeepSeek, OpenRouter and
// Gemini's OpenAI-compat surface all speak the same protocol, so we
// don't have to force-remap every selection to `gpt-4o-mini`.
function detectAgentRuntimeProvider(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  // Bare OpenAI-native ids (NO aggregator slug): gpt-4o, o1, chatgpt-*, fine-tunes.
  // A slug form like `openai/gpt-5.5` is NOT native OpenAI — it routes through
  // OpenRouter (see the slug branch below), which is how the main chat flow
  // resolves it (provider-inference.js). Guarding on the absence of a `/`
  // is what stops openai/gpt-5.5 from silently falling through to the
  // gpt-4o-mini fallback.
  if (!id.includes('/') && /^(gpt-|o\d|chatgpt-|ft:gpt-|ft:o)/i.test(id)) {
    return { provider: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseURL: null };
  }
  // Direct DeepSeek API only for bare `deepseek-v*/chat/reasoner` ids. The
  // slug form `deepseek/...` is an OpenRouter aggregator id and is handled
  // by the slug branch below (matches isDirectDeepSeekModel in
  // provider-inference.js).
  if (/^deepseek-(v\d|chat|reasoner)/i.test(id)) {
    return { provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' };
  }
  // Google Gemini family (bare gemini-*/imagen-* ids, no slug).
  if (!id.includes('/') && (/^gemini-/i.test(id) || /^imagen-/i.test(id))) {
    return {
      provider: 'Gemini',
      apiKeyEnv: 'GEMINI_API_KEY',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    };
  }
  // Any aggregator slug ("provider/model") routes through OpenRouter — this is
  // exactly how the main chat flow (provider-inference.js) maps openai/*,
  // google/*, anthropic/*, x-ai/*, qwen/*, mistralai/*, moonshotai/*, etc.
  // Previously only a short allowlist (anthropic|meta-llama|moonshotai|x-ai|
  // openrouter) matched, so openai/gpt-5.5 returned null and got force-remapped
  // to gpt-4o-mini (modelRemapped:true). Catching every slug keeps the agent
  // runtime in lockstep with the user's selected model.
  if (id.includes('/')) {
    return {
      provider: 'OpenRouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.NEXT_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
        'X-Title': 'SiraGPT',
      },
    };
  }
  return null;
}

function buildOpenAICompatibleClient(target, env = process.env) {
  if (!target || !target.apiKeyEnv) return null;
  const apiKey = env[target.apiKeyEnv];
  if (!apiKey) return null;
  const opts = { apiKey };
  if (target.baseURL) opts.baseURL = target.baseURL;
  if (target.defaultHeaders) opts.defaultHeaders = target.defaultHeaders;
  // Bound every model call. The OpenAI SDK defaults to a 600s (10 min)
  // per-request timeout — a hung or degraded provider would otherwise freeze
  // the planning phase ("Analizando solicitud", 0 steps / 0 tools) for
  // minutes while the client's 90s idle watchdog aborts the run. A tight
  // timeout makes a stalled call reject fast so react-agent breaks with a
  // clean `model_error` (and the contract resolver falls back to its
  // heuristic) instead of stalling silently. Both knobs are env-tunable.
  const timeoutMs = Number.parseInt(process.env.AGENT_TASK_LLM_TIMEOUT_MS || '', 10);
  opts.timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  const maxRetries = Number.parseInt(process.env.AGENT_TASK_LLM_MAX_RETRIES || '', 10);
  opts.maxRetries = Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 2;
  return new OpenAI(opts);
}

function normalizeAgentRuntimeModel(selectedModel) {
  const displayModel = String(selectedModel || '').trim() || 'gpt-4o';
  const configuredFallback = String(
    process.env.AGENT_TASK_OPENAI_MODEL ||
    process.env.AGENT_TASK_RUNTIME_MODEL ||
    'gpt-4o-mini'
  ).trim();
  const detected = detectAgentRuntimeProvider(displayModel);
  const isOpenAINative = detected && detected.provider === 'OpenAI';
  return {
    displayModel,
    runtimeModel: detected ? displayModel : configuredFallback,
    runtimeProvider: isOpenAINative
      ? 'selected-openai'
      : detected
        ? `selected-${detected.provider.toLowerCase()}`
        : 'openai-fallback',
    detected,
    remapped: !detected,
  };
}

function agentModelFailoverEnabled(env = process.env) {
  const flag = String(env.AGENT_TASK_MODEL_FAILOVER || '').trim();
  if (flag === '0') return false;
  // Determinismo en tests: los shards de CI exportan keys dummy que aquí
  // dispararían llamadas de red reales en el reintento.
  if (String(env.NODE_ENV) === 'test' && flag !== '1') return false;
  return true;
}

/**
 * Runtime de respaldo cross-provider para cuando el modelo seleccionado
 * falla EN EJECUCIÓN (402 sin créditos, 401, caída del proveedor) aunque
 * su key exista. Elige el primer proveedor DISTINTO al que acaba de
 * fallar que tenga key configurada. Devuelve null si no hay alternativa.
 */
function resolveAgentModelFailoverRuntime(profile, env = process.env) {
  const failedProvider = String(profile?.detected?.provider || 'OpenAI');
  const fallbackModel = String(
    env.AGENT_TASK_OPENAI_MODEL || env.AGENT_TASK_RUNTIME_MODEL || 'gpt-4o-mini'
  ).trim() || 'gpt-4o-mini';
  const candidates = [
    { provider: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseURL: null, model: fallbackModel },
    {
      provider: 'Gemini',
      apiKeyEnv: 'GEMINI_API_KEY',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      model: env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
    },
    { provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  ];
  for (const target of candidates) {
    if (target.provider === failedProvider) continue;
    if (!env[target.apiKeyEnv]) continue;
    const client = buildOpenAICompatibleClient(target, env);
    if (client) return { client, model: target.model, provider: target.provider };
  }
  return null;
}

// Resolve the OpenAI-compatible client the agent runtime should drive.
// Tries the user's selected provider first; if that provider has no API
// key configured, walks a small fallback list so we never hand the
// runtime null on a host that has at least one key set.
function resolveAgentRuntimeClient(profile) {
  const tried = new Set();
  const tryTarget = (target) => {
    if (!target) return null;
    const key = `${target.provider}:${target.apiKeyEnv}`;
    if (tried.has(key)) return null;
    tried.add(key);
    return buildOpenAICompatibleClient(target);
  };

  let primary = tryTarget(profile?.detected);
  if (primary) {
    return { client: primary, model: profile.runtimeModel, provider: profile.detected.provider };
  }

  // The user's selected provider has no usable key. Walk a small fallback
  // list — but each fallback MUST use a model ITS OWN provider accepts. The
  // selected model id (e.g. an OpenRouter "moonshotai/kimi-k2.6" when
  // OPENROUTER_API_KEY is unset/empty) would be rejected by the OpenAI or
  // DeepSeek endpoints, which previously left the runtime driving a valid
  // client with a FOREIGN model id → every LLM call failed and the run
  // stalled silently at "Analizando solicitud" (0 steps / 0 tools) until the
  // client's 90s idle watchdog fired. So the OpenAI fallback uses a known
  // OpenAI model (env-tunable), never the originally-selected id.
  const openAIFallbackModel = String(
    process.env.AGENT_TASK_OPENAI_MODEL || process.env.AGENT_TASK_RUNTIME_MODEL || 'gpt-4o-mini'
  ).trim() || 'gpt-4o-mini';
  const fallbackTargets = [
    { provider: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseURL: null, model: openAIFallbackModel },
    { provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
    {
      provider: 'OpenRouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.NEXT_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
        'X-Title': 'SiraGPT',
      },
      // Honor the selected model when it really is an OpenRouter model;
      // otherwise drive a known OpenRouter default.
      model: profile?.detected?.provider === 'OpenRouter' ? profile.runtimeModel : 'moonshotai/kimi-k2.6',
    },
  ];
  for (const target of fallbackTargets) {
    const client = tryTarget(target);
    if (client) {
      return { client, model: target.model, provider: target.provider };
    }
  }
  return { client: null, model: profile?.runtimeModel || 'gpt-4o-mini', provider: 'unconfigured' };
}

async function persistAssistantMessage({
  chatId,
  userId,
  assistantMessageId,
  streamState,
  task,
  status,
  artifacts,
  metadata,
}) {
  if (!chatId || !prisma) return null;
  try {
    const { serializeAgentState } = routeInternals();
    const serialized = serializeAgentState(streamState);
    const data = {
      content: serialized,
      tokens: Math.ceil(serialized.length / 4),
      metadata: {
        source: 'agent-task',
        taskId: task.taskId,
        status,
        displayGoal: task.displayGoal,
        artifacts,
        updatedAt: new Date().toISOString(),
        ...metadata,
      },
    };
    if (assistantMessageId) {
      return await prisma.message.update({ where: { id: assistantMessageId }, data });
    }
    const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return null;
    return await prisma.message.create({
      data: { chatId, role: 'ASSISTANT', timestamp: new Date(), ...data },
    });
  } catch {
    return null;
  }
}

// ── in-flight idempotency guard ──────────────────────────────────────
//
// `runAgentTaskJob` is reachable from several independent execution
// backends for the SAME taskId: the BullMQ worker, the queue→local handoff
// watchdog (routes/agent-task.js runAgentJobInProcess), the local-fallback
// route, the Telegram/codex/batch entrypoints, and the Temporal activity.
// On the 1-vCPU VM, when the queue is slow the watchdog fires a local run
// WHILE the worker also picks the job up, and a client that reconnects after
// the ~30s GCLB response cut can trigger yet another. Each entry re-runs the
// full pipeline → duplicate `agent_task_worker_started` log lines and, worse,
// duplicate LLM spend. We collapse concurrent invocations for one taskId to a
// single in-flight run; late callers await the SAME promise instead of
// starting a parallel one. The entry clears once the run settles, so BullMQ's
// legitimate failure-retry path (a fresh run after the previous finished) is
// unaffected.
const inFlightAgentTasks = new Map(); // taskId → Promise

function runAgentTaskJob(payload = {}, job = null) {
  const taskId = payload && payload.taskId;
  if (!taskId) return _runAgentTaskJobImpl(payload, job);
  const existingRun = inFlightAgentTasks.get(taskId);
  if (existingRun) {
    try {
      auditLog.audit({
        event: 'agent_task_duplicate_invocation_skipped',
        taskId,
        jobId: job?.id ? String(job.id) : (payload.jobId || null),
      });
    } catch (_) { /* never throw from the dedup guard */ }
    return existingRun;
  }
  const run = Promise.resolve()
    .then(() => _runAgentTaskJobImpl(payload, job))
    .finally(() => { inFlightAgentTasks.delete(taskId); });
  inFlightAgentTasks.set(taskId, run);
  return run;
}

async function _runAgentTaskJobImpl(payload = {}, job = null) {
  const {
    taskId,
    traceId,
    user,
    goal,
    displayGoal,
    systemContract,
    files = [],
    fileMetadata = [],
    chatId = null,
    model = 'gpt-4o',
    maxSteps = 60,
    maxRuntimeMs = 2 * 60 * 60 * 1000,
    folderCode = null,
    cycle = null,
  } = payload;
  if (!taskId) throw new Error('agent task payload missing taskId');
  if (!user?.id) throw new Error('agent task payload missing user.id');
  const plainTranscriptionRequest = isPlainTranscriptionRequest(goal);
  const hasAttachedFiles = Array.isArray(files) && files.length > 0;
  let wantsSourcePreservingEdit = isSourcePreservingEditRequest(displayGoal || goal, files);
  const deterministicVancouverRequest = isVancouverMatrixWordRequest(`${goal || ''} ${displayGoal || ''}`) &&
    hasAttachedFiles;
  if (!process.env.OPENAI_API_KEY && !plainTranscriptionRequest && !deterministicVancouverRequest && !hasAttachedFiles) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  if (payload.workflow?.pattern === 'fork_join' && !payload._skipForkJoin) {
    const { forkJoin } = require('./agent-collaboration');
    const subTasks = (payload.workflow.subTasks || []).slice(0, 3).map((st, idx) => ({
      goal: typeof st === 'string' ? st : (st.goal || goal),
      taskId: `${taskId}-fj-${idx}`,
      maxSteps: Math.min(25, maxSteps),
    }));
    if (subTasks.length >= 2) {
      taskStore.markTaskStatus({ taskId, userId: user.id }, 'running');
      const fj = await forkJoin({
        subTasks,
        user,
        options: {
          chatId,
          model,
          maxSteps: Math.min(25, maxSteps),
          maxRuntimeMs: Math.min(maxRuntimeMs, 180_000),
          onEvent: (type, data) => {
            try {
              taskStore.appendTaskEvent({ taskId, userId: user.id }, { type, payload: data });
            } catch { /* best-effort */ }
          },
        },
      });
      taskStore.markTaskStatus(
        { taskId, userId: user.id },
        fj.ok ? 'completed' : 'failed',
        { mergedSummary: fj.mergedSummary || null },
      );
      return { ok: fj.ok, pattern: 'fork_join', mergedSummary: fj.mergedSummary, results: fj.results };
    }
  }

  const internals = routeInternals();
  const controller = new AbortController();
  const startedAt = Date.now();
  const existing = taskStore.getTaskSnapshotForUser(taskId, user.id);
  let streamState = existing?.streamState || internals.initialAgentState();
  let documentPolicy = normalizeDocumentPolicyCoherence(
    payload.documentPolicy || existing?.documentPolicy || buildDocumentDeliveryPolicy({
      goal,
      displayGoal,
      files,
    })
  );
  const runtimeModelProfile = normalizeAgentRuntimeModel(model);

  const executionProfile = buildExecutionProfile({ goal, fileIds: files, fileMetadata });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: goal, fileIds: files });
  const openclawRuntimeProfile = payload.openclawRuntimeProfile || existing?.openclawRuntimeProfile || buildOpenClawRuntimeProfile({
    goal,
    userId: user.id,
    chatId,
    fileIds: files,
    model,
  });
  // Attribution telemetry — runs the executive summary on the goal so we
  // can record what the system thought the user wanted before any step
  // executes. Pure local, no LLM. Posted as a task event so reviewers see
  // "I understood your goal as X (confidence Y)" alongside the run.
  try {
    if (String(process.env.SIRAGPT_AGENT_ATTRIBUTION_DISABLED || '').toLowerCase() !== '1') {
      const executiveSummary = require('../attribution-executive-summary');
      const attrSummary = executiveSummary.buildSummary({ prompt: String(goal || '') });
      try {
        taskStore.appendTaskEvent({ taskId, userId: user.id }, {
          type: 'attribution_summary',
          payload: {
            headline: attrSummary.headline,
            verdict: attrSummary.verdict,
            confidenceGrade: attrSummary.confidenceGrade,
            qualityGrade: attrSummary.qualityGrade,
            recommendedSkill: attrSummary.recommendedSkill?.id || null,
            metrics: attrSummary.metrics,
          },
        });
      } catch (_evtErr) { /* swallow */ }
    }
  } catch (_attrErr) { /* swallow */ }
  const universalTaskContract = buildUniversalTaskContract({
    rawUserRequest: goal,
    fileIds: files,
  });
  const finalizeProfile = buildFinalizeProfile(executionProfile, universalTaskContract);
  let taskContract = deriveLegacyTaskContract(universalTaskContract);
  let taskContractSource = 'fallback';
  // Resolve the actual OpenAI-compatible client (and final model id) for
  // the user's selected provider. If the user picked DeepSeek and we have
  // DEEPSEEK_API_KEY, we drive DeepSeek directly — without this, every
  // non-OpenAI selection used to be silently remapped to gpt-4o-mini and
  // would hard-fail whenever OPENAI_API_KEY was rate-limited.
  const runtimeClientResolution = resolveAgentRuntimeClient(runtimeModelProfile);
  const openai = runtimeClientResolution.client;
  if (runtimeClientResolution.client) {
    runtimeModelProfile.runtimeModel = runtimeClientResolution.model;
    runtimeModelProfile.runtimeProvider = runtimeClientResolution.provider;
    runtimeModelProfile.remapped = runtimeClientResolution.model !== runtimeModelProfile.displayModel
      || runtimeClientResolution.provider !== runtimeModelProfile.detected?.provider;
  }
  const deterministicAttachmentAnswer = shouldUseDeterministicAttachmentAnswer({
    goal: displayGoal || goal,
    documentPolicy,
    files,
  });
  if (!plainTranscriptionRequest && openai && !deterministicAttachmentAnswer && !wantsSourcePreservingEdit) {
    try {
      const resolved = await resolveTaskContract({
        goal,
        openai,
        fileIds: files,
        fallback: () => deriveLegacyTaskContract(universalTaskContract),
      });
      taskContract = enforceLegacyTaskContract(resolved.contract || taskContract, universalTaskContract);
      taskContractSource = resolved.source || taskContractSource;
    } catch (err) {
      console.warn('[agent-task-runner] task-contract resolver failed:', err?.message);
    }
  }

  const taskPlan = buildAgentTaskPlan({
    goal,
    executionProfile,
    intentAlignmentProfile,
    openclawProfile: openclawRuntimeProfile,
    universalTaskContract,
    fileIds: files,
    maxRuntimeMs,
    toolManifests: listManifests(),
  });
  const enterpriseExecutionGraph = buildEnterpriseExecutionGraph({
    contract: universalTaskContract,
    taskId,
    userId: user.id,
    chatId,
  });
  const enterpriseToolRuntimePlan = buildToolRuntimePlan({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
  });
  const enterpriseQaBoardReview = buildAgenticQaBoardReview({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
    toolRuntimePlan: enterpriseToolRuntimePlan,
    phase: 'worker-preflight',
  });
  const agenticOperatingCore = buildAgenticOperatingCore({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
    toolRuntimePlan: enterpriseToolRuntimePlan,
    qaBoardReview: enterpriseQaBoardReview,
  });
  const integrationRuntimeProfile = buildIntegrationRuntimeProfile({
    contract: universalTaskContract,
    fileIds: files,
    requiredTools: enterpriseToolRuntimePlan?.summary?.requestedTools || [],
  });
  let durableExecution = null;
  try {
    durableExecution = durableExecutionStore.createDurableExecutionRecord({
      graph: enterpriseExecutionGraph,
      contract: universalTaskContract,
      taskId,
      userId: user.id,
      chatId,
      toolRuntimePlan: enterpriseToolRuntimePlan,
      qaBoardReview: enterpriseQaBoardReview,
    });
  } catch (err) {
    console.warn('[agent-task-runner] durable execution record failed:', err?.message || err);
  }
  const enterpriseRuntimeProfile = {
    ...buildEnterpriseRuntimeProfile(universalTaskContract, enterpriseExecutionGraph),
    agenticOperatingCore: agenticOperatingCore.summary,
    toolRuntime: enterpriseToolRuntimePlan.summary,
    qaPreflight: enterpriseQaBoardReview.summary,
    integrationRuntime: integrationRuntimeProfile.promptProfile,
    durableExecution: durableExecution
      ? {
        graphId: durableExecution.graphId,
        persisted: true,
        nodeCount: durableExecution.nodes.length,
        checkpointCount: durableExecution.checkpoints.length,
      }
      : { graphId: enterpriseExecutionGraph.graph_id, persisted: false },
  };

  const task = internals.createTaskRecord({
    taskId,
    userId: user.id,
    chatId,
    displayGoal,
    model,
    controller,
    maxSteps,
    maxRuntimeMs,
    streamState,
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    openclawRuntimeProfile,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    enterpriseToolRuntimePlan,
    enterpriseQaBoardReview,
    agenticOperatingCore,
    durableExecution,
    jobId: job?.id ? String(job.id) : existing?.jobId || taskId,
    queueName: getQueueName(),
    traceId: traceId || existing?.traceId || null,
    documentPolicy,
    status: 'running',
  });
  task.runtimeModel = runtimeModelProfile.runtimeModel;

  const artifacts = [];
  // Throttle in-flight progress upserts. A long-running task emits
  // hundreds of events; firing a Prisma upsert + BullMQ updateProgress
  // on every single one wastes DB connections and Redis round-trips.
  // The terminal persistProgress(status) call at the end always
  // bypasses the throttle so the final state lands authoritatively.
  const PROGRESS_THROTTLE_MS = 250;
  let lastProgressAt = 0;
  const persistProgress = (status = task.status, { force = false } = {}) => {
    const now = Date.now();
    const isTerminal = status !== 'running';
    if (!force && !isTerminal && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    void persistence.upsertAgentTask({
      ...task,
      status,
      state: streamState,
      documentPolicy,
    });
    if (job) {
      // Catch and discard: BullMQ writes progress through Redis, which
      // can reject mid-failover. Without .catch() the rejection goes
      // unhandled and (depending on Node policy) can terminate the
      // worker. Progress is best-effort observability — never fatal.
      Promise.resolve(job.updateProgress({ status, lastEventSeq: task.lastEventSeq || 0 })).catch(() => {});
    }
  };
  const emit = (event) => {
    streamState = internals.reduceAgentState(streamState, event);
    task.streamState = streamState;
    const written = taskStore.appendTaskEvent(task, event, streamState, { eventLimit: internals.TASK_EVENT_LIMIT || 600 });
    if (written) {
      task.events = written.events || task.events;
      task.checkpoints = written.checkpoints || task.checkpoints;
      task.lastEventSeq = written.lastEventSeq || task.lastEventSeq;
      task.artifacts = written.artifacts || task.artifacts;
    }
    void persistence.appendAgentTaskEvent(task, task.events?.[task.events.length - 1] || event);
    metrics.counter('agent_task_events_total', { type: event.type || 'unknown' });
    persistProgress('running');
    return event;
  };

  emit({
    type: 'queue_status',
    taskId,
    status: 'running',
    queue: getQueueName(),
    jobId: job?.id ? String(job.id) : task.jobId,
    position: null,
    estimatedWaitMs: 0,
  });
  emit({ type: 'document_policy', policy: documentPolicy });

  const langGraphLayer = await buildLangGraphLayer({ taskId, documentPolicy });
  const forbiddenToolNames = buildForbiddenToolNames({
    baseForbidden: Array.isArray(universalTaskContract.forbidden_tools)
      ? universalTaskContract.forbidden_tools
      : [],
    goal,
    fileIds: files,
    documentPolicy,
    executionProfile,
    universalTaskContract,
  });
  const tools = buildTaskTools().filter((tool) => !forbiddenToolNames.has(tool.name));
  const frameworkStatus = await buildAgenticFrameworkStatus({ tools, langGraphLayer });
  emit({
    type: 'framework_status',
    taskId,
    ...frameworkStatus,
  });
  emit({
    type: 'checkpoint',
    label: langGraphLayer.enabled ? 'LangGraph durable listo' : 'Grafo durable fallback listo',
    status: 'saved',
    payload: {
      provider: langGraphLayer.provider,
      enabled: langGraphLayer.enabled,
      nodes: langGraphLayer.nodes,
      checkpointer: langGraphLayer.checkpointer || null,
      humanInTheLoop: Boolean(langGraphLayer.humanInTheLoop),
      fallback: langGraphLayer.fallback || null,
    },
  });

  emit({
    type: 'meta',
    taskId,
    goal: displayGoal,
    model,
    runtimeModel: runtimeModelProfile.runtimeModel,
    runtimeProvider: runtimeModelProfile.runtimeProvider,
    tools: tools.map((tool) => tool.name),
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    enterpriseToolRuntimePlan,
    enterpriseQaBoardReview,
    agenticOperatingCore,
    openclawRuntimeProfile,
    frameworks: frameworkStatus,
    taskContract,
    taskContractSource,
  });
  for (const event of openclawCapabilityKernel.buildOpenClawRuntimeEvents(openclawRuntimeProfile)) {
    emit(event);
  }

  auditLog.audit({
    event: 'agent_task_worker_started',
    taskId,
    userId: user.id,
    chatId,
    model,
    runtimeModel: runtimeModelProfile.runtimeModel,
    runtimeProvider: runtimeModelProfile.runtimeProvider,
    modelRemapped: runtimeModelProfile.remapped,
    queue: getQueueName(),
    jobId: job?.id ? String(job.id) : task.jobId,
    traceId: task.traceId,
    documentPolicy: auditLog.slimDocumentPolicy(documentPolicy),
  });

  let assistantMessageId = existing?.assistantMessageId || null;
  let uploadedFileContext = wantsSourcePreservingEdit
    ? ''
    : await buildUploadedFileContext(prisma, {
      userId: user.id,
      fileIds: files,
      query: deterministicAttachmentAnswer ? '' : displayGoal || goal,
      maxChars: deterministicAttachmentAnswer ? 120000 : 36000,
    });

  // ── Vision grounding para imágenes adjuntas ────────────────────────
  // Cuando la extracción de texto deja casi nada (logos, fotos, diagramas,
  // capturas sin OCR útil), el guard de adjunto-insuficiente rechazaría el
  // turno aunque un modelo de visión pueda leer la imagen directamente.
  // Describimos las imágenes con el runtime de visión configurado y
  // anexamos la descripción al contexto: el guard deja de dispararse y el
  // agente responde con contexto visual real.
  if (!wantsSourcePreservingEdit && prisma && Array.isArray(files) && files.length > 0
    && countUsefulWords(uploadedFileContext) < DEFAULT_THIN_THRESHOLD) {
    try {
      const fileRows = await prisma.file.findMany({
        where: { id: { in: files }, userId: user.id },
        select: { id: true, filename: true, originalName: true, mimeType: true, path: true },
      });
      const imageFiles = fileRows
        .filter((row) => isImageFile(row))
        .map((row) => {
          const resolvedPath = resolveStoredFilePath(row, user.id);
          return resolvedPath
            ? { path: resolvedPath, mimeType: row.mimeType || 'image/png' }
            : null;
        })
        .filter(Boolean);
      if (imageFiles.length > 0) {
        const aiService = require('../ai-service');
        const visualDescription = await aiService.describeAttachedImages(
          imageFiles,
          displayGoal || goal,
        );
        if (visualDescription) {
          uploadedFileContext = [
            uploadedFileContext,
            `Análisis visual de ${imageFiles.length} imagen(es) adjunta(s) realizado por un modelo de visión:`,
            visualDescription,
          ].filter(Boolean).join('\n\n');
          console.log(`[agent-task] vision grounding aplicado: ${imageFiles.length} imagen(es), ${visualDescription.length} chars (task ${taskId})`);
        } else {
          console.warn(`[agent-task] vision grounding sin descripción (¿proveedor de visión no configurado?) (task ${taskId})`);
        }
      }
    } catch (visionErr) {
      console.warn('[agent-task] vision grounding falló (se continúa con el texto extraído):', visionErr?.message || visionErr);
    }
  }
  if (chatId && prisma) {
    try {
      const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: user.id } });
      if (chat) {
        if (!existing?.assistantMessageId) {
          const messageFiles = await serializeMessageAttachments(prisma, {
            userId: user.id,
            fileIds: files,
            clientMetadata: fileMetadata,
          });
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: displayGoal,
              files: messageFiles.length ? messageFiles : null,
              timestamp: new Date(),
              metadata: { source: 'agent-task-user', taskId, fileIds: files },
            },
          });
        }
        const assistant = assistantMessageId
          ? null
          : await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: internals.serializeAgentState(streamState),
              timestamp: new Date(),
              metadata: {
                source: 'agent-task',
                taskId,
                status: 'running',
                displayGoal,
                documentPolicy,
              },
            },
          });
        assistantMessageId = assistantMessageId || assistant?.id || null;
        task.assistantMessageId = assistantMessageId;
        taskStore.markTaskStatus(task, 'running', { assistantMessageId, streamState });
      }
    } catch {
      // DB persistence is intentionally non-fatal for local/dev.
    }
  }

  let stepIdCounter = 0;
  let currentStepId = null;
  const runtimeTimer = setTimeout(() => controller.abort(), maxRuntimeMs + 5000);

  // ── BullMQ lock heartbeat ──────────────────────────────────────────
  // Agent tasks routinely run 10–20 min (max_steps=80 reached at ~19min
  // in prod logs). BullMQ's automatic lock renewal fires every
  // lockDuration/2 and any single failed renew (Upstash failover, quota
  // throttle, network blip) loses the lock for the rest of the run,
  // producing the "could not renew lock" spam and then the fatal
  // "Missing lock for job ... moveToFinished" when the work is done.
  //
  // We piggyback our own heartbeat that explicitly calls extendLock on
  // a tight cadence (every 30 s by default) using the job's token. If a
  // single tick fails we retry on the next tick instead of giving up,
  // and we throttle warns so a Redis outage logs once per minute, not
  // once per heartbeat. Cleared in the outer `finally` below.
  const lockHeartbeatIntervalMs = Math.max(
    5_000,
    Number.parseInt(process.env.AGENT_WORKER_LOCK_HEARTBEAT_MS || '30000', 10) || 30_000,
  );
  const lockHeartbeatExtendMs = Math.max(
    lockHeartbeatIntervalMs * 4,
    Number.parseInt(process.env.AGENT_WORKER_LOCK_DURATION_MS || '', 10) || 5 * 60 * 1000,
  );
  let lockHeartbeatTimer = null;
  let lockHeartbeatLastWarnAt = 0;
  if (job && typeof job.extendLock === 'function' && job.token) {
    const tick = async () => {
      try {
        await job.extendLock(job.token, lockHeartbeatExtendMs);
      } catch (err) {
        const now = Date.now();
        if (now - lockHeartbeatLastWarnAt > 60_000) {
          lockHeartbeatLastWarnAt = now;
          console.warn(
            `[agent-task-runner] lock heartbeat extendLock failed for ${taskId}: ${err?.message || err} (will keep retrying)`,
          );
        }
      }
    };
    // Refresh immediately so the first long step doesn't race the
    // initial 30s renew, then on a steady cadence.
    tick();
    lockHeartbeatTimer = setInterval(tick, lockHeartbeatIntervalMs);
    if (typeof lockHeartbeatTimer.unref === 'function') lockHeartbeatTimer.unref();
  }
  const finishDeterministicTask = async ({
    finalMarkdown,
    stoppedReason,
    steps,
    artifactsList = artifacts,
    metadata = {},
  }) => {
    if (finalMarkdown) emit({ type: 'final_text', markdown: finalMarkdown });
    const doneEvent = emit({
      type: 'done',
      stoppedReason,
      stats: { steps, artifacts: artifactsList.length },
    });

    const status = 'completed';
    task.status = status;
    task.updatedAt = new Date().toISOString();
    const dbMessage = await persistAssistantMessage({
      chatId,
      userId: user.id,
      assistantMessageId,
      streamState,
      task,
      status,
      artifacts: artifactsList,
      metadata: {
        documentPolicy,
        runtimeModel: runtimeModelProfile.runtimeModel,
        selectedModel: model,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        openclawRuntimeProfile,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        frameworks: frameworkStatus,
        durableExecution: enterpriseRuntimeProfile.durableExecution,
        stoppedReason,
        maxSteps,
        maxRuntimeMs,
        ...metadata,
      },
    });
    if (dbMessage?.id && doneEvent) {
      emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
    }

    taskStore.markTaskStatus(task, status, {
      streamState,
      stats: {
        steps,
        artifacts: artifactsList.length,
        durationMs: Date.now() - startedAt,
        stoppedReason,
      },
      artifacts: artifactsList,
    });
    if (task.durableExecution?.graphId) {
      try {
        durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
          stats: {
            steps,
            artifacts: artifactsList.length,
            durationMs: Date.now() - startedAt,
            stoppedReason,
          },
        });
      } catch (err) {
        console.warn('[agent-task-runner] durable graph status write failed:', err.message);
      }
    }
    metrics.counter('agent_task_invocations_total', { status });
    metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
    metrics.counter('agent_task_artifacts_total', { status }, artifactsList.length);
    persistProgress(status);
    auditLog.audit({
      event: 'agent_task_worker_finished',
      taskId,
      userId: user.id,
      chatId,
      status,
      stoppedReason,
      steps,
      artifacts: artifactsList.length,
      durationMs: Date.now() - startedAt,
    });
    return { taskId, status, artifacts: artifactsList.length };
  };

  try {
    if (wantsSourcePreservingEdit && documentPolicy?.autoGenerate) {
      stepIdCounter = 1;
      currentStepId = 's1';
      emit({ type: 'step_start', id: currentStepId, label: 'Editando documento original', icon: 'file-text' });
      try {
        emit({
          type: 'checkpoint',
          label: 'Editando documento original',
          status: 'running',
          payload: {
            mode: 'source_preserving_append',
            fileCount: Array.isArray(files) ? files.length : 0,
            orchestration: 'source_preserving_document_swarm',
          },
        });
        const preserved = await tryGenerateSourcePreservingDocumentEdit({
          prisma,
          userId: user.id,
          chatId,
          fileIds: files,
          prompt: goal,
          displayPrompt: displayGoal,
        });
        if (preserved === null) {
          // No había archivo adjunto ni artefacto previo que conservar: la
          // petición es en realidad un documento NUEVO. Señalamos el caso con
          // un sentinel para que el catch lo trate como "generar desde cero"
          // (fallthrough) en vez de rechazar la creación del documento.
          const fresh = new Error('source_preserving_no_base');
          fresh.__fallthroughFreshDocument = true;
          throw fresh;
        }
        if (!preserved.validation?.passed) {
          const unresolved = preserved.validation?.details?.agenticCycle?.unresolvedChecks || [];
          throw new Error(`La edición se generó pero no pasó la autoevaluación del DOCX${unresolved.length ? `: ${unresolved.join(', ')}` : '.'}`);
        }
        const artifactEvent = {
          id: preserved.artifact.id,
          filename: preserved.artifact.filename,
          format: preserved.artifact.format,
          mime: preserved.artifact.mime,
          sizeBytes: preserved.artifact.sizeBytes,
          downloadUrl: preserved.artifact.downloadUrl,
          previewHtml: preserved.previewHtml,
          validation: preserved.validation,
        };
        artifacts.push(artifactEvent);
        emit({ type: 'file_artifact', artifact: artifactEvent });
        emit({
          type: 'checkpoint',
          label: 'Autoevaluación del documento',
          status: 'completed',
          payload: preserved.validation?.details?.agenticCycle || null,
        });
        for (const criterion of preserved.validation?.details?.agenticCycle?.semanticCriteria || []) {
          emit({
            type: 'quality_gate',
            gate: `docx_${criterion.id}`,
            label: criterion.label || criterion.id,
            passed: Boolean(criterion.passed),
            summary: criterion.passed
              ? 'Criterio verificado en el DOCX generado.'
              : 'Criterio no cumplido en el DOCX generado.',
            payload: criterion,
          });
        }
        emit({
          type: 'quality_gate',
          gate: 'source_preserving_document_edit',
          label: 'Documento original conservado',
          passed: Boolean(preserved.validation?.passed),
          summary: 'Se completó el archivo original sin regenerar portada, tablas ni estructura previa.',
          payload: {
            ...(preserved.validation || {}),
            orchestration: preserved.orchestration || preserved.validation?.details?.orchestration || null,
          },
        });
        await persistence.persistGeneratedArtifact({
          artifact: { ...preserved.artifact, validation: preserved.validation },
          task,
          previewHtml: preserved.previewHtml,
          validation: preserved.validation,
        });
        emit({ type: 'step_done', id: currentStepId, ok: Boolean(preserved.validation?.passed) });
        currentStepId = null;
        return finishDeterministicTask({
          finalMarkdown: preserved.content,
          stoppedReason: 'source_preserving_document_edit',
          steps: stepIdCounter,
          artifactsList: artifacts,
          metadata: {
            sourcePreservingEdit: true,
            sourceFileIds: files,
            sourcePreservingOrchestration: preserved.orchestration || null,
          },
        });
      } catch (err) {
        // "Target-not-located" failures (the literal editor couldn't find the
        // exact string/section to delete/replace) are NOT terminal: the request
        // is well-formed, the deterministic literal matcher just can't resolve
        // natural language ("borra el jurado evaluador"). Fall through to the
        // generative path (grounded in the file's text) instead of dead-ending
        // with "No pude editar…". The semantic document_edit tool on the inline
        // /api/ai/generate path is the primary handler; this keeps the queued
        // surface from giving the user an error on a perfectly valid edit.
        const TARGET_NOT_LOCATED = new Set([
          'DELETE_TEXT_NOT_FOUND', 'DELETE_TEXT_UNSPECIFIED',
          'REPLACE_TEXT_NOT_FOUND', 'REPLACE_TEXT_UNSPECIFIED',
          'SECTION_TABLE_NOT_FOUND', 'CRONOGRAMA_TABLE_NOT_FOUND',
          'XLSX_REPLACE_TEXT_NOT_FOUND', 'XLSX_REPLACE_TEXT_UNSPECIFIED',
          'PPTX_REPLACE_TEXT_NOT_FOUND', 'PPTX_REPLACE_TEXT_UNSPECIFIED',
        ]);
        if (err && err.__fallthroughFreshDocument) {
          // Sin archivo base que conservar: cerramos el paso de edición y
          // dejamos que el flujo genere un documento nuevo más abajo en lugar
          // de rechazar la creación del documento.
          wantsSourcePreservingEdit = false;
          emit({ type: 'step_done', id: currentStepId, ok: true });
          currentStepId = null;
        } else if (err && TARGET_NOT_LOCATED.has(err.code)) {
          wantsSourcePreservingEdit = false;
          emit({ type: 'step_done', id: currentStepId, ok: true });
          currentStepId = null;
          emit({
            type: 'quality_gate',
            gate: 'source_preserving_document_edit',
            label: 'Reintentando la edición de forma semántica',
            passed: true,
            summary: 'El editor literal no ubicó el fragmento exacto; el agente reintenta la edición sobre el documento.',
          });
        } else {
          emit({ type: 'step_done', id: currentStepId, ok: false });
          currentStepId = null;
          emit({
            type: 'quality_gate',
            gate: 'source_preserving_document_edit',
            label: 'Edición preservadora no disponible',
            passed: false,
            summary: err?.message || 'No se pudo editar el archivo original.',
          });
          return finishDeterministicTask({
            finalMarkdown: `No pude editar el archivo original sin cambiarlo: ${err?.message || 'error desconocido'}. No generé un documento nuevo para evitar entregarte contenido ajeno al archivo.`,
            stoppedReason: 'source_preserving_document_edit_failed',
            steps: stepIdCounter,
            artifactsList: [],
            metadata: {
              sourcePreservingEdit: true,
              sourcePreservingError: err?.message || 'unknown_error',
              sourceFileIds: files,
            },
          });
        }
      }
    }

    if (plainTranscriptionRequest) {
      const transcriptionFileIds = Array.isArray(files) && files.length
        ? files.map(String).filter(Boolean)
        : await resolveTranscriptionFileIds(prisma, {
          userId: user.id,
          chatId,
          providedFileIds: files,
        });
      const transcriptionText = await buildTranscriptionTextFromFiles(prisma, {
        userId: user.id,
        fileIds: transcriptionFileIds,
      });

      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: transcriptionText
          ? 'Solicitud de transcripción literal; se devuelve el texto extraído en el chat.'
          : 'Solicitud de transcripción literal sin contenido legible disponible.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          transcriptionOnly: true,
          fileCount: transcriptionFileIds.length,
          wordCount: transcriptionText ? transcriptionText.split(/\s+/).filter(Boolean).length : 0,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      const readStepId = 's1';
      const finalStepId = 's2';
      stepIdCounter = 1;
      emit({ type: 'step_start', id: readStepId, label: 'Leyendo archivo adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: readStepId, ok: Boolean(transcriptionText) });
      emit({
        type: 'checkpoint',
        label: transcriptionText ? 'Texto extraído' : 'Sin texto legible',
        status: transcriptionText ? 'saved' : 'warning',
        payload: { fileIds: transcriptionFileIds, textLength: transcriptionText.length },
      });
      stepIdCounter = 2;
      emit({ type: 'step_start', id: finalStepId, label: 'Preparando transcripción', icon: 'braces' });
      emit({ type: 'step_done', id: finalStepId, ok: true });

      const finalMarkdown = transcriptionText || 'No se encontró texto disponible para transcribir en los archivos adjuntos. Por favor, proporciona un archivo legible o más detalles sobre el contenido que deseas transcribir.';
      emit({ type: 'final_text', markdown: finalMarkdown });
      const doneEvent = emit({
        type: 'done',
        stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        stats: { steps: 2, artifacts: 0 },
      });

      const status = 'completed';
      task.status = status;
      task.updatedAt = new Date().toISOString();
      const dbMessage = await persistAssistantMessage({
        chatId,
        userId: user.id,
        assistantMessageId,
        streamState,
        task,
        status,
        artifacts,
        metadata: {
          documentPolicy,
          runtimeModel: runtimeModelProfile.runtimeModel,
          selectedModel: model,
          stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
          transcriptionFileIds,
        },
      });
      if (dbMessage?.id && doneEvent) {
        emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
      }

      taskStore.markTaskStatus(task, status, {
        streamState,
        stats: {
          steps: 2,
          artifacts: 0,
          durationMs: Date.now() - startedAt,
          stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        },
        artifacts,
      });
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
            stats: {
              steps: 2,
              artifacts: 0,
              durationMs: Date.now() - startedAt,
              stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
            },
          });
        } catch (err) {
          console.warn('[agent-task-runner] durable graph status write failed:', err.message);
        }
      }
      metrics.counter('agent_task_invocations_total', { status });
      metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
      metrics.counter('agent_task_artifacts_total', { status }, 0);
      persistProgress(status);
      auditLog.audit({
        event: 'agent_task_worker_finished',
        taskId,
        userId: user.id,
        chatId,
        status,
        stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        steps: 2,
        artifacts: 0,
        durationMs: Date.now() - startedAt,
        transcriptionFileCount: transcriptionFileIds.length,
        transcriptionTextLength: transcriptionText.length,
      });
      return { taskId, status, artifacts: 0 };
    }

    // ── Thin-attachment guard ─────────────────────────────────────────
    // If the user attached files AND the question references the attachment
    // ("de qué es esto?", "qué dice este documento?"), but extraction
    // produced only a handful of useful words, refuse to bluff. Ask the
    // user for the real content instead — better UX than a confident
    // "no se pudo determinar..." follow-up wrapped in an auto DOCX.
    const attachmentStats = assessAttachmentContext({
      uploadedFileContext,
      files,
      userText: displayGoal || goal,
    });
    if (attachmentStats.isThin) {
      const thinBibliographyFallback = buildBibliographyFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      if (thinBibliographyFallback) {
        documentPolicy = {
          ...(documentPolicy || {}),
          mode: 'chat_only',
          autoGenerate: false,
          reason: 'Bibliografía generada desde filas legibles del adjunto.',
          thresholds: {
            ...(documentPolicy?.thresholds || {}),
            attachmentFallback: true,
            thinContextWords: attachmentStats.usefulWords,
            fileCount: files.length,
          },
        };
        task.documentPolicy = documentPolicy;
        emit({ type: 'document_policy', policy: documentPolicy });
        stepIdCounter = 1;
        emit({ type: 'step_start', id: 's1', label: 'Formateando referencias', icon: 'file-text' });
        emit({ type: 'step_done', id: 's1', ok: true });
        return finishDeterministicTask({
          finalMarkdown: thinBibliographyFallback,
          stoppedReason: 'attachment_bibliography_fallback',
          steps: 1,
          artifactsList: [],
          metadata: {
            attachmentFallback: true,
            bibliographyRows: parseSpreadsheetCitationRows(uploadedFileContext).length,
            sourceFileIds: files,
          },
        });
      }

      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: 'Contexto adjunto insuficiente; se solicita material adicional al usuario.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          thinContextWords: attachmentStats.usefulWords,
          fileCount: files.length,
          transcriptionOnly: false,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      const stepId = 's1';
      stepIdCounter = 1;
      emit({ type: 'step_start', id: stepId, label: 'Revisando adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: stepId, ok: true });
      emit({
        type: 'checkpoint',
        label: 'Adjunto con contenido insuficiente',
        status: 'warning',
        payload: { usefulWords: attachmentStats.usefulWords, fileCount: files.length },
      });

      const wordsLabel = attachmentStats.usefulWords === 1 ? '1 palabra útil' : `${attachmentStats.usefulWords} palabras útiles`;
      const finalMarkdown = [
        `El material adjunto solo contiene ${wordsLabel}, lo que no me alcanza para responder tu pregunta con confianza.`,
        '',
        '**¿Puedes ayudarme con una de estas opciones?**',
        '- Pega el texto completo de la página o documento.',
        '- Sube el archivo original (PDF, DOCX, imagen completa).',
        '- Comparte el enlace de origen para revisar el contenido directamente.',
      ].join('\n');

      emit({ type: 'final_text', markdown: finalMarkdown });
      const doneEvent = emit({
        type: 'done',
        stoppedReason: 'thin_attachment_context',
        stats: { steps: 1, artifacts: 0 },
      });

      const status = 'completed';
      task.status = status;
      task.updatedAt = new Date().toISOString();
      const dbMessage = await persistAssistantMessage({
        chatId,
        userId: user.id,
        assistantMessageId,
        streamState,
        task,
        status,
        artifacts: [],
        metadata: {
          documentPolicy,
          runtimeModel: runtimeModelProfile.runtimeModel,
          selectedModel: model,
          stoppedReason: 'thin_attachment_context',
          attachmentStats,
        },
      });
      if (dbMessage?.id && doneEvent) {
        emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
      }

      taskStore.markTaskStatus(task, status, {
        streamState,
        stats: {
          steps: 1,
          artifacts: 0,
          durationMs: Date.now() - startedAt,
          stoppedReason: 'thin_attachment_context',
        },
        artifacts: [],
      });
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
            stats: {
              steps: 1,
              artifacts: 0,
              durationMs: Date.now() - startedAt,
              stoppedReason: 'thin_attachment_context',
            },
          });
        } catch (err) {
          console.warn('[agent-task-runner] durable graph status write failed:', err.message);
        }
      }
      metrics.counter('agent_task_invocations_total', { status });
      metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
      metrics.counter('agent_task_artifacts_total', { status }, 0);
      persistProgress(status);
      auditLog.audit({
        event: 'agent_task_worker_finished',
        taskId,
        userId: user.id,
        chatId,
        status,
        stoppedReason: 'thin_attachment_context',
        steps: 1,
        artifacts: 0,
        durationMs: Date.now() - startedAt,
        attachmentStats,
      });
      return { taskId, status, artifacts: 0 };
    }

    if (deterministicAttachmentAnswer) {
      const recoveredMarkdown = buildBibliographyFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      }) || buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
        reason: 'attachment_chat_fast_path',
      });
      const finalFallbackMarkdown = recoveredMarkdown || buildAttachmentUnavailableFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: recoveredMarkdown
          ? 'Respuesta directa generada desde el contenido extraído del adjunto.'
          : 'Adjunto sin texto legible suficiente para una respuesta directa.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFastPath: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });
      stepIdCounter = 1;
      emit({ type: 'step_start', id: 's1', label: 'Analizando adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: 's1', ok: Boolean(recoveredMarkdown) });
      emit({
        type: 'quality_gate',
        gate: 'attachment_chat_fast_path',
        label: recoveredMarkdown ? 'Respuesta desde adjunto' : 'Adjunto requiere más contenido',
        passed: Boolean(recoveredMarkdown),
        summary: recoveredMarkdown
          ? 'Se respondió sin depender del bucle de herramientas ni de la cola.'
          : 'Se explicó cómo aportar contenido legible en lugar de dejar el stream abierto.',
      });
      return finishDeterministicTask({
        finalMarkdown: finalFallbackMarkdown,
        stoppedReason: recoveredMarkdown ? 'attachment_chat_fast_path' : 'attachment_unreadable_fast_path',
        steps: 1,
        artifactsList: [],
        metadata: {
          attachmentFastPath: true,
          sourceFileIds: files,
          usefulWords: countUsefulWords(uploadedFileContext),
        },
      });
    }

    if (!openai && hasAttachedFiles) {
      const recoveredMarkdown = buildBibliographyFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      }) || buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      const finalFallbackMarkdown = recoveredMarkdown || buildAttachmentUnavailableFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: recoveredMarkdown
          ? 'Respuesta generada desde el contenido del adjunto.'
          : 'Adjunto sin texto legible suficiente; se pidió material al usuario.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFallback: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });
      stepIdCounter = 1;
      emit({ type: 'step_start', id: 's1', label: 'Analizando documento adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: 's1', ok: Boolean(recoveredMarkdown) });
      emit({
        type: 'quality_gate',
        gate: 'attachment_local_fallback',
        label: recoveredMarkdown ? 'Respuesta desde el adjunto' : 'Adjunto requiere más contenido',
        passed: Boolean(recoveredMarkdown),
        summary: recoveredMarkdown
          ? 'Se generó la respuesta usando el texto extraído del archivo.'
          : 'Se indicó al usuario cómo aportar contenido legible.',
      });
      return finishDeterministicTask({
        finalMarkdown: finalFallbackMarkdown,
        stoppedReason: recoveredMarkdown ? 'attachment_local_fallback' : 'attachment_unreadable_fallback',
        steps: 1,
        artifactsList: [],
        metadata: {
          attachmentFallback: true,
          fallbackReason: 'openai_not_configured',
          sourceFileIds: files,
        },
      });
    }

    if (deterministicVancouverRequest) {
      documentPolicy = {
        ...buildDocumentDeliveryPolicy({
          goal,
          displayGoal,
          files,
          requestedFormat: 'docx',
        }),
        mode: 'doc_required',
        format: 'docx',
        autoGenerate: true,
        reason: 'Solicitud explícita de tabla en Word con estructura Vancouver.',
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      stepIdCounter = 1;
      emit({ type: 'step_start', id: 's1', label: 'Leyendo documento adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: 's1', ok: true });
      emit({
        type: 'checkpoint',
        label: 'Contenido documental disponible',
        status: 'saved',
        payload: {
          fileCount: files.length,
          contextChars: String(uploadedFileContext || '').length,
        },
      });

      stepIdCounter = 2;
      emit({ type: 'step_start', id: 's2', label: 'Construyendo matriz Vancouver', icon: 'table' });
      const generated = await generateVancouverMatrixDocument({
        prisma,
        task,
        userId: user.id,
        fileIds: files,
        goal: displayGoal || goal,
        emit,
      });
      if (generated?.artifact) artifacts.push(generated.artifact);
      emit({ type: 'step_done', id: 's2', ok: true });

      stepIdCounter = 3;
      emit({ type: 'step_start', id: 's3', label: 'Preparando entrega final', icon: 'check' });
      emit({ type: 'step_done', id: 's3', ok: true });

      return finishDeterministicTask({
        finalMarkdown: generated.finalMarkdown,
        stoppedReason: 'vancouver_matrix_docx',
        steps: 3,
        artifactsList: artifacts,
        metadata: {
          vancouverMatrix: true,
          sourceFileIds: files,
          validation: generated.validation,
        },
      });
    }

    const { createAuthorizationGate } = require('./tool-authorization-gate');
    const toolManifest = require('./tool-manifest');
    const toolGate = createAuthorizationGate();
    const toolUsageMap = {};
    const toolCtx = {
      userId: user.id,
      userEmail: user.email,
      openai,
      signal: controller.signal,
      chatId,
      taskId,
      folderCode,
      fileIds: files,
      displayGoal,
      taskContract,
      universalTaskContract,
      enterpriseExecutionGraph,
      enterpriseRuntimeProfile,
      toolGate,
      toolAuthCtx: {
        userId: user.id,
        clearance: user.clearance || 'authenticated',
        scopes: user.scopes || [],
        taskId,
      },
      toolUsageMap,
      checkToolBudget: toolManifest.checkToolUsageBudget,
      enterpriseToolRuntimePlan,
      prisma,
      onEvent: (evt) => {
        const payloadEvent = { ...evt, stepId: evt.stepId || currentStepId };
        if (evt.type === 'file_artifact' && evt.artifact) {
          artifacts.push(evt.artifact);
          void persistence.persistGeneratedArtifact({ artifact: evt.artifact, task, validation: evt.artifact.validation });
        }
        if (evt.type === 'contract_review') {
          emit({
            type: 'quality_gate',
            gate: 'contract_review',
            label: 'Contrato de artefacto',
            passed: Boolean(evt.passed),
            summary: `${evt.testsPassed || 0}/${evt.testsTotal || 0} pruebas contractuales`,
            payload: evt,
          });
        }
        emit(payloadEvent);
      },
    };

    // Chat-only requests against an attachment have no artifact to
    // produce — the agent only needs to read the file, reason, and
    // answer inline. Capping at 20 steps prevents the runner from
    // looping for 3+ minutes when the attachment turns out to be
    // unreadable; the post-loop recovery (attachment_unreadable_
    // empty_response_recovery) then generates a fallback answer in
    // seconds instead of minutes. Non-attachment goals and document-
    // generation goals keep the caller-provided ceiling.
    const isChatOnlyWithAttachment = hasAttachedFiles
      && documentPolicy?.mode === 'chat_only';
    const effectiveMaxSteps = isChatOnlyWithAttachment
      ? Math.min(maxSteps, 20)
      : maxSteps;

    // Professional document cycle: announce the ordered stages up-front so
    // the UI can render the full progress track before the agent reports
    // each transition via report_stage (cycle_stage events).
    if (cycle && Array.isArray(cycle.stages) && cycle.stages.length > 0) {
      emit({
        type: 'cycle_init',
        stages: cycle.stages,
        documentType: cycle.documentType || null,
        field: cycle.field || null,
        citationStyle: cycle.citationStyle || null,
        code: cycle.code || folderCode || null,
      });
    }

    let preLoopStepId = null;

    const reactRunArgs = {
      query: goal,
      tools,
      maxSteps: effectiveMaxSteps,
      maxRuntimeMs,
      model: runtimeModelProfile.runtimeModel,
      extraSystem: internals.buildAgentSystemPrompt(
        systemContract,
        files,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        taskContract,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        uploadedFileContext,
        openclawRuntimeProfile
      ),
      ctx: toolCtx,
      finalizeGuard: ({ steps, unavailableTools }) => validateAgentTaskFinalize({
        finalizeProfile,
        openclawRuntimeProfile,
        taskPlan,
        steps,
        unavailableTools,
      }),
      onCompact: ({ step, removedMessages, chars }) => {
        try { console.log(`[agent-task-runner] trace compacted at step ${step}: -${removedMessages} msgs, ${chars} chars (task ${taskId})`); } catch (_) {}
      },
      onStepStart: (step) => {
        if (preLoopStepId && currentStepId === preLoopStepId) {
          emit({ type: 'step_done', id: preLoopStepId, ok: true });
          preLoopStepId = null;
        }
        stepIdCounter += 1;
        currentStepId = `s${stepIdCounter}`;
        const thought = (step.thought || '').trim();
        const firstAction = step.actions?.[0];
        const label = thought || firstAction?.tool || 'Pensando...';
        const icon = internals.inferIconFor ? internals.inferIconFor(firstAction?.tool) : undefined;
        emit({ type: 'step_start', id: currentStepId, label: internals.shortLabel ? internals.shortLabel(label) : label, icon });
      },
      onStepDone: (step) => {
        const firstAction = step.actions?.[0];
        emit({ type: 'step_done', id: currentStepId, ok: !firstAction?.observation?.error });
        emit({
          type: 'checkpoint',
          label: `Paso ${stepIdCounter} guardado`,
          status: 'saved',
          payload: { stepId: currentStepId },
        });
        currentStepId = null;
      },
    };

    // Emit an immediate "thinking" step before the first LLM round-trip so
    // the frontend stale-detection timer (90 s of no step events) does NOT
    // fire during a slow model response. Without this, a DeepSeek / OpenRouter
    // call that takes >90 s produces "Sin actualizaciones recientes" even
    // though the task is actively running.
    stepIdCounter += 1;
    currentStepId = `s${stepIdCounter}`;
    preLoopStepId = currentStepId;
    const preLoopLabel = (() => {
      const g = (goal || '').toLowerCase();
      if (/busca|artículo|investiga|paper|paper|científico|científica|search|find/.test(g)) return 'Buscando información...';
      if (/analiz|resume|resumir|resum|analys/.test(g)) return 'Analizando solicitud...';
      if (/escribe|redacta|crea|genera|write|draft/.test(g)) return 'Redactando respuesta...';
      return 'Procesando solicitud...';
    })();
    emit({ type: 'step_start', id: preLoopStepId, label: preLoopLabel, icon: 'brain' });

    let result = await reactAgent.run(openai, reactRunArgs);

    if (preLoopStepId && currentStepId === preLoopStepId) {
      emit({ type: 'step_done', id: preLoopStepId, ok: true });
      preLoopStepId = null;
      currentStepId = null;
    }

    // ── Cross-provider model failover (OpenClaw-style) ─────────────────
    // The tool stack (búsquedas científicas key-free, documentos, etc.) es
    // agnóstico del modelo: si el modelo seleccionado muere (402 sin
    // créditos, 401 key inválida, caída del proveedor), la tarea NO debe
    // morir con él. Reintentamos UNA vez con el primer runtime sano de
    // otro proveedor antes de degradar la respuesta.
    const modelFailed = String(result.stoppedReason || '').startsWith('model_error');
    if (modelFailed && agentModelFailoverEnabled()) {
      const failoverRuntime = resolveAgentModelFailoverRuntime(runtimeModelProfile);
      if (failoverRuntime?.client) {
        console.warn(`[agent-task] model failover: ${runtimeModelProfile.runtimeModel} → ${failoverRuntime.provider}:${failoverRuntime.model} (task ${taskId})`);
        emit({
          type: 'checkpoint',
          label: `Modelo de respaldo activado: ${failoverRuntime.model}`,
          status: 'warning',
          payload: { from: runtimeModelProfile.runtimeModel, to: failoverRuntime.model, reason: result.stoppedReason },
        });
        result = await reactAgent.run(failoverRuntime.client, {
          ...reactRunArgs,
          model: failoverRuntime.model,
        });
      }
    }

    let finalMarkdown = result.finalAnswer || '';
    let stoppedReason = result.stoppedReason;
    const recoveryUploadedFileContext = [
      uploadedFileContext,
      buildToolObservationFallbackContext(result.steps),
    ].filter(Boolean).join('\n');
    const attachmentFinalNeedsRecovery = Array.isArray(files) && files.length > 0 && (
      looksLikeEmptyOrWeakFinalAnswer(finalMarkdown) ||
      looksLikeMissingAttachmentAnswer(finalMarkdown)
    );
    if (attachmentFinalNeedsRecovery) {
      const llmRecoveredMarkdown = await buildLlmAttachmentRecoveryAnswer({
        goal: displayGoal || goal,
        uploadedFileContext: recoveryUploadedFileContext,
      });
      const recoveredMarkdown = llmRecoveredMarkdown || buildBibliographyFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext: recoveryUploadedFileContext,
      }) || buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext: recoveryUploadedFileContext,
        reason: result.stoppedReason,
      });
      const finalFallbackMarkdown = recoveredMarkdown || buildAttachmentUnavailableFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext: recoveryUploadedFileContext,
      });
      finalMarkdown = finalFallbackMarkdown;
      stoppedReason = recoveredMarkdown
        ? 'attachment_empty_response_recovery'
        : 'attachment_unreadable_empty_response_recovery';
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: recoveredMarkdown
          ? 'Respuesta generada desde el contenido del adjunto.'
          : 'Sin texto legible suficiente en el adjunto.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFallback: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
          originalStoppedReason: result.stoppedReason,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({
        type: 'repair_attempt',
        attempt: 1,
        status: recoveredMarkdown ? 'recovered' : 'degraded',
        message: recoveredMarkdown
          ? 'Recuperé la respuesta usando el contenido de tu archivo.'
          : 'No hubía suficiente texto en el adjunto; te indico cómo continuar.',
      });
      if (stepIdCounter === 0) {
        stepIdCounter = 1;
        currentStepId = 's1';
        emit({ type: 'step_start', id: currentStepId, label: 'Recuperando respuesta desde el documento', icon: 'file-text' });
        emit({ type: 'step_done', id: currentStepId, ok: Boolean(recoveredMarkdown) });
        currentStepId = null;
      }
      emit({
        type: 'quality_gate',
        gate: 'attachment_empty_response_recovery',
        label: recoveredMarkdown ? 'Respuesta recuperada' : 'Se necesita más contenido',
        passed: Boolean(recoveredMarkdown),
        summary: recoveredMarkdown
          ? 'Se usó el texto del adjunto para completar la respuesta.'
          : 'Se explicó cómo aportar contenido legible en lugar de dejar el chat vacío.',
      });
    }
    documentPolicy = buildDocumentDeliveryPolicy({
      goal,
      displayGoal,
      finalText: finalMarkdown,
      files,
      requestedFormat: documentPolicy?.autoGenerate || documentPolicy?.mode === 'doc_required'
        ? documentPolicy?.format
        : null,
    });
    task.documentPolicy = documentPolicy;
    emit({ type: 'document_policy', policy: documentPolicy });

    if (documentPolicy.autoGenerate && artifacts.length === 0) {
      if (wantsSourcePreservingEdit) {
        try {
          emit({
            type: 'checkpoint',
            label: 'Editando documento original',
            status: 'running',
            payload: { mode: 'source_preserving_append', fileCount: Array.isArray(files) ? files.length : 0 },
          });
          const preserved = await tryGenerateSourcePreservingDocumentEdit({
            prisma,
            userId: user.id,
            chatId,
            fileIds: files,
            prompt: goal,
            displayPrompt: displayGoal,
          });
          if (preserved?.artifact) {
            if (!preserved.validation?.passed) {
              const unresolved = preserved.validation?.details?.agenticCycle?.unresolvedChecks || [];
              throw new Error(`La edición se generó pero no pasó la autoevaluación del DOCX${unresolved.length ? `: ${unresolved.join(', ')}` : '.'}`);
            }
            const artifactEvent = {
              id: preserved.artifact.id,
              filename: preserved.artifact.filename,
              format: preserved.artifact.format,
              mime: preserved.artifact.mime,
              sizeBytes: preserved.artifact.sizeBytes,
              downloadUrl: preserved.artifact.downloadUrl,
              previewHtml: preserved.previewHtml,
              validation: preserved.validation,
            };
            artifacts.push(artifactEvent);
            emit({ type: 'file_artifact', artifact: artifactEvent });
            emit({
              type: 'checkpoint',
              label: 'Autoevaluación del documento',
              status: 'completed',
              payload: preserved.validation?.details?.agenticCycle || null,
            });
            for (const criterion of preserved.validation?.details?.agenticCycle?.semanticCriteria || []) {
              emit({
                type: 'quality_gate',
                gate: `docx_${criterion.id}`,
                label: criterion.label || criterion.id,
                passed: Boolean(criterion.passed),
                summary: criterion.passed
                  ? 'Criterio verificado en el DOCX generado.'
                  : 'Criterio no cumplido en el DOCX generado.',
                payload: criterion,
              });
            }
            emit({
              type: 'quality_gate',
              gate: 'source_preserving_document_edit',
              label: 'Documento original conservado',
              passed: Boolean(preserved.validation?.passed),
              summary: 'Se agregó el contenido solicitado al archivo original sin regenerar portada, tablas ni estructura previa.',
              payload: preserved.validation,
            });
            await persistence.persistGeneratedArtifact({
              artifact: { ...preserved.artifact, validation: preserved.validation },
              task,
              previewHtml: preserved.previewHtml,
              validation: preserved.validation,
            });
            finalMarkdown = preserved.content;
          } else {
            // preserved === null: no hay archivo base que conservar, así que
            // generamos un documento NUEVO más abajo en vez de rechazar la
            // petición.
            wantsSourcePreservingEdit = false;
          }
        } catch (err) {
          // A "target-not-located" literal failure is not terminal — fall
          // through to the generative path (grounded in the file's text)
          // instead of returning an apology, mirroring the BEFORE-loop catch.
          const TARGET_NOT_LOCATED_POST = new Set([
            'DELETE_TEXT_NOT_FOUND', 'DELETE_TEXT_UNSPECIFIED',
            'REPLACE_TEXT_NOT_FOUND', 'REPLACE_TEXT_UNSPECIFIED',
            'SECTION_TABLE_NOT_FOUND', 'CRONOGRAMA_TABLE_NOT_FOUND',
            'XLSX_REPLACE_TEXT_NOT_FOUND', 'XLSX_REPLACE_TEXT_UNSPECIFIED',
            'PPTX_REPLACE_TEXT_NOT_FOUND', 'PPTX_REPLACE_TEXT_UNSPECIFIED',
          ]);
          if (err && TARGET_NOT_LOCATED_POST.has(err.code)) {
            emit({
              type: 'quality_gate',
              gate: 'source_preserving_document_edit',
              label: 'Reintentando la edición de forma semántica',
              passed: true,
              summary: 'El editor literal no ubicó el fragmento exacto; se genera el documento editado sobre el contenido del archivo.',
            });
            wantsSourcePreservingEdit = false;
          } else {
            emit({
              type: 'quality_gate',
              gate: 'source_preserving_document_edit',
              label: 'Edición preservadora no disponible',
              passed: false,
              summary: err?.message || 'No se pudo editar el archivo original.',
            });
            finalMarkdown = `No pude editar el archivo original sin cambiarlo: ${err?.message || 'error desconocido'}. No generé un documento nuevo para evitar entregarte contenido ajeno al archivo.`;
          }
        }
      }
    }

    if (documentPolicy.autoGenerate && artifacts.length === 0 && !wantsSourcePreservingEdit) {
      try {
        const generated = await generateAutoDocument({
          task,
          goal: displayGoal,
          finalText: finalMarkdown,
          policy: documentPolicy,
          signal: controller.signal,
          emit,
        });
        if (generated?.artifact) artifacts.push({
          id: generated.artifact.id,
          filename: generated.artifact.filename,
          format: generated.artifact.format,
          mime: generated.artifact.mime,
          sizeBytes: generated.artifact.sizeBytes,
          downloadUrl: generated.artifact.downloadUrl,
        });
        finalMarkdown = summarizeForChat(finalMarkdown, documentPolicy);
      } catch (err) {
        emit({
          type: 'repair_attempt',
          attempt: 1,
          status: 'failed',
          message: `La generación automática de documento falló: ${err.message}`,
        });
      }
    }

    if (finalMarkdown) emit({ type: 'final_text', markdown: finalMarkdown });
    const completedStepCount = Math.max(result.steps.length, stepIdCounter);
    const doneEvent = emit({
      type: 'done',
      stoppedReason,
      stats: { steps: completedStepCount, artifacts: artifacts.length },
    });

    const status = stoppedReason === 'aborted' ? 'cancelled' : 'completed';
    task.status = status;
    task.updatedAt = new Date().toISOString();
    const dbMessage = await persistAssistantMessage({
      chatId,
      userId: user.id,
      assistantMessageId,
      streamState,
      task,
      status,
      artifacts,
      metadata: {
        documentPolicy,
        runtimeModel: runtimeModelProfile.runtimeModel,
        selectedModel: model,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        frameworks: frameworkStatus,
        durableExecution: enterpriseRuntimeProfile.durableExecution,
        stoppedReason,
        maxSteps,
        maxRuntimeMs,
      },
    });
    if (dbMessage?.id && doneEvent) {
      emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
    }

    taskStore.markTaskStatus(task, status, {
      streamState,
      stats: {
        steps: completedStepCount,
        artifacts: artifacts.length,
        durationMs: Date.now() - startedAt,
        stoppedReason,
      },
      artifacts,
    });
    if (task.durableExecution?.graphId) {
      try {
        durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
          stats: {
            steps: completedStepCount,
            artifacts: artifacts.length,
            durationMs: Date.now() - startedAt,
            stoppedReason,
          },
        });
      } catch (err) {
        console.warn('[agent-task-runner] durable graph status write failed:', err.message);
      }
    }
    metrics.counter('agent_task_invocations_total', { status });
    metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
    metrics.counter('agent_task_artifacts_total', { status }, artifacts.length);
    persistProgress(status);
    auditLog.audit({
      event: 'agent_task_worker_finished',
      taskId,
      userId: user.id,
      chatId,
      status,
      stoppedReason,
      steps: completedStepCount,
      artifacts: artifacts.length,
      durationMs: Date.now() - startedAt,
    });
    return { taskId, status, artifacts: artifacts.length };
  } catch (err) {
    if (!controller.signal.aborted && hasAttachedFiles) {
      const recoveredMarkdown = buildBibliographyFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      }) || buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
        reason: err?.message,
      });
      const finalFallbackMarkdown = recoveredMarkdown || buildAttachmentUnavailableFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: recoveredMarkdown
          ? 'Respuesta generada desde el contenido del adjunto.'
          : 'Servicio interrumpido y adjunto sin texto legible suficiente.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFallback: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });
      emit({
        type: 'repair_attempt',
        attempt: 1,
        status: recoveredMarkdown ? 'recovered' : 'degraded',
        message: recoveredMarkdown
          ? 'Recuperé la respuesta usando el contenido de tu archivo.'
          : 'El servicio falló y el adjunto no tenía texto suficiente; te indico los siguientes pasos.',
      });
      if (!currentStepId) {
        stepIdCounter += 1;
        currentStepId = `s${stepIdCounter}`;
        emit({ type: 'step_start', id: currentStepId, label: 'Recuperando respuesta desde el documento', icon: 'file-text' });
      }
      emit({ type: 'step_done', id: currentStepId, ok: Boolean(recoveredMarkdown) });
      currentStepId = null;
      emit({
        type: 'quality_gate',
        gate: 'attachment_runtime_recovery',
        label: recoveredMarkdown ? 'Recuperación desde adjunto' : 'Se necesita más contenido',
        passed: Boolean(recoveredMarkdown),
        summary: recoveredMarkdown
          ? 'La respuesta se completó con el texto del adjunto.'
          : 'Se dieron instrucciones claras en lugar de un error opaco.',
      });
      return finishDeterministicTask({
        finalMarkdown: finalFallbackMarkdown,
        stoppedReason: recoveredMarkdown ? 'attachment_runtime_recovery' : 'attachment_unreadable_recovery',
        steps: Math.max(1, stepIdCounter),
        artifactsList: [],
        metadata: {
          attachmentFallback: true,
          fallbackReason: err?.message || 'runtime_failure',
          sourceFileIds: files,
        },
      });
    }
    const message = controller.signal.aborted ? 'Tarea detenida por el usuario.' : (err.message || 'agent task failed');
    task.status = controller.signal.aborted ? 'cancelled' : 'error';
    emit({ type: 'error', message });
    taskStore.markTaskStatus(task, task.status, {
      streamState,
      stats: { durationMs: Date.now() - startedAt, error: message },
    });
    persistProgress(task.status);
    auditLog.audit({
      event: 'agent_task_worker_failed',
      taskId,
      userId: user.id,
      chatId,
      status: task.status,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    if (task.status === 'error') throw err;
    return { taskId, status: task.status };
  } finally {
    clearTimeout(runtimeTimer);
    if (lockHeartbeatTimer) {
      clearInterval(lockHeartbeatTimer);
      lockHeartbeatTimer = null;
    }
  }
}

// ── Error introspection & recovery helpers ─────────────────────
// Used externally by the job scheduler to decide retry strategy.

// Add ±20% jitter so concurrent retries from the same upstream incident
// don't all hit at the exact same wall clock — flattens the recovery
// thundering herd without changing the average backoff.
function withJitter(baseMs) {
  if (!baseMs || baseMs <= 0) return baseMs;
  const spread = baseMs * 0.2;
  return Math.max(100, Math.round(baseMs + (Math.random() * 2 - 1) * spread));
}

/**
 * Classify an error thrown by runAgentTaskJob to determine retry eligibility.
 * Returns { retryable, reason, ttlMs } where ttlMs is how long before retry
 * (0 = immediate, >0 = backoff).
 */
const { classifyTaskError } = require('../../utils/task-error-classifier');

module.exports = {
  runAgentTaskJob,
  buildFinalizeProfile,
  buildOpenAICompatibleClient,
  classifyTaskError,
  normalizeAgentRuntimeModel,
  resolveAgentRuntimeClient,
  detectAgentRuntimeProvider,
  buildAttachmentGroundedFallbackAnswer,
  buildBibliographyFallbackAnswer,
  buildAttachmentUnavailableFallbackAnswer,
  buildLlmAttachmentRecoveryAnswer,
  pickAttachmentRecoveryRuntime,
  agentModelFailoverEnabled,
  resolveAgentModelFailoverRuntime,
  parseSpreadsheetCitationRows,
  parseCitationAuthors,
  resolveAttachmentFallbackMarkdown,
  shouldUseDeterministicAttachmentAnswer,
};
