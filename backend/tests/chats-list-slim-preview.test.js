'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

describe('chats list · slim preview payload', () => {
  it('strips reasoning/files from the preview message and caps content', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'chats.js'), 'utf8');
    const start = src.indexOf('const serializedChats = chats.map');
    assert.ok(start > 0, 'list serialization must exist');
    const block = src.slice(start, start + 900);
    assert.match(block, /content: String\(m\.content \|\| ''\)\.slice\(0, 240\)/);
    assert.doesNotMatch(block, /reasoning/);
    assert.doesNotMatch(block, /files:/);
    assert.match(block, /row\.messages = row\.messages\.map/);
  });
});
