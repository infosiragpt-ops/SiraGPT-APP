'use strict';

/**
 * F9 evals — scripted LLM client + mock tool executors.
 *
 * The harness never talks to OpenRouter (credits are exhausted and CI must
 * stay offline). Instead, each scenario ships a deterministic "script": the
 * ordered list of assistant turns the fake model will produce. The client
 * implements the exact OpenAI shape `runAgentLoop` expects
 * (`client.chat.completions.create`), so the REAL loop, verification gate
 * and cancel path are exercised — only the model and the sandbox are fake.
 */

/**
 * @typedef {Object} ScriptedTurn
 * @property {string} [content]                       assistant text (final answer or thought)
 * @property {Array<{name: string, args?: Object}>} [toolCalls]  tool calls for this turn
 */

/**
 * Build an OpenAI-shaped client that replays `turns` in order. When the
 * script is exhausted (e.g. the loop pushed a verification nudge), the last
 * turn is repeated — mirroring a model that keeps giving the same answer.
 *
 * @param {ScriptedTurn[]} turns
 */
function createScriptedClient(turns = []) {
  const script = Array.isArray(turns) && turns.length
    ? turns
    : [{ content: '' }];
  let cursor = 0;
  const calls = [];

  return {
    calls,
    chat: {
      completions: {
        async create(payload = {}) {
          const index = Math.min(cursor, script.length - 1);
          cursor += 1;
          calls.push({
            model: payload.model,
            messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
            turnIndex: index,
          });
          const turn = script[index] || {};
          const toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
          const message = toolCalls.length
            ? {
              role: 'assistant',
              content: turn.content ?? null,
              tool_calls: toolCalls.map((call, idx) => ({
                id: `scripted_${index}_${idx}`,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args || {}),
                },
              })),
            }
            : { role: 'assistant', content: turn.content ?? '' };
          return { choices: [{ message }] };
        },
      },
    },
  };
}

// Canned happy-path results per tool. Scenarios can override any of them
// (or force an ERROR) via `scenario.toolResults`.
const DEFAULT_TOOL_RESULTS = Object.freeze({
  create_presentation: 'OK: created /workspace/outputs/presentacion.pptx (6 slides, outline applied)',
  set_slide_background: 'OK: solid background applied to every slide',
  render_preview: 'OK: rendered 6 slides to /workspace/previews, avg brightness 231 (light)',
  execute_python: 'OK: script finished, assertions passed',
  execute_bash: 'OK',
  read_file: 'OK: (empty file)',
  write_file: 'OK: file written',
  edit_file: 'OK: replaced 1 occurrence',
  list_files: '/workspace/uploads\n/workspace/outputs',
  glob: '(no matches)',
  grep: '(no matches)',
});

/**
 * Build the mock executor map for one scenario run.
 *
 * @param {Object} opts
 * @param {Object} [opts.toolResults]   per-tool result overrides ("ERROR: …" marks failure)
 * @param {Object} [opts.fileContents]  path (or basename) → content served by read_file
 * @param {Array}  [opts.toolLog]       receives { tool, args } per execution, in order
 * @param {Function} [opts.onExecute]   called after each execution (cancel hook)
 */
function createMockExecutors({
  toolResults = {},
  fileContents = {},
  toolLog = [],
  onExecute = () => {},
} = {}) {
  const executors = {};
  const names = new Set([
    ...Object.keys(DEFAULT_TOOL_RESULTS),
    ...Object.keys(toolResults),
  ]);
  for (const name of names) {
    executors[name] = async (args = {}) => {
      toolLog.push({ tool: name, args });
      let result;
      if (Object.prototype.hasOwnProperty.call(toolResults, name)) {
        result = toolResults[name];
      } else if (name === 'read_file') {
        const requested = String(args.path || '');
        const key = Object.keys(fileContents).find(
          (candidate) => requested === candidate || requested.endsWith(`/${candidate}`) || requested.includes(candidate),
        );
        result = key !== undefined ? fileContents[key] : DEFAULT_TOOL_RESULTS.read_file;
      } else {
        result = DEFAULT_TOOL_RESULTS[name];
      }
      onExecute({ tool: name, args });
      return typeof result === 'function' ? result(args) : String(result);
    };
  }
  return executors;
}

module.exports = {
  createScriptedClient,
  createMockExecutors,
  DEFAULT_TOOL_RESULTS,
};
