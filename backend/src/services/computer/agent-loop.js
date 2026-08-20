'use strict';

/**
 * agentLoop — screenshot/CDP → DeepSeek V4 Flash/Pro → xdotool action.
 *
 * Runs on the member's one persistent desktop (shared by department agents).
 * Max 25 steps. Aborts if the same canonical action repeats 3 times.
 * JSON log per step. PNG is for this loop only; humans use noVNC.
 * cdpMode (accessibility tree text) is the functional default when the
 * active model does not accept images. Pixel screenshots are used only
 * when the model is listed in COMPUTER_VISION_MODELS. No OpenRouter.
 */

const { throwIfAborted } = require('../../utils/abort-signals');
const {
  resolveComputerModel,
  resolveObservationMode,
  modelAcceptsImages,
} = require('./flags');
const { createDeepSeekClient, completeJson } = require('./deepseek');
const { snapshotAccessibility } = require('./cdp-client');

const MAX_STEPS = 25;
const REPEAT_LIMIT = 3;

function canonicalizeAction(action) {
  if (!action || typeof action !== 'object') return '';
  const keys = Object.keys(action).sort();
  const out = {};
  for (const k of keys) out[k] = action[k];
  return JSON.stringify(out);
}

function actionFingerprint(action) {
  if (!action || action.type === 'done' || action.type === 'stop') return '';
  return canonicalizeAction(action);
}

function repeatedSameAction(fingerprints) {
  if (fingerprints.length < REPEAT_LIMIT) return false;
  const last = fingerprints[fingerprints.length - 1];
  if (!last) return false;
  return fingerprints.slice(-REPEAT_LIMIT).every((f) => f === last);
}

function systemPrompt(mode, goal, taskId) {
  return [
    'You control a Linux XFCE desktop with Google Chrome (Thunar + xfce4-terminal).',
    'This desktop belongs to one SiraGPT member. All of that member\'s department agents share it.',
    'Reply with a single JSON object only.',
    mode === 'cdp'
      ? 'Observation is the Chrome accessibility tree (text). Screenshots are for the control loop only, not the human viewer.'
      : 'Observation is a PNG screenshot of the desktop for the control loop. The human viewer is noVNC, not this PNG.',
    'Actions: click, double_click, right_click, move, drag, scroll, type, key, done.',
    'Schema: {"reasoning":"","action":{"type":"click","x":0,"y":0}} or {"action":{"type":"done","result":"..."}}.',
    'Stop when the goal is complete. Do not repeat the same action.',
    taskId ? `Write task artifacts under /workspace/${taskId}/.` : 'Task artifacts may go under /workspace/<task-id>/.',
    `Goal: ${goal}`,
  ].join('\n');
}

function userObservation(mode, observation) {
  if (mode === 'screenshot' && observation.png) {
    return [
      {
        type: 'text',
        text: 'Desktop screenshot follows. Choose the next action as JSON.',
      },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${observation.png}` },
      },
    ];
  }
  return `Accessibility tree / observation:\n${observation.text || '(empty)'}`;
}

async function defaultObserve({ mode, agentUrl, cdpUrl, fetchImpl, cdpSnapshot }) {
  if (mode === 'cdp') {
    const snap = cdpSnapshot || snapshotAccessibility;
    return snap(cdpUrl);
  }
  const fetchFn = fetchImpl || fetch;
  const res = await fetchFn(`${agentUrl}/screenshot`);
  if (!res.ok) throw new Error(`screenshot HTTP ${res.status}`);
  return res.json();
}

async function defaultEnsureTask({ agentUrl, taskId, fetchImpl }) {
  if (!taskId) return null;
  const fetchFn = fetchImpl || fetch;
  const res = await fetchFn(`${agentUrl}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `task dir HTTP ${res.status}`);
    err.details = body;
    throw err;
  }
  return body;
}

async function defaultAct({ agentUrl, action, fetchImpl }) {
  const fetchFn = fetchImpl || fetch;
  const res = await fetchFn(`${agentUrl}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `action HTTP ${res.status}`);
    err.details = body;
    throw err;
  }
  return body;
}

async function agentLoop({
  goal,
  agentUrl,
  cdpUrl,
  model,
  cdpMode,
  taskId,
  env = process.env,
  signal,
  maxSteps = MAX_STEPS,
  createClient,
  complete = completeJson,
  observe,
  act,
  ensureTask,
  fetchImpl,
  cdpSnapshot,
} = {}) {
  if (!goal) throw new Error('goal is required');
  const resolvedModel = resolveComputerModel(model, env);
  const mode = resolveObservationMode({ cdpMode, model: resolvedModel, env });
  const client = createClient ? await createClient() : createDeepSeekClient({ env, createClient });
  const log = [];
  const fingerprints = [];
  let stoppedReason = null;
  let taskDir = null;

  const observeFn = observe || ((ctx) => defaultObserve({ ...ctx, fetchImpl, cdpSnapshot }));
  const actFn = act || ((ctx) => defaultAct({ ...ctx, fetchImpl }));
  const ensureTaskFn = ensureTask || ((ctx) => defaultEnsureTask({ ...ctx, fetchImpl }));
  if (taskId) {
    try {
      taskDir = await ensureTaskFn({ agentUrl, taskId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        event: 'agent-computer-task-dir',
        ok: false,
        taskId,
        message: err.message,
      }));
    }
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    throwIfAborted(signal);
    const observation = await observeFn({ mode, agentUrl, cdpUrl, step });
    const messages = [
      { role: 'system', content: systemPrompt(mode, goal, taskId) },
      { role: 'user', content: userObservation(mode, observation) },
    ];
    const decision = await complete({ client, model: resolvedModel, messages, signal });
    const action = decision.action || decision;
    const fp = actionFingerprint(action);
    fingerprints.push(fp);

    const entry = {
      step,
      ts: new Date().toISOString(),
      mode,
      model: resolvedModel,
      taskId: taskId || null,
      observation: mode === 'cdp'
        ? { text: String(observation.text || '').slice(0, 4000) }
        : { pngBytes: observation.png ? Buffer.from(observation.png, 'base64').length : 0 },
      action,
      reasoning: decision.reasoning || null,
    };
    log.push(entry);
    // JSON log per step (structured, one object).
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'agent-computer-step', ...entry }));

    if (action.type === 'done' || action.type === 'stop') {
      stoppedReason = 'done';
      break;
    }
    if (repeatedSameAction(fingerprints)) {
      stoppedReason = 'repeated_action';
      break;
    }
    await actFn({ agentUrl, action, step });
  }

  if (!stoppedReason) stoppedReason = log.length >= maxSteps ? 'max_steps' : 'completed';
  return {
    ok: stoppedReason === 'done' || stoppedReason === 'completed',
    stoppedReason,
    steps: log.length,
    mode,
    model: resolvedModel,
    vision: modelAcceptsImages(resolvedModel, env),
    taskId: taskId || null,
    taskDir,
    log,
  };
}

module.exports = {
  MAX_STEPS,
  REPEAT_LIMIT,
  canonicalizeAction,
  actionFingerprint,
  repeatedSameAction,
  systemPrompt,
  agentLoop,
};
