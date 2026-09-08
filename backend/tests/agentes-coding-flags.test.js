'use strict';

/**
 * AGENTES_CODING_V2 flag contract (docs/agentes-arquitectura.md §Despliegue).
 * Off by default; only 1/true/on enable. Same shape as CODEX_AGENT_V2.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { isAgentesCodingV2Enabled } = require('../src/services/agentes-coding/flags');

afterEach(() => { delete process.env.AGENTES_CODING_V2; });

test('flag is off by default and rejects junk', () => {
  delete process.env.AGENTES_CODING_V2;
  assert.equal(isAgentesCodingV2Enabled(), false);
  for (const v of ['', '0', 'false', 'off', 'no', '2', 'enabled']) {
    assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: v }), false, JSON.stringify(v));
  }
});

test('flag enables on 1/true/on (case-insensitive, trimmed)', () => {
  for (const v of ['1', 'true', 'on', 'TRUE', ' On ']) {
    assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: v }), true, JSON.stringify(v));
  }
  process.env.AGENTES_CODING_V2 = '1';
  assert.equal(isAgentesCodingV2Enabled(), true);
});
