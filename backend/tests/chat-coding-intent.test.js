'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cases = require('./fixtures/chat-coding-intents.json');
const { detectCodingIntent, chatGithubRepository, codingProjectName } = require('../src/services/agents/software-build-intent');
for (const { text, options, kind } of cases) test(`chat intent: ${text} ${JSON.stringify(options)}`, () => {
  const result = detectCodingIntent(text, options);
  assert.equal(result.kind, kind);
  assert.equal(result.active, Boolean(kind));
  if (kind) assert.ok(result.projectName && result.projectName.length <= 80);
});
test('repository URLs identify only GitHub repos and remove git suffix', () => {
  assert.equal(chatGithubRepository('revisa https://github.com/example/bikes.git'), 'https://github.com/example/bikes');
  for (const text of ['revisa https://evilgithub.com/example/bikes', 'revisa https://github.com.evil.test/a/b', 'revisa https://github.com/settings/tokens', 'revisa https://github.com/a/..']) assert.equal(chatGithubRepository(text), null);
});
test('repository selection ignores fenced source URLs and preserves the explicit repository', () => {
  for (const fence of ['```', '````', '~~~']) {
    const source = `${fence}js\nconst link = "https://github.com/example/decoy";\n${fence}`;
    assert.equal(chatGithubRepository(`Corrige este código:\n${source}`), null);
    assert.equal(detectCodingIntent(`Corrige este código:\n${source}`).repositoryUrl, null);
    const prompt = `${source}\nRevisa https://github.com/Example/Target.git`;
    assert.equal(chatGithubRepository(prompt), 'https://github.com/Example/Target');
    assert.equal(detectCodingIntent(prompt).repositoryUrl, 'https://github.com/Example/Target');
    assert.equal(chatGithubRepository(`Corrige este código:\n${fence}js\nconst link = "https://github.com/example/decoy";`), null);
  }
});
test('project names do not copy credentials or code from the request', () => {
  assert.equal(codingProjectName('Crea una web de bicicletas con API key sensitive-placeholder'), 'Web de bicicletas');
  assert.equal(codingProjectName('Crea una app llamada "Bici 20"'), 'Bici 20');
  assert.equal(codingProjectName('crea código ```js const key = "example"```'), 'Proyecto de código');
});

test('secret-shaped text never becomes a project label, regardless of letter case', () => {
  for (const marker of ['sk-' + 'testonly'.repeat(5), 'Sk-' + 'testonly'.repeat(5), 'Bearer ' + 'synthetic'.repeat(3), 'ghp_' + 'sampleonly'.repeat(4), 'github_pat_' + 'synthetic'.repeat(4), 'AKIA' + '0'.repeat(16)]) {
    assert.equal(codingProjectName(`Crea una web llamada "${marker}"`), 'Proyecto de código');
    assert.equal(codingProjectName(`Crea una web para ACME ${marker}`), 'Proyecto de código');
  }
});
