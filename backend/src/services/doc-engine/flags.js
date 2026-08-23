'use strict';

/**
 * FEATURE_DOC_ENGINE — default false.
 * Solo 1/true/yes/on activan el motor OOXML. Cualquier otro valor (incluido
 * ausente) deja el chat en el path de edición por párrafos existente.
 */

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value == null ? '' : value).trim());
}

function isDocEngineEnabled(env = process.env) {
  return isTruthyEnv(env.FEATURE_DOC_ENGINE);
}

function getDocEngineConfig(env = process.env) {
  const n = (raw, fallback, min, max) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(v)));
  };
  return {
    enabled: isDocEngineEnabled(env),
    image: String(env.DOC_ENGINE_IMAGE || 'siragpt-doc-sandbox:latest').trim(),
    concurrency: n(env.DOC_ENGINE_CONCURRENCY, 2, 1, 8),
    timeoutMs: n(env.DOC_ENGINE_TIMEOUT_MS, 180_000, 5_000, 600_000),
    workspaceSize: String(env.DOC_ENGINE_WORKSPACE_SIZE || '512m').trim(),
    queueName: String(env.DOC_ENGINE_QUEUE_NAME || 'doc-jobs').trim(),
    artifactTtlSec: n(env.DOC_ENGINE_ARTIFACT_TTL_SEC, 15 * 60, 60, 3600),
    maxVerifyIterations: n(env.DOC_ENGINE_VERIFY_MAX_ITERATIONS, 3, 1, 3),
    verifyMaxTokens: n(env.DOC_ENGINE_VERIFY_MAX_TOKENS, 400, 64, 2000),
    deepseekFlashModel: String(env.DOC_ENGINE_DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash').trim(),
    deepseekProModel: String(env.DOC_ENGINE_DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro').trim(),
    signingSecret: String(env.DOC_ENGINE_SIGNING_SECRET || env.JWT_SECRET || '').trim(),
  };
}

function isTemplateTransformRequest(prompt = '', files = []) {
  const text = String(prompt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!text) return false;
  const list = Array.isArray(files) ? files : [];
  const docs = list.filter((f) => {
    if (typeof f === 'string') return /\.docx$/i.test(f);
    const name = String(f?.originalName || f?.filename || f?.name || f?.fieldname || '');
    const mime = String(f?.mimeType || f?.mimetype || f?.type || '');
    return mime.includes('wordprocessingml') || /\.docx$/i.test(name);
  });
  // Chat preloop pasa fileIds (strings). Cuenta esos ids cuando no hay MIME.
  const count = docs.length > 0 ? docs.length : list.length;
  // Cualquier 2+ docx + formato|format|plantilla|UPN|pasalo. "pasalo" no
  // matchea \bpasa\b. "format" (sin o) es el typo de "pasalo a mi format".
  const templateCue = /\b(formato|format|plantilla|template|upn|apa|ieee|pasalo|pasala)\b/.test(text);
  const passCue = /\b(pasa\w*|aplica\w*|convierte\w*|traslad\w*|transplant\w*|usa\w*|usar)\b/.test(text);
  const hashNames = (String(prompt || '').match(/##\s*\S+\.docx/gi) || []).length >= 2;
  if (hashNames) return true;
  // passCue alone is too broad ("usando todos los documentos…").
  // 2+ attachments still need formato|plantilla|UPN|pasalo.
  // Chat recent_attachment turns pass fileIds=[] — still transplant when
  // the prompt has both a template cue and a pass cue ("pasalo a formato UPN").
  if (templateCue && (passCue || count >= 2)) return true;
  return false;
}

function shouldRunChatTemplateTransform(prompt = '', files = []) {
  return isTemplateTransformRequest(prompt, files);
}

module.exports = {
  isTruthyEnv,
  isDocEngineEnabled,
  getDocEngineConfig,
  isTemplateTransformRequest,
  shouldRunChatTemplateTransform,
};
