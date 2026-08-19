/**
 * Tests for services/skills/capabilities.js — capability vocabulary.
 *
 * The whole point of this module is to fail loudly when a skill
 * manifest mistypes a capability. So we verify the strict checks AND
 * pin the exact set so a future rename or removal is a deliberate
 * commit that updates this test too.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  CAPABILITIES,
  ALL_CAPABILITIES,
  isKnown,
  assertKnown,
} = require('../src/services/skills/capabilities');

describe('CAPABILITIES enum', () => {
  it('pins the exact capability set', () => {
    assert.deepEqual({ ...CAPABILITIES }, {
      FS_READ: 'fs:read',
      FS_WRITE: 'fs:write',
      NET_OUTBOUND: 'net:outbound',
      NET_LLM: 'net:outbound:llm',
      BROWSER: 'browser',
      MEDIA_PROCESS: 'media:process',
      SCHEDULE: 'schedule',
      AGENT_SPAWN: 'agent:spawn',
      AGENT_READ: 'agent:read',
      SHELL: 'shell',
      LLM: 'llm:call',
    });
  });

  it('is frozen (cannot be mutated at runtime)', () => {
    assert.throws(() => { CAPABILITIES.NEW = 'evil'; }, TypeError);
  });
});

describe('ALL_CAPABILITIES', () => {
  it('contains every value from CAPABILITIES', () => {
    const expectedValues = Object.values(CAPABILITIES);
    assert.deepEqual([...ALL_CAPABILITIES].sort(), expectedValues.sort());
  });

  it('is frozen', () => {
    assert.throws(() => ALL_CAPABILITIES.push('hack'), TypeError);
  });

  it('has exactly 11 capabilities (catches accidental additions)', () => {
    assert.equal(ALL_CAPABILITIES.length, 11);
  });
});

describe('isKnown', () => {
  it('returns true for every defined capability', () => {
    for (const cap of ALL_CAPABILITIES) {
      assert.equal(isKnown(cap), true, `expected ${cap} to be known`);
    }
  });

  it('returns false for unknown strings', () => {
    assert.equal(isKnown('made-up-cap'), false);
    assert.equal(isKnown('fs:execute'), false);
    assert.equal(isKnown(''), false);
  });

  it('is case-sensitive (capabilities are lowercase)', () => {
    assert.equal(isKnown('FS:READ'), false);
    assert.equal(isKnown('Fs:Read'), false);
  });

  it('returns false for non-string inputs', () => {
    assert.equal(isKnown(null), false);
    assert.equal(isKnown(undefined), false);
    assert.equal(isKnown(42), false);
    assert.equal(isKnown({}), false);
  });
});

describe('assertKnown', () => {
  it('passes silently for an array of known caps', () => {
    assert.doesNotThrow(() => assertKnown(['fs:read', 'net:outbound'], 'manifest:test'));
  });

  it('passes on an empty array (pure-compute skill is valid)', () => {
    assert.doesNotThrow(() => assertKnown([], 'manifest:pure-compute'));
  });

  it('throws with the "where" label on a non-array input', () => {
    assert.throws(
      () => assertKnown('fs:read', 'manifest:bad'),
      /manifest:bad: capabilities must be an array/,
    );
    assert.throws(
      () => assertKnown(null, 'manifest:nullcaps'),
      /manifest:nullcaps: capabilities must be an array/,
    );
  });

  it('throws on the first unknown capability with a helpful message', () => {
    assert.throws(
      () => assertKnown(['fs:read', 'fs:nuke'], 'skill:my-skill'),
      /skill:my-skill: unknown capability "fs:nuke"/,
    );
  });

  it('error message hints where to add the new capability', () => {
    try {
      assertKnown(['typo:cap'], 'skill:test');
      assert.fail('expected throw');
    } catch (e) {
      assert.match(e.message, /Add to services\/skills\/capabilities\.js or fix the typo/);
    }
  });

  it('checks every item — first unknown wins, rest do not matter for the message', () => {
    // The check order is insertion order; first failure surfaces.
    assert.throws(
      () => assertKnown(['fs:read', 'first-bad', 'second-bad'], 'skill:x'),
      /unknown capability "first-bad"/,
    );
  });
});
