'use strict';

const FORMAT_SPECS = [
  { format: 'docx', label: 'Word', pattern: /\b(docx|word)\b/i },
  { format: 'xlsx', label: 'Excel', pattern: /\b(xlsx|excel|hoja\s+de\s+c[aá]lculo)\b/i },
  { format: 'sav', label: 'SPSS (.sav)', pattern: /\b(?:spss|sav)\b/i },
  { format: 'sps', label: 'Sintaxis SPSS (.sps)', pattern: /\bsps\b/i },
  { format: 'pptx', label: 'PowerPoint', pattern: /\b(pptx?|power\s*point|diapositivas?|slides?)\b/i },
  { format: 'pdf', label: 'PDF', pattern: /\bpdf\b/i },
  { format: 'csv', label: 'CSV', pattern: /\bcsv\b/i },
  { format: 'svg', label: 'SVG', pattern: /\bsvg\b/i },
  { format: 'md', label: 'Markdown', pattern: /\b(markdown|\.md)\b/i },
  { format: 'txt', label: 'texto', pattern: /\b(txt|archivo\s+de\s+texto)\b/i },
  { format: 'json', label: 'JSON', pattern: /\bjson\b/i },
  { format: 'html', label: 'HTML', pattern: /\bhtml?\b/i },
  { format: 'rtf', label: 'RTF', pattern: /\brtf\b/i },
  { format: 'odt', label: 'OpenDocument de texto', pattern: /\bodt\b/i },
  { format: 'ods', label: 'OpenDocument de cálculo', pattern: /\bods\b/i },
  { format: 'odp', label: 'OpenDocument de presentación', pattern: /\bodp\b/i },
  { format: 'yaml', label: 'YAML', pattern: /\bya?ml\b/i },
  { format: 'xml', label: 'XML', pattern: /\bxml\b/i },
  { format: 'zip', label: 'ZIP', pattern: /\bzip\b/i },
  { format: 'png', label: 'PNG', pattern: /\bpng\b/i },
  { format: 'jpg', label: 'JPEG', pattern: /\bjpe?g\b/i },
  { format: 'gif', label: 'GIF', pattern: /\bgif\b/i },
  { format: 'webp', label: 'WebP', pattern: /\bwebp\b/i },
  { format: 'ico', label: 'ICO', pattern: /\bico\b/i },
  { format: 'wav', label: 'WAV', pattern: /\bwav\b/i },
  { format: 'mp3', label: 'MP3', pattern: /\bmp3\b/i },
  { format: 'mp4', label: 'MP4', pattern: /\bmp4\b/i },
  { format: 'webm', label: 'WebM', pattern: /\bwebm\b/i },
];

const DELIVERABLE_ACTION = /\b(crea(?:r|me)?|genera(?:r|me)?|prepara(?:r|me)?|elabora(?:r|me)?|arma(?:r|me)?|construye(?:r|me)?|redacta(?:r|me)?|exporta(?:r|me)?|edita(?:r|me)?|modifica(?:r|me)?|devu[eé]lve(?:me|nos)?|convierte|descargables?|entr[eé]ga(?:r|me)?|dame)\b/i;
const DELIVERABLE_NOUN = /\b(archivos?|documentos?|entregables?|versiones?|formatos?|informe|reporte|presentaci[oó]n|word|excel|spss|sav|power\s*point|pptx?|pdf|csv|svg|markdown|docx|xlsx|json|html?|rtf|odt|ods|odp)\b/i;
const COUNT_WORDS = Object.freeze({ un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8 });

function parseCount(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COUNT_WORDS, normalized)) return COUNT_WORDS[normalized];
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extensionOf(artifact) {
  const explicit = String(artifact?.format || '').trim().toLowerCase().replace(/^\./, '');
  if (explicit) return ({ ppt: 'pptx', jpeg: 'jpg', yml: 'yaml', htm: 'html', markdown: 'md' })[explicit] || explicit;
  const match = String(artifact?.filename || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  if (!match) return '';
  return ({ ppt: 'pptx', jpeg: 'jpg', yml: 'yaml', htm: 'html', markdown: 'md' })[match[1]] || match[1];
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

function requestedSavXlsxMatrix(text, requested) {
  if (!requested.some((item) => item.format === 'sav')
    || !requested.some((item) => item.format === 'xlsx')) return null;
  const sample = String(text).match(/\b(?:muestra\s+de|participantes?|encuestados?|casos?)\s+(\d{1,5})\b/i)
    || String(text).match(/\b(\d{1,5})\s+(?:participantes?|encuestados?|casos?)\b/i);
  const questions = String(text).match(/\b(\d{1,3})\s+preguntas?\b/i);
  // “muestra de 20 preguntas” contains only one number; it does not specify
  // 20 participants as well. Require independent numeric spans.
  if (sample && questions
    && sample.index < questions.index + questions[0].length
    && questions.index < sample.index + sample[0].length) return null;
  const rows = Number(sample?.[1]);
  const columns = Number(questions?.[1]);
  return Number.isSafeInteger(rows) && rows > 0 && Number.isSafeInteger(columns) && columns > 0
    ? { rows, columns }
    : null;
}

function buildArtifactDeliveryContract(prompt, policy = {}) {
  const text = String(prompt || '');
  // Literal replacement content is data, not an output count. Keep indices
  // stable so counts before a format enumeration can still be distinguished.
  const countText = text.replace(/“[^”]*”|«[^»]*»|"[^"]*"|'[^']*'/g, (literal) => ' '.repeat(literal.length));
  // SPSS + Excel is an explicit two-file request even in the default chat.
  // Requiring the configured multi-artifact capability here would let a
  // lone Excel pass as the complete result of this specific request.
  const explicitSpssExcel = FORMAT_SPECS.find((spec) => spec.format === 'sav').pattern.test(text)
    && !(/\bsps\b/i.test(text) && !/\bsav\b/i.test(text))
    && FORMAT_SPECS.find((spec) => spec.format === 'xlsx').pattern.test(text);
  const pairEdit = explicitSpssExcel && require('./generated-artifact-followup').isSavXlsxPairEditRequest(text);
  if ((!policy.multipleArtifacts && !explicitSpssExcel) || (!DELIVERABLE_ACTION.test(text) && !pairEdit)
    || !DELIVERABLE_NOUN.test(text)) {
    return { active: false, expectedCount: 0, requested: [], maxArtifacts: policy.maxArtifactsPerTurn || 6 };
  }

  const maxArtifacts = Math.max(1, Math.min(8, Number(policy.maxArtifactsPerTurn) || 6));
  const totalMatch = countText.match(/\b(\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho)\s+(?:archivos?|documentos?|entregables?|versiones?|copias?)\b/i);
  const requestedTotal = Math.max(0, parseCount(totalMatch?.[1]) || 0);
  const requested = FORMAT_SPECS
    .filter((spec) => spec.pattern.test(text)
      && !(spec.format === 'sav' && /\bsps\b/i.test(text) && !/\bsav\b/i.test(text)))
    .map((spec) => {
      const countMatch = countText.match(new RegExp(`\\b(\\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho)\\s+(?:(?:archivos?|documentos?|entregables?|versiones?|copias?)\\s+(?:en\\s+)?)?(?:${spec.pattern.source})`, 'i'));
      const tail = countMatch ? countText.slice(countMatch.index + countMatch[0].length) : '';
      // «tres archivos Word, Excel y PowerPoint» counts the enumerated batch.
      // «dos documentos Word y un Excel» gives independent format counts.
      const listTail = tail.match(/^\s*(?:,|\b(?:y|e)\b)\s*([^,.;]+)/i)?.[1] || '';
      const totalBeforeList = countMatch && totalMatch && countMatch.index === totalMatch.index
        && listTail && !/^(?:\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho)\b/i.test(listTail)
        && FORMAT_SPECS.some((other) => other.format !== spec.format && other.pattern.test(listTail));
      return { format: spec.format, label: spec.label, count: Math.min(maxArtifacts, Math.max(1, totalBeforeList ? 1 : parseCount(countMatch?.[1]) || 1)) };
    });

  if (requested.length === 1) {
    const countMatch = totalMatch;
    const count = parseCount(countMatch?.[1]);
    if (count && count > 1) requested[0].count = Math.min(maxArtifacts, count);
  }

  if (requested.length === 0) {
    const countMatch = totalMatch;
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
  // Preserve an explicit total even when only some formats were named. A
  // bounded turn can report its limit, but cannot call six files a completed
  // request for more files. Counts refer to deliverables, not data rows.
  const expectedCount = Math.max(requestedTotal, bounded.reduce((sum, item) => sum + item.count, 0));
  return {
    active: expectedCount > 1,
    expectedCount,
    requested: bounded,
    maxArtifacts,
    savXlsxMatrix: requestedSavXlsxMatrix(text, bounded),
  };
}

function assessArtifactDeliveryCounts(contract, artifacts = []) {
  const delivered = (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => artifact?.downloadUrl);
  const remaining = delivered.slice().reverse();
  const selected = []; const missing = [];
  for (const request of contract?.requested || []) {
    const candidates = remaining.filter((artifact) => !request.format || extensionOf(artifact) === request.format);
    const chosen = candidates.slice(0, request.count);
    selected.push(...chosen);
    for (const artifact of chosen) remaining.splice(remaining.indexOf(artifact), 1);
    if (chosen.length < request.count) missing.push({ ...request, count: request.count - chosen.length });
  }
  const additional = Math.max(0, (contract?.expectedCount || 0) - selected.length - missing.reduce((sum, request) => sum + request.count, 0));
  const chosen = remaining.slice(0, additional);
  selected.push(...chosen);
  if (chosen.length < additional) missing.push({ format: null, label: 'archivo', count: additional - chosen.length });
  return { selected, missing };
}

function successfulVerificationIds(steps = []) {
  const ids = new Set();
  for (const step of steps || []) {
    for (const action of step?.actions || []) {
      if (action?.tool !== 'verify_artifact') continue;
      const observation = action.observation || {};
      if (observation.error || observation.ok !== true || observation.warning
        || observation.validation?.passed === false || observation.validation?.ok === false) continue;
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

  const { selected, missing } = assessArtifactDeliveryCounts(contract, artifacts);

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
    selectedArtifacts: selected,
  };
}

async function validateSavXlsxDelivery(contract, { artifacts = [], inspectPair } = {}) {
  const expected = contract?.savXlsxMatrix;
  if (!contract?.active || !expected) return { ok: true, active: false };
  const refs = ['sav', 'xlsx'].map((format) => {
    const artifact = (Array.isArray(artifacts) ? artifacts : [])
      .slice().reverse().find((item) => item?.downloadUrl && extensionOf(item) === format);
    return artifact && {
      id: String(artifact.id || artifact.artifactId || ''),
      filename: String(artifact.filename || ''),
      format,
    };
  });
  if (refs.some((ref) => !ref?.id || !ref.filename)) {
    return {
      ok: false, active: true, missingTools: ['create_document'],
      message: 'Finalization blocked: faltan el SAV o el Excel solicitados.',
      repairInstructions: 'Crea ambos archivos descargables y verifica cada uno antes de finalizar.',
    };
  }
  let inspected;
  try {
    inspected = typeof inspectPair === 'function' ? await inspectPair(refs) : null;
  } catch (_) { /* A failed byte read never becomes a successful delivery. */ }
  const metrics = inspected?.metrics;
  if (!inspected?.ok || !metrics || metrics.matrixComparable !== true || metrics.headersMatch !== true) {
    return {
      ok: false, active: true, missingTools: ['python_exec'],
      message: 'Finalization blocked: no se pudo abrir y comparar el SAV con el Excel.',
      repairInstructions: 'Reabre los dos archivos originales, compara las celdas y repara cualquier diferencia antes de finalizar.',
    };
  }
  const hasRespondentId = metrics.hasRespondentId === true;
  const savDemographicColumns = metrics.savDemographicColumns ?? 0;
  const excelDemographicColumns = metrics.excelDemographicColumns ?? 0;
  const savQuestionColumns = metrics.savQuestionColumns ?? (metrics.savColumns - Number(hasRespondentId));
  const excelQuestionColumns = metrics.excelQuestionColumns ?? (metrics.excelColumns - Number(hasRespondentId));
  const correctShape = metrics.savRows === expected.rows
    && metrics.excelRows === expected.rows
    && Number.isSafeInteger(savDemographicColumns)
    && savDemographicColumns >= 0 && savDemographicColumns <= 3
    && excelDemographicColumns === savDemographicColumns
    && savQuestionColumns === expected.columns
    && excelQuestionColumns === expected.columns
    && metrics.savColumns === expected.columns + savDemographicColumns + Number(hasRespondentId)
    && metrics.excelColumns === expected.columns + excelDemographicColumns + Number(hasRespondentId);
  if (!correctShape) {
    return {
      ok: false, active: true, missingTools: ['create_document'],
      message: `Finalization blocked: el SAV y el Excel deben contener ${expected.rows} filas × ${expected.columns} preguntas.`,
      repairInstructions: 'Regenera ambos archivos con la muestra y el número de preguntas solicitados; luego vuelve a verificarlos.',
    };
  }
  if (hasRespondentId && metrics.respondentIdsMatch !== true) {
    return {
      ok: false, active: true, missingTools: ['create_document'],
      message: 'Finalization blocked: los identificadores de participantes del SAV y el Excel no coinciden o no son únicos.',
      repairInstructions: 'Corrige la columna ID de ambos archivos y verifica que cada participante tenga un identificador único y coincidente.',
    };
  }
  if (metrics.labelCount !== expected.columns) {
    return {
      ok: false, active: true, missingTools: ['create_document'],
      message: `Finalization blocked: el SAV debe conservar ${expected.columns} etiquetas de variables.`,
      repairInstructions: 'Añade una etiqueta por variable al SAV, vuelve a abrirlo y verifica las etiquetas.',
    };
  }
  const expectedCells = expected.rows * expected.columns;
  const expectedDemographicCells = expected.rows * savDemographicColumns;
  if (metrics.comparedCells !== expectedCells
    || (metrics.demographicComparedCells ?? 0) !== expectedDemographicCells
    || metrics.differentCells !== 0) {
    return {
      ok: false, active: true, missingTools: ['create_document'],
      message: metrics.differentDemographicCells > 0
        ? 'Finalization blocked: hay diferencias en los datos demográficos entre el SAV y el Excel.'
        : `Finalization blocked: hay diferencias entre el SAV y el Excel; deben coincidir las ${expectedCells} respuestas y todos los datos demográficos.`,
      repairInstructions: 'Repara las respuestas y los datos demográficos de ambos archivos y compara cada celda antes de finalizar.',
    };
  }
  return { ok: true, active: true, comparedCells: expectedCells, labelCount: metrics.labelCount };
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
    ...(contract.savXlsxMatrix
      ? [`- El SAV y el Excel deben contener ${contract.savXlsxMatrix.rows} filas de datos y ${contract.savXlsxMatrix.columns} preguntas, con una etiqueta por variable en el SAV. Reabre ambos y compara todos sus valores celda por celda.`]
      : []),
  ].join('\n');
}

module.exports = {
  FORMAT_SPECS,
  buildArtifactDeliveryContract,
  assessArtifactDeliveryCounts,
  buildArtifactDeliveryPrompt,
  extensionOf,
  parseActionArgs,
  successfulVerificationIds,
  validateArtifactDelivery,
  validateSavXlsxDelivery,
};
