'use strict';

/**
 * Attach CONSTRUIR artifacts to the existing /api/ai/generate-webdev path.
 * Fail-open: a hook error never blocks the HTML stream.
 */

const { isSoftwareBuildRequest } = require('../agents/software-build-intent');
const { scaffoldConstruirProject, isCompleteHtml } = require('./scaffold');
const { deliverConstruirProject } = require('./index');

function fallbackHtml(prompt) {
  return scaffoldConstruirProject({ prompt }).files['index.html'];
}

function ensureRenderableHtml(candidateHtml, prompt) {
  if (isCompleteHtml(candidateHtml)) return { html: candidateHtml, fallback: false };
  return { html: fallbackHtml(prompt), fallback: true };
}

async function attachConstruirDeliverable(opts = {}) {
  const prompt = String(opts.prompt || '').trim();
  if (opts.requireSoftwareAsk !== false && !isSoftwareBuildRequest(prompt) && !opts.html) {
    return { attached: false };
  }
  try {
    const delivery = await deliverConstruirProject({
      prompt,
      html: opts.html,
      userId: opts.userId,
      chatId: opts.chatId,
      modelAlias: opts.modelAlias || opts.model,
      saveArtifact: opts.saveArtifact,
      onEvent: opts.onEvent,
      env: opts.env,
    });
    return { attached: true, delivery };
  } catch (err) {
    return {
      attached: false,
      error: err && err.message ? String(err.message).slice(0, 200) : 'attach_failed',
    };
  }
}

module.exports = {
  fallbackHtml,
  ensureRenderableHtml,
  attachConstruirDeliverable,
};
