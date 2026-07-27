'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildScientificFederatedSearchSkill } = require('../src/services/agents/hermes-plugin-bridge');

test('hermes-web publishes a bounded federated scientific search skill', async () => {
  const skill = buildScientificFederatedSearchSkill();
  assert.equal(skill.id, 'scientific_federated_search');
  assert.deepEqual(skill.capabilities, ['net:outbound']);
  assert.equal(typeof skill.execute, 'function');
  assert.equal(skill.params.properties.providers.items.enum.length, 16);
  assert.ok(skill.timeoutMs >= 20000);

  const empty = await skill.execute({ query: '' });
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.papers, []);
  assert.match(empty.errors[0].message, /empty/);
});
