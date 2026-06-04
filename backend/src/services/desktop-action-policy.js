'use strict';

const {
  buildSafeAppAliases,
  buildSafeProjectAliases,
  normalizeHostPlatform,
  resolveHostPlatformCapabilities,
} = require('./host-platform-profile');

const DESKTOP_ACTION_POLICY_VERSION = 'desktop-action-policy-2026-06';

const BLOCKED_ACTION_PATTERNS = Object.freeze([
  { re: /\brm\s+-rf\b/i, reason: 'destructive_shell_command' },
  { re: /\bsudo\b/i, reason: 'privileged_shell_command' },
  { re: /\b(?:delete|remove|destroy|wipe|format)\b/i, reason: 'destructive_action' },
  { re: /\b(?:borra|borrar|elimina|eliminar|destruye|destruir|formatea|formatear)\b/i, reason: 'destructive_action' },
  { re: /\b(?:pagar|comprar|checkout|place order|transferir dinero|wire transfer|bank account|credit card)\b/i, reason: 'financial_or_irreversible_action' },
  { re: /\b(?:send email|enviar correo|post tweet|publicar|subir a produccion|deploy production)\b/i, reason: 'external_side_effect_requires_review' },
  { re: /\b(?:password|contrase(?:ñ|n)a|token|secret|api key|private key)\b/i, reason: 'secret_or_credential_request' },
]);

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const OPEN_VERBS_RE = /\b(?:abre|abreme|habre|abrir|open|lanza|lanzar|inicia|iniciar|muestra|mostrar)\b/i;
const COMMAND_VERBS_RE = /\b(?:ejecuta|ejecutar|corre|correr|run|lanza el comando|terminal command)\b/i;

function normalizeText(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function detectBlockedAction(raw) {
  const text = String(raw || '');
  for (const item of BLOCKED_ACTION_PATTERNS) {
    if (item.re.test(text)) {
      return {
        blocked: true,
        reason: item.reason,
      };
    }
  }
  return { blocked: false, reason: null };
}

function resolvePolicyPlatform(options = {}) {
  return normalizeHostPlatform(options.platform || options.hostPlatform || process.platform);
}

function detectSafeApp(normalizedText, options = {}) {
  if (!OPEN_VERBS_RE.test(normalizedText)) return null;
  for (const item of buildSafeAppAliases(resolvePolicyPlatform(options))) {
    if (item.aliases.some(alias => normalizedText.includes(normalizeText(alias)))) {
      return item;
    }
  }
  return null;
}

function detectSafeProject(normalizedText, options = {}) {
  if (!OPEN_VERBS_RE.test(normalizedText)) return null;
  for (const item of buildSafeProjectAliases(options.env || process.env, resolvePolicyPlatform(options))) {
    if (item.aliases.some(alias => normalizedText.includes(normalizeText(alias)))) {
      return item;
    }
  }
  return null;
}

function extractUrl(raw) {
  const match = String(raw || '').match(URL_RE);
  return match ? match[0] : null;
}

function extractCommandCandidate(raw) {
  const text = String(raw || '').trim();
  if (!COMMAND_VERBS_RE.test(text)) return null;
  return text
    .replace(COMMAND_VERBS_RE, '')
    .replace(/^(?:el|un|este)?\s*(?:comando|command)?\s*[:：-]?\s*/i, '')
    .trim()
    .slice(0, 300);
}

function buildBasePlan(raw) {
  return {
    version: DESKTOP_ACTION_POLICY_VERSION,
    hostPlatform: normalizeHostPlatform(process.platform),
    rawText: String(raw || ''),
    normalizedText: normalizeText(raw),
    actionRequired: false,
    allowed: false,
    status: 'not_desktop_command',
    reason: 'No desktop command detected.',
    risk: 'none',
    requiresLocalBridge: false,
    requiresConfirmation: false,
    action: null,
    auditTags: [],
  };
}

function planDesktopAction(raw, options = {}) {
  const plan = buildBasePlan(raw);
  plan.hostPlatform = resolvePolicyPlatform(options);
  const blocked = detectBlockedAction(raw);
  if (blocked.blocked) {
    return {
      ...plan,
      actionRequired: true,
      allowed: false,
      status: 'blocked',
      reason: blocked.reason,
      risk: 'blocked',
      requiresLocalBridge: true,
      requiresConfirmation: true,
      auditTags: ['blocked', blocked.reason],
    };
  }

  const command = extractCommandCandidate(raw);
  if (command) {
    return {
      ...plan,
      actionRequired: true,
      allowed: true,
      status: 'confirmation_required',
      reason: 'Shell commands require explicit confirmation before a local bridge can execute them.',
      risk: 'high',
      requiresLocalBridge: true,
      requiresConfirmation: true,
      action: {
        type: 'run_shell_command',
        command,
        workingDirectory: options.defaultWorkingDirectory || null,
      },
      auditTags: ['desktop', 'shell_command', 'confirmation_required'],
    };
  }

  const project = detectSafeProject(plan.normalizedText, options);
  if (project) {
    return {
      ...plan,
      actionRequired: true,
      allowed: true,
      status: 'ready_for_local_bridge',
      reason: 'Allowlisted local project open request.',
      risk: 'low',
      requiresLocalBridge: true,
      requiresConfirmation: false,
      action: {
        type: 'open_project',
        projectId: project.id,
        label: project.label,
        path: project.path,
        preferredApp: project.preferredApp || 'Visual Studio Code',
        platform: plan.hostPlatform,
      },
      auditTags: ['desktop', 'open_project', project.id],
    };
  }

  const app = detectSafeApp(plan.normalizedText, options);
  if (app) {
    return {
      ...plan,
      actionRequired: true,
      allowed: true,
      status: 'ready_for_local_bridge',
      reason: 'Allowlisted app open request.',
      risk: 'low',
      requiresLocalBridge: true,
      requiresConfirmation: false,
      action: {
        type: 'open_app',
        app: app.app,
        platform: plan.hostPlatform,
        launcher: app.launcher || null,
      },
      auditTags: ['desktop', 'open_app', app.app.toLowerCase().replace(/\s+/g, '_')],
    };
  }

  const url = extractUrl(raw);
  if (OPEN_VERBS_RE.test(plan.normalizedText) && url) {
    return {
      ...plan,
      actionRequired: true,
      allowed: true,
      status: 'ready_for_local_bridge',
      reason: 'HTTP(S) URL open request.',
      risk: 'low',
      requiresLocalBridge: true,
      requiresConfirmation: false,
      action: {
        type: 'open_url',
        url,
        platform: plan.hostPlatform,
      },
      auditTags: ['desktop', 'open_url'],
    };
  }

  return plan;
}

function resolveDesktopBridgeCapabilities(env = process.env, opts = {}) {
  const enabled = String(env.SIRAGPT_DESKTOP_BRIDGE_ENABLED || '').toLowerCase() === 'true'
    || env.SIRAGPT_DESKTOP_BRIDGE_ENABLED === '1';
  const host = resolveHostPlatformCapabilities(env, opts);
  const apps = buildSafeAppAliases(host.platform);
  const projects = buildSafeProjectAliases(env, host.platform);
  return {
    enabled,
    mode: enabled ? host.bridgeMode : 'contract_only',
    policyVersion: DESKTOP_ACTION_POLICY_VERSION,
    hostPlatform: host,
    allowedActions: ['open_app', 'open_project', 'open_url'],
    confirmationRequiredActions: ['run_shell_command'],
    blockedCategories: Array.from(new Set(BLOCKED_ACTION_PATTERNS.map(item => item.reason))),
    allowlistedApps: apps.map(item => item.app),
    allowlistedProjects: projects.map(item => ({
      id: item.id,
      label: item.label,
      path: item.path,
    })),
    safety: {
      requiresAuthenticatedUser: true,
      requiresLocalPairingToken: true,
      blocksDestructiveActions: true,
      writesAuditTrail: true,
    },
  };
}

module.exports = {
  DESKTOP_ACTION_POLICY_VERSION,
  SAFE_APP_ALIASES: buildSafeAppAliases(),
  SAFE_PROJECT_ALIASES: buildSafeProjectAliases(),
  BLOCKED_ACTION_PATTERNS,
  normalizeText,
  planDesktopAction,
  resolveDesktopBridgeCapabilities,
};
