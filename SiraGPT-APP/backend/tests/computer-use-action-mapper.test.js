'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  SUPPORTED_COMPUTER_ACTIONS,
  getActionLabel,
  normalizeDragPath,
  normalizeKey,
} = require('../src/services/computer-use-action-mapper');

describe('normalizeKey', () => {
  test('maps CMD (case-insensitive) to Meta', () => {
    assert.equal(normalizeKey('cmd'), 'Meta');
    assert.equal(normalizeKey('CMD'), 'Meta');
    assert.equal(normalizeKey('Cmd'), 'Meta');
  });

  test('maps ESC to Escape', () => {
    assert.equal(normalizeKey('ESC'), 'Escape');
    assert.equal(normalizeKey('esc'), 'Escape');
  });

  test('maps arrow aliases to Arrow* keys', () => {
    assert.equal(normalizeKey('up'), 'ArrowUp');
    assert.equal(normalizeKey('down'), 'ArrowDown');
    assert.equal(normalizeKey('left'), 'ArrowLeft');
    assert.equal(normalizeKey('right'), 'ArrowRight');
    assert.equal(normalizeKey('arrowup'), 'ArrowUp');
  });

  test('maps named keys per KEY_MAP table', () => {
    assert.equal(normalizeKey('enter'), 'Enter');
    assert.equal(normalizeKey('return'), 'Enter');
    assert.equal(normalizeKey('escape'), 'Escape');
    assert.equal(normalizeKey('tab'), 'Tab');
    assert.equal(normalizeKey('space'), ' ');
    assert.equal(normalizeKey('backspace'), 'Backspace');
    assert.equal(normalizeKey('delete'), 'Delete');
    assert.equal(normalizeKey('del'), 'Delete');
    assert.equal(normalizeKey('home'), 'Home');
    assert.equal(normalizeKey('end'), 'End');
    assert.equal(normalizeKey('pageup'), 'PageUp');
    assert.equal(normalizeKey('pagedown'), 'PageDown');
    assert.equal(normalizeKey('ctrl'), 'Control');
    assert.equal(normalizeKey('control'), 'Control');
    assert.equal(normalizeKey('shift'), 'Shift');
    assert.equal(normalizeKey('option'), 'Alt');
    assert.equal(normalizeKey('alt'), 'Alt');
    assert.equal(normalizeKey('meta'), 'Meta');
    assert.equal(normalizeKey('command'), 'Meta');
  });

  test('returns unknown single-char key unchanged', () => {
    assert.equal(normalizeKey('a'), 'a');
  });

  test('returns the trimmed raw value for an unknown multi-char key', () => {
    // Unknown keys fall through to `|| raw`, where raw is the trimmed original
    // (NOT upper-cased).
    assert.equal(normalizeKey('  Foo  '), 'Foo');
    assert.equal(normalizeKey('F5'), 'F5');
  });

  test('returns empty string for empty input', () => {
    assert.equal(normalizeKey(''), '');
  });

  test('coerces nullish/non-string input to empty string', () => {
    assert.equal(normalizeKey(null), '');
    assert.equal(normalizeKey(undefined), '');
  });

  test('trims surrounding whitespace before mapping', () => {
    assert.equal(normalizeKey('  cmd  '), 'Meta');
  });
});

describe('normalizeDragPath', () => {
  test('normalizes a mix of [x,y] arrays and {x,y} objects', () => {
    const result = normalizeDragPath([[1, 2], { x: 3, y: 4 }]);
    assert.deepEqual(result, [[1, 2], [3, 4]]);
  });

  test('coerces string coordinates to numbers', () => {
    const result = normalizeDragPath([['5', '6'], { x: '7', y: '8' }]);
    assert.deepEqual(result, [[5, 6], [7, 8]]);
  });

  test('keeps only the first two elements of longer arrays', () => {
    const result = normalizeDragPath([[10, 20, 99]]);
    assert.deepEqual(result, [[10, 20]]);
  });

  test('returns an empty array for an empty path', () => {
    assert.deepEqual(normalizeDragPath([]), []);
  });

  test('throws when path is not an array', () => {
    assert.throws(() => normalizeDragPath('nope'), {
      message: 'drag action requires a path array',
    });
    assert.throws(() => normalizeDragPath(null), {
      message: 'drag action requires a path array',
    });
    assert.throws(() => normalizeDragPath({ x: 1, y: 2 }), {
      message: 'drag action requires a path array',
    });
  });

  test('throws on a malformed array entry (too short)', () => {
    assert.throws(() => normalizeDragPath([[1]]), {
      message: 'drag path entries must be coordinate pairs or {x, y} objects',
    });
  });

  test('throws on an object entry missing x or y', () => {
    assert.throws(() => normalizeDragPath([{ x: 1 }]), {
      message: 'drag path entries must be coordinate pairs or {x, y} objects',
    });
    assert.throws(() => normalizeDragPath([{ y: 2 }]), {
      message: 'drag path entries must be coordinate pairs or {x, y} objects',
    });
  });

  test('throws on a primitive entry', () => {
    assert.throws(() => normalizeDragPath([42]), {
      message: 'drag path entries must be coordinate pairs or {x, y} objects',
    });
    assert.throws(() => normalizeDragPath([null]), {
      message: 'drag path entries must be coordinate pairs or {x, y} objects',
    });
  });
});

describe('getActionLabel', () => {
  test('returns "unknown" for falsy action or missing type', () => {
    assert.equal(getActionLabel(null), 'unknown');
    assert.equal(getActionLabel(undefined), 'unknown');
    assert.equal(getActionLabel({}), 'unknown');
    assert.equal(getActionLabel({ type: '' }), 'unknown');
  });

  test('labels click with default left button', () => {
    assert.equal(getActionLabel({ type: 'click', x: 5, y: 6 }), 'click left @ 5,6');
  });

  test('labels click with an explicit button', () => {
    assert.equal(
      getActionLabel({ type: 'click', button: 'right', x: 1, y: 2 }),
      'click right @ 1,2',
    );
  });

  test('labels double_click', () => {
    assert.equal(getActionLabel({ type: 'double_click', x: 7, y: 8 }), 'double click @ 7,8');
  });

  test('labels scroll with provided and defaulted deltas', () => {
    assert.equal(
      getActionLabel({ type: 'scroll', scrollX: 10, scrollY: 20 }),
      'scroll 10,20',
    );
    assert.equal(getActionLabel({ type: 'scroll' }), 'scroll 0,0');
  });

  test('labels type with character count', () => {
    assert.equal(getActionLabel({ type: 'type', text: 'hello' }), 'type 5 chars');
    assert.equal(getActionLabel({ type: 'type' }), 'type 0 chars');
  });

  test('labels keypress with joined keys', () => {
    assert.equal(
      getActionLabel({ type: 'keypress', keys: ['Control', 'c'] }),
      'keypress Control+c',
    );
    assert.equal(getActionLabel({ type: 'keypress' }), 'keypress ');
  });

  test('labels drag with point count', () => {
    assert.equal(
      getActionLabel({ type: 'drag', path: [[0, 0], [1, 1], [2, 2]] }),
      'drag 3 points',
    );
    assert.equal(getActionLabel({ type: 'drag' }), 'drag 0 points');
  });

  test('labels move', () => {
    assert.equal(getActionLabel({ type: 'move', x: 3, y: 4 }), 'move @ 3,4');
  });

  test('labels wait and screenshot as static strings', () => {
    assert.equal(getActionLabel({ type: 'wait' }), 'wait');
    assert.equal(getActionLabel({ type: 'screenshot' }), 'screenshot');
  });

  test('falls back to the raw type for an unknown action type', () => {
    assert.equal(getActionLabel({ type: 'frobnicate' }), 'frobnicate');
  });
});

describe('SUPPORTED_COMPUTER_ACTIONS', () => {
  test('is frozen', () => {
    assert.equal(Object.isFrozen(SUPPORTED_COMPUTER_ACTIONS), true);
  });

  test('contains exactly the expected actions in order', () => {
    assert.deepEqual(SUPPORTED_COMPUTER_ACTIONS, [
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
  });

  test('mutation attempts do not change the array', () => {
    const before = SUPPORTED_COMPUTER_ACTIONS.length;
    try {
      SUPPORTED_COMPUTER_ACTIONS.push('hack');
    } catch {
      // strict mode throws; either way the array is unchanged
    }
    assert.equal(SUPPORTED_COMPUTER_ACTIONS.length, before);
    assert.equal(SUPPORTED_COMPUTER_ACTIONS.includes('hack'), false);
  });
});
