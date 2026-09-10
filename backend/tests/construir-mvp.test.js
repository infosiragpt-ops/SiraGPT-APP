'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const {
  scaffoldConstruirProject,
  titleFromPrompt,
  pickKind,
  isCompleteHtml,
  repoNameFromTitle,
} = require('../src/services/construir-mvp/scaffold');
const { resolveConstruirBrand, looksLikeRawVendor } = require('../src/services/construir-mvp/brand');
const { zipProjectFiles } = require('../src/services/construir-mvp/zip');
const { publishProject, CONNECT_PATH } = require('../src/services/construir-mvp/github-publish');
const mvp = require('../src/services/construir-mvp');
const { ensureRenderableHtml, attachConstruirDeliverable } = require('../src/services/construir-mvp/webdev-hook');
const { createConstruirMvpRouter } = require('../src/routes/construir-mvp');
const agentTools = require('../src/services/agents/agent-tools');
const { isSoftwareBuildRequest } = require('../src/services/agents/software-build-intent');
const { isAgentesCodingV2Enabled } = require('../src/services/agentes-coding/flags');

function fakeSaveArtifact() {
  const saved = [];
  return {
    saved,
    saveArtifact(args) {
      const id = `art_${saved.length + 1}`;
      const rec = {
        id,
        filename: args.filename,
        mime: args.mime,
        format: String(args.filename || '').split('.').pop(),
        sizeBytes: Buffer.from(args.base64 || '', 'base64').length,
        downloadUrl: `/api/agent/artifact/${id}?name=${encodeURIComponent(args.filename)}`,
        brandLabel: args.brandLabel || null,
        kind: args.kind || null,
      };
      saved.push({ args, rec });
      return rec;
    },
  };
}

describe('construir-mvp scaffold', () => {
  test('builds a real notes project with file DB, not Office', () => {
    const project = scaffoldConstruirProject({ prompt: 'créame una app de notas para el equipo' });
    assert.equal(project.kind, 'notes');
    assert.ok(project.files['index.html'].includes('<!DOCTYPE html>'));
    assert.ok(project.files['server.js'].includes('createFileDb'));
    assert.ok(project.files['lib/db.js'].includes('data'));
    assert.ok(project.files['data/app.json'].includes('notes'));
    assert.ok(project.files['README.md'].includes('data/app.json'));
    assert.doesNotMatch(JSON.stringify(project.files), /\.docx|create_document|DeepSeek|OpenRouter/i);
    assert.equal(isCompleteHtml(project.files['index.html']), true);
  });

  test('landing variant for “créame una web” and wraps supplied HTML', () => {
    assert.equal(pickKind('créame una web de ventas'), 'landing');
    assert.match(titleFromPrompt('créame una web de ventas'), /Ventas/i);
    const wrapped = scaffoldConstruirProject({
      prompt: 'créame una web de ventas',
      html: '<!DOCTYPE html><html><body><h1>Tienda</h1></body></html>',
    });
    assert.match(wrapped.files['index.html'], /Tienda/);
    assert.equal(repoNameFromTitle('Ventas'), 'sira-ventas');
  });
});

describe('construir-mvp brand', () => {
  test('maps picker aliases and hides raw vendor ids', () => {
    assert.equal(resolveConstruirBrand('Sira Rápido').brandLabel, 'Sira Rápido');
    assert.equal(resolveConstruirBrand('Sira Pro').brandLabel, 'Sira Pro');
    assert.equal(resolveConstruirBrand('deepseek-v4-flash').brandLabel, 'Sira Rápido');
    assert.equal(resolveConstruirBrand('deepseek-v4-pro').brandLabel, 'Sira Pro');
    assert.equal(looksLikeRawVendor('deepseek-v4-flash'), true);
    assert.equal(looksLikeRawVendor('Sira Rápido'), false);
    assert.equal(resolveConstruirBrand('Claude').brandLabel, 'Claude');
  });
});

describe('construir-mvp happy path', () => {
  beforeEach(() => mvp.clearProjectStore());

  test('deliver saves HTML + zip artifacts and never requires AGENTES_CODING_V2', async () => {
    assert.equal(isAgentesCodingV2Enabled({ NODE_ENV: 'production', AGENTES_CODING_V2: '1' }), false);
    assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: '0' }), false);
    const { saveArtifact, saved } = fakeSaveArtifact();
    const events = [];
    const out = await mvp.deliverConstruirProject({
      prompt: 'créame una web de ventas',
      chatId: 'chat-1',
      userId: 'user-1',
      modelAlias: 'deepseek-v4-flash',
      saveArtifact,
      onEvent: (ev) => events.push(ev),
      env: { AGENTES_CODING_V2: '0', NODE_ENV: 'production' },
    });
    assert.equal(out.ok, true);
    assert.equal(out.brandLabel, 'Sira Rápido');
    assert.equal(out.flagRequired, false);
    assert.equal(out.agentesCodingV2, false);
    assert.equal(saved.length, 2);
    assert.match(saved[0].rec.filename, /\.html$/);
    assert.match(saved[1].rec.filename, /\.zip$/);
    assert.equal(saved[1].rec.mime, 'application/zip');
    assert.equal(events.filter((ev) => ev.type === 'file_artifact').length, 2);
    assert.match(out.footer, /Descargar/);
    assert.doesNotMatch(JSON.stringify(out), /deepseek|openrouter|sk-|gho_/i);
    assert.equal(isSoftwareBuildRequest('créame una web de ventas'), true);
    const zip = Buffer.from(saved[1].args.base64, 'base64');
    assert.equal(zip[0], 0x50);
    assert.equal(zip[1], 0x4b);
    assert.ok(mvp.lastProjectForChat('chat-1'));
  });

  test('zip contains the scaffold files', async () => {
    const project = scaffoldConstruirProject({ prompt: 'hazme una app de notas' });
    const buf = await zipProjectFiles(project.files);
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
    const asText = buf.toString('binary');
    assert.match(asText, /index\.html/);
    assert.match(asText, /server\.js/);
    assert.match(asText, /lib\/db\.js/);
    assert.match(asText, /README\.md/);
  });
});

describe('construir-mvp GitHub', () => {
  test('no token → Spanish CTA, fetch never called', async () => {
    let calls = 0;
    const out = await publishProject({
      userId: 'u1',
      files: { 'README.md': 'hola' },
      repoName: 'sira-demo',
      resolveToken: async () => null,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('should not fetch');
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'E_GITHUB_CONNECT');
    assert.match(out.message, /conecta/i);
    assert.equal(out.connectPath, CONNECT_PATH);
    assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify(out), /gho_|sk-|github_pat_|Bearer /i);
  });

  test('connected token creates repo and commits files', async () => {
    const calls = [];
    const out = await publishProject({
      userId: 'u1',
      files: { 'index.html': '<html></html>', 'README.md': 'hola' },
      repoName: 'sira-demo',
      resolveToken: async () => ({ accessToken: 'TEST_TOKEN_NOT_A_SECRET' }),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: (init && init.method) || 'GET' });
        const href = String(url);
        if (href.endsWith('/user') && (!init || !init.method || init.method === 'GET')) {
          return new Response(JSON.stringify({ login: 'luis' }), { status: 200 });
        }
        if (href.includes('/repos/luis/sira-demo') && (!init || !init.method || init.method === 'GET') && !href.includes('/git/')) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        if (href.endsWith('/user/repos') && init && init.method === 'POST') {
          const body = JSON.parse(init.body);
          assert.equal(body.access_token, undefined);
          return new Response(JSON.stringify({
            full_name: 'luis/sira-demo',
            html_url: 'https://github.com/luis/sira-demo',
            default_branch: 'main',
          }), { status: 201 });
        }
        if (href.includes('/git/ref/heads/main')) {
          return new Response(JSON.stringify({ object: { sha: 'aaa111' } }), { status: 200 });
        }
        if (href.includes('/git/commits/aaa111')) {
          return new Response(JSON.stringify({ tree: { sha: 'tree0' } }), { status: 200 });
        }
        if (href.includes('/git/blobs')) {
          return new Response(JSON.stringify({ sha: 'blob1' }), { status: 201 });
        }
        if (href.includes('/git/trees')) {
          return new Response(JSON.stringify({ sha: 'tree1' }), { status: 201 });
        }
        if (href.includes('/git/commits') && init && init.method === 'POST') {
          return new Response(JSON.stringify({ sha: 'ccc222' }), { status: 201 });
        }
        if (href.includes('/git/refs/heads/main') && init && init.method === 'PATCH') {
          return new Response(JSON.stringify({ object: { sha: 'ccc222' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ message: 'unexpected ' + href }), { status: 500 });
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.created, true);
    assert.equal(out.fullName, 'luis/sira-demo');
    assert.equal(out.htmlUrl, 'https://github.com/luis/sira-demo');
    assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/user/repos')));
    assert.doesNotMatch(JSON.stringify(out), /TEST_TOKEN|Bearer|gho_/);
  });

  test('publishLastProject requires approval', async () => {
    mvp.rememberProject('chat-x', {
      files: { 'README.md': 'x' },
      title: 'X',
      slug: 'sira-x',
      kind: 'notes',
    });
    const denied = await mvp.publishLastProject({
      chatId: 'chat-x',
      userId: 'u',
      approved: false,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'E_PLAN_GATE');
  });
});

describe('construir-mvp tools + webdev hook + route', () => {
  test('agent tools are registered and scaffold handler uses injectable save', async () => {
    assert.ok(agentTools.TOOLS_BY_NAME.has('construir_scaffold'));
    assert.ok(agentTools.TOOLS_BY_NAME.has('github_publish_project'));
    const { saveArtifact, saved } = fakeSaveArtifact();
    const out = await agentTools.construir_scaffold.handler(
      { prompt: 'créame una app de notas' },
      { userId: 'u', chatId: 'c', modelAlias: 'Sira Pro', saveArtifact },
    );
    assert.equal(out.ok, true);
    assert.equal(out.brandLabel, 'Sira Pro');
    assert.equal(saved.length, 2);
  });

  test('webdev hook falls back to scaffold HTML and attaches artifacts', async () => {
    const empty = ensureRenderableHtml('', 'créame una web de ventas');
    assert.equal(empty.fallback, true);
    assert.equal(isCompleteHtml(empty.html), true);
    const { saveArtifact } = fakeSaveArtifact();
    const attached = await attachConstruirDeliverable({
      prompt: 'créame una web de ventas',
      html: empty.html,
      userId: 'u',
      chatId: 'c',
      modelAlias: 'Sira Rápido',
      saveArtifact,
      requireSoftwareAsk: false,
    });
    assert.equal(attached.attached, true);
    assert.match(attached.delivery.footer, /Proyecto listo/);
  });

  test('health is on without AGENTES_CODING_V2', async () => {
    const app = express();
    app.use('/api/construir-mvp', createConstruirMvpRouter({
      env: { AGENTES_CODING_V2: '0', NODE_ENV: 'production' },
    }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    const payload = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/construir-mvp/health`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      }).on('error', reject);
    });
    server.close();
    assert.equal(payload.status, 200);
    assert.equal(payload.body.ok, true);
    assert.equal(payload.body.enabled, true);
    assert.equal(payload.body.flagRequired, false);
    assert.equal(payload.body.agentesCodingV2, false);
    assert.deepEqual(payload.body.brandAliases, ['Sira Rápido', 'Sira Pro']);
  });

  test('index.js mounts /api/construir-mvp and generate-webdev attaches the hook', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    assert.match(indexSrc, /construirMvpRoutes/);
    assert.match(indexSrc, /app\.use\('\/api\/construir-mvp'/);
    const aiSrc = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
    assert.match(aiSrc, /attachConstruirDeliverable/);
    assert.match(aiSrc, /ensureRenderableHtml/);
    const streamSrc = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');
    assert.match(streamSrc, /construir_scaffold/);
    assert.match(streamSrc, /github_publish_project/);
    const csrfSrc = fs.readFileSync(path.join(__dirname, '../src/middleware/csrf-route-policy.js'), 'utf8');
    assert.match(csrfSrc, /\/api\/construir-mvp/);
  });
});
