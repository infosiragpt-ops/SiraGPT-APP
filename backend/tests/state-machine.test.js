'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createMachine, MachineError } = require('../src/utils/state-machine');

const trafficLight = {
  initial: 'red',
  states: {
    red:    { on: { TICK: 'green' } },
    green:  { on: { TICK: 'yellow' } },
    yellow: { on: { TICK: 'red' } },
  },
};

describe('createMachine — construction', () => {
  test('rejects bad shape', () => {
    assert.throws(() => createMachine(null), MachineError);
    assert.throws(() => createMachine({}), MachineError);
    assert.throws(() => createMachine({ initial: 'x' }), MachineError);
    assert.throws(() => createMachine({ initial: 'x', states: { y: {} } }), MachineError);
  });

  test('starts in initial state with empty context', () => {
    const m = createMachine(trafficLight);
    assert.equal(m.value, 'red');
    assert.deepEqual(m.context, {});
  });
});

describe('send — transitions', () => {
  test('walks the cycle', () => {
    let m = createMachine(trafficLight);
    m = m.send('TICK'); assert.equal(m.value, 'green');
    m = m.send('TICK'); assert.equal(m.value, 'yellow');
    m = m.send('TICK'); assert.equal(m.value, 'red');
  });

  test('value semantics: send returns NEW machine', () => {
    const a = createMachine(trafficLight);
    const b = a.send('TICK');
    assert.notEqual(a, b);
    assert.equal(a.value, 'red');
    assert.equal(b.value, 'green');
  });

  test('unknown event leaves state, returns errors hint', () => {
    const m = createMachine(trafficLight);
    const r = m.send('NOPE');
    assert.equal(r.value, 'red');
    assert.equal(r.errors[0].code, 'NO_TRANSITION');
  });

  test('can() reflects available transitions', () => {
    const m = createMachine(trafficLight);
    assert.equal(m.can('TICK'), true);
    assert.equal(m.can('NOPE'), false);
  });
});

describe('guards', () => {
  const def = {
    initial: 'idle',
    context: { tries: 0 },
    states: {
      idle: { on: { GO: { target: 'busy', guard: (ctx) => ctx.tries < 3 } } },
      busy: { on: {
        DONE: 'idle',
        FAIL: { target: 'idle', assign: (ctx) => ({ tries: ctx.tries + 1 }) },
      } },
    },
  };

  test('guard true allows transition', () => {
    const m = createMachine(def).send('GO');
    assert.equal(m.value, 'busy');
  });

  test('guard false denies, surfaces GUARD_DENIED', () => {
    let m = createMachine(def);
    m = m.send('GO').send('FAIL');
    m = m.send('GO').send('FAIL');
    m = m.send('GO').send('FAIL'); // tries now 3
    const r = m.send('GO');
    assert.equal(r.value, 'idle');
    assert.equal(r.errors[0].code, 'GUARD_DENIED');
  });

  test('throwing guard surfaces GUARD_THREW + denies', () => {
    const m = createMachine({
      initial: 'a',
      states: { a: { on: { X: { target: 'b', guard: () => { throw new Error('bad'); } } } }, b: {} },
    });
    const r = m.send('X');
    assert.equal(r.value, 'a');
    const codes = r.errors.map((e) => e.code);
    assert.ok(codes.includes('GUARD_THREW'));
    assert.ok(codes.includes('GUARD_DENIED'));
  });
});

describe('assign + actions', () => {
  test('assign merges partial context', () => {
    const def = {
      initial: 'a',
      context: { x: 1 },
      states: { a: { on: { ADD: { target: 'a', assign: (c, e) => ({ x: c.x + e.payload }) } } } },
    };
    const m = createMachine(def).send('ADD', 5);
    assert.equal(m.context.x, 6);
  });

  test('actions called with (ctx, event); throwing surfaces ACTION_THREW', () => {
    const seen = [];
    const def = {
      initial: 'a',
      states: { a: { on: { X: {
        target: 'a',
        actions: [
          (c, e) => seen.push({ ctx: c, ev: e.type }),
          () => { throw new Error('side bad'); },
        ],
      } } } },
    };
    const r = createMachine(def).send('X');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ev, 'X');
    assert.ok(r.errors && r.errors[0].code === 'ACTION_THREW');
  });
});

describe('matches + frozen state', () => {
  test('matches checks state name', () => {
    const m = createMachine(trafficLight);
    assert.equal(m.matches('red'), true);
    assert.equal(m.matches('green'), false);
  });

  test('context object is frozen on snapshot', () => {
    const m = createMachine({ initial: 'a', context: { x: 1 }, states: { a: {} } });
    assert.throws(() => { m.context.x = 2; }, TypeError);
  });
});

describe('bad target detection', () => {
  test('transition pointing at unknown target throws on send', () => {
    const m = createMachine({
      initial: 'a',
      states: { a: { on: { X: 'b' } } }, // no 'b' state
    });
    assert.throws(() => m.send('X'), MachineError);
  });
});
