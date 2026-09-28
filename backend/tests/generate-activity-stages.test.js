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
  // One emitter (services/turn-progress) built on emitStage, right after it.
  const helperAt = src.indexOf('const emitStage = (label, extra = {}) => {');
  const progressAt = src.search(/createTurnProgress\(\{\s*emitStage,/);
  assert.ok(progressAt > helperAt, 'createTurnProgress wraps emitStage, declared after it');
  // Capability negotiation: v2 rows only for clients that asked for them.
  assert.match(src, /body\('progressProtocol'\)\.optional\(\)\.isInt\(\{ min: 1, max: 9 \}\)/);
  assert.match(src, /protocol: Number\(req\.body\?\.progressProtocol\) === 2 \? 2 : 1,/);
  assert.match(src, /turnProgress\.begin\('attachments'/);
  // Only when a search really runs (not on every allowed turn).
  assert.match(src, /const _willSearchWeb = _webSearchAllowed && webSearchPlanned\(_webGroundingPrompt, _webSearchOptions\);/);
  assert.match(src, /if \(_willSearchWeb\)[^;]*turnProgress\.begin\('web'/);
  assert.match(src, /turnProgressLib\.sourcesNote\(webSearchSources\)/);
  assert.match(src, /turnProgress\.begin\('vision'/);
  // The model row comes from the stream's own attempts (modelSink).
  const streamAt = src.indexOf("const out = await aiService.generateStream({");
  assert.ok(streamAt > 0);
  const streamCall = src.slice(streamAt, streamAt + 2500);
  assert.match(streamCall, /onProgress: turnProgress\.modelSink\(/);
  // Hand-offs settle the pipeline rows.
  assert.ok((src.match(/turnProgress\.settleAll\(\)/g) || []).length >= 3);
  // Persisted with the reply for the reload; disposed in the outer finally.
  assert.equal((src.match(/req\._turnProgress\?\.toMetadata\(/g) || []).length, 2);
  assert.match(src, /req\._turnProgress\?\.dispose\(\)/);
  // The agentic loop reports its model calls through the same emitter.
  assert.match(src, /progress: turnProgress,/);
});

test('model_resolved names the model by display name only (no raw id, no transport)', () => {
  assert.doesNotMatch(src, /type: 'model_resolved', model: actualModel, provider: actualProvider/);
  assert.match(src, /type: 'model_resolved', label: turnProgress\.modelLabel\(actualModel, actualProvider\)/);
  // The legacy static phrases are gone: every label carries real facts.
  assert.doesNotMatch(src, /emitStage\('Pensando', \{ tool: 'model' \}\)/);
  assert.doesNotMatch(src, /emitStage\('Buscando en la web', \{ tool: 'web_search' \}\)/);
});

test('route rows claim only what happened (attachments, memory, web, faithfulness, model name)', () => {
  // An earlier image deliberately skipped is not «No pude abrir…»: the row
  // is relabelled only after the filter, and settled as not needed.
  const filterAt = src.indexOf('__skippedRecoveredImages = __beforeImageFilter - processedFiles.length;');
  const relabelAt = src.indexOf('// The names are known now (after the deliberate image filter)');
  assert.ok(filterAt > 0 && relabelAt > filterAt, 'relabel after the recovered-image filter');
  assert.match(src, /'La imagen anterior no hace falta para esta pregunta'/);
  // Memory: «conversaciones similares» only when cross-chat retrieval runs;
  // a failed / timed-out recall is not «sin recuerdos relevantes».
  assert.match(src, /_crossChatEnabled\s*\? 'Consultando tu memoria y conversaciones similares'\s*: 'Consultando tu memoria'/);
  assert.match(src, /__memoryHandle\.fail\('No pude consultar tu memoria'/);
  // Web: a provider failure is told apart from a search that found nothing.
  assert.match(src, /onOutcome: \(outcome\) => \{ if \(outcome === 'failed'\) __webFailed = true; \}/);
  assert.doesNotMatch(src, /'La búsqueda no devolvió resultados'/);
  // Faithfulness: no row below the judge's 120 chars; null → could not check.
  assert.match(src, /String\(fullResponseContent \|\| ''\)\.trim\(\)\.length >= 120\s*\? turnProgress\.begin\('post', 'Comprobando que la respuesta esté respaldada por las fuentes'/);
  assert.match(src, /__faithHandle\.fail\('No se pudo comprobar el respaldo'/);
  assert.doesNotMatch(src, /'Comprobación de respaldo terminada'/);
  // The model row names the model that answers; the reasoning level comes
  // from ai-service (what the provider really got), not from the route.
  const streamAt = src.indexOf('const out = await aiService.generateStream({');
  const sinkCall = src.slice(src.indexOf('onProgress: turnProgress.modelSink({', streamAt), src.indexOf('maxOutputTokens:', streamAt));
  assert.match(sinkCall, /modelId: actualModel,/);
  assert.match(sinkCall, /modelLabel: turnProgressLib\.displayNameFor\(actualModel, actualProvider\)/);
  assert.doesNotMatch(sinkCall, /thinkingLevel:/);
  // The planning note never claims an effort on a trivial turn or for a
  // model that does not reason.
  assert.match(src, /req\._thinkingLevelExplicit === true && req\._trivialTurn !== true && !isTrivialChatTurn\(prompt\)/);
  assert.match(src, /\.supportsReasoning === true/);
});
