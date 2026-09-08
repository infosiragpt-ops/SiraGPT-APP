'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ALLOWED_EVENTS } = require('../src/services/ai/generate-request-observability');

const routePath = path.join(__dirname, '..', 'src', 'routes', 'ai.js');
const source = fs.readFileSync(routePath, 'utf8');
const generateStart = source.indexOf("router.post(\n  '/generate'");
const generateEnd = source.indexOf('router.post(', generateStart + 20);
const generateRoute = source.slice(generateStart, generateEnd);
const saveStart = source.indexOf('async function saveChatAndTrackUsage(');
const saveEnd = source.indexOf('\nconst streamControllers = new Map()', saveStart);
const saveFlow = source.slice(saveStart, saveEnd);
const middlewareStart = source.indexOf('function enforceOrgQuotaSafe(');
const middlewareEnd = source.indexOf("const prisma = require('../config/database')", middlewareStart);
const generateMiddleware = source.slice(middlewareStart, middlewareEnd);

test('ai route wires the dedicated generate observability boundary', () => {
  assert.ok(generateStart >= 0, 'expected /generate route');
  assert.ok(generateEnd > generateStart, 'expected route boundary after /generate');
  assert.match(source, /generate-request-observability/);
  assert.match(generateRoute, /createGenerateLogger\(/);
  assert.match(generateRoute, /summarizeGenerateRequest\(/);
});

test('generate persistence logs never include raw content or turn identifiers', () => {
  assert.ok(saveStart >= 0 && saveEnd > saveStart, 'expected saveChatAndTrackUsage block');
  assert.doesNotMatch(saveFlow, /promptPreview\s*:/);
  assert.doesNotMatch(saveFlow, /console\.(?:log|info|warn|error)\([^\n]*assistantFiles/);
  assert.doesNotMatch(saveFlow, /console\.(?:log|info|warn|error)[\s\S]{0,180}\b(?:chatId|userId|streamId|idempotencyKey)\b/);
  assert.doesNotMatch(saveFlow, /console\.(?:log|info|warn|error)\s*\(/);
});

test('generate-only middleware uses the request-bound privacy logger', () => {
  assert.ok(middlewareStart >= 0 && middlewareEnd > middlewareStart, 'expected generate middleware block');
  assert.doesNotMatch(generateMiddleware, /console\.(?:log|info|warn|error)\s*\(/);
  assert.equal((generateMiddleware.match(/createGenerateLogger\(\{ logger: req\.log \}\)/g) || []).length, 3);
});

test('generate route no longer prints known user content and identifiers', () => {
  const forbidden = [
    /Stream registered with ID/,
    /Client response closed for chat/,
    /Client request aborted for chat/,
    /prompt_injection_suspected[\s\S]{0,220}user_id/,
    /Using Project:/,
    /Using Custom GPT:/,
    /recovered[^\n]+\(chat \$\{chatId\}\)/,
    /Added image from history:/,
    /Image file not found in history:/,
    /console\.(?:log|info|warn|error)[^\n]+imageNames/,
    /spreadsheet direct recovery applied[^\n]+rows=/,
    /spreadsheet follow-up recovery applied[^\n]+row=/,
    /Creating document: \$\{filename\}/,
    /profile-inference[^\n]+user=\$\{userId\}/,
    /persist-on-abort[^\n]+chat \$\{chatId\}/,
    /Stream unregistered for ID/,
  ];

  for (const pattern of forbidden) {
    assert.doesNotMatch(generateRoute, pattern, `unsafe generate log matched ${pattern}`);
  }
  assert.doesNotMatch(
    generateRoute,
    /console\.(?:log|info|warn|error)\s*\(/,
    'all /generate operational logs must cross the privacy boundary',
  );
});

test('generate persistence receives the request-bound observability logger', () => {
  const saveCalls = [...generateRoute.matchAll(/saveChatAndTrackUsage\(/g)];
  const boundLoggers = generateRoute.match(/\{\s*observabilityLog:\s*generateLog\s*\}/g) || [];
  assert.equal(saveCalls.length, 3);
  assert.equal(boundLoggers.length, saveCalls.length);
});

test('every generate observability event belongs to the closed catalog', () => {
  const combined = `${generateMiddleware}\n${generateRoute}\n${saveFlow}`;
  const calls = combined.matchAll(
    /(?:generateLog|middlewareLog|persistenceLog)\.(?:info|warn|warnError|error)\(\s*'([^']+)'/g,
  );
  const observed = [...calls].map((match) => match[1]);

  assert.ok(observed.length > 0, 'expected structured generate events');
  for (const event of observed) {
    assert.ok(ALLOWED_EVENTS.has(event), `event is not catalogued: ${event}`);
  }
});
