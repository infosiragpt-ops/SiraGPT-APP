'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pickModel, detectLanguage, estimateComplexity } = require('../src/services/ai/model-router');

test('detectLanguage flags Spanish vs English', () => {
    assert.equal(detectLanguage('Hola, ¿cómo estás? Necesito ayuda con el código'), 'es');
    assert.equal(detectLanguage('Hello, how are you? I need help with the code'), 'en');
});

test('detectLanguage returns unknown for empty', () => {
    assert.equal(detectLanguage(''), 'unknown');
    assert.equal(detectLanguage(null), 'unknown');
});

test('estimateComplexity marks short greetings as trivial', () => {
    const c = estimateComplexity({ prompt: 'hola' });
    assert.equal(c.bucket, 'trivial');
});

test('estimateComplexity marks long code prompts as complex', () => {
    const prompt = '```js\n' + 'function foo() { return 1; }\n'.repeat(40) + '```\nPlease refactor and optimize this entire codebase architecture step by step';
    const c = estimateComplexity({ prompt });
    assert.equal(c.hasCode, true);
    assert.equal(c.bucket, 'complex');
});

test('pickModel honors explicit user preference', () => {
    const r = pickModel({ prompt: 'anything', userPreference: 'claude-opus-4.7' });
    assert.equal(r.model, 'claude-opus-4.7');
    assert.equal(r.reason, 'user_preference');
});

test('pickModel returns mini for trivial', () => {
    const r = pickModel({ prompt: 'hola' });
    assert.equal(r.model, 'gpt-4o-mini');
    assert.equal(r.reason, 'trivial_prompt');
});

test('pickModel selects vision model when images attached', () => {
    const r = pickModel({
        prompt: 'what is this?',
        attachments: [{ mimeType: 'image/png' }],
    });
    assert.ok(r.model.startsWith('gpt-4o'));
    assert.match(r.reason, /vision/);
});

test('pickModel uses long-context model on very large context', () => {
    const r = pickModel({ prompt: 'summarize', contextSize: 200_000 });
    assert.equal(r.model, 'gemini-2.5-pro');
    assert.equal(r.reason, 'long_context');
});

test('pickModel returns reason and signals object', () => {
    const r = pickModel({ prompt: 'refactor and optimize the design step by step '.repeat(60) });
    assert.ok(r.model);
    assert.ok(r.reason);
    assert.ok(r.signals);
    assert.ok(['simple', 'moderate', 'complex'].includes(r.signals.bucket));
});
