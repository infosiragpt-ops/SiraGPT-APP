'use strict';

/**
 * Bridge harness-v2 loop events onto the existing chat SSE protocol
 * (agent-harness/event-stream.js: tool_call_start / tool_executing /
 * tool_result / agent_done + durable `run.steps` records), so Phase 1b can
 * swap the engine behind /agentes without touching the AgentTrace UI.
 *
 *   harness event        → event-stream
 *   tool_call_end        → onStepStart({ thought, actions:[{tool,args}] })
 *                          (tool_call_start with human description, record)
 *   tool_result          → onStepDone({ actions:[{tool,args,observation}] })
 *   thinking_delta       → buffered; becomes the step's `thought` and is
 *                          forwarded to `onThinking` for the «Pensó» UI
 *   text_delta           → `onText` (the route writes `{content}` chunks)
 *   turn_reset           → `onReset` (drop partial text of a retried turn)
 *   done                 → finish({ stoppedReason, finalAnswer })
 */

function createHarnessEventBridge(eventStream, { onText = () => {}, onThinking = () => {}, onReset = () => {}, onEvent = () => {} } = {}) {
  if (!eventStream || typeof eventStream.onStepStart !== 'function') throw new TypeError('bridge needs an agent-harness event stream');
  let thought = '';
  let finished = null;
  return {
    handle(ev) {
      try { onEvent(ev); } catch (_) { /* observer */ }
      switch (ev && ev.type) {
        case 'text_delta': onText(ev.text); break;
        case 'thinking_delta':
          thought += ev.text || '';
          onThinking(ev.text);
          break;
        case 'turn_reset': thought = ''; onReset(ev); break;
        case 'tool_call_end':
          eventStream.onStepStart({ thought: thought || null, actions: [{ tool: ev.name, args: ev.input || {} }] });
          thought = '';
          break;
        case 'tool_result':
          eventStream.onStepDone({
            actions: [{ tool: ev.name, args: ev.input || {}, observation: ev.isError ? { error: ev.content } : ev.content }],
          });
          break;
        case 'done':
          if (!finished) finished = eventStream.finish({ stoppedReason: ev.stopReason, interrupted: ev.stopReason === 'aborted', finalAnswer: ev.finalText || '' });
          break;
        default:
          break;
      }
    },
    get run() { return finished || eventStream.run; },
  };
}

module.exports = { createHarnessEventBridge };
