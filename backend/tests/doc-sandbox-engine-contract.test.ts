import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_ENGINE_CONTRACT } from '../src/modules/doc-sandbox/engine/contracts';

test('sandbox engine contract keeps the Anthropic messages identity', () => {
  assert.equal(SANDBOX_ENGINE_CONTRACT, 'anthropic-messages');
});
