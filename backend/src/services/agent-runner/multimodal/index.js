'use strict';

/**
 * F7 — Multimodal extras for the AgentRunner loop (vision, voice,
 * bounded computer-use).
 *
 * Contract with the core runner (same shape a future prepareF8Extras uses):
 *   - `extraToolDefinitions({ env })`  → OpenAI-style tool definitions for
 *     every ENABLED capability (kill switches in ./flags).
 *   - `extraExecutors({ ... })`        → matching executors bound to the
 *     current sandbox / LLM client.
 *   - `prepareF7Extras({ ... })`       → one call the runner makes per turn:
 *     { toolDefinitions, executors, imageParts, applyToMessages, cleanup }.
 *   - `buildImageDataMessage(images)`  → used by the loop's F7 hook to hand
 *     a tool-produced image to the NEXT LLM call as a vision block.
 *
 * Everything here is additive: with all three flags off (the NODE_ENV=test
 * default) the runner behaves byte-for-byte as before F7.
 */

const flags = require('./flags');
const vision = require('./vision');
const voice = require('./voice');
const computer = require('./computer');

/** An OpenAI-compatible client that can take `image_url` content (the vision ladder or a test fake). */
function hasVisionClient(client) {
  return Boolean(client && client.chat && client.chat.completions && typeof client.chat.completions.create === 'function');
}

// `vision` = a vision-capable client exists this turn. describe_image looks at
// pixels, so without one the tool is not offered at all: production
// 2026-10-08 wired it to the loop's text model (DeepSeek V4 Flash), every call
// failed, and three failed calls in a row cut a turn whose deck was finished.
function extraToolDefinitions({ env = process.env, vision: visionAvailable = true } = {}) {
  const defs = [];
  if (flags.visionEnabled(env) && visionAvailable) defs.push(...vision.VISION_TOOL_DEFINITIONS);
  if (flags.voiceEnabled(env)) defs.push(...voice.VOICE_TOOL_DEFINITIONS);
  if (flags.computerEnabled(env)) defs.push(...computer.COMPUTER_TOOL_DEFINITIONS);
  return defs;
}

/**
 * Build the executors for every enabled capability.
 * Injectable seams (all optional, for tests / provider routing):
 *   client/model      — vision LLM for describe_image
 *   openaiClient      — Whisper client for transcribe_audio
 *   synthesize        — TTS impl for speak
 *   computerDriver    — pre-built computer driver (fake/xvfb)
 * Returns { executors, cleanup }.
 */
function extraExecutors({
  env = process.env,
  sandbox,
  client = null,
  model = null,
  format = 'openrouter',
  openaiClient = null,
  synthesize = null,
  computerDriver = null,
} = {}) {
  const executors = {};
  let computerCleanup = null;
  if (flags.visionEnabled(env) && hasVisionClient(client)) {
    executors.describe_image = vision.makeDescribeImageExecutor({ sandbox, client, model, format });
  }
  if (flags.voiceEnabled(env)) {
    executors.transcribe_audio = voice.makeTranscribeAudioExecutor({ sandbox, openaiClient, env });
    executors.speak = voice.makeSpeakExecutor({ sandbox, synthesize, env });
  }
  if (flags.computerEnabled(env)) {
    const built = computer.makeComputerExecutors({ env, driver: computerDriver });
    Object.assign(executors, built.executors);
    computerCleanup = built.cleanup;
  }
  return {
    executors,
    async cleanup() {
      if (computerCleanup) await computerCleanup();
    },
  };
}

/**
 * Single per-turn entry point for the runner (the F7 hook in index.js).
 *
 * `applyToMessages(messages)` upgrades the LAST user message to multimodal
 * content when the turn carries image attachments — the first LLM call sees
 * the pixels as real vision blocks, framed as data.
 */
function prepareF7Extras({
  files = [],
  sandbox,
  client = null,
  model = null,
  env = process.env,
  format = 'openrouter',
  openaiClient = null,
  synthesize = null,
  computerDriver = null,
} = {}) {
  const toolDefinitions = extraToolDefinitions({ env, vision: hasVisionClient(client) });
  const { executors, cleanup } = extraExecutors({
    env, sandbox, client, model, format, openaiClient, synthesize, computerDriver,
  });
  const imageParts = flags.visionEnabled(env)
    ? vision.collectImageAttachments(files, { env })
    : [];
  return {
    toolDefinitions,
    executors,
    imageParts,
    applyToMessages(messages) {
      if (!imageParts.length || !Array.isArray(messages)) return messages;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m && m.role === 'user' && typeof m.content === 'string') {
          messages[i] = {
            role: 'user',
            content: vision.buildUserContentWithImages(m.content, imageParts, { format }),
          };
          break;
        }
      }
      return messages;
    },
    cleanup,
  };
}

module.exports = {
  // flags
  f7FlagEnabled: flags.f7FlagEnabled,
  visionEnabled: flags.visionEnabled,
  voiceEnabled: flags.voiceEnabled,
  computerEnabled: flags.computerEnabled,
  // wiring
  hasVisionClient,
  extraToolDefinitions,
  extraExecutors,
  prepareF7Extras,
  // loop hook + vision helpers
  buildImageDataMessage: vision.buildImageDataMessage,
  buildUserContentWithImages: vision.buildUserContentWithImages,
  collectImageAttachments: vision.collectImageAttachments,
  formatImagePart: vision.formatImagePart,
  wrapVisionDescription: vision.wrapVisionDescription,
  IMAGE_DATA_FRAMING: vision.IMAGE_DATA_FRAMING,
  // voice helpers
  wrapTranscript: voice.wrapTranscript,
  // computer helpers
  createComputerDriver: computer.createComputerDriver,
  createFakeComputerDriver: computer.createFakeComputerDriver,
  resolveComputerDriverKind: computer.resolveComputerDriverKind,
};
