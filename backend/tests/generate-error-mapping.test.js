'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONNECTION_UNAVAILABLE_MESSAGE,
  STREAM_TIMEOUT_MESSAGE,
  PROVIDER_FAIL_MESSAGE,
  classifyGenerateError,
  publicGenerateErrorMessage,
  closeGenerateSseWithError,
} = require('../src/services/ai/generate-sse-close');
const { CONNECT_MESSAGE } = require('../src/services/construir-mvp/github-publish');

function mockRes() {
  const chunks = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    chunks,
    write(frame) {
      chunks.push(String(frame));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return res;
}

test('keeps missing-key / vendor leak as Conexión no disponible', () => {
  assert.equal(
    publicGenerateErrorMessage({ message: '400 unknown parameter reasoning' }),
    CONNECTION_UNAVAILABLE_MESSAGE,
  );
  assert.equal(
    publicGenerateErrorMessage({ message: 'OpenRouter 502 DeepSeek muse-spark-1.2-contributor' }),
    CONNECTION_UNAVAILABLE_MESSAGE,
  );
  assert.equal(
    publicGenerateErrorMessage({ message: CONNECTION_UNAVAILABLE_MESSAGE, code: 'connection_unavailable' }),
    CONNECTION_UNAVAILABLE_MESSAGE,
  );
  assert.equal(classifyGenerateError({}).code, 'connection_unavailable');
});

test('maps timeout / abort / stream drop to E_TIMEOUT, not a fake GitHub connection', () => {
  const cases = [
    { name: 'AbortError', message: 'aborted' },
    { code: 'ETIMEDOUT', message: 'connect timeout' },
    { message: 'First-byte timeout after 45000ms' },
    { code: 'runtime_budget_exhausted', message: 'budget' },
    { code: 'aborted', message: '' },
    { message: 'La solicitud tardó demasiado. Intenta de nuevo.' },
  ];
  for (const err of cases) {
    const out = classifyGenerateError(err);
    assert.equal(out.code, 'E_TIMEOUT', JSON.stringify(err));
    assert.equal(out.message, STREAM_TIMEOUT_MESSAGE);
    assert.doesNotMatch(out.message, /Conexión no disponible|connection_unavailable/i);
    assert.match(out.message, /stream|Reintenta/i);
  }
});

test('maps GitHub OAuth miss to E_GITHUB_CONNECT + /conexiones CTA', () => {
  const out = classifyGenerateError({
    code: 'E_GITHUB_CONNECT',
    message: CONNECT_MESSAGE,
  });
  assert.equal(out.code, 'E_GITHUB_CONNECT');
  assert.equal(out.message, CONNECT_MESSAGE);
  assert.match(out.message, /\/conexiones/);
  assert.doesNotMatch(out.message, /Conexión no disponible/);

  const english = classifyGenerateError({
    code: 'github_not_connected',
    message: 'GitHub is not connected for this user',
  });
  assert.equal(english.code, 'E_GITHUB_CONNECT');
  assert.match(english.message, /\/conexiones/);
});

test('maps sandbox jail and generic tool/provider failures honestly', () => {
  const jail = classifyGenerateError({ code: 'E_PATH_ESCAPE', message: 'La ruta sale del workspace aislado.' });
  assert.equal(jail.code, 'E_SANDBOX');
  assert.match(jail.message, /workspace|ruta/i);

  const provider = classifyGenerateError({ message: 'AI generation failed after exhausting fallback chain' });
  assert.equal(provider.code, 'E_PROVIDER');
  assert.equal(provider.message, PROVIDER_FAIL_MESSAGE);
  assert.doesNotMatch(provider.message, /Conexión no disponible/);
});

test('SSE closer writes the classified Spanish text, not a generic connection', () => {
  const res = mockRes();
  closeGenerateSseWithError(res, {
    message: STREAM_TIMEOUT_MESSAGE,
    code: 'E_TIMEOUT',
  });
  const body = res.chunks.join('');
  assert.match(body, /El modelo cortó el stream/);
  assert.match(body, /"code":"E_TIMEOUT"/);
  assert.doesNotMatch(body, /Conexión no disponible/);
  assert.match(body, /data: \[DONE\]/);
});

test('frontend remappers only collapse true connection_unavailable, not timeout or GitHub CTA', () => {
  const roots = [
    path.join(__dirname, '../../lib/generate-stream-errors.ts'),
    path.join(__dirname, '../../lib/chat-context-integrated.tsx'),
    path.join(__dirname, '../../lib/api.ts'),
    path.join(__dirname, '../../lib/recover-persisted-turn.ts'),
  ];
  for (const file of roots) {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /connection_unavailable|conexión no disponible/i, file);
    assert.doesNotMatch(
      src,
      /E_TIMEOUT|E_GITHUB_CONNECT/,
      `${file} must not remap the new codes onto Conexión no disponible`,
    );
  }
  assert.equal(STREAM_TIMEOUT_MESSAGE.includes('conexión no disponible'), false);
  assert.equal(CONNECT_MESSAGE.includes('conexión no disponible'), false);
});
