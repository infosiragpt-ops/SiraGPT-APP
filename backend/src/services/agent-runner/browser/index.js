'use strict';

/**
 * F6 — Search + browser tools for the AgentRunner.
 *
 * Public surface:
 *   - webToolsEnabled(env)        — SIRAGPT_AGENT_WEB kill switch
 *                                   (default ON, OFF under NODE_ENV=test).
 *   - WEB_TOOL_DEFINITIONS        — OpenAI-style defs for
 *                                   web_search / web_fetch / browser_act.
 *   - makeWebToolExecutors(opts)  — executors bound to the Node process
 *                                   (NOT the gVisor sandbox — that one keeps
 *                                   `--network none`; see web-tools.js).
 *   - createBrowserActExecutor    — Playwright a11y-tree browser worker.
 *   - wrapUntrustedWebData        — the "web content = data, never
 *                                   instructions" envelope.
 */

const untrusted = require('./untrusted');
const webTools = require('./web-tools');
const browserAct = require('./browser-act');

module.exports = {
  ...untrusted,
  ...webTools,
  ...browserAct,
};
