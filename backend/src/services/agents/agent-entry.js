/**
 * agent-entry — unified programmatic entry point for running the agent
 * outside an HTTP request.
 *
 * This is the analogue of /api/agent/run for non-HTTP callers —
 * cron jobs, background tasks, sub-agent delegations, admin tooling.
 *
 * Unlike the HTTP route, this module:
 *   - Accepts a prompt and returns a structured result (no SSE framing)
 *   - Registers the FULL toolset: web search, code execution, document
 *     generation, git operations, shell access, CI monitoring, RAG
 *   - Supports ReAct (thinking: low) and planner-executor (thinking: medium/high)
 *   - Can delegate sub-tasks via task queue or in-process sub-agents
 *   - Is fully testable — no req/res objects, no streaming consumers
 *
 * Tool integration ensures that background agent runs have the same
 * capabilities as interactive chat sessions.
 */

const OpenAI = require('openai');
const reactAgent = require('../react-agent');
const executor = require('./executor');
const agentTools = require('./agent-tools');
const { cloneProjectTool } = require('./clone-project-tool');
const { hostBashTool } = require('./host-bash-tool');
const { hostFileTool } = require('./host-file-tool');
const { checkCiStatusTool, monitorCiTool } = require('./github-actions-tool');

// ── Observability ──────────────────────────────────────────────
const { getLogger } = require('./structured-logger');
const { getTracer } = require('./performance-tracer');

const MAX_SPAWN_DEPTH = 3;
const log = getLogger('agent-entry');

// ─── Tool adapters ─────────────────────────────────────────────────────────
// agent-tools.js tools use {schema, handler} shape. react-agent expects
// {parameters, execute}. Adapt inline.

function adaptAgentTool(tool, jsonSchema) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: jsonSchema,
    execute: async (args, _ctx) => tool.handler(args, _ctx),
  };
}

/**
 * Build the complete tool set for non-HTTP agent runs.
 * Mirrors the tool set used in agentic-chat-stream.js's buildDefaultTools().
 */
function buildAllTools(thinking = 'low', opts = {}) {
  const tools = [];

  let allowedNames = null;
  if (opts.toolset) {
    try {
      const toolsetRegistry = require('./toolset-registry');
      allowedNames = new Set(toolsetRegistry.resolveToolset(opts.toolset));
    } catch (_) {
      // fall back to full toolset
    }
  }

  // 1. Base web tools (search + read URL)
  tools.push(
    adaptAgentTool(agentTools.web_search, {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Search query, 2-12 keywords.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 15, description: 'How many hits to return. Default 5.' },
        locale:     { type: 'string', description: 'BCP-47 hint, e.g. "es-es".' },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    adaptAgentTool(agentTools.read_url, {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'Absolute http(s) URL to read.' },
        maxChars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Markdown cap. Default 12000.' },
      },
      required: ['url'],
      additionalProperties: false,
    }),
    adaptAgentTool(agentTools.web_extract, {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'Absolute http(s) URL to extract as readable markdown.' },
        maxChars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Markdown cap. Default 12000.' },
      },
      required: ['url'],
      additionalProperties: false,
    }),
    adaptAgentTool(agentTools.session_search, {
      type: 'object',
      properties: {
        query:           { type: 'string', description: 'Terms to search in the user’s past chat messages.' },
        limit:           { type: 'integer', minimum: 1, maximum: 25, description: 'How many matching snippets to return. Default 8.' },
        sessionId:       { type: 'string', description: 'Optional chat/session id to restrict the search.' },
        includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    adaptAgentTool(agentTools.browser_navigate, {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to open in the active browser session.' },
      },
      required: ['url'],
      additionalProperties: false,
    }),
    adaptAgentTool(agentTools.browser_click, {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to click in the active browser session.' },
      },
      required: ['selector'],
      additionalProperties: false,
    }),
    adaptAgentTool(agentTools.browser_type, {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the input/textarea target.' },
        text:     { type: 'string', description: 'Text to type into the target.' },
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    }),
    adaptAgentTool(agentTools.browser_scroll, {
      type: 'object',
      properties: {
        y:        { type: 'integer', description: 'Vertical pixel delta. Default 800 when selector is omitted.' },
        selector: { type: 'string', description: 'CSS selector to scroll into view.' },
      },
      additionalProperties: false,
    }),
  );

  // 2. Task tools (code execution, document generation, web search, RAG)
  try {
    const taskTools = require('./task-tools');
    // buildTaskTools() returns the array of tool objects with
    // {name, description, parameters, execute} shape — direct match
    // Skills are added below with this sub-agent's own clearance and allow-list.
    // Keeping them out of the generic task bundle prevents an earlier,
    // unrestricted run_skill tool from winning during name deduplication.
    const taskToolArray = taskTools.buildTaskTools({ includeSkills: false });
    if (Array.isArray(taskToolArray)) {
      tools.push(...taskToolArray);
    }
  } catch (err) {
    console.warn('[agent-entry] task-tools unavailable:', err?.message);
  }

  // 3. Git, shell, file, and CI tools
  tools.push(cloneProjectTool, hostBashTool, hostFileTool, checkCiStatusTool, monitorCiTool);

  // 4. Hermes-compatible tools (cron, gateway, memory, delegate, toolsets)
  try {
    const { buildHermesTools } = require('./hermes-tools');
    tools.push(...buildHermesTools());
  } catch (err) {
    console.warn('[agent-entry] hermes-tools unavailable:', err?.message);
  }

  // 5. Filesystem skills. `skillIds` is an execution allow-list, not merely a
  // prompt hint: the runner enforces it again when the model calls run_skill.
  try {
    const skillRunner = require('./skill-runner');
    const skillOptions = {
      ctx: {
        clearance: opts.clearance || 'authenticated',
        ...(Array.isArray(opts.skillIds) ? { allowedSkillIds: opts.skillIds } : {}),
      },
      allowedSkillIds: Array.isArray(opts.skillIds) ? opts.skillIds : null,
      recommendedSkillIds: Array.isArray(opts.skillIds) ? opts.skillIds : [],
    };
    const runSkillTool = skillRunner.buildRunSkillTool(skillOptions);
    const runSkillPipelineTool = skillRunner.buildRunSkillPipelineTool(skillOptions);
    if (runSkillTool) tools.push(runSkillTool);
    if (runSkillPipelineTool) tools.push(runSkillPipelineTool);
  } catch (err) {
    console.warn('[agent-entry] skill-runner unavailable:', err?.message);
  }

  // Deduplicate by name
  const seen = new Set();
  return tools.filter(t => {
    if (!t || !t.name || seen.has(t.name)) return false;
    if (allowedNames && !allowedNames.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}

// ─── Task queue bridge ─────────────────────────────────────────────────────
// When a sub-agent run needs to persist beyond the current process, we
// enqueue it to the BullMQ task queue rather than blocking on it.

async function enqueueDelegatedTask(prompt, ctx, opts = {}) {
  const { v4: uuidv4 } = require('uuid');
  const taskId = opts.taskId || uuidv4();
  const { enqueueAgentTask } = require('./agent-task-queue');

  const payload = {
    taskId,
    taskType: opts.taskType || 'agentic_subtask',
    prompt,
    userId: ctx.userId,
    collection: ctx.collection || 'default',
    model: opts.model || 'gpt-4o',
    thinking: opts.thinking || 'low',
    maxSteps: opts.maxSteps || 8,
    source: opts.source || 'agent-entry:delegated',
    parentTaskId: ctx.taskId || null,
    depth: (ctx.depth || 0) + 1,
    metadata: opts.metadata || {},
  };

  await enqueueAgentTask(payload, {
    jobId: taskId,
    priority: opts.priority || 0,
  });

  log.info({ taskId, taskType: payload.taskType }, 'delegated_task_enqueued');
  return { taskId, status: 'queued' };
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Run the agent for a specific user, returning when the run finishes.
 *
 * @param {object} opts
 * @param {string|number} opts.userId
 * @param {string} opts.prompt
 * @param {'low'|'medium'|'high'} [opts.thinking='low']
 * @param {string[]} [opts.skillIds] — restrict executable skills for every thinking mode
 * @param {string} [opts.collection='default']
 * @param {number} [opts.maxSteps=8]
 * @param {string} [opts.model='gpt-4o']
 * @param {string} [opts.source] — free-form tag for logs ("cron:job_x").
 * @param {number} [opts.depth=0] — recursion depth. Capped at MAX_SPAWN_DEPTH.
 * @param {AbortSignal} [opts.signal] — cancellation signal
 *
 * @returns {Promise<{
 *   answer: string,
 *   plan?: Array,
 *   stoppedReason: string,
 *   steps?: Array,
 *   source?: string,
 * }>}
 */
async function runAgent(opts) {
  const {
    userId, prompt,
    thinking = 'low',
    skillIds = null,
    collection = 'default',
    maxSteps,
    model = 'gpt-4o',
    source = 'internal',
    depth = 0,
    signal = null,
  } = opts;

  if (!userId) throw new Error('agent-entry.runAgent: userId required');
  if (!prompt) throw new Error('agent-entry.runAgent: prompt required');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  if (depth > MAX_SPAWN_DEPTH) {
    throw new Error(`agent-entry.runAgent: spawn depth ${depth} exceeds max ${MAX_SPAWN_DEPTH}`);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const clearance = opts.clearance || 'authenticated';
  const ctx = {
    openai,
    userId,
    collection,
    source,
    depth,
    clearance,
    ...(Array.isArray(skillIds) ? { allowedSkillIds: skillIds } : {}),
    taskId: opts.taskId || null,
  };

  const startTime = Date.now();
  const spanId = String(startTime);
  const tracer = getTracer();
  const span = tracer.start('agent.run');

  log.info({ userId: String(userId), thinking, depth, source }, 'agent_run_started');

  const tools = buildAllTools(thinking, {
    skillIds,
    clearance,
    toolset: opts.toolset || null,
  });

  try {
    if (signal?.aborted) {
      return { answer: '', stoppedReason: 'cancelled', steps: [], source };
    }

    if (thinking === 'low') {
      const reactSpan = tracer.start('react.run', span.spanId);
      try {
        const r = await reactAgent.run(openai, {
          query: prompt,
          tools,
          maxSteps,
          model,
          ctx,
          signal,
          onStep: opts.onStep || null,
        });
        return {
          answer: r.finalAnswer || '',
          stoppedReason: r.stoppedReason,
          steps: r.steps,
          source,
        };
      } finally {
        tracer.end(reactSpan);
      }
    }

    // Planner-executor for medium/high thinking
    const execSpan = tracer.start('executor.run', span.spanId);
    try {
      const r = await executor.run(openai, {
        goal: prompt,
        tools,
        thinking,
        executorModel: model,
        ctx,
      });
      return {
        answer: r.finalAnswer || '',
        plan: r.plan,
        stoppedReason: r.stoppedReason,
        steps: r.stepResults,
        source,
      };
    } finally {
      tracer.end(execSpan);
    }
  } finally {
    tracer.end(span);
    const elapsed = Date.now() - startTime;
    log.info({ elapsed, userId: String(userId), depth }, 'agent_run_finished');
  }
}

// ─── Shortcut: run in sub-agent mode (isolated, bounded) ───────────────────

/**
 * Run a sub-task with a lower iteration budget and propagate parent context.
 * Used by SubAgentOrchestrator for delegated parallel work.
 *
 * @param {string} goal        — sub-task prompt
 * @param {object} ctx         — parent context (with userId, collection, openai)
 * @param {object} opts
 * @param {number} [opts.maxSteps=6]
 * @returns {Promise<{ answer: string, steps: Array, stoppedReason: string, metadata: object }>}
 */
async function runSubAgent(goal, ctx, opts = {}) {
  const openai = ctx.openai || new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const tools = buildAllTools('low', {
    skillIds: opts.skillIds || null,
    clearance: opts.clearance || ctx.clearance || 'authenticated',
    toolset: opts.toolset || null,
  });
  const maxSteps = opts.maxSteps || 6;

  const r = await reactAgent.run(openai, {
    query: goal,
    tools,
    maxSteps,
    model: 'gpt-4o-mini',
    ctx: { ...ctx, openai, isSubAgent: true, traceId: ctx.traceId || 'sub' },
    source: ctx.source || 'sub-agent',
  });

  return {
    answer: r.finalAnswer || '',
    steps: r.steps || [],
    stoppedReason: r.stoppedReason || 'completed',
    metadata: { toolCalls: (r.steps || []).filter(s => s.toolCall).length },
  };
}

module.exports = {
  runAgent,
  runSubAgent,
  enqueueDelegatedTask,
  buildAllTools,
  MAX_SPAWN_DEPTH,
};
