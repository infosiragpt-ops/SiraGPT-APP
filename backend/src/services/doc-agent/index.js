'use strict';

/**
 * Document agent (Cowork-style) — orchestrator.
 *
 *   runDocumentAgent({ files, instruction, model, client, onEvent })
 *     1. creates an isolated sandbox (Docker container when available,
 *        local ephemeral workspace otherwise — see ./sandbox.js)
 *     2. mounts the uploads under /workspace/uploads
 *     3. seeds [system(skills) + user(instruction)] and runs the agentic
 *        loop (≤25 iterations) with the five tools
 *     4. collects every file the agent wrote to /workspace/outputs
 *     5. ALWAYS destroys the sandbox
 *
 * The LLM client is injected; `createOpenRouterClient()` builds the
 * production one from OPENROUTER_API_KEY. Keeping the client injectable is
 * what makes the full pipeline testable offline with a scripted fake.
 */

const { createSandbox } = require('./sandbox');
const { TOOL_DEFINITIONS, makeToolExecutors } = require('./tools');
const { buildDocAgentSystemPrompt } = require('./skills');
const { runDocAgentLoop, MAX_ITERATIONS_DEFAULT } = require('./loop');

const DEFAULT_MODEL = process.env.SIRAGPT_DOC_AGENT_MODEL || 'openai/gpt-4o-mini';

function createOpenRouterClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  const OpenAI = require('openai');
  return new OpenAI({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://siragpt.app',
      'X-Title': 'SiraGPT Document Agent',
    },
  });
}

function sanitizeUploadName(name, index) {
  const base = String(name || `file-${index + 1}`).split(/[\\/]/).pop();
  const clean = base.replace(/[^\w.\-() À-ɏ]/g, '_').slice(0, 180);
  return clean || `file-${index + 1}`;
}

/**
 * @param {object} opts
 * @param {Array<{ name: string, buffer: Buffer }>} opts.files uploaded documents
 * @param {string} opts.instruction the user's natural-language request
 * @param {string} [opts.model]
 * @param {object} [opts.client] OpenAI-compatible client (default: OpenRouter)
 * @param {Function} [opts.onEvent] SSE relay
 * @param {'auto'|'local'|'docker'} [opts.driver]
 * @param {number} [opts.maxIterations]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ finalText: string, outputs: Array<{name:string,buffer:Buffer}>, steps: Array, iterations: number, stoppedReason: string, driver: string }>}
 */
async function runDocumentAgent({
  files = [],
  instruction,
  model = DEFAULT_MODEL,
  client,
  onEvent = () => {},
  driver,
  maxIterations = MAX_ITERATIONS_DEFAULT,
  signal,
} = {}) {
  const task = String(instruction || '').trim();
  if (!task) throw new Error('runDocumentAgent: instruction is required');
  const llm = client || createOpenRouterClient();

  const sandbox = await createSandbox({ driver });
  onEvent({ type: 'sandbox_ready', driver: sandbox.driver });
  try {
    const names = [];
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      if (!f || !Buffer.isBuffer(f.buffer)) continue;
      const name = sanitizeUploadName(f.name, i);
      await sandbox.putFile(`uploads/${name}`, f.buffer);
      names.push(name);
    }

    const messages = [
      { role: 'system', content: buildDocAgentSystemPrompt(names) },
      { role: 'user', content: task },
    ];

    const result = await runDocAgentLoop({
      client: llm,
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      executors: makeToolExecutors(sandbox),
      maxIterations,
      onEvent,
      signal,
    });

    const outputs = await sandbox.collectOutputs();
    onEvent({ type: 'outputs', count: outputs.length, names: outputs.map((o) => o.name) });
    return { ...result, outputs, driver: sandbox.driver };
  } finally {
    await sandbox.destroy();
  }
}

module.exports = { runDocumentAgent, createOpenRouterClient, DEFAULT_MODEL };
