'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const pexecFile = promisify(execFile);

const DISPLAY = process.env.DISPLAY || ':1';
const XDOTOOL = process.env.COMPUTER_XDOTOOL || 'xdotool';
const ACTION_TIMEOUT_MS = 20_000;

function runEnv() {
  return { ...process.env, DISPLAY };
}

async function runXdotool(args, { timeoutMs = ACTION_TIMEOUT_MS } = {}) {
  const { stdout, stderr } = await pexecFile(XDOTOOL, args, {
    timeout: timeoutMs,
    env: runEnv(),
    maxBuffer: 1024 * 1024,
  });
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

function buttonCode(button) {
  if (button === 'middle') return '2';
  if (button === 'right') return '3';
  return '1';
}

function scrollButton(direction) {
  if (direction === 'up') return '4';
  if (direction === 'down') return '5';
  if (direction === 'left') return '6';
  if (direction === 'right') return '7';
  return '5';
}

/**
 * Build the xdotool argv for a validated action. Pure — used by tests
 * and by executeAction. Never concatenates a shell string.
 */
function buildXdotoolArgs(action) {
  switch (action.type) {
    case 'click':
      return ['mousemove', String(action.x), String(action.y), 'click', buttonCode(action.button)];
    case 'double_click':
      return ['mousemove', String(action.x), String(action.y), 'click', '--repeat', '2', '--delay', '80', '1'];
    case 'right_click':
      return ['mousemove', String(action.x), String(action.y), 'click', '3'];
    case 'move':
      return ['mousemove', String(action.x), String(action.y)];
    case 'drag':
      return [
        'mousemove', String(action.x), String(action.y),
        'mousedown', '1',
        'mousemove', String(action.x2), String(action.y2),
        'mouseup', '1',
      ];
    case 'scroll': {
      const args = [];
      if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
        args.push('mousemove', String(action.x), String(action.y));
      }
      const dy = Number.isFinite(action.dy) ? action.dy : 0;
      const dx = Number.isFinite(action.dx) ? action.dx : 0;
      if (dy !== 0) {
        const btn = dy < 0 ? '4' : '5';
        args.push('click', '--repeat', String(Math.min(50, Math.abs(dy))), '--delay', '20', btn);
      } else if (dx !== 0) {
        const btn = dx < 0 ? '6' : '7';
        args.push('click', '--repeat', String(Math.min(50, Math.abs(dx))), '--delay', '20', btn);
      } else {
        const amount = action.amount || 3;
        args.push('click', '--repeat', String(amount), '--delay', '20', scrollButton(action.direction || 'down'));
      }
      return args;
    }
    case 'type':
      return ['type', '--delay', '20', '--', action.text];
    case 'key':
      return ['key', '--', action.key];
    default:
      throw new Error(`unsupported action: ${action.type}`);
  }
}

async function executeAction(action) {
  const args = buildXdotoolArgs(action);
  await runXdotool(args);
  return { ok: true, type: action.type, args };
}

module.exports = {
  DISPLAY,
  buildXdotoolArgs,
  executeAction,
  runXdotool,
};
