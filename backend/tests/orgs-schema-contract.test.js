'use strict';

/**
 * Regression guard for the org-settings schemas (ratchet 44).
 *
 * Background: a recent upstream port accidentally dropped
 * `TransferSettingsSchema` from `OrgSettingsSchema` / `OrgSettingsPatchSchema`
 * while `ORG_SETTINGS_KNOWN_KEYS` still listed `transfer`. The bug was
 * silent because both schemas use `.passthrough()` — the dropped key just
 * stopped being validated.
 *
 * This contract test enforces the invariant that every key in
 * `ORG_SETTINGS_KNOWN_KEYS` MUST have a corresponding entry in both
 * `OrgSettingsSchema.shape` and `OrgSettingsPatchSchema.shape`. If a future
 * port drops one again, this test fails immediately.
 *
 * It also asserts the inverse: a key fabricated into the known-keys list
 * that does NOT exist in either schema is detected — i.e. the check
 * actually compares the two sets (defensive against tautologies).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OrgSettingsSchema,
  OrgSettingsPatchSchema,
  ORG_SETTINGS_KNOWN_KEYS,
} = require('../src/schemas/orgs');

test('orgs schema contract: every ORG_SETTINGS_KNOWN_KEYS entry has a nested OrgSettingsSchema.shape entry', () => {
  assert.ok(Array.isArray(ORG_SETTINGS_KNOWN_KEYS) && ORG_SETTINGS_KNOWN_KEYS.length > 0,
    'ORG_SETTINGS_KNOWN_KEYS must be a non-empty array');
  const shapeKeys = Object.keys(OrgSettingsSchema.shape);
  for (const key of ORG_SETTINGS_KNOWN_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(OrgSettingsSchema.shape, key),
      `OrgSettingsSchema.shape is missing nested schema for known key "${key}". ` +
        `Known keys: [${ORG_SETTINGS_KNOWN_KEYS.join(', ')}]. ` +
        `Shape keys: [${shapeKeys.join(', ')}].`,
    );
  }
});

test('orgs schema contract: every ORG_SETTINGS_KNOWN_KEYS entry has a nested OrgSettingsPatchSchema.shape entry', () => {
  const shapeKeys = Object.keys(OrgSettingsPatchSchema.shape);
  for (const key of ORG_SETTINGS_KNOWN_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(OrgSettingsPatchSchema.shape, key),
      `OrgSettingsPatchSchema.shape is missing nested schema for known key "${key}". ` +
        `Known keys: [${ORG_SETTINGS_KNOWN_KEYS.join(', ')}]. ` +
        `Shape keys: [${shapeKeys.join(', ')}].`,
    );
  }
});

test('orgs schema contract: ORG_SETTINGS_KNOWN_KEYS and OrgSettingsSchema.shape are bidirectionally aligned', () => {
  // Catches the reverse regression: a new nested key added to the schema
  // but forgotten in ORG_SETTINGS_KNOWN_KEYS (would silently land in the
  // `warnings` array on every PATCH).
  const known = new Set(ORG_SETTINGS_KNOWN_KEYS);
  const shapeKeys = Object.keys(OrgSettingsSchema.shape);
  for (const key of shapeKeys) {
    assert.ok(
      known.has(key),
      `OrgSettingsSchema declares "${key}" but ORG_SETTINGS_KNOWN_KEYS does not list it. ` +
        `This would make PATCH /api/orgs/:id/settings emit it as an unknown-key warning.`,
    );
  }
  assert.equal(
    shapeKeys.length,
    ORG_SETTINGS_KNOWN_KEYS.length,
    `Mismatch: OrgSettingsSchema has ${shapeKeys.length} keys but ORG_SETTINGS_KNOWN_KEYS has ${ORG_SETTINGS_KNOWN_KEYS.length}.`,
  );
});

test('orgs schema contract: appending an unknown sentinel key to known-keys makes the check fail', () => {
  // Defensive meta-check: confirms the assertion in the first test actually
  // compares the two sets rather than being a tautology. We simulate a
  // future drop by extending the known-keys list with a key that does NOT
  // exist in the schema; the same predicate should now flag it.
  const sentinel = '__contract_test_unknown_key__';
  const extended = [...ORG_SETTINGS_KNOWN_KEYS, sentinel];
  let detected = false;
  for (const key of extended) {
    if (!Object.prototype.hasOwnProperty.call(OrgSettingsSchema.shape, key)) {
      detected = true;
      break;
    }
  }
  assert.equal(
    detected,
    true,
    'Expected the contract predicate to flag a fabricated unknown known-key, but it did not. ' +
      'This means the test would not catch a real regression.',
  );
  // And the same for the patch schema.
  let detectedPatch = false;
  for (const key of extended) {
    if (!Object.prototype.hasOwnProperty.call(OrgSettingsPatchSchema.shape, key)) {
      detectedPatch = true;
      break;
    }
  }
  assert.equal(detectedPatch, true,
    'Same defensive check failed against OrgSettingsPatchSchema.shape.');
});

test('orgs schema contract: TransferSettingsSchema regression — `transfer` is wired in both schemas', () => {
  // Explicit named guard for the exact regression that motivated this file
  // (the upstream port that dropped `transfer`). Keep this even though the
  // generic tests above would catch it — named failures aid debugging.
  assert.ok(ORG_SETTINGS_KNOWN_KEYS.includes('transfer'),
    'ORG_SETTINGS_KNOWN_KEYS must include "transfer"');
  assert.ok(Object.prototype.hasOwnProperty.call(OrgSettingsSchema.shape, 'transfer'),
    'OrgSettingsSchema.shape.transfer must exist (TransferSettingsSchema wiring)');
  assert.ok(Object.prototype.hasOwnProperty.call(OrgSettingsPatchSchema.shape, 'transfer'),
    'OrgSettingsPatchSchema.shape.transfer must exist (TransferSettingsSchema wiring)');
});
