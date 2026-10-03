'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isAgentesCodingV2Enabled,
  FLAG,
} = require('../src/services/agentes-coding/flags');

test('flag name is AGENTES_CODING_V2', () => {
  assert.equal(FLAG, 'AGENTES_CODING_V2');
});

test('disabled by default (empty env) including production', () => {
  assert.equal(isAgentesCodingV2Enabled({}), false);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: '' }), false);
  assert.equal(isAgentesCodingV2Enabled({ NODE_ENV: 'production' }), false);
  assert.equal(
    isAgentesCodingV2Enabled({ NODE_ENV: 'production', AGENTES_CODING_V2: '' }),
    false,
  );
});

test('enabled with 1 / true / on (case-insensitive, trimmed)', () => {
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: '1' }), true);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: 'true' }), true);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: ' ON ' }), true);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: 'TRUE' }), true);
  process.env.AGENTES_CODING_V2 = '1';
  assert.equal(isAgentesCodingV2Enabled(), true);
  delete process.env.AGENTES_CODING_V2;
});

test('disabled with 0 / false / off / garbage', () => {
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: '0' }), false);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: 'false' }), false);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: 'off' }), false);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: 'yes please' }), false);
  for (const v of ['no', '2', 'enabled']) {
    assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: v }), false, JSON.stringify(v));
  }
});
