'use strict';

/**
 * Hermes TUI bridge — slash-command protocol without terminal UI.
 * Mirrors Hermes CLI/TUI commands as a backend API for any client.
 */

const sessionManager = require('../session-manager');
const { runHermesCommand } = require('./hermes-cli-bridge');
const { compressConversation } = require('./hermes-agent-bridge');
const skillsRegistry = require('../skills-registry');
const toolsetRegistry = require('./toolset-registry');
const memoryBridge = require('./hermes-memory-bridge');

const SLASH_COMMANDS = Object.freeze([
  'new', 'reset', 'model', 'tools', 'skills', 'compress', 'usage', 'memory', 'doctor', 'stop',
]);

function parseSlashInput(input) {
  const raw = String(input || '').trim();
  if (!raw.startsWith('/')) return { isSlash: false, raw };
  const parts = raw.slice(1).split(/\s+/);
  const command = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);
  return { isSlash: true, command, args, raw };
}

async function executeSlashCommand(input, ctx = {}) {
  const parsed = parseSlashInput(input);
  if (!parsed.isSlash) {
    return { handled: false, reason: 'not_slash_command', raw: parsed.raw };
  }

  const userId = ctx.userId;
  const sessionId = ctx.sessionId;

  switch (parsed.command) {
    case 'new':
    case 'reset': {
      if (sessionId) sessionManager.resetSession(sessionId);
      const session = userId ? sessionManager.createSession(userId, { label: 'Hermes reset' }) : null;
      return { handled: true, command: parsed.command, sessionId: session?.id || null };
    }
    case 'model':
      return { handled: true, ...runHermesCommand('model', ctx) };
    case 'tools':
      return { handled: true, toolsets: toolsetRegistry.listToolsets() };
    case 'skills':
      return {
        handled: true,
        skills: skillsRegistry.listSkills({ limit: 50 }).map((s) => ({ id: s.id, label: s.label })),
      };
    case 'compress': {
      const report = await compressConversation({
        messages: ctx.messages || [],
        model: ctx.model || null,
        activeTask: ctx.activeTask || null,
      });
      return { handled: true, command: 'compress', report };
    }
    case 'usage':
      return {
        handled: true,
        usage: {
          messageCount: (ctx.messages || []).length,
          hint: 'Full token accounting available via request-token-intelligence on chat routes',
        },
      };
    case 'memory':
      return { handled: true, ...memoryBridge.status(userId) };
    case 'doctor':
      return { handled: true, ...runHermesCommand('doctor', ctx) };
    case 'stop':
      return { handled: true, command: 'stop', aborted: Boolean(ctx.abortSignal?.aborted) };
    default:
      return {
        handled: false,
        reason: 'unknown_slash_command',
        command: parsed.command,
        available: SLASH_COMMANDS,
      };
  }
}

function listSlashCommands() {
  return [...SLASH_COMMANDS];
}

module.exports = {
  SLASH_COMMANDS,
  parseSlashInput,
  executeSlashCommand,
  listSlashCommands,
};
