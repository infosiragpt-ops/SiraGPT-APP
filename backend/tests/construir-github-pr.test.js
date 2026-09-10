'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const mvp = require('../src/services/construir-mvp');
const {
  openRepo,
  listRepoFiles,
  readRepoFile,
  writeRepoFile,
  execRepo,
  openPullRequest,
  CONNECT_PATH,
  shouldSkipPath,
  workBranchName,
} = require('../src/services/construir-mvp/github-pr-flow');
const { jailRelPath, clearSessions } = require('../src/services/construir-mvp/github-repo-workspace');
const { isGithubPrRequest, extractOwnerRepo, parseOwnerRepo } = require('../src/services/agents/github-pr-intent');
const { isAgentesCodingV2Enabled } = require('../src/services/agentes-coding/flags');
const { createConstruirMvpRouter } = require('../src/routes/construir-mvp');
const agentTools = require('../src/services/agents/agent-tools');

const TOKEN = 'TEST_TOKEN_NOT_A_SECRET';

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

function githubMock({ files = { 'README.md': '# demo\n' } } = {}) {
  const calls = [];
  const blobs = new Map();
  let blobN = 0;
  const tree = Object.keys(files).map((rel, i) => {
    const sha = `blob-${i + 1}`;
    blobs.set(sha, Buffer.from(files[rel], 'utf8').toString('base64'));
    return { path: rel, type: 'blob', sha, size: Buffer.byteLength(files[rel]) };
  });

  async function fetchImpl(url, init = {}) {
    const href = String(url);
    const method = (init && init.method) || 'GET';
    calls.push({ url: href, method });
    const auth = init.headers && (init.headers.Authorization || init.headers.authorization);
    assert.ok(!href.includes(TOKEN), 'token must not appear in the URL');
    if (href.endsWith('/user')) {
      return new Response(JSON.stringify({ login: 'luis' }), { status: 200 });
    }
    if (/\/repos\/luis\/demo$/.test(href) && method === 'GET') {
      return new Response(JSON.stringify({
        full_name: 'luis/demo',
        html_url: 'https://github.com/luis/demo',
        default_branch: 'main',
      }), { status: 200 });
    }
    if (href.includes('/git/ref/heads/main') && method === 'GET') {
      return new Response(JSON.stringify({ object: { sha: 'aaa111' } }), { status: 200 });
    }
    if (href.includes('/git/trees/aaa111') && method === 'GET') {
      return new Response(JSON.stringify({ sha: 'tree0', truncated: false, tree }), { status: 200 });
    }
    const blobGet = href.match(/\/git\/blobs\/(blob-\d+)$/);
    if (blobGet && method === 'GET') {
      return new Response(JSON.stringify({
        encoding: 'base64',
        content: blobs.get(blobGet[1]) || '',
      }), { status: 200 });
    }
    if (href.includes('/git/commits/aaa111') && method === 'GET') {
      return new Response(JSON.stringify({ tree: { sha: 'tree0' } }), { status: 200 });
    }
    if (href.includes('/git/blobs') && method === 'POST') {
      blobN += 1;
      return new Response(JSON.stringify({ sha: `newblob${blobN}` }), { status: 201 });
    }
    if (href.includes('/git/trees') && method === 'POST') {
      return new Response(JSON.stringify({ sha: 'tree1' }), { status: 201 });
    }
    if (href.includes('/git/commits') && method === 'POST') {
      return new Response(JSON.stringify({ sha: 'ccc222' }), { status: 201 });
    }
    if (href.includes('/git/refs') && method === 'POST') {
      return new Response(JSON.stringify({ ref: 'refs/heads/sira/feat' }), { status: 201 });
    }
    if (href.includes('/pulls') && method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      assert.equal(body.access_token, undefined);
      return new Response(JSON.stringify({
        html_url: 'https://github.com/luis/demo/pull/7',
        number: 7,
        title: body.title,
      }), { status: 201 });
    }
    return new Response(JSON.stringify({ message: `unexpected ${method} ${href}` }), { status: 500 });
  }

  return { fetchImpl, calls };
}

describe('github-pr-intent', () => {
  test('detects Luis’s “abre un PR en owner/repo” phrase and extracts the repo', () => {
    assert.equal(isGithubPrRequest('abre un PR en luis/demo que añada un README'), true);
    assert.equal(isGithubPrRequest('open a pull request in acme/api that fixes the login'), true);
    assert.deepEqual(extractOwnerRepo('abre un PR en luis/demo que añada un README'), { owner: 'luis', repo: 'demo' });
    assert.deepEqual(parseOwnerRepo('https://github.com/luis/demo.git'), { owner: 'luis', repo: 'demo' });
    assert.equal(isGithubPrRequest('créame una web de ventas'), false);
    assert.equal(isGithubPrRequest('hola'), false);
    assert.equal(isGithubPrRequest('explica este código'), false);
  });
});

describe('construir GitHub PR workspace jail', () => {
  test('rejects host escapes and never treats host .env as in-scope', () => {
    assert.equal(jailRelPath('../.env').code, 'E_PATH_ESCAPE');
    assert.equal(jailRelPath('/etc/passwd').code, 'E_PATH_ESCAPE');
    assert.equal(jailRelPath('..\\windows').code, 'E_PATH_ESCAPE');
    assert.equal(shouldSkipPath('.env'), true);
    assert.equal(shouldSkipPath('node_modules/leftpad/index.js'), true);
    assert.equal(shouldSkipPath('README.md'), false);
    assert.equal(workBranchName('main', 'main'), 'sira/main');
  });
});

describe('construir GitHub PR flow', () => {
  beforeEach(() => {
    clearSessions();
    mvp.clearRepoSessions();
  });

  test('works with AGENTES_CODING_V2 off (including NODE_ENV=production)', () => {
    assert.equal(isAgentesCodingV2Enabled({ NODE_ENV: 'production', AGENTES_CODING_V2: '1' }), false);
    assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: '0' }), false);
  });

  test('no token → Spanish CTA to /conexiones and fetch is never called', async () => {
    let calls = 0;
    const out = await openRepo({
      userId: 'u1',
      chatId: 'c1',
      repo: 'luis/demo',
      resolveToken: async () => null,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('should not fetch');
      },
      env: { AGENTES_CODING_V2: '0', NODE_ENV: 'production' },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'E_GITHUB_CONNECT');
    assert.match(out.message, /conexiones/i);
    assert.equal(out.connectPath, CONNECT_PATH);
    assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify(out), /gho_|sk-|github_pat_|Bearer |TEST_TOKEN/i);
  });

  test('happy path: open → list/read/write/exec → PR URL, no network, no secret leak', async () => {
    const { fetchImpl, calls } = githubMock({
      files: { 'README.md': '# demo\n', 'src/app.js': 'console.log(1)\n' },
    });
    const { saveArtifact, saved } = fakeSaveArtifact();
    const events = [];

    const opened = await openRepo({
      userId: 'u1',
      chatId: 'c1',
      repo: 'luis/demo',
      modelAlias: 'deepseek-v4-flash',
      resolveToken: async () => ({ accessToken: TOKEN }),
      fetchImpl,
      saveArtifact,
      env: { AGENTES_CODING_V2: '0', NODE_ENV: 'production' },
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.flagRequired, false);
    assert.equal(opened.agentesCodingV2, false);
    assert.equal(opened.brandLabel, 'Sira Rápido');
    assert.equal(opened.fullName, 'luis/demo');
    assert.ok(opened.workspaceId.startsWith('cws_'));
    assert.ok(opened.files.includes('README.md'));
    assert.doesNotMatch(JSON.stringify(opened), /TEST_TOKEN|Bearer|gho_|deepseek|openrouter/i);

    const listed = await listRepoFiles({ userId: 'u1', chatId: 'c1' });
    assert.equal(listed.ok, true);
    assert.ok(listed.files.includes('src/app.js'));

    const read = await readRepoFile({ userId: 'u1', chatId: 'c1', path: 'README.md' });
    assert.equal(read.ok, true);
    assert.match(read.content, /# demo/);

    const escaped = await writeRepoFile({ userId: 'u1', chatId: 'c1', path: '../.env' });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.code, 'E_PATH_ESCAPE');

    const wrote = await writeRepoFile({
      userId: 'u1',
      chatId: 'c1',
      path: 'README.md',
      content: '# demo\n\nhecho desde /agentes\n',
    });
    assert.equal(wrote.ok, true);

    const execLs = await execRepo({ userId: 'u1', chatId: 'c1', command: 'ls' });
    assert.equal(execLs.ok, true);
    assert.match(execLs.stdout, /README\.md/);

    const execEscape = await execRepo({ userId: 'u1', chatId: 'c1', command: 'cat', args: ['/etc/passwd'] });
    assert.equal(execEscape.ok, false);
    assert.equal(execEscape.code, 'E_PATH_ESCAPE');

    const denied = await openPullRequest({
      userId: 'u1',
      chatId: 'c1',
      title: 'docs: nota',
      approved: false,
      resolveToken: async () => ({ accessToken: TOKEN }),
      fetchImpl,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'E_PLAN_GATE');

    const pr = await openPullRequest({
      userId: 'u1',
      chatId: 'c1',
      title: 'docs: nota desde /agentes',
      branch: 'sira/feat-readme',
      approved: true,
      resolveToken: async () => ({ accessToken: TOKEN }),
      fetchImpl,
      saveArtifact,
      onEvent: (ev) => events.push(ev),
      env: { AGENTES_CODING_V2: '0', NODE_ENV: 'production' },
    });
    assert.equal(pr.ok, true);
    assert.equal(pr.prUrl, 'https://github.com/luis/demo/pull/7');
    assert.equal(pr.number, 7);
    assert.equal(pr.branch, 'sira/feat-readme');
    assert.equal(pr.brandLabel, 'Sira Rápido');
    assert.equal(pr.flagRequired, false);
    assert.equal(saved.length, 1);
    assert.match(saved[0].rec.filename, /pr-luis-demo-7/);
    assert.equal(events.some((ev) => ev.type === 'file_artifact'), true);
    assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/pulls')));
    assert.doesNotMatch(JSON.stringify(pr), /TEST_TOKEN|Bearer|gho_|deepseek|openrouter/i);
  });

  test('workspace is scoped to the user', async () => {
    const { fetchImpl } = githubMock();
    const opened = await openRepo({
      userId: 'owner',
      chatId: 'c1',
      repo: 'luis/demo',
      resolveToken: async () => ({ accessToken: TOKEN }),
      fetchImpl,
    });
    assert.equal(opened.ok, true);
    const stolen = await readRepoFile({
      userId: 'intruder',
      chatId: 'c1',
      workspaceId: opened.workspaceId,
      path: 'README.md',
    });
    assert.equal(stolen.ok, false);
    assert.equal(stolen.code, 'E_PARAMS');
  });

  test('agent tools are registered and handlers use injectable GitHub', async () => {
    assert.ok(agentTools.TOOLS_BY_NAME.has('github_open_repo'));
    assert.ok(agentTools.TOOLS_BY_NAME.has('github_open_pull_request'));
    const { fetchImpl } = githubMock();
    const out = await agentTools.github_open_repo.handler(
      { repo: 'luis/demo' },
      {
        userId: 'u',
        chatId: 'c',
        modelAlias: 'Sira Pro',
        resolveGithubToken: async () => ({ accessToken: TOKEN }),
        fetchImpl,
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.brandLabel, 'Sira Pro');
  });
});

describe('construir GitHub PR HTTP + wiring', () => {
  test('health advertises the PR flow without AGENTES_CODING_V2', async () => {
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
        res.on('end', () => resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      }).on('error', reject);
    });
    server.close();
    assert.equal(payload.status, 200);
    assert.equal(payload.body.githubPrFlow, true);
    assert.equal(payload.body.flagRequired, false);
    assert.equal(payload.body.agentesCodingV2, false);
    assert.ok(payload.body.tools.includes('github_open_pull_request'));
  });

  test('chat stream and docs mention the OAuth PR tools', () => {
    const streamSrc = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');
    assert.match(streamSrc, /github_open_repo/);
    assert.match(streamSrc, /github_open_pull_request/);
    assert.match(streamSrc, /isGithubPrRequest/);
    const docs = fs.readFileSync(path.join(__dirname, '../../docs/construir-github-pr.md'), 'utf8');
    assert.match(docs, /\/conexiones/);
    assert.match(docs, /abre un PR/);
    assert.match(docs, /AGENTES_CODING_V2/);
  });
});
