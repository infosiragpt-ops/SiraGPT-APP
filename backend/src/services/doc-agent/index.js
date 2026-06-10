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

/**
 * Structural OOXML validity check (no dependency): a docx/xlsx/pptx is a ZIP
 * whose central directory contains an entry named exactly "[Content_Types].xml"
 * at the root. Catches the classic "zipped an absolute/parent path so every
 * entry is nested under a folder" corruption.
 */
function isValidOoxml(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) return false;
    if (buffer.readUInt32LE(0) !== 0x04034b50) return false; // local file header "PK\x03\x04"
    const EOCD_SIG = 0x06054b50; // "PK\x05\x06"
    let eocd = -1;
    const minStart = Math.max(0, buffer.length - 22 - 0xffff);
    for (let i = buffer.length - 22; i >= minStart; i -= 1) {
      if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd === -1) return false;
    const total = buffer.readUInt16LE(eocd + 10);
    let off = buffer.readUInt32LE(eocd + 16);
    const CDH_SIG = 0x02014b50; // "PK\x01\x02"
    for (let n = 0; n < total; n += 1) {
      if (off + 46 > buffer.length || buffer.readUInt32LE(off) !== CDH_SIG) break;
      const nameLen = buffer.readUInt16LE(off + 28);
      const extraLen = buffer.readUInt16LE(off + 30);
      const commentLen = buffer.readUInt16LE(off + 32);
      const name = buffer.toString('utf8', off + 46, off + 46 + nameLen);
      if (name === '[Content_Types].xml') return true;
      off += 46 + nameLen + extraLen + commentLen;
    }
    return false;
  } catch {
    return false;
  }
}

/** Collect /workspace/outputs and tag each with structural validity. */
async function collectValidOutputs(sandbox, onEvent = () => {}) {
  const outputs = await sandbox.collectOutputs();
  for (const out of outputs) {
    const ext = String(out.name).split('.').pop().toLowerCase();
    if (['docx', 'xlsx', 'pptx'].includes(ext)) {
      out.valid = isValidOoxml(out.buffer);
      if (!out.valid) onEvent({ type: 'output_invalid', name: out.name, reason: 'ooxml_structure' });
    } else {
      out.valid = true;
    }
  }
  return outputs;
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
    const executors = makeToolExecutors(sandbox);

    let result = await runDocAgentLoop({
      client: llm, model, messages, tools: TOOL_DEFINITIONS, executors, maxIterations, onEvent, signal,
    });
    let outputs = await collectValidOutputs(sandbox, onEvent);

    // One corrective retry when the run produced no usable deliverable (a flaky
    // model can burn its iterations on a wrong strategy — e.g. str_replace on
    // the binary .docx). We nudge it with the failure and let it finish the job
    // on the SAME sandbox (its scratch work + uploads are still there).
    const needsRetry = !signal?.aborted && outputs.filter((o) => o.valid !== false).length === 0 && files.length > 0;
    if (needsRetry) {
      onEvent({ type: 'retry', reason: 'no_valid_output' });
      messages.push({
        role: 'user',
        content:
          'You have not yet produced a valid deliverable in /workspace/outputs. Remember: a .docx/.xlsx/.pptx is a binary ZIP — ' +
          'do NOT str_replace it directly. Unpack it (unzip) into a scratch dir, edit the extracted XML (or use python3 / python-docx), ' +
          'then write the final file to /workspace/outputs and verify it opens. Do this now and finish.',
      });
      result = await runDocAgentLoop({
        client: llm, model, messages, tools: TOOL_DEFINITIONS, executors,
        maxIterations: Math.min(maxIterations, 12), onEvent, signal,
      });
      outputs = await collectValidOutputs(sandbox, onEvent);
    }

    onEvent({ type: 'outputs', count: outputs.length, names: outputs.map((o) => o.name) });
    return { ...result, outputs, driver: sandbox.driver };
  } finally {
    await sandbox.destroy();
  }
}

module.exports = { runDocumentAgent, createOpenRouterClient, DEFAULT_MODEL, isValidOoxml };
