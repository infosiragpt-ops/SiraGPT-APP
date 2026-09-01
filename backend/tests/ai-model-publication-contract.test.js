'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AI_ROUTE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../src/routes/ai.js'),
  'utf8',
);

function publicModelsHandlerSource() {
  const match = AI_ROUTE_SOURCE.match(
    /router\.get\('\/models',[\s\S]*?\nrouter\.post\('\/intent\/semantic'/,
  );
  assert.ok(match, 'public /api/ai/models handler must exist');
  return match[0];
}

test('public model catalog is backed exclusively by explicitly active database rows', () => {
  const source = publicModelsHandlerSource();

  assert.match(source, /const whereClause = \{\s*isActive:\s*true,?\s*\}/);
  assert.doesNotMatch(source, /__virtual_/);
  assert.doesNotMatch(source, /VIRTUAL_VOICE_DEFINITIONS/);
  assert.doesNotMatch(source, /buildGema4VirtualModel/);
  assert.doesNotMatch(source, /DEEPSEEK_TEXT_MODELS/);
  assert.doesNotMatch(source, /KIMI_K26_NATIVE/);
});

test('VOICE returns an explicit empty catalog before Prisma sees an unsupported enum', () => {
  const source = publicModelsHandlerSource();
  const voiceReturn = source.indexOf("if (type === 'VOICE')");
  const findMany = source.indexOf('prisma.aiModel.findMany');

  assert.ok(voiceReturn >= 0, 'VOICE must have an explicit compatibility branch');
  assert.ok(findMany >= 0, 'model catalog must query Prisma for supported types');
  assert.ok(voiceReturn < findMany, 'VOICE must return before the Prisma query');
  assert.match(source, /if \(type === 'VOICE'\) \{\s*return res\.json\(\{ models: \[\], policy: modelPolicy \}\);\s*\}/);
  assert.match(source, /const VALID_TYPES = \['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'MUSIC'\]/);
});
