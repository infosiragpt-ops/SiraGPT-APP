'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const seedSource = fs.readFileSync(
  path.resolve(__dirname, '../prisma/seed.js'),
  'utf8',
);

test('database seed preserves admin activation and creates every new model inactive', () => {
  assert.match(seedSource, /const \{ isActive: _legacySeedDefault, \.\.\.metadata \} = modelData/);
  assert.match(seedSource, /update:\s*metadata/);
  assert.match(seedSource, /create:\s*\{ \.\.\.metadata, isActive: false \}/);
  assert.doesNotMatch(seedSource, /update:\s*modelData/);
  assert.doesNotMatch(seedSource, /create:\s*modelData/);
});
