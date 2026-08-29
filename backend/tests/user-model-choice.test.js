'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const aiRoute = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'ai.js'),
  'utf8',
);

test('generate does not auto-redirect the user picker to org preferredModel', () => {
  assert.match(
    aiRoute,
    /Honor the \/agentes picker/,
    'org preferredModel must be documented as a default, not a redirect',
  );
  assert.match(
    aiRoute,
    /if \(!customGpt && !String\(model \|\| ''\)\.trim\(\)\)/,
    'preferredModel may apply only when the client sent no model',
  );
});

test('generate routes Custom/Ollama through the local connection client', () => {
  assert.match(
    aiRoute,
    /createCustomProviderClient/,
    'Custom/Ollama/HuggingFace must not fall through to OpenAI',
  );
  assert.match(
    aiRoute,
    /isCustomProvider\(provider\)/,
    'the local Custom provider names must be recognized',
  );
});

test('generate surfaces a Spanish error when the selected model cannot run', () => {
  assert.match(
    aiRoute,
    /Este modelo no se pudo ejecutar\. No cambié a otro modelo/,
    'failed Custom/local models must error in Spanish on that model',
  );
  assert.match(aiRoute, /CONNECTION_UNAVAILABLE_MESSAGE/);
  assert.match(aiRoute, /ECONNREFUSED/);
  assert.match(aiRoute, /unknown model/);
});

test('generate does not steal a user-selected model via reasoning-orchestrator', () => {
  assert.match(
    aiRoute,
    /const honorUserModel = String\(model \|\| ''\)\.trim\(\)\.length > 0/,
    'generate must detect an explicit user model pick',
  );
  assert.match(
    aiRoute,
    /&& !honorUserModel/,
    'orchestrator re-route must not run when the user picked a model',
  );
});
