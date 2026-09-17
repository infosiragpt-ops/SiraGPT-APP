'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validateRecoveryEvidence } = require('./install-runtime-rollback.cjs');
const evidence = { configuration: { originalHash: 'absent', candidateHash: 'a'.repeat(64) }, configurationWrite: {
  configurationHash: 'a'.repeat(64), backup: '/etc/docker/.siragpt-runtime-' + 'b'.repeat(24) + '.backup',
  backupSha256: createHash('sha256').update('absent\n').digest('hex') } };
test('recovery accepts only proof of an originally absent config', () => validateRecoveryEvidence(evidence));
test('recovery refuses pre-existing configuration, changed hashes and arbitrary backup paths', () => {
  for (const bad of [null, {}, { ...evidence, configuration: { ...evidence.configuration, originalHash: 'c'.repeat(64) } },
    { ...evidence, configurationWrite: { ...evidence.configurationWrite, configurationHash: 'd'.repeat(64) } },
    { ...evidence, configurationWrite: { ...evidence.configurationWrite, backup: '/etc/docker/daemon.json' } },
    { ...evidence, configurationWrite: { ...evidence.configurationWrite, backupSha256: 'e'.repeat(64) } }]) {
    assert.throws(() => validateRecoveryEvidence(bad), /invalid_recovery/);
  }
});
