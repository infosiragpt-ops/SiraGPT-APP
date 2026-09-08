'use strict';

const { globMatch } = require('./project-hooks');

const MODES = new Set(['auto', 'confirm', 'plan-only']);
const EFFORTS = new Set(['low', 'medium', 'high']);
const MAX_PATTERNS = 80;
const SAFE_CONFIRM_TOOLS = new Set([
  'read_file',
  'read_media',
  'list_files',
  'glob',
  'grep_search',
  'repo_map',
  'inspect_database',
  'use_skill',
  'web_search',
  'web_fetch',
  'task_logs',
  'subagent_status',
  'update_plan',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanPattern(value, { commands = false } = {}) {
  const text = String(value || '').trim();
  if (!text || text.length > 180) return null;
  const valid = commands
    ? /^[a-zA-Z0-9_@./:*?=+\-\s]+$/.test(text)
    : /^[a-zA-Z0-9_*?.:-]+$/.test(text);
  return valid ? text : null;
}

function patternList(raw, options = {}) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('settings patterns must be arrays');
  if (raw.length > MAX_PATTERNS) throw new Error(`settings patterns exceed ${MAX_PATTERNS}`);
  const values = raw.map((value) => cleanPattern(value, options));
  if (values.some((value) => !value)) throw new Error('invalid settings pattern');
  return [...new Set(values)];
}

function optionalPatternList(root, key, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(root, key)) return null;
  return patternList(root[key], options);
}

function parseSettingsObject(input = {}) {
  const root = asObject(input);
  if (root.version != null && Number(root.version) !== 1) throw new Error('unsupported settings version');
  const rawMode = String(root.mode || '').trim().toLowerCase();
  if (rawMode && !MODES.has(rawMode)) throw new Error('settings mode must be auto, confirm or plan-only');

  const permissions = asObject(root.permissions);
  const tools = asObject(root.tools);
  const commandRoot = asObject(root.commands);
  const budget = asObject(root.budget);
  const subagents = asObject(root.subagents);
  const effort = String(subagents.defaultEffort || '').trim().toLowerCase();
  if (effort && !EFFORTS.has(effort)) throw new Error('invalid subagent effort');
  const dailyUsd = budget.dailyUsd == null ? null : Number(budget.dailyUsd);
  if (dailyUsd != null && (!Number.isFinite(dailyUsd) || dailyUsd < 0 || dailyUsd > 100_000)) {
    throw new Error('budget.dailyUsd must be between 0 and 100000');
  }

  return {
    version: 1,
    mode: rawMode || null,
    tools: {
      allow: optionalPatternList(tools, 'allow') ?? optionalPatternList(permissions, 'allowTools'),
      deny: optionalPatternList(tools, 'deny') ?? optionalPatternList(permissions, 'denyTools'),
      requireApproval: optionalPatternList(tools, 'requireApproval') ?? optionalPatternList(permissions, 'requireApproval'),
      mcpAllowWithoutApproval: optionalPatternList(tools, 'mcpAllowWithoutApproval')
        ?? optionalPatternList(permissions, 'mcpAllowWithoutApproval'),
    },
    commands: {
      allow: optionalPatternList(commandRoot, 'allow', { commands: true }),
      deny: optionalPatternList(commandRoot, 'deny', { commands: true }),
    },
    budget: { dailyUsd },
    subagents: {
      defaultModel: subagents.defaultModel ? String(subagents.defaultModel).trim().slice(0, 160) : null,
      defaultEffort: effort || null,
      explorerModel: subagents.explorerModel ? String(subagents.explorerModel).trim().slice(0, 160) : null,
    },
  };
}

function mergeSettings(base, overlay) {
  const left = base || parseSettingsObject({});
  const right = overlay || parseSettingsObject({});
  return {
    version: 1,
    mode: right.mode || left.mode || 'auto',
    tools: {
      allow: right.tools.allow ?? left.tools.allow ?? [],
      deny: right.tools.deny ?? left.tools.deny ?? [],
      requireApproval: right.tools.requireApproval ?? left.tools.requireApproval ?? [],
      mcpAllowWithoutApproval: right.tools.mcpAllowWithoutApproval ?? left.tools.mcpAllowWithoutApproval ?? [],
    },
    commands: {
      allow: right.commands.allow ?? left.commands.allow ?? [],
      deny: right.commands.deny ?? left.commands.deny ?? [],
    },
    budget: {
      dailyUsd: right.budget.dailyUsd ?? left.budget.dailyUsd ?? null,
    },
    subagents: {
      defaultModel: right.subagents.defaultModel || left.subagents.defaultModel || null,
      defaultEffort: right.subagents.defaultEffort || left.subagents.defaultEffort || null,
      explorerModel: right.subagents.explorerModel || left.subagents.explorerModel || null,
    },
  };
}

function settingsFromProject(project) {
  const brief = asObject(project?.brief);
  const persisted = parseSettingsObject(asObject(brief.settings));
  const legacyPermissions = brief.permissions == null
    ? null
    : parseSettingsObject({
      permissions: Array.isArray(brief.permissions)
        ? { requireApproval: brief.permissions }
        : brief.permissions,
    });
  return legacyPermissions ? mergeSettings(persisted, legacyPermissions) : persisted;
}

function parseSettings(text) {
  if (!String(text || '').trim()) return parseSettingsObject({});
  return parseSettingsObject(JSON.parse(String(text)));
}

async function loadProjectSettings({ runner, projectId, project }) {
  const persisted = settingsFromProject(project);
  try {
    const out = await runner.readFile(projectId, '.sira/settings.json');
    return {
      settings: mergeSettings(persisted, parseSettings(out?.content)),
      source: '.sira/settings.json',
      error: null,
    };
  } catch (error) {
    if (/not[ _-]?found|enoent|missing|no existe/i.test(String(error?.message || '')) || error?.status === 404) {
      return { settings: mergeSettings(parseSettingsObject({}), persisted), source: 'project.brief', error: null };
    }
    return {
      settings: mergeSettings(parseSettingsObject({}), persisted),
      source: 'project.brief',
      error: String(error?.message || error),
    };
  }
}

function matchesAny(patterns, value) {
  return (patterns || []).some((pattern) => globMatch(pattern, value));
}

function toolDecision(settings, toolName) {
  const name = String(toolName || '');
  const policy = settings || mergeSettings();
  if (matchesAny(policy.tools.deny, name)) return { allowed: false, reason: `tool ${name} denied by project settings` };
  if (policy.tools.allow.length && !matchesAny(policy.tools.allow, name)) {
    return { allowed: false, reason: `tool ${name} is outside the project allowlist` };
  }
  if (policy.mode === 'plan-only' && !SAFE_CONFIRM_TOOLS.has(name)) {
    return { allowed: false, reason: `project mode plan-only blocks ${name}` };
  }
  return { allowed: true, reason: '' };
}

// Safety floor: destructive patterns denied even when the project's own
// denylist is empty. These escape the workspace sandbox (host-wide deletes,
// permission changes, remote destruction) — the agent must be able to try a
// lot INSIDE the sandbox without ever being able to break anything outside
// it, regardless of project configuration.
const DESTRUCTIVE_COMMAND_FLOOR = [
  'rm -rf /*', 'rm -rf ~*', 'rm -rf ~/*', 'rm -rf /',
  'rm -rf ..', 'rm -rf ../*',
  'sudo *', 'su *',
  'chmod -R 777*', 'chown -R *',
  'mkfs*', 'dd if=*of=/dev/*', 'dd if=* of=/dev/*',
  'shutdown*', 'reboot*', 'halt*', 'poweroff*',
  '*curl*|*sh', '*curl* | *sh', '*curl*|* bash', '*wget*|*sh', '*wget* | *sh',
  ':(){ :* };:',
  'git push --force *origin main*', 'git push --force *origin master*',
  'git push *--force*', 'git reset --hard *origin/main*', 'git reset --hard *origin/master*',
  'DROP DATABASE*', 'DROP SCHEMA*',
];

function commandDecision(settings, cmd) {
  const policy = settings || mergeSettings();
  if (!Array.isArray(cmd) || cmd.some((part) => typeof part !== 'string')) {
    return { allowed: false, reason: 'command must be an array of strings' };
  }
  const full = cmd.join(' ').trim();
  const executable = String(cmd[0] || '').trim();
  const matches = (patterns) => matchesAny(patterns, full) || matchesAny(patterns, executable);
  // Floor first — a project cannot allowlist its way around it.
  if (matches(DESTRUCTIVE_COMMAND_FLOOR)) {
    return { allowed: false, reason: `command denied by safety floor (destructive outside sandbox): ${full}` };
  }
  if (matches(policy.commands.deny)) return { allowed: false, reason: `command denied by project settings: ${full}` };
  if (policy.commands.allow.length && !matches(policy.commands.allow)) {
    return { allowed: false, reason: `command is outside the project allowlist: ${full}` };
  }
  return { allowed: true, reason: '' };
}

function requiresApproval(settings, toolName) {
  const policy = settings || mergeSettings();
  if (matchesAny(policy.tools.requireApproval, toolName)) return true;
  return policy.mode === 'confirm' && !SAFE_CONFIRM_TOOLS.has(String(toolName || ''));
}

module.exports = {
  MODES,
  EFFORTS,
  SAFE_CONFIRM_TOOLS,
  parseSettings,
  parseSettingsObject,
  settingsFromProject,
  mergeSettings,
  loadProjectSettings,
  toolDecision,
  commandDecision,
  requiresApproval,
  matchesAny,
};
