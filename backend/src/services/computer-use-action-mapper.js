'use strict';

const SUPPORTED_COMPUTER_ACTIONS = Object.freeze([
  'click',
  'double_click',
  'scroll',
  'type',
  'wait',
  'keypress',
  'drag',
  'move',
  'screenshot',
]);

const KEY_MAP = Object.freeze({
  ENTER: 'Enter',
  RETURN: 'Enter',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  TAB: 'Tab',
  SPACE: ' ',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',
  DEL: 'Delete',
  HOME: 'Home',
  END: 'End',
  PAGEUP: 'PageUp',
  PAGEDOWN: 'PageDown',
  UP: 'ArrowUp',
  DOWN: 'ArrowDown',
  LEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight',
  ARROWUP: 'ArrowUp',
  ARROWDOWN: 'ArrowDown',
  ARROWLEFT: 'ArrowLeft',
  ARROWRIGHT: 'ArrowRight',
  CTRL: 'Control',
  CONTROL: 'Control',
  SHIFT: 'Shift',
  OPTION: 'Alt',
  ALT: 'Alt',
  META: 'Meta',
  CMD: 'Meta',
  COMMAND: 'Meta',
});

function normalizeKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return raw;
  return KEY_MAP[raw.toUpperCase()] || raw;
}

function normalizeDragPath(path) {
  if (!Array.isArray(path)) {
    throw new Error('drag action requires a path array');
  }

  return path.map((point) => {
    if (Array.isArray(point) && point.length >= 2) {
      return [Number(point[0]), Number(point[1])];
    }
    if (point && typeof point === 'object' && 'x' in point && 'y' in point) {
      return [Number(point.x), Number(point.y)];
    }
    throw new Error('drag path entries must be coordinate pairs or {x, y} objects');
  });
}

async function withModifiers(page, keys, callback) {
  const normalizedKeys = (keys || []).map(normalizeKey).filter(Boolean);
  const pressed = [];

  try {
    for (const key of normalizedKeys) {
      await page.keyboard.down(key);
      pressed.push(key);
    }
    return await callback();
  } finally {
    for (const key of pressed.reverse()) {
      await page.keyboard.up(key).catch(() => {});
    }
  }
}

function getActionLabel(action) {
  if (!action || !action.type) return 'unknown';
  switch (action.type) {
    case 'click':
      return `click ${action.button || 'left'} @ ${action.x},${action.y}`;
    case 'double_click':
      return `double click @ ${action.x},${action.y}`;
    case 'scroll':
      return `scroll ${action.scrollX || 0},${action.scrollY || 0}`;
    case 'type':
      return `type ${String(action.text || '').length} chars`;
    case 'keypress':
      return `keypress ${(action.keys || []).join('+')}`;
    case 'drag':
      return `drag ${(action.path || []).length} points`;
    case 'move':
      return `move @ ${action.x},${action.y}`;
    case 'wait':
      return 'wait';
    case 'screenshot':
      return 'screenshot';
    default:
      return action.type;
  }
}

async function executePlaywrightComputerActions(page, actions, options = {}) {
  const list = Array.isArray(actions) ? actions : [actions].filter(Boolean);
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 1200;

  for (const action of list) {
    if (!action || typeof action !== 'object') continue;
    options.onAction?.(action);

    switch (action.type) {
      case 'click':
        await withModifiers(page, action.keys, async () => {
          await page.mouse.click(Number(action.x), Number(action.y), {
            button: action.button || 'left',
          });
        });
        break;

      case 'double_click':
        await withModifiers(page, action.keys, async () => {
          await page.mouse.dblclick(Number(action.x), Number(action.y), {
            button: action.button || 'left',
          });
        });
        break;

      case 'drag': {
        const path = normalizeDragPath(action.path);
        if (path.length < 2) {
          throw new Error('drag action requires at least two path points');
        }
        await withModifiers(page, action.keys, async () => {
          const [[startX, startY], ...rest] = path;
          await page.mouse.move(startX, startY);
          await page.mouse.down();
          for (const [x, y] of rest) {
            await page.mouse.move(x, y);
          }
          await page.mouse.up();
        });
        break;
      }

      case 'move':
        await withModifiers(page, action.keys, async () => {
          await page.mouse.move(Number(action.x), Number(action.y));
        });
        break;

      case 'scroll':
        await withModifiers(page, action.keys, async () => {
          await page.mouse.move(Number(action.x || 0), Number(action.y || 0));
          await page.mouse.wheel(Number(action.scrollX || 0), Number(action.scrollY || 0));
        });
        break;

      case 'keypress':
        for (const key of action.keys || []) {
          await page.keyboard.press(normalizeKey(key));
        }
        break;

      case 'type':
        await page.keyboard.type(String(action.text || ''));
        break;

      case 'wait':
        await page.waitForTimeout(Number(action.ms || waitMs));
        break;

      case 'screenshot':
        break;

      default:
        throw new Error(`Unsupported computer action: ${action.type}`);
    }
  }
}

module.exports = {
  SUPPORTED_COMPUTER_ACTIONS,
  executePlaywrightComputerActions,
  getActionLabel,
  normalizeDragPath,
  normalizeKey,
  withModifiers,
};
