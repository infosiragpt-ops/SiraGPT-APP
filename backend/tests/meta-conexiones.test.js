'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  inferProviderFromModelId,
  listKnownProviders,
} = require('../src/services/ai/provider-inference');

const root = path.join(__dirname, '..');
const aiRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'ai.js'), 'utf8');
const firstPartyClients = fs.readFileSync(path.join(root, 'src', 'services', 'ai', 'first-party-chat-clients.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'src', 'services', 'admin-connections-bridge.js'), 'utf8');
const connectionsRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'admin-connections.js'), 'utf8');

test('admin connections treat meta as a first-class provider key', () => {
  assert.match(connectionsRoute, /'meta'/);
  assert.match(connectionsRoute, /meta: 'Meta Model API'/);
});

test('connections bridge maps Meta to MODEL_API_KEY and probes api.meta.ai', () => {
  assert.match(bridge, /meta: 'MODEL_API_KEY'/);
  assert.match(bridge, /meta: 'Meta'/);
  assert.match(bridge, /https:\/\/api\.meta\.ai\/v1\/models/);
  assert.match(bridge, /META_API_KEY/);
  assert.match(bridge, /LLAMA_API_KEY/);
});

test('createProviderClient can point at Meta Model API', () => {
  assert.match(aiRoute, /provider === "Meta"/);
  assert.match(aiRoute, /https:\/\/api\.meta\.ai\/v1/);
  assert.match(aiRoute, /MODEL_API_KEY/);
});

test('createProviderClient also honors Groq / Mistral / xAI keys from Connections', () => {
  assert.match(aiRoute, /provider === "Groq"/);
  assert.match(aiRoute, /https:\/\/api\.groq\.com\/openai\/v1/);
  assert.match(aiRoute, /provider === "Mistral"/);
  assert.match(aiRoute, /https:\/\/api\.mistral\.ai\/v1/);
  assert.match(aiRoute, /provider === "xAI"/);
  assert.match(aiRoute, /createXaiClient/);
  // Native xAI URL lives in the first-party client, not inlined in ai.js.
  assert.match(firstPartyClients, /https:\/\/api\.x\.ai\/v1/);
});

test('inferProviderFromModelId: Meta Muse Spark / Llama 4 vs Cerebras llama-3 and OpenRouter', () => {
  assert.equal(inferProviderFromModelId('muse-spark-1.2'), 'Meta');
  assert.equal(inferProviderFromModelId('muse-spark-1.1'), 'Meta');
  assert.equal(inferProviderFromModelId('muse-spark-1.2-contributor'), 'Meta');
  assert.equal(inferProviderFromModelId('muse-image-1.0'), 'Meta');
  assert.equal(inferProviderFromModelId('llama-4-maverick'), 'Meta');
  assert.equal(inferProviderFromModelId('llama-3.1-8b'), 'Cerebras');
  assert.equal(inferProviderFromModelId('llama-3.3-70b-versatile'), 'Groq');
  assert.equal(inferProviderFromModelId('meta-llama/llama-3.3-70b'), 'OpenRouter');
});

test('inferProviderFromModelId: grok ids including x-ai slugs go to xAI', () => {
  assert.equal(inferProviderFromModelId('grok-4'), 'xAI');
  assert.equal(inferProviderFromModelId('grok-2'), 'xAI');
  assert.equal(inferProviderFromModelId('Grok 4.5'), 'xAI');
  assert.equal(inferProviderFromModelId('x-ai/grok-4'), 'xAI');
  assert.equal(inferProviderFromModelId('x-ai/grok-4.5'), 'xAI');
});

test('listKnownProviders includes Meta and xAI', () => {
  const list = listKnownProviders();
  assert.ok(list.includes('Meta'));
  assert.ok(list.includes('xAI'));
});
