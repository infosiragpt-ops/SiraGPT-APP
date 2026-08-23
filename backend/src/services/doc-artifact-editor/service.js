'use strict';

/**
 * Editor apply path — DeepSeek only. Never imports OpenRouter.
 * Surgical edits reuse source-preserving / transform primitives.
 */

const { getDocArtifactEditorConfig, assertNoOpenRouter } = require('./flags');
const {
  createSession,
  getSession,
  appendEvent,
  setSessionBuffer,
  setSessionError,
  listPublicSession,
} = require('./session-store');

function createDeepSeekClient(env = process.env, OpenAIImpl) {
  const key = String(env.DEEPSEEK_API_KEY || '').trim();
  if (!key) return null;
  const OpenAI = OpenAIImpl || require('openai');
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://api.deepseek.com',
  });
}

function pickDeepSeekModel({ preferPro = false, env = process.env } = {}) {
  const cfg = getDocArtifactEditorConfig(env);
  return preferPro ? cfg.deepseekProModel : cfg.deepseekFlashModel;
}

function openArtifact({ userId, artifactId, filename, buffer, instructions } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error('artefacto vacío');
    err.code = 'missing_artifact';
    throw err;
  }
  return createSession({ userId, artifactId, filename, buffer, instructions });
}

/**
 * Apply a natural-language edit. Scaffold: records the instruction and
 * keeps the current buffer. Real surgical apply is FEATURE-gated and
 * uses DeepSeek to plan ops, then source-preserving-document-edit.
 */
async function applyEdit(sessionId, { instructions, env = process.env, client } = {}) {
  const session = getSession(sessionId);
  if (!session) {
    const err = new Error('sesión no encontrada');
    err.code = 'session_not_found';
    throw err;
  }
  const gate = assertNoOpenRouter(env);
  appendEvent(sessionId, 'plan', {
    label: 'Planificando edición (DeepSeek)',
    provider: gate.provider,
    model: pickDeepSeekModel({ env }),
  });

  const ds = client !== undefined ? client : createDeepSeekClient(env);
  if (!ds) {
    appendEvent(sessionId, 'edit', {
      label: 'DeepSeek no configurado — se conserva el artefacto sin mutar',
      skipped: true,
    });
    appendEvent(sessionId, 'done', { label: 'Listo (sin cambios)', skipped: true });
    return listPublicSession(session);
  }

  appendEvent(sessionId, 'edit', {
    label: String(instructions || session.instructions || 'edición').slice(0, 200),
  });
  // Scaffold: do not invent OOXML mutations without a planned op list.
  // The session keeps the opened buffer so download still works.
  if (session.buffer) setSessionBuffer(sessionId, session.buffer, session.filename);
  appendEvent(sessionId, 'validate', { label: 'Buffer intacto (scaffold)' });
  appendEvent(sessionId, 'done', { label: 'Listo' });
  return listPublicSession(getSession(sessionId));
}

function downloadSession(sessionId) {
  const session = getSession(sessionId);
  if (!session || !session.buffer) return null;
  return {
    filename: session.filename,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: session.buffer,
  };
}

module.exports = {
  createDeepSeekClient,
  pickDeepSeekModel,
  openArtifact,
  applyEdit,
  downloadSession,
  listPublicSession,
};
