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

const CATALOG_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../src/services/ai-model-catalog.js'),
  'utf8',
);

test('public model catalog is backed exclusively by explicitly active database rows', () => {
  const source = publicModelsHandlerSource();

  // The route reads through the catalog serving layer (per-scope in-memory
  // snapshot); the where-clause it builds must still be "active rows only".
  assert.match(source, /let models = await loadPickerRows\(\{ prisma, type \}\);/);
  assert.match(CATALOG_SOURCE, /const whereClause = \{\s*isActive:\s*true,?\s*\}/);
  assert.match(CATALOG_SOURCE, /prisma\.aiModel\.findMany\(\{\s*where: buildPickerWhereClause\(type\)/);
  for (const forbidden of [/__virtual_/, /VIRTUAL_VOICE_DEFINITIONS/, /buildGema4VirtualModel/, /DEEPSEEK_TEXT_MODELS/, /KIMI_K26_NATIVE/]) {
    assert.doesNotMatch(source, forbidden);
    assert.doesNotMatch(CATALOG_SOURCE, forbidden);
  }
});

test('VOICE maps to the AUDIO (TTS) catalog before Prisma sees an unsupported enum', () => {
  const source = publicModelsHandlerSource();
  assert.ok(source.indexOf("type === 'AUDIO' || type === 'VOICE'") >= 0, 'VOICE must map onto the AUDIO rows (the Voz chip lists TTS models)');
  assert.match(source, /const VALID_TYPES = \['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'MUSIC', 'VOICE'\]/);
  assert.match(source, /const wantAudio = !type \|\| type === 'AUDIO' \|\| type === 'VOICE';/);

  // The where-clause itself must carry AUDIO when the UI asks VOICE —
  // filtering 'VOICE' verbatim threw inside Prisma and emptied the Voz chip
  // ("Sin modelos activos") while generation itself worked. The mapping now
  // lives in the catalog layer, ahead of the only Prisma query.
  const voiceMap = CATALOG_SOURCE.indexOf("if (normalized === 'VOICE') {\n    whereClause.type = 'AUDIO';");
  const findMany = CATALOG_SOURCE.indexOf('prisma.aiModel.findMany');
  assert.ok(voiceMap >= 0, 'catalog layer must map VOICE → AUDIO in the where-clause');
  assert.ok(findMany >= 0, 'catalog layer must query Prisma for supported types');
  assert.ok(voiceMap < findMany, 'the VOICE→AUDIO mapping must happen before the Prisma query');
  assert.match(CATALOG_SOURCE, /if \(normalized === 'VOICE'\) return 'AUDIO';/, 'VOICE and AUDIO share one snapshot scope');
  // Never send the non-Prisma enum value to the database.
  for (const src of [source, CATALOG_SOURCE]) {
    assert.doesNotMatch(src, /type: 'VOICE'/);
    assert.doesNotMatch(src, /in: \[[^\]]*'VOICE'/);
  }
});
