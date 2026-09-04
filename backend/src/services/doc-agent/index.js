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
const { validateEditedFile, MAX_ATTEMPTS } = require('./validate');
const { composeAbortSignals, throwIfAborted } = require('../../utils/abort-signals');
const { resolveDocAgentCandidates, createFailoverClient } = require('./llm-runtime');

// Production 2026-09: gpt-4o-mini is retired and the OpenAI key answers 401;
// the document agent writes python-docx / openpyxl / python-pptx code, so it
// needs a current coding model. DeepSeek V4 Pro (the "Sira Pro" tier) via
// OpenRouter is the default; override with SIRAGPT_DOC_AGENT_MODEL.
const DEFAULT_MODEL = process.env.SIRAGPT_DOC_AGENT_MODEL || 'deepseek/deepseek-v4-pro';
const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000;

function resolveMaxRuntimeMs(value = process.env.SIRAGPT_DOC_AGENT_MAX_RUNTIME_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RUNTIME_MS;
  return Math.max(30_000, Math.min(30 * 60 * 1000, Math.floor(parsed)));
}

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
    if (!out.buffer || out.buffer.length === 0) {
      // An empty deliverable is never useful, whatever the format.
      out.valid = false;
      onEvent({ type: 'output_invalid', name: out.name, reason: 'empty_file' });
    } else if (['docx', 'xlsx', 'pptx'].includes(ext)) {
      out.valid = isValidOoxml(out.buffer);
      if (!out.valid) onEvent({ type: 'output_invalid', name: out.name, reason: 'ooxml_structure' });
    } else {
      out.valid = true;
    }
  }
  // Valid deliverables first so naive consumers (first-artifact UIs) get the
  // good file even when a scratch/corrupt sibling also landed in outputs/.
  outputs.sort((a, b) => Number(b.valid !== false) - Number(a.valid !== false));
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
 * @param {Function} [opts.onEvent] SSE relay (phase/tool/output events)
 * @param {'auto'|'local'|'docker'} [opts.driver]
 * @param {number} [opts.maxIterations]
 * @param {AbortSignal} [opts.signal]
 * @param {'auto'|'approval'} [opts.approvalMode] 'approval' emits approval_required with the plan before executing
 * @param {Function} [opts.approvePlan] async (plan) => boolean — only used in approval mode
 * @param {boolean} [opts.trackChanges] append tracked-changes (w:del/w:ins) instruction for DOCX
 * @param {number} [opts.maxAttempts] validation rollback attempts (default 3, max 3)
 * @param {'auto'|'anthropic'|'sandbox'} [opts.route] 'anthropic' uses Route A when ANTHROPIC_API_KEY is set
 * @returns {Promise<{ finalText: string, outputs: Array<{name:string,buffer:Buffer}>, steps: Array, iterations: number, stoppedReason: string, driver: string }>}
 */
async function runDocumentAgent({
  files = [],
  instruction,
  model,
  client,
  onEvent = () => {},
  driver,
  maxIterations = MAX_ITERATIONS_DEFAULT,
  signal,
  approvalMode = 'auto',
  approvePlan = null,
  trackChanges = false,
  maxAttempts,
  route,
} = {}) {
  const task = String(instruction || '').trim();
  if (!task) throw new Error('runDocumentAgent: instruction is required');

  // Route A (Anthropic sandbox) shares this orchestration interface so the
  // frontend never changes when the engine is swapped. Explicit opt-in only.
  const wantAnthropic = String(route || process.env.SIRAGPT_DOC_AGENT_ROUTE || 'auto').toLowerCase() === 'anthropic';
  if (wantAnthropic) {
    const { isAnthropicRouteAvailable, runAnthropicRoute } = require('./anthropic-route');
    if (!isAnthropicRouteAvailable()) throw new Error('runDocumentAgent: route=anthropic but ANTHROPIC_API_KEY is not configured');
    onEvent({ type: 'phase', phase: 'execute', route: 'anthropic' });
    const r = await runAnthropicRoute({ files, instruction: task, system: buildDocAgentSystemPrompt(files.map((f) => f?.name).filter(Boolean), { instruction: task }) });
    onEvent({ type: 'outputs', count: r.outputs.length, names: r.outputs.map((o) => o.name) });
    return { finalText: r.finalText, outputs: r.outputs, steps: [], iterations: 0, stoppedReason: 'final', driver: r.driver };
  }

  // Injected client (tests, callers with their own runtime): use it as-is.
  // Otherwise build the production runtime: the explicit model on its
  // provider first, then every configured provider of the ladder, with
  // per-call failover (an exhausted OpenRouter balance no longer kills the
  // run when DeepSeek/Meta/Gemini/xAI can take the same tool-calling loop).
  const llm = client || createFailoverClient(resolveDocAgentCandidates({ model }), {
    onFailover: (info) => onEvent({ type: 'llm_failover', ...info }),
  });
  const loopModel = model || DEFAULT_MODEL;

  const abortScope = composeAbortSignals([signal], {
    timeoutMs: resolveMaxRuntimeMs(),
    timeoutReason: 'document_agent_timeout',
  });
  let sandbox = null;
  try {
    throwIfAborted(abortScope.signal);
    sandbox = await createSandbox({ driver, signal: abortScope.signal });
    onEvent({ type: 'sandbox_ready', driver: sandbox.driver });
    const names = [];
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      if (!f || !Buffer.isBuffer(f.buffer)) continue;
      const name = sanitizeUploadName(f.name, i);
      await sandbox.putFile(`uploads/${name}`, f.buffer);
      names.push(name);
    }

    const userTask = trackChanges
      ? `${task}\n\nReturn DOCX with tracked changes (w:del/w:ins + author/date) so the reviewer sees what changed.`
      : task;
    const messages = [
      { role: 'system', content: buildDocAgentSystemPrompt(names, { instruction: task }) },
      { role: 'user', content: userTask },
    ];
    const executors = makeToolExecutors(sandbox);

    // Five-phase loop over SSE: inspect → plan → execute → validate → report.
    // The agent loop itself is the execute phase; the rest is orchestration.
    onEvent({ type: 'phase', phase: 'inspect', files: names });
    onEvent({ type: 'phase', phase: 'plan', approvalMode });

    if (String(approvalMode || 'auto').toLowerCase() === 'approval') {
      const plan = { instruction: task, files: names, trackChanges };
      onEvent({ type: 'approval_required', plan });
      if (typeof approvePlan === 'function') {
        const approved = await approvePlan(plan);
        if (!approved) {
          return {
            finalText: '', outputs: [], steps: [], iterations: 0, stoppedReason: 'awaiting_approval',
            driver: sandbox.driver,
            runtime: typeof llm.describe === 'function' ? llm.describe() : { provider: null, model: loopModel, failovers: [] },
          };
        }
      }
    }

    onEvent({ type: 'phase', phase: 'execute' });
    let result = await runDocAgentLoop({
      client: llm, model: loopModel, messages, tools: TOOL_DEFINITIONS, executors, maxIterations, onEvent,
      signal: abortScope.signal,
    });
    throwIfAborted(abortScope.signal);
    onEvent({ type: 'phase', phase: 'validate' });
    let outputs = await collectValidOutputs(sandbox, onEvent);
    throwIfAborted(abortScope.signal);

    const crypto = require('crypto');
    const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
    const inputHashes = new Set(files.map((f) => f && Buffer.isBuffer(f.buffer) ? sha1(f.buffer) : null).filter(Boolean));
    // Single-file baseline for the milimetric diff (multi-file: no baseline).
    const baseline = files.length === 1 && Buffer.isBuffer(files[0].buffer) ? files[0].buffer : null;

    const reviewOutputs = (outs) => {
      // An output byte-identical to an input is a copy, not an edit — a flaky
      // model sometimes repacks the file without applying any change.
      for (const out of outs) {
        if (out.valid !== false && out.buffer.length > 0 && inputHashes.has(sha1(out.buffer))) {
          out.valid = false;
          onEvent({ type: 'output_invalid', name: out.name, reason: 'identical_to_input' });
        }
      }
      // Milimetric validation (§7): same parts, forbidden parts reported.
      // Forbidden touches stay ADVISORY (see validate.js): library round-trips
      // re-serialize untouched parts, so a CRC touch proves nothing by itself.
      for (const out of outs) {
        if (out.valid === false) continue;
        const ext = String(out.name).split('.').pop().toLowerCase();
        if (!['docx', 'xlsx', 'pptx'].includes(ext)) continue;
        const verdict = validateEditedFile({ originalBuffer: baseline, editedBuffer: out.buffer, instruction: task });
        if (!verdict.ok) {
          out.valid = false;
          onEvent({ type: 'output_invalid', name: out.name, reason: verdict.reason, details: verdict.details || undefined });
        } else if (verdict.unexpectedParts && verdict.unexpectedParts.length > 0) {
          out.unexpectedParts = verdict.unexpectedParts;
        }
        if (verdict.diff) out.changeReport = { changed: verdict.diff.changed, added: verdict.diff.added };
      }
    };
    reviewOutputs(outputs);

    // Rollback retries: discard, restart from the pristine copy and retry with
    // the error as context (max 3 attempts total). Same sandbox — uploads are
    // still pristine, so the model retries on a clean slate.
    const attempts = Math.max(1, Math.min(MAX_ATTEMPTS, Number(maxAttempts) || MAX_ATTEMPTS));
    let attempt = 1;
    while (
      !abortScope.signal.aborted
      && outputs.filter((o) => o.valid !== false).length === 0
      && files.length > 0
      && attempt < attempts
    ) {
      attempt += 1;
      const failures = outputs.map((o) => o.name).join(', ') || 'no deliverable';
      onEvent({ type: 'retry', reason: 'no_valid_output', attempt, failures });
      messages.push({
        role: 'user',
        content:
          `Attempt ${attempt}/${attempts}: you have NOT yet produced a valid, EDITED deliverable in /workspace/outputs ` +
          `(${failures} — missing, corrupt, byte-identical to the upload, or with removed parts). ` +
          'Remember: a .docx/.xlsx/.pptx is a binary ZIP — NEVER edit it with str_replace directly. ' +
          'For TEXT-ONLY changes prefer the surgical path: unpack, patch the XML with lxml preserving ' +
          'w:rPr/a:rPr (join split runs first), repack with identical parts/order. For STRUCTURAL changes use ' +
          'python-docx/openpyxl/python-pptx end to end. NEVER touch styles.xml, numbering.xml, theme, ' +
          'layouts, masters or [Content_Types].xml. Then VERIFY by loading the saved file again and ' +
          'printing the changed content. Do this now and finish.',
      });
      onEvent({ type: 'phase', phase: 'execute', attempt });
      result = await runDocAgentLoop({
        client: llm, model, messages, tools: TOOL_DEFINITIONS, executors,
        maxIterations: Math.min(maxIterations, 12), onEvent, signal: abortScope.signal,
      });
      throwIfAborted(abortScope.signal);
      onEvent({ type: 'phase', phase: 'validate', attempt });
      outputs = await collectValidOutputs(sandbox, onEvent);
      throwIfAborted(abortScope.signal);
      reviewOutputs(outputs);
    }

    throwIfAborted(abortScope.signal);
    onEvent({ type: 'phase', phase: 'report', count: outputs.length });
    onEvent({ type: 'outputs', count: outputs.length, names: outputs.map((o) => o.name) });
    return {
      ...result,
      outputs,
      driver: sandbox.driver,
      // Which provider/model actually answered (after any failover) — surfaced
      // in logs/events so an exhausted provider is visible, not silent.
      runtime: typeof llm.describe === 'function' ? llm.describe() : { provider: null, model: loopModel, failovers: [] },
    };
  } finally {
    try {
      if (sandbox) await sandbox.destroy();
    } finally {
      abortScope.cleanup();
    }
  }
}

module.exports = {
  runDocumentAgent,
  createOpenRouterClient,
  DEFAULT_MODEL,
  DEFAULT_MAX_RUNTIME_MS,
  resolveMaxRuntimeMs,
  isValidOoxml,
};
