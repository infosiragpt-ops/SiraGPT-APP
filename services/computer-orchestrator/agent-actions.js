'use strict';

/**
 * Map the live /sessions/:id/agent/action body onto xdotool in the desktop.
 * Types match computer-use-action-mapper.js (click/type/keypress/…).
 */

const KEY_MAP = Object.freeze({
  ENTER: 'Return',
  RETURN: 'Return',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  TAB: 'Tab',
  SPACE: 'space',
  BACKSPACE: 'BackSpace',
  DELETE: 'Delete',
  DEL: 'Delete',
  HOME: 'Home',
  END: 'End',
  PAGEUP: 'Page_Up',
  PAGEDOWN: 'Page_Down',
  UP: 'Up',
  DOWN: 'Down',
  LEFT: 'Left',
  RIGHT: 'Right',
  ARROWUP: 'Up',
  ARROWDOWN: 'Down',
  ARROWLEFT: 'Left',
  ARROWRIGHT: 'Right',
  CTRL: 'ctrl',
  CONTROL: 'ctrl',
  SHIFT: 'shift',
  ALT: 'alt',
  META: 'super',
  CMD: 'super',
  COMMAND: 'super',
});

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\\''`)}'`;
}

function xdoKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return '';
  return KEY_MAP[raw.toUpperCase()] || raw;
}

function actionType(body) {
  return String((body && (body.type || body.action || body.tool)) || '').trim().toLowerCase();
}

function buildActionCommand(body) {
  const action = body && typeof body === 'object' ? body : {};
  const type = actionType(action);
  const x = Number.isFinite(Number(action.x)) ? Math.floor(Number(action.x)) : 0;
  const y = Number.isFinite(Number(action.y)) ? Math.floor(Number(action.y)) : 0;
  const button = String(action.button || 'left').toLowerCase() === 'right' ? 3
    : String(action.button || '').toLowerCase() === 'middle' ? 2 : 1;

  switch (type) {
    case 'click':
      return `xdotool mousemove ${x} ${y} click ${button}`;
    case 'double_click':
      return `xdotool mousemove ${x} ${y} click --repeat 2 --delay 80 ${button}`;
    case 'move':
      return `xdotool mousemove ${x} ${y}`;
    case 'scroll': {
      const dy = Number(action.scrollY || 0);
      const dx = Number(action.scrollX || 0);
      const vert = dy < 0 ? 4 : 5;
      const repeats = Math.min(20, Math.max(1, Math.round(Math.abs(dy || dx) / 80) || 3));
      return `xdotool mousemove ${x} ${y} click --repeat ${repeats} ${vert}`;
    }
    case 'type':
      return `xdotool type --delay 12 -- ${shellQuote(action.text || '')}`;
    case 'keypress': {
      const keys = (Array.isArray(action.keys) ? action.keys : [action.key, action.text])
        .map(xdoKey)
        .filter(Boolean);
      if (!keys.length) return 'true';
      return `xdotool key ${keys.map(shellQuote).join(' ')}`;
    }
    case 'drag': {
      const path = Array.isArray(action.path) ? action.path : [];
      if (path.length < 2) return 'true';
      const pts = path.map((p) => {
        if (Array.isArray(p)) return [Math.floor(Number(p[0]) || 0), Math.floor(Number(p[1]) || 0)];
        return [Math.floor(Number(p && p.x) || 0), Math.floor(Number(p && p.y) || 0)];
      });
      const [sx, sy] = pts[0];
      const moves = pts.slice(1).map(([px, py]) => `xdotool mousemove ${px} ${py}`).join(' && ');
      return `xdotool mousemove ${sx} ${sy} mousedown 1 && ${moves} && xdotool mouseup 1`;
    }
    case 'wait':
      return 'sleep 0.4';
    case 'screenshot':
      return 'import -window root -silent png:- | base64 -w0';
    default:
      return null;
  }
}

function screenshotCommand() {
  return 'import -window root -silent png:- | base64 -w0';
}

module.exports = {
  actionType,
  buildActionCommand,
  screenshotCommand,
  xdoKey,
};
