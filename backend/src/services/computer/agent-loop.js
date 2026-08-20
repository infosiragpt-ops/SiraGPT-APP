'use strict';

/**
 * agentLoop — screenshot/CDP → DeepSeek V4 Flash/Pro → action.
 *
 * Max 25 steps. Aborts if the same canonical action repeats 3 times.
 * cdpMode (accessibility tree text) is the functional default when the
 * active model does not accept images. Pixel screenshots are used only
 * when the model is listed in COMPUTER_VISION_MODELS.
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

function systemPrompt(mode, goal) {
  return [
    'You control a Linux XFCE desktop with Google Chrome.',
    'Reply with a single JSON object only.',
    mode === 'cdp'
      ? 'Observation is the Chrome accessibility tree (text). There is no screenshot.'
      : 'Observation is a PNG screenshot of the desktop.',
    'Actions: click, double_click, right_click, move, drag, scroll, type, key, done.',
    'Schema: {"reasoning":"","action":{"type":"click","x":0,"y":0}} or {"action":{"type":"done","result":"..."}}.',
    'Stop when the goal is complete. Do not repeat the same action.',
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
  env = process.env,
  signal,
  maxSteps = MAX_STEPS,
  createClient,
  complete = completeJson,
  observe,
  act,
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

  const observeFn = observe || ((ctx) => defaultObserve({ ...ctx, fetchImpl, cdpSnapshot }));
  const actFn = act || ((ctx) => defaultAct({ ...ctx, fetchImpl }));

  for (let step = 1; step <= maxSteps; step += 1) {
    throwIfAborted(signal);
    const observation = await observeFn({ mode, agentUrl, cdpUrl, step });
    const messages = [
      { role: 'system', content: systemPrompt(mode, goal) },
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
