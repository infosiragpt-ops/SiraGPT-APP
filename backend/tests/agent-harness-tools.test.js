'use strict';

/**
 * agent-harness built-in tools — web_fetch (SSRF posture + sanitization +
 * caps), run_javascript (WASM sandbox limits + isolation) and
 * create_artifact (existing artifact-store integration).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertSafeUrl,
  executeAgentWebFetch,
  capText,
  htmlToReadableText,
  MAX_TEXT_CHARS,
} = require('../src/services/agent-harness/tools/web-fetch-tool');
const { executeRunJavascript } = require('../src/services/agent-harness/tools/run-javascript-tool');

// ── web_fetch: URL safety ───────────────────────────────────────────────────

test('web_fetch: private, loopback, link-local, metadata and non-http URLs are blocked', () => {
  const blocked = [
    'http://localhost:3000/x',
    'http://app.localhost/x',
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://172.16.0.9/x',
    'http://192.168.1.1/router',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://backend.internal/admin',
    'file:///etc/passwd',
    'gopher://example.com/',
    'http://user:secret@example.com/',
    'http://[::1]/x',
  ];
  for (const url of blocked) {
    assert.throws(() => assertSafeUrl(url), `expected block: ${url}`);
  }
  assert.ok(assertSafeUrl('https://example.com/page?q=1'));
  assert.ok(assertSafeUrl('http://93.184.216.34/'), 'public IP literals are allowed');
});

test('web_fetch: redirects are re-validated per hop — a public page cannot bounce into metadata', async () => {
  const fetchMock = async (url) => {
    if (String(url).startsWith('https://example.com/')) {
      return {
        status: 302,
        headers: { get: (h) => (h.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data' : null) },
        body: { cancel: async () => {} },
      };
    }
    throw new Error('must never fetch the redirect target');
  };
  await assert.rejects(
    () => executeAgentWebFetch({ url: 'https://example.com/jump' }, { fetch: fetchMock, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }),
    /web_fetch_blocked_host|not reachable/i,
  );
});

test('web_fetch: DNS resolving to a private address is rejected (anti-rebinding)', async () => {
  await assert.rejects(
    () => executeAgentWebFetch(
      { url: 'https://rebind.example.com/' },
      { fetch: async () => { throw new Error('must not fetch'); }, lookup: async () => [{ address: '10.0.0.8', family: 4 }] },
    ),
    /resolved to a private|web_fetch_resolved_blocked/i,
  );
});

test('web_fetch: HTML is sanitized to readable text (scripts dropped) and capped with a marker', async () => {
  const html = `<!DOCTYPE html><html><head><title>Página</title><script>steal()</script></head>
    <body><article><h1>Titular</h1>${'<p>contenido relevante.</p>'.repeat(40)}</article></body></html>`;
  const fetchMock = async () => ({
    status: 200,
    url: 'https://example.com/article',
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    body: null,
    text: async () => html,
  });
  const result = await executeAgentWebFetch(
    { url: 'https://example.com/article', maxChars: 600 },
    { fetch: fetchMock, lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
  );
  assert.equal(result.status, 200);
  assert.ok(!/steal\(\)/.test(result.text), 'script bodies must never reach the model');
  assert.match(result.text, /contenido relevante/);
  assert.equal(result.truncated, true);
  assert.match(result.text, /contenido truncado/);
  assert.ok(result.text.length <= 600);
});

test('web_fetch: binary responses come back as a structured note, not bytes (and the body is cancelled)', async () => {
  let cancelled = false;
  const fetchMock = async () => ({
    status: 200,
    url: 'https://example.com/f.png',
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
    body: { cancel: async () => { cancelled = true; } },
    text: async () => 'PNGRAWBYTES',
  });
  const result = await executeAgentWebFetch(
    { url: 'https://example.com/f.png' },
    { fetch: fetchMock, lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
  );
  assert.equal(result.text, '');
  assert.match(result.note, /binario/);
  // The unread binary body must be cancelled — otherwise the socket leaks.
  assert.equal(cancelled, true, 'binary response body was cancelled, not leaked');
});

test('web_fetch: capText cap is exactly the documented 50k default', () => {
  const { text, truncated } = capText('a'.repeat(MAX_TEXT_CHARS + 5_000), MAX_TEXT_CHARS);
  assert.equal(truncated, true);
  assert.equal(text.length, MAX_TEXT_CHARS);
});

test('web_fetch: tag-strip fallback still extracts text from minimal html', () => {
  const { text } = htmlToReadableText('<html><body><style>.x{}</style><p>hola <b>mundo</b></p></body></html>', 'https://e.com');
  assert.match(text, /hola/);
  assert.ok(!/\.x\{\}/.test(text));
});

// ── run_javascript: WASM sandbox ────────────────────────────────────────────

test('run_javascript: returns the last expression and captures console output', async () => {
  const result = await executeRunJavascript({ code: 'const xs=[1,2,3]; console.log("sum", xs.reduce((a,b)=>a+b,0)); xs.map(x=>x*2)' });
  assert.equal(result.ok, true);
  assert.equal(result.result, '[2,4,6]');
  assert.deepEqual(result.logs, ['sum 6']);
});

test('run_javascript: infinite loops are interrupted at the deadline', async () => {
  const started = Date.now();
  const result = await executeRunJavascript({ code: 'while(true){}', timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 4_000, 'interrupt must fire near the deadline, not the hard cap');
});

test('run_javascript: guest has no require / fs / process / fetch / timers', async () => {
  const probe = await executeRunJavascript({
    code: '[typeof require, typeof process, typeof fetch, typeof setTimeout].join("|")',
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.result, 'undefined|undefined|undefined|undefined');
});

test('run_javascript: runtime errors are surfaced as data, never thrown', async () => {
  const result = await executeRunJavascript({ code: 'JSON.parse("{nope")' });
  assert.equal(result.ok, false);
  assert.match(result.error, /SyntaxError/);
});

test('run_javascript: oversized memory allocations fail inside the 64MB cap', async () => {
  const result = await executeRunJavascript({
    code: 'const chunks=[]; for(let i=0;i<4000;i++){ chunks.push("x".repeat(1024*1024)); } chunks.length',
    timeoutMs: 5000,
  });
  assert.equal(result.ok, false, 'allocating ~4GB must fail (memory limit or interrupt)');
});

// ── create_artifact: integration with the existing artifact store ───────────

test('create_artifact: persists through task-tools saveArtifact and emits file_artifact', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifacts-'));
  const prevDir = process.env.AGENT_ARTIFACT_DIR;
  process.env.AGENT_ARTIFACT_DIR = tmpDir;
  t.after(() => {
    if (prevDir === undefined) delete process.env.AGENT_ARTIFACT_DIR; else process.env.AGENT_ARTIFACT_DIR = prevDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  // task-tools captures ARTIFACT_DIR at require time — force a fresh load.
  delete require.cache[require.resolve('../src/services/agents/task-tools')];
  delete require.cache[require.resolve('../src/services/agent-harness/tools/create-artifact-tool')];
  const { buildCreateArtifactTool } = require('../src/services/agent-harness/tools/create-artifact-tool');

  const events = [];
  const tool = buildCreateArtifactTool();
  const result = await tool.execute(
    { title: 'Mi página', type: 'html', content: '<!DOCTYPE html><html><body><h1>Hola</h1></body></html>' },
    { userId: 'u1', chatId: 'c1', onEvent: (evt) => events.push(evt) },
  );
  assert.equal(result.ok, true);
  assert.match(result.filename, /^Mi-p/);
  assert.match(result.downloadUrl, /^\/api\/agent\/artifact\//);
  const artifactEvent = events.find((e) => e.type === 'file_artifact');
  assert.ok(artifactEvent, 'file_artifact must be emitted for the chat UI');
  assert.match(artifactEvent.artifact.previewHtml, /<h1>Hola<\/h1>/);
  // the binary actually landed in the artifact store
  const stored = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.html'));
  assert.equal(stored.length, 1);
});

test('create_artifact: schema rejects unknown types and empty content', () => {
  delete require.cache[require.resolve('../src/services/agent-harness/tools/create-artifact-tool')];
  const { buildCreateArtifactTool } = require('../src/services/agent-harness/tools/create-artifact-tool');
  const tool = buildCreateArtifactTool();
  assert.equal(tool.inputSchema.safeParse({ title: 'x', type: 'exe', content: 'x' }).success, false);
  assert.equal(tool.inputSchema.safeParse({ title: 'x', type: 'html', content: '' }).success, false);
  assert.equal(tool.inputSchema.safeParse({ title: 'x', type: 'code', content: 'print(1)', language: 'python' }).success, true);
});
