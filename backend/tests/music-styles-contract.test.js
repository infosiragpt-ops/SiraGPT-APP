const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Contract: the audio-panel Music tab (GET /api/elevenlabs/music-styles)
// must offer EXACTLY the 9 production styles of the chat composer's
// "Producción musical" menu — same ids, names and order. A drift here means
// the two entries to the same feature describe different products.
// Composer source of truth: lib/chat/media-composer-config.ts
// (MUSIC_STYLE_OPTIONS; the chat component imports it).
const EXPECTED_STYLES = [
  { id: 'auto', name: 'Auto' },
  { id: 'cinematic', name: 'Cinematic' },
  { id: 'pop', name: 'Pop' },
  { id: 'electronic', name: 'Electronic' },
  { id: 'ambient', name: 'Ambient' },
  { id: 'orchestral', name: 'Orchestral' },
  { id: 'latin', name: 'Latin' },
  { id: 'hip-hop', name: 'Hip-Hop' },
  { id: 'jazz', name: 'Jazz' },
];

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/elevenlabs.js'), 'utf8');
const composerSource = fs.readFileSync(
  path.join(__dirname, '../../lib/chat/media-composer-config.ts'),
  'utf8'
);

test('music-styles route exposes the 9 composer styles in order', () => {
  const block = routeSource.slice(routeSource.indexOf("router.get('/music-styles'"));
  assert.ok(block.length > 100, 'music-styles route must exist');
  let lastIndex = -1;
  for (const { id, name } of EXPECTED_STYLES) {
    const idPos = block.indexOf(`id: '${id}'`);
    assert.ok(idPos > lastIndex, `style id '${id}' must be present in order`);
    assert.ok(block.includes(`name: '${name}'`), `style name '${name}' must be present`);
    lastIndex = idPos;
  }
  // No legacy placeholder styles may leak back in.
  for (const legacy of ['Nature', 'Classical', 'Rock']) {
    assert.equal(block.includes(`name: '${legacy}'`), false, `legacy style '${legacy}' must not be present`);
  }
});

test('composer MUSIC_STYLE_OPTIONS matches the same 9 styles', () => {
  const match = composerSource.match(/MUSIC_STYLE_OPTIONS[^=]*=\s*\[([^\]]+)\]/);
  assert.ok(match, 'MUSIC_STYLE_OPTIONS must exist in the composer config');
  const options = match[1].split(',').map((s) => s.trim().replace(/["']/g, ''));
  assert.deepEqual(options, EXPECTED_STYLES.map((s) => s.name));
});
