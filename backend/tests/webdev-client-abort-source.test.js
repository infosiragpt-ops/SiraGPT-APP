'use strict';

/**
 * /api/ai/generate-webdev — a Stop (or a closed tab) during the first pass
 * used to fall into the design fallback, which died at once with the SDK's
 * APIUserAbortError and was logged as «❌ Web development generation
 * error». Source contract: the route returns as soon as the signal is
 * aborted, and treats APIUserAbortError like AbortError.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
const start = route.indexOf("'/generate-webdev'");
const end = route.indexOf('Web Dev Stream unregistered', start);
assert.ok(start > 0 && end > start, 'webdev handler located');
const handler = route.slice(start, end);

test('a Stop during the first pass returns before the design fallback runs', () => {
  const firstPass = handler.indexOf('const firstPass = await aiService.generateStream({');
  const earlyReturn = handler.indexOf('if (signal.aborted) return;', firstPass);
  const fallback = handler.indexOf('streamDesignGeneration(null, {', firstPass);
  assert.ok(firstPass > 0 && earlyReturn > firstPass && fallback > earlyReturn,
    'signal.aborted is checked after the first pass and before streamDesignGeneration');
});

test('APIUserAbortError (OpenAI / xAI / DeepSeek SDK) counts as a client abort in the route catch', () => {
  assert.match(handler, /\/\^\(AbortError\|APIUserAbortError\)\$\//);
  assert.match(handler, /const abortLike = signal\.aborted/);
  assert.doesNotMatch(handler, /apiError\.name === 'AbortError'\) \{\n\s+console\.warn\('Web Dev AI Service stream aborted by client in route\.'\)/);
});

test('ai-service: an empty stream after a client abort is the abort, not «Empty completion»', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai-service.js'), 'utf8');
  const empty = service.indexOf("throw Object.assign(new Error('Empty completion — model returned no content')");
  const guard = service.lastIndexOf('if (signal && signal.aborted) throw clientAbortError(signal);', empty);
  assert.ok(empty > 0 && guard > 0 && empty - guard < 200, 'the abort guard sits right before the empty-completion throw');
  assert.match(service, /function clientAbortError\(signal\)/);
});
