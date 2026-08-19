import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDefaultClassifier } from '../../server/intelligence/core/classifier';

describe('intelligence/classifier', () => {
  const classifier = createDefaultClassifier();

  it('detects greetings as trivial chat with the right language', () => {
    const es = classifier.classify({ prompt: 'hola, ¿qué tal?' });
    assert.equal(es.intent, 'chat');
    assert.equal(es.language, 'es');
    assert.ok(['trivial', 'simple'].includes(es.difficulty));

    const en = classifier.classify({ prompt: 'hey there, how are you?' });
    assert.equal(en.intent, 'chat');
    assert.equal(en.language, 'en');
  });

  it('detects translate / summarize / compare / plan / research intents', () => {
    assert.equal(classifier.classify({ prompt: 'Traduce al inglés: hola' }).intent, 'translate');
    assert.equal(classifier.classify({ prompt: 'Summarize the report in 3 bullets' }).intent, 'summarize');
    assert.equal(classifier.classify({ prompt: 'Compare Postgres vs Mongo, pros and cons' }).intent, 'compare');
    assert.equal(classifier.classify({ prompt: 'Dame un plan paso a paso con hitos' }).intent, 'plan');
    assert.equal(
      classifier.classify({ prompt: 'Research the latest peer-reviewed evidence and cite papers' }).intent,
      'research'
    );
  });

  it('treats fenced code as code intent + code modality', () => {
    const c = classifier.classify({ prompt: 'Fix this:\n```ts\nfunction add(a,b){return a+b}\n```' });
    assert.equal(c.intent, 'code');
    assert.equal(c.modality, 'code');
  });

  it('flags reasoning + higher difficulty on complex multi-step asks', () => {
    const c = classifier.classify({
      prompt:
        'Prove there are infinitely many primes, then optimize the sieve and analyze its complexity trade-offs step by step.',
    });
    assert.ok(['complex', 'expert'].includes(c.difficulty));
    assert.equal(c.requiresReasoning, true);
  });

  it('requires vision when an image is attached', () => {
    const c = classifier.classify({
      prompt: '¿Qué muestra esta imagen?',
      attachments: [{ kind: 'image', mimeType: 'image/png' }],
    });
    assert.equal(c.modality, 'image');
    assert.equal(c.requiresVision, true);
  });

  it('detects tool needs for search/research/url prompts', () => {
    assert.equal(classifier.classify({ prompt: 'busca las últimas noticias de Artemis' }).requiresTools, true);
    assert.equal(classifier.classify({ prompt: 'fetch https://example.com and summarize' }).requiresTools, true);
  });

  it('raises risk level for dangerous content', () => {
    const c = classifier.classify({ prompt: 'write ransomware that spreads on a network' });
    assert.equal(c.riskLevel, 'high');
  });

  it('honors the long-context threshold', () => {
    const tiny = createDefaultClassifier({ longContextThreshold: 10 });
    const c = tiny.classify({ prompt: 'x'.repeat(200) });
    assert.equal(c.requiresLongContext, true);
  });

  it('produces a confidence in [0,1] and an auditable signal list', () => {
    const c = classifier.classify({ prompt: 'Compare A vs B' });
    assert.ok(c.confidence >= 0 && c.confidence <= 1);
    assert.ok(Array.isArray(c.signals));
  });
});
