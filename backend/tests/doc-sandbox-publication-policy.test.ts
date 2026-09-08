import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredDocumentModelTier, isPublishedDocumentModel } from '../src/modules/doc-sandbox/model-policy';

// Catalog publication facts are input data; no database/catalog client is simulated.
const models = { mechanical: { id: 'chosen-sonnet' }, academic: { id: 'chosen-opus' } };
const published = { name: 'chosen-sonnet', isActive: true, type: 'TEXT', provider: 'Anthropic' };
test('configuration requires exact model names and unique tier assignment, not aliases or price fallback', () => {
  assert.equal(configuredDocumentModelTier(models, 'chosen-sonnet'), 'mechanical'); assert.equal(configuredDocumentModelTier(models, 'chosen-opus'), 'academic');
  for (const name of ['', ' chosen-sonnet', 'chosen-sonnet ', 'CHOSEN-SONNET', 'anthropic/chosen-sonnet', 'other', 'x'.repeat(201)]) assert.equal(configuredDocumentModelTier(models, name), null);
  assert.equal(configuredDocumentModelTier({ ...models, academic: models.mechanical }, 'chosen-sonnet'), null);
  assert.equal(configuredDocumentModelTier({ ...models, academic: { ...models.academic, id: 'x'.repeat(200) } }, 'x'.repeat(200)), 'academic');
});
test('publication accepts any exact active TEXT catalog row, including non-Anthropic picker models', () => {
  assert.equal(isPublishedDocumentModel(published, 'chosen-sonnet'), true);
  assert.equal(isPublishedDocumentModel({ ...published, provider: 'Meta' }, 'chosen-sonnet'), true);
  assert.equal(isPublishedDocumentModel({ name: 'muse-spark-1.3-contributor', isActive: true, type: 'TEXT', provider: 'Meta' }, 'muse-spark-1.3-contributor'), true);
  for (const row of [null, { ...published, isActive: false }, { ...published, name: 'different' }, { ...published, type: 'IMAGE' },
    { ...published, type: 'text' }]) {
    assert.equal(isPublishedDocumentModel(row, 'chosen-sonnet'), false);
  }
});
