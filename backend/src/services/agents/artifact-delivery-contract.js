'use strict';

const FORMAT_SPECS = [
  { format: 'docx', label: 'Word', pattern: /\b(docx|word)\b/i },
  { format: 'xlsx', label: 'Excel', pattern: /\b(xlsx|excel|hoja\s+de\s+c[aá]lculo)\b/i },
  { format: 'pptx', label: 'PowerPoint', pattern: /\b(pptx?|power\s*point|diapositivas?|slides?)\b/i },
  { format: 'pdf', label: 'PDF', pattern: /\bpdf\b/i },
  { format: 'csv', label: 'CSV', pattern: /\bcsv\b/i },
  { format: 'svg', label: 'SVG', pattern: /\bsvg\b/i },
  { format: 'md', label: 'Markdown', pattern: /\b(markdown|\.md)\b/i },
  { format: 'txt', label: 'texto', pattern: /\b(txt|archivo\s+de\s+texto)\b/i },
];

const DELIVERABLE_ACTION = /\b(crea(?:r|me)?|genera(?:r|me)?|prepara(?:r|me)?|elabora(?:r|me)?|arma(?:r|me)?|construye(?:r|me)?|redacta(?:r|me)?|exporta(?:r|me)?|convierte|descargable|entr[eé]ga(?:r|me)?)\b/i;
const DELIVERABLE_NOUN = /\b(archivos?|documentos?|entregables?|versiones?|formatos?|informe|reporte|presentaci[oó]n|word|excel|power\s*point|pptx?|pdf|csv|svg|markdown|docx|xlsx)\b/i;
const COUNT_WORDS = Object.freeze({ un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8 });

function parseCount(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COUNT_WORDS, normalized)) return COUNT_WORDS[normalized];
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extensionOf(artifact) {
  const explicit = String(artifact?.format || '').trim().toLowerCase().replace(/^\./, '');
  if (explicit) return explicit === 'ppt' ? 'pptx' : explicit;
  const match = String(artifact?.filename || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  if (!match) return '';
  return match[1] === 'ppt' ? 'pptx' : match[1];
}

function parseActionArgs(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function buildArtifactDeliveryContract(prompt, policy = {}) {
  const text = String(prompt || '');
  if (!policy.multipleArtifacts || !DELIVERABLE_ACTION.test(text) || !DELIVERABLE_NOUN.test(text)) {
    return { active: false, expectedCount: 0, requested: [], maxArtifacts: policy.maxArtifactsPerTurn || 6 };
  }

  const maxArtifacts = Math.max(1, Math.min(8, Number(policy.maxArtifactsPerTurn) || 6));
  const requested = FORMAT_SPECS
    .filter((spec) => spec.pattern.test(text))
    .map((spec) => ({ format: spec.format, label: spec.label, count: 1 }));

  if (requested.length === 1) {
    const countMatch = text.match(/\b(\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho)\s+(?:archivos?|documentos?|entregables?|versiones?|copias?)\b/i);
    const count = parseCount(countMatch?.[1]);
    if (count && count > 1) requested[0].count = Math.min(maxArtifacts, count);
  }

  if (requested.length === 0) {
    const countMatch = text.match(/\b(\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho)\s+(?:archivos?|documentos?|entregables?|versiones?|copias?)\b/i);
    const count = Math.max(1, parseCount(countMatch?.[1]) || 1);
    requested.push({ format: null, label: 'archivo', count: Math.min(maxArtifacts, count) });
  }

  let remaining = maxArtifacts;
  const bounded = [];
  for (const item of requested) {
    if (remaining <= 0) break;
    const count = Math.min(remaining, Math.max(1, Number(item.count) || 1));
    bounded.push({ ...item, count });
    remaining -= count;
  }
  const expectedCount = bounded.reduce((sum, item) => sum + item.count, 0);
  return {
    active: expectedCount > 1,
    expectedCount,
    requested: bounded,
    maxArtifacts,
  };
}

function successfulVerificationIds(steps = []) {
  const ids = new Set();
  for (const step of steps || []) {
    for (const action of step?.actions || []) {
      if (action?.tool !== 'verify_artifact') continue;
      const observation = action.observation || {};
      if (observation.error || observation.ok === false) continue;
      const args = parseActionArgs(action.args);
      const candidates = [
        args.artifactId,
        observation.artifactId,
        observation.id,
        observation.summary?.artifactId,
      ];
      for (const candidate of candidates) {
        if (candidate != null && String(candidate).trim()) ids.add(String(candidate).trim());
      }
    }
  }
  return ids;
}

function validateArtifactDelivery(contract, { artifacts = [], steps = [], unavailableTools = [] } = {}) {
  if (!contract?.active) return { ok: true, active: false };
  const unavailable = new Set((unavailableTools || []).map(String));
  if (unavailable.has('create_document') || unavailable.has('verify_artifact')) {
    return { ok: true, active: true, degraded: true, unavailableTools: Array.from(unavailable) };
  }

  const delivered = (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => artifact?.downloadUrl);
  const deliveredByFormat = new Map();
  for (const artifact of delivered) {
    const format = extensionOf(artifact);
    if (!deliveredByFormat.has(format)) deliveredByFormat.set(format, []);
    deliveredByFormat.get(format).push(artifact);
  }

  const selected = [];
  const missing = [];
  for (const request of contract.requested || []) {
    const candidates = request.format ? (deliveredByFormat.get(request.format) || []) : delivered;
    const available = candidates.filter((artifact) => !selected.includes(artifact));
    selected.push(...available.slice(0, request.count));
    if (available.length < request.count) {
      missing.push({ format: request.format, label: request.label, count: request.count - available.length });
    }
  }

  if (missing.length > 0) {
    const detail = missing.map((item) => `${item.count} ${item.label}`).join(', ');
    return {
      ok: false,
      active: true,
      missingTools: ['create_document'],
      message: `Finalization blocked: faltan entregables solicitados (${detail}).`,
      repairInstructions: 'Crea cada entregable faltante con un nombre de archivo único, conserva el formato solicitado y después verifica cada archivo antes de finalizar. No menciones este control interno al usuario.',
    };
  }

  const verifiedIds = successfulVerificationIds(steps);
  const unverified = selected.filter((artifact) => {
    const id = String(artifact?.id || artifact?.artifactId || '').trim();
    return !id || !verifiedIds.has(id);
  });
  if (unverified.length > 0) {
    return {
      ok: false,
      active: true,
      missingTools: ['verify_artifact'],
      message: `Finalization blocked: ${unverified.length} entregable(s) todavía no fueron verificados.`,
      repairInstructions: `Llama verify_artifact una vez para cada id pendiente (${unverified.map((artifact) => artifact.id || artifact.artifactId).filter(Boolean).join(', ')}), corrige cualquier fallo y vuelve a finalizar. No menciones este control interno al usuario.`,
    };
  }

  return {
    ok: true,
    active: true,
    expectedCount: contract.expectedCount,
    deliveredCount: selected.length,
    verifiedCount: selected.length,
  };
}

function buildArtifactDeliveryPrompt(contract) {
  if (!contract?.active) return '';
  const requested = (contract.requested || [])
    .map((item) => `${item.count} ${item.label}`)
    .join(', ');
  return [
    'CONTRATO DE ENTREGA MULTIARTEFACTO:',
    `- El usuario solicitó ${contract.expectedCount} entregables independientes: ${requested}.`,
    '- Crea un archivo separado por cada entregable solicitado, con nombre único y extensión correcta.',
    '- Después de CADA create_document llama verify_artifact con el id devuelto. Repara cualquier archivo vacío, corrupto o incompleto.',
    '- No finalices hasta que todos los entregables aparezcan como tarjetas descargables y todos hayan sido verificados.',
  ].join('\n');
}

module.exports = {
  FORMAT_SPECS,
  buildArtifactDeliveryContract,
  buildArtifactDeliveryPrompt,
  extensionOf,
  parseActionArgs,
  successfulVerificationIds,
  validateArtifactDelivery,
};
