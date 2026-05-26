'use strict';

const { resolveDesktopBridgeCapabilities } = require('./desktop-action-policy');

const DEFAULT_ACTIONS = Object.freeze([
  'navigate',
  'click',
  'type',
  'scroll',
  'wait',
  'extract_text',
  'extract_structured_data',
  'screenshot',
  'download_report',
]);

const DEFAULT_SAFETY_RULES = Object.freeze([
  'Authenticated user scope is required for every HTTP route.',
  'CAPTCHA, paywall, login-wall, payment, order, money-transfer, email-send, and public-post automation are blocked by middleware.',
  'Each session is isolated by sessionId and userId.',
  'Screenshots and extracted page data are emitted as evidence for review.',
  'Browser sessions expire through the computer-use cleanup job.',
]);

function hasModule(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function resolveComputerUseCapabilities(env = process.env) {
  const playwrightAvailable = hasModule('playwright');
  const openAiConfigured = Boolean(env.OPENAI_API_KEY);
  const enabled = env.COMPUTER_USE_ENABLED !== '0';
  const desktopBridge = resolveDesktopBridgeCapabilities(env);

  return {
    enabled,
    mode: 'openclaw_style_browser',
    engine: playwrightAvailable ? 'playwright.chromium' : 'unavailable',
    planner: openAiConfigured ? 'openai_chat_dom_planner' : 'manual_or_stub_only',
    canLaunchBrowser: enabled && playwrightAvailable,
    canPlanActions: enabled && openAiConfigured,
    canPlanDesktopActions: true,
    canExecuteDesktopActions: enabled && desktopBridge.enabled,
    actions: DEFAULT_ACTIONS,
    desktopBridge,
    limits: {
      maxStepsPerTask: 20,
      sessionTtlMinutes: 30,
      rateLimit: '5 requests per minute per IP',
      defaultViewport: { width: 1024, height: 768 },
    },
    safety: {
      requiresAuth: true,
      userScopedSessions: true,
      blocksExternalIrreversibleActions: true,
      blocksDestructiveDesktopActions: true,
      rules: DEFAULT_SAFETY_RULES,
    },
  };
}

module.exports = {
  DEFAULT_ACTIONS,
  DEFAULT_SAFETY_RULES,
  resolveComputerUseCapabilities,
};
