'use strict';

// The /agentes thinking timeline (Claude style) is fed by `stage` SSE frames.
// Pin the phases the generate route announces so a refactor cannot silently
// return the UI to a bare "Pensando…".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');

test('generate route defines emitStage after the SSE headers are flushed', () => {
  const flushAt = src.indexOf("res.write(`data: ${JSON.stringify({ type: 'start', at: Date.now() })}\\n\\n`)");
  const helperAt = src.indexOf('const emitStage = (label, extra = {}) => {');
  assert.ok(flushAt > 0, 'start frame must exist');
  assert.ok(helperAt > flushAt, 'emitStage must be declared after the start frame (headers flushed)');
  assert.match(src, /if \(!label \|\| clientGone \|\| res\.writableEnded\) return;/);
  assert.match(src, /type: 'stage', label, \.\.\.extra/);
});

test('generate route announces attachments, web search, vision and the model phase', () => {
  assert.match(src, /emitStage\(files\.length === 1 \? 'Leyendo el archivo adjunto' : `Leyendo \$\{files\.length\} archivos adjuntos`, \{ tool: 'read_file' \}\)/);
  assert.match(src, /if \(_webSearchAllowed\) emitStage\('Buscando en la web', \{ tool: 'web_search' \}\)/);
  assert.match(src, /emitStage\(webSearchSources\.length === 1 \? 'Leyendo 1 fuente' : `Leyendo \$\{webSearchSources\.length\} fuentes`, \{ tool: 'web_fetch' \}\)/);
  assert.match(src, /emitStage\(__imageCount === 1 \? 'Analizando la imagen' : `Analizando \$\{__imageCount\} imágenes`, \{ tool: 'vision' \}\)/);
  assert.match(src, /emitStage\('Pensando', \{ tool: 'model' \}\);\s*\}\s*const out = await aiService\.generateStream\(\{/);
});
