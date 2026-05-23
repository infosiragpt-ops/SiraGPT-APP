'use strict';

const NUMBER_RE = /(?<![\w])(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?(?:\s?(?:[KkMmBb]|millones?|billones?|thousand|million|billion))?)(?:\s?%|\s?(?:USD|EUR|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|CHF|d[oó]lares?|euros?|libras?|pesos?|reales?|soles?))?(?![\w])/g;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|Q[1-4]\s+\d{4}|[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+\d{1,2},\s+\d{4}|\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{4})\b/g;
const ENTITY_RE = /\b([\p{Lu}][\p{L}\p{N}'\-]+(?:\s+(?:de|del|of|y|and|&)\s+[\p{Lu}][\p{L}\p{N}'\-]+){0,3})\b/gu;

function extractAnchors(text) {
  if (!text) return { numbers: [], dates: [], entities: [] };
  const numbers = [];
  const dates = [];
  const entities = [];
  NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = NUMBER_RE.exec(text)) !== null) numbers.push(m[1].toLowerCase());
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text)) !== null) dates.push(m[1].toLowerCase());
  ENTITY_RE.lastIndex = 0;
  while ((m = ENTITY_RE.exec(text)) !== null) entities.push(m[1].toLowerCase());
  return { numbers: [...new Set(numbers)], dates: [...new Set(dates)], entities: [...new Set(entities)] };
}

function buildEvidencePool(sources) {
  const pool = { numbers: new Set(), dates: new Set(), entities: new Set(), claims: [] };
  if (!Array.isArray(sources)) return pool;
  for (const src of sources) {
    if (src == null) continue; // tolerate null/undefined entries — they were
    // crashing the pool builder before this guard.
    const text = typeof src === 'string' ? src : (src.extractedText || src.text || '');
    if (!text) continue;
    const anchors = extractAnchors(text);
    for (const n of anchors.numbers) pool.numbers.add(n);
    for (const d of anchors.dates) pool.dates.add(d);
    for (const e of anchors.entities) pool.entities.add(e);
  }
  return pool;
}

function verifyClaim(claim, pool) {
  const anchors = extractAnchors(claim);
  const evidence = [];
  let supported = 0;
  let unsupported = 0;
  let contradicted = 0;
  for (const n of anchors.numbers) {
    if (pool.numbers.has(n)) {
      supported++;
      evidence.push({ type: 'number', value: n, status: 'supported' });
    } else {
      unsupported++;
      evidence.push({ type: 'number', value: n, status: 'unsupported' });
    }
  }
  for (const d of anchors.dates) {
    if (pool.dates.has(d)) {
      supported++;
      evidence.push({ type: 'date', value: d, status: 'supported' });
    } else {
      unsupported++;
      evidence.push({ type: 'date', value: d, status: 'unsupported' });
    }
  }
  for (const e of anchors.entities) {
    if (pool.entities.has(e)) {
      supported++;
      evidence.push({ type: 'entity', value: e, status: 'supported' });
    } else {
      unsupported++;
      evidence.push({ type: 'entity', value: e, status: 'unsupported' });
    }
  }
  const totalAnchors = supported + unsupported + contradicted;
  let status = 'unverifiable';
  if (totalAnchors === 0) status = 'no_anchors';
  else if (unsupported === 0 && contradicted === 0) status = 'fully_supported';
  else if (supported > 0 && unsupported > 0) status = 'partially_supported';
  else if (unsupported > 0 && supported === 0) status = 'unsupported';
  return {
    claim: claim.slice(0, 200),
    status,
    evidence,
    supportedCount: supported,
    unsupportedCount: unsupported,
    contradictedCount: contradicted,
    confidence: totalAnchors > 0 ? supported / totalAnchors : 0,
  };
}

function buildVerificationReport(response, sources) {
  const pool = buildEvidencePool(sources);
  const sentences = (response || '').split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ\d"'¿¡(])/).filter(s => s.trim().length >= 15);
  const claims = sentences.filter(s => {
    const anchors = extractAnchors(s);
    return anchors.numbers.length + anchors.dates.length + anchors.entities.length > 0;
  }).slice(0, 30);
  const verifications = claims.map(c => verifyClaim(c, pool));
  const fullySupported = verifications.filter(v => v.status === 'fully_supported').length;
  const partiallySupported = verifications.filter(v => v.status === 'partially_supported').length;
  const unsupported = verifications.filter(v => v.status === 'unsupported').length;
  const unverifiable = verifications.filter(v => v.status === 'no_anchors').length;
  const total = verifications.length;
  const score = total > 0 ? (fullySupported + partiallySupported * 0.5) / total : 1;
  return {
    total,
    fullySupported,
    partiallySupported,
    unsupported,
    unverifiable,
    score: Number(score.toFixed(3)),
    level: score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low',
    verifications: verifications.slice(0, 15),
    poolSize: {
      numbers: pool.numbers.size,
      dates: pool.dates.size,
      entities: pool.entities.size,
    },
  };
}

function renderVerificationNote(report) {
  if (!report || report.total === 0) return '';
  if (report.level === 'high' && report.unsupported === 0) return '';
  const lines = [];
  lines.push('## VERIFICACIÓN DE FIDELIDAD');
  lines.push(`_${report.total} afirmaciones verificadas contra fuentes — soportadas: ${report.fullySupported}, parciales: ${report.partiallySupported}, sin soporte: ${report.unsupported}, score: ${(report.score * 100).toFixed(0)}%._`);
  const flagged = report.verifications.filter(v => v.status === 'unsupported' || v.status === 'partially_supported');
  if (flagged.length > 0) {
    lines.push('');
    lines.push('### Afirmaciones que requieren verificación:');
    for (const f of flagged.slice(0, 8)) {
      const unsupportedAnchors = f.evidence.filter(e => e.status === 'unsupported').map(e => `${e.type}:${e.value}`).join(', ');
      lines.push(`- **[${f.status}]** ${f.claim.slice(0, 120)}${f.claim.length > 120 ? '...' : ''} — sin evidencia para: ${unsupportedAnchors || 'elementos no encontrados en fuentes'}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  extractAnchors,
  buildEvidencePool,
  verifyClaim,
  buildVerificationReport,
  renderVerificationNote,
};
