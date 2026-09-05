'use strict';

/**
 * Persist Sira Voz studio results (dubs, audiobooks, transcriptions) into a
 * chat so they survive a reload and render through the existing renderers:
 *   - audio results → an `agent-task-state` fenced block with an audio
 *     artifact (same shape /api/ai/generate-speech stores → AudioArtifactPlayer)
 *   - video results → an assistant message whose `files` JSON carries the
 *     mp4 (MessageDocChips renders video attachments with ChatVideoPlayer)
 *
 * Deliberately independent from routes/ai.js (12k lines) so background jobs
 * never pull the whole AI router into memory.
 */

const prisma = require('../../config/database');

function agentTaskStateBlock(state) {
  return '```agent-task-state\n' + JSON.stringify(state) + '\n```';
}

function buildAudioArtifactState({ goal, label, artifact, model = 'Sira Voz', tool = 'generate_speech', finalText = '' }) {
  return {
    meta: { goal: String(goal || '').slice(0, 200), model, tools: [tool] },
    steps: [
      {
        id: `${tool}-1`,
        label,
        icon: 'check',
        status: 'done',
        reasoning: '',
        toolCalls: [{ tool, output: { ok: true, preview: artifact.filename } }],
      },
    ],
    artifacts: [artifact],
    approvals: [],
    checkpoints: [],
    qualityGates: [],
    repairs: [],
    finalText: finalText || '',
    done: true,
  };
}

function buildAudioArtifact({ id, filename, mime, format, sizeBytes, downloadUrl, prompt, kind = 'speech', model = 'Sira Voz' }) {
  return {
    id,
    filename,
    mime,
    format,
    kind,
    category: 'audio',
    model,
    sizeBytes: Number(sizeBytes) || 0,
    downloadUrl,
    prompt: String(prompt || '').slice(0, 280),
  };
}

function buildVideoFileSnapshot({ id, filename, originalName, sizeBytes, url, mime = 'video/mp4', durationSeconds = null }) {
  return {
    id: id || null,
    tempId: null,
    name: originalName || filename,
    originalName: originalName || filename,
    filename,
    mimeType: mime,
    type: mime,
    size: Number(sizeBytes) || null,
    url,
    preview: null,
    thumbnailUrl: null,
    path: null,
    extractedText: null,
    mediaMeta: durationSeconds ? { kind: 'video', durationSeconds } : null,
    source: 'sira-voz',
  };
}

async function chatOwnedBy(userId, chatId, client = prisma) {
  if (!userId || !chatId) return null;
  return client.chat.findFirst({ where: { id: chatId, userId, deletedAt: null }, select: { id: true } });
}

/**
 * Append a USER message (what the user asked the studio to do). Returns the
 * message id or null when the chat is not the user's.
 */
async function persistUserTurn({ userId, chatId, content, files = null }, client = prisma) {
  const chat = await chatOwnedBy(userId, chatId, client);
  if (!chat) return null;
  const message = await client.message.create({
    data: {
      chatId,
      role: 'USER',
      content: String(content || '').slice(0, 4000),
      files: Array.isArray(files) && files.length ? JSON.stringify(files) : null,
      metadata: { source: 'sira-voz-studio' },
    },
    select: { id: true },
  });
  await client.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }).catch(() => {});
  return message.id;
}

/**
 * Append the ASSISTANT result. `content` is the rendered block (agent-task-state
 * or plain markdown); `files` is the optional attachment snapshot list.
 */
async function persistAssistantTurn({ userId, chatId, content, files = null, metadata = null }, client = prisma) {
  const chat = await chatOwnedBy(userId, chatId, client);
  if (!chat) return null;
  const message = await client.message.create({
    data: {
      chatId,
      role: 'ASSISTANT',
      content: String(content || ''),
      files: Array.isArray(files) && files.length ? JSON.stringify(files) : null,
      metadata: { source: 'sira-voz-studio', ...(metadata && typeof metadata === 'object' ? metadata : {}) },
    },
    select: { id: true },
  });
  await client.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }).catch(() => {});
  return message.id;
}

module.exports = {
  agentTaskStateBlock,
  buildAudioArtifactState,
  buildAudioArtifact,
  buildVideoFileSnapshot,
  persistUserTurn,
  persistAssistantTurn,
};
