'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const flags = require('../src/services/doc-artifact-editor/flags');
const store = require('../src/services/doc-artifact-editor/session-store');
const service = require('../src/services/doc-artifact-editor/service');

describe('FEATURE_DOC_ARTIFACT_EDITOR flag', () => {
  it('is off by default', () => {
    assert.equal(flags.isDocArtifactEditorEnabled({}), false);
    assert.equal(flags.isDocArtifactEditorEnabled({ FEATURE_DOC_ARTIFACT_EDITOR: '0' }), false);
  });

  it('enables only on 1/true/yes/on', () => {
    assert.equal(flags.isDocArtifactEditorEnabled({ FEATURE_DOC_ARTIFACT_EDITOR: '1' }), true);
    assert.equal(flags.isDocArtifactEditorEnabled({ FEATURE_DOC_ARTIFACT_EDITOR: 'true' }), true);
  });

  it('never uses OpenRouter', () => {
    const gate = flags.assertNoOpenRouter({ OPENROUTER_API_KEY: 'sk-or-fake' });
    assert.equal(gate.provider, 'deepseek');
    assert.deepEqual(gate.forbiddenProviders, ['openrouter']);
  });
});

describe('doc-artifact-editor session', () => {
  before(() => store.resetStore());

  it('opens, streams stages, and downloads without mutating when DeepSeek is missing', async () => {
    const buf = Buffer.from('PK\x03\x04fake-docx');
    const session = service.openArtifact({
      userId: 'u1',
      filename: 'tesis.docx',
      buffer: buf,
      instructions: 'corrige el titulo',
    });
    assert.ok(session.id.startsWith('dae_'));
    assert.equal(session.status, 'open');

    const out = await service.applyEdit(session.id, { env: {}, client: null });
    assert.equal(out.status, 'done');
    const types = out.events.map((e) => e.type);
    assert.ok(types.includes('open'));
    assert.ok(types.includes('plan'));
    assert.ok(types.includes('edit'));
    assert.ok(types.includes('done'));
    assert.equal(out.events.some((e) => /openrouter/i.test(JSON.stringify(e))), false);

    const file = service.downloadSession(session.id);
    assert.ok(file);
    assert.equal(file.filename, 'tesis.docx');
    assert.equal(Buffer.compare(file.buffer, buf), 0);
  });

  it('picks DeepSeek models only', () => {
    assert.equal(service.pickDeepSeekModel({ env: {} }), 'deepseek-v4-flash');
    assert.equal(service.pickDeepSeekModel({ preferPro: true, env: {} }), 'deepseek-v4-pro');
    assert.doesNotMatch(service.pickDeepSeekModel({ env: {} }), /openrouter/i);
  });
});

describe('doc-artifact-editor HTTP', () => {
  it('health stays 200 when the flag is off; sessions 404', async () => {
    const prev = process.env.FEATURE_DOC_ARTIFACT_EDITOR;
    delete process.env.FEATURE_DOC_ARTIFACT_EDITOR;
    const express = require('express');
    const http = require('node:http');
    const router = require('../src/routes/doc-artifact-editor');
    const app = express();
    app.use('/api/doc-artifact-editor', router);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const health = await fetch(`http://127.0.0.1:${port}/api/doc-artifact-editor/health`);
      assert.equal(health.status, 200);
      const body = await health.json();
      assert.equal(body.enabled, false);
      assert.equal(body.provider, 'deepseek');
      assert.equal(body.isolatedFromChatChrome, true);
      const sessions = await fetch(`http://127.0.0.1:${port}/api/doc-artifact-editor/sessions`, { method: 'POST' });
      assert.equal(sessions.status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (prev === undefined) delete process.env.FEATURE_DOC_ARTIFACT_EDITOR;
      else process.env.FEATURE_DOC_ARTIFACT_EDITOR = prev;
    }
  });
});
