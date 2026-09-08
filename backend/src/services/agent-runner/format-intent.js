'use strict';

/**
 * Explicit Word / PPT / Excel format claims.
 *
 * "documento Word, no Excel no PPT" must be claimed by AgentRunner and
 * must NEVER fall through to advanced_pipeline (which produced .xlsx
 * marked verified). Casual mentions ("qué dice el documento") stay out.
 */

const CREATE_OR_WANT_RE = /\b(crea|creame|créame|genera|hazme|arma|diseña|designa|make|create|escribe|escribeme|escríbeme|redacta|elabora|write|quiero|necesito|dame|pásame|pasame|entrega|redactame|redáctame|generame|genérame|prepara|prepárame)\b/i;

function requestedOfficeFormat(text = '') {
  const t = String(text || '');
  if (!t.trim()) return null;

  const forbidExcel = /\b((?:sin|no|ni)\s+(?:convertirlo\s+a\s+)?(?:excel|xlsx))\b/i.test(t);
  const forbidPpt = /\b((?:sin|no|ni)\s+(?:convertirlo\s+a\s+)?(?:ppt|pptx|powerpoint|presentaci[oó]n(?:es)?))\b/i.test(t);
  const forbidWord = /\b((?:sin|no|ni)\s+(?:word|docx))\b/i.test(t);

  // "Escribe … sin Excel ni PPT" is Word. Mentioning PPT as forbidden
  // must NEVER claim xlsx (live 2026-08-14).
  const writeVerb = /\b(escribe(?:r|me|nos)?|escr[ií]beme|redacta(?:r|me)?|elabora(?:r|me)?|write)\b/i.test(t);
  if (writeVerb && (forbidExcel || forbidPpt) && !forbidWord) return 'docx';

  const explicitWord = (
    /\b((?:documento|archivo|file)\s+word|word\s+(?:documento|archivo)|archivo\s+\.?docx|\.docx)\b/i.test(t)
    || (/\bword\b/i.test(t) && (forbidExcel || forbidPpt))
  );
  const visible = t.replace(/\b(?:sin|no|ni)\s+(?:convertirlo\s+a\s+)?(?:excel|xlsx|ppt|pptx|powerpoint|presentaci[oó]n(?:es)?)\b/gi, ' ');
  const explicitPpt = (
    /\b(powerpoint|\.pptx)\b/i.test(visible)
    || (
      /\bpresentaci[oó]n(?:es)?\b/i.test(visible)
      && (CREATE_OR_WANT_RE.test(t) || forbidExcel || forbidWord || /\b(diapositiv|slides?|ppt)\b/i.test(visible))
    )
    || (/\b(ppt|pptx|diapositiv)/i.test(visible) && (CREATE_OR_WANT_RE.test(t) || forbidExcel || forbidWord))
  );

  if (explicitWord && !forbidWord) return 'docx';
  if (explicitPpt && !forbidPpt) return 'pptx';
  if (/\bexporta(?:r)?\s+a\s+docx\b/i.test(t) || /\barchivo\s+docx\b/i.test(t) || /\.docx\b/i.test(t)) return 'docx';
  if (/\barchivo\s+pptx\b/i.test(t) || /\.pptx\b/i.test(t)) return 'pptx';
  if (forbidExcel && !forbidWord && /\b(informe|documento|redact|ensayo|word|docx)\b/i.test(t)) return 'docx';

  if (CREATE_OR_WANT_RE.test(t)) {
    if (/\b(excel|xlsx)\b/i.test(t) && !forbidExcel && !writeVerb && !forbidPpt) return 'xlsx';
    if (/\b(word|docx)\b/i.test(t) && !forbidWord) return 'docx';
    if (/\b(ppt|pptx|powerpoint|presentaci|diapositiva|slides?)\b/i.test(t) && !forbidPpt) return 'pptx';
  }
  // Bare explicit tokens the user named: always claim, never xlsx fallback.
  if (/\bdocumento\s+word\b/i.test(t) && !forbidWord) return 'docx';
  if (/\bsin\s+excel\b/i.test(t) && !explicitPpt) return 'docx';
  if (/\bdocx\b/i.test(t) && !forbidWord) return 'docx';
  if (/\bpptx\b/i.test(t) && !forbidPpt) return 'pptx';
  return null;
}

function isExplicitOfficeFormatRequest(text = '') {
  return Boolean(requestedOfficeFormat(text));
}

function parseExplicitOfficeFormat(text = '') {
  const format = requestedOfficeFormat(text);
  return { claimed: Boolean(format), format: format || null };
}

function shouldBlockGenericPipeline(text = '') {
  return isExplicitOfficeFormatRequest(text);
}

function isExplicitWordRequest(text = '') {
  return requestedOfficeFormat(text) === 'docx';
}

function buildExplicitFormatBlockMessage(text = '') {
  const fmt = requestedOfficeFormat(text);
  if (fmt === 'pptx') {
    return 'No pude generar la presentacion pedida (pptx). El agente no reclamo el turno; no voy a entregarte un Excel de relleno. Intentalo de nuevo.';
  }
  return 'No pude generar el documento Word pedido (sin Excel). El agente no reclamo el turno; no voy a entregarte un xlsx de relleno. Intentalo de nuevo.';
}

module.exports = {
  requestedOfficeFormat,
  isExplicitOfficeFormatRequest,
  parseExplicitOfficeFormat,
  shouldBlockGenericPipeline,
  isExplicitWordRequest,
  buildExplicitFormatBlockMessage,
  CREATE_OR_WANT_RE,
};
