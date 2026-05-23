/**
 * Unit tests for the read_url skill.
 *
 * We spin up a tiny in-process HTTP server so the tests don't depend
 * on the open internet (slow, flaky, blocked in some CI sandboxes).
 * The server simulates: HTML pages, 404s, redirects (same- and cross-
 * domain), robots.txt blocks, hanging requests (timeout), and
 * oversized bodies (truncation cap).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const skill = require('../src/skills/read_url/handler');
const { parseRobots, pathDisallowed, normalizeUrl } = skill._internal;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('normalizeUrl rejects non-http schemes and bad input', () => {
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl(null), null);
  assert.ok(normalizeUrl('https://example.com/'));
});

test('parseRobots handles wildcard groups and Disallow paths', () => {
  const rules = parseRobots([
    'User-agent: *',
    'Disallow: /private',
    'Allow: /public  # ignored',
    '',
    'User-agent: SiraGPTBot',
    'Disallow: /no-bots',
  ].join('\n'));
  assert.deepEqual(rules, [
    { agent: '*', path: '/private' },
    { agent: 'siragptbot', path: '/no-bots' },
  ]);
});

test('pathDisallowed prefers SiraGPTBot-specific rules over wildcard', () => {
  const rules = [
    { agent: '*', path: '/everywhere' },
    { agent: 'siragptbot', path: '/no-bots' },
  ];
  // Wildcard rule must NOT apply once a SiraGPTBot section exists.
  assert.equal(pathDisallowed(rules, '/everywhere'), false);
  assert.equal(pathDisallowed(rules, '/no-bots'), true);
  // Empty Disallow allows everything.
  assert.equal(pathDisallowed([{ agent: '*', path: '' }], '/anything'), false);
});

test('read_url returns Readability markdown for a normal HTML page', async () => {
  const html = `<!doctype html><html><head><title>Hola Mundo</title></head><body>
    <header>Nav · Menu · About</header>
    <article>
      <h1>Título principal</h1>
      <p>Esto es un párrafo largo con suficiente texto para superar el umbral de Readability y producir un extract limpio de la página de prueba que escribimos para validar el skill read_url. Necesita más texto para activar el extractor: rellenamos con palabras hasta cruzar el charThreshold y aseguramos que la versión markdown contenga el contenido principal sin la navegación lateral ni el footer del documento.</p>
      <p>Segundo párrafo con un <a href="/otra">enlace interno</a>.</p>
    </article>
    <footer>© 2026</footer>
  </body></html>`;
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  try {
    const out = await skill.execute({ url: `${baseUrl}/articulo` });
    assert.equal(out.error, undefined);
    assert.equal(out.title, 'Hola Mundo');
    assert.match(out.content_markdown, /Título principal/);
    assert.match(out.content_markdown, /Segundo párrafo/);
    // The footer should be stripped by Readability.
    assert.doesNotMatch(out.content_markdown, /© 2026/);
    assert.equal(out.source_url, `${baseUrl}/articulo`);
  } finally {
    await closeServer(server);
  }
});

test('read_url surfaces a 404 as http_error', async () => {
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(404); res.end('not found');
  });
  try {
    const out = await skill.execute({ url: `${baseUrl}/missing` });
    assert.equal(out.error, 'http_error');
    assert.equal(out.status, 404);
  } finally {
    await closeServer(server);
  }
});

test('read_url blocks cross-domain redirects', async () => {
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    if (req.url === '/jump') {
      res.writeHead(302, { location: 'https://evil.example/landing' });
      res.end();
      return;
    }
    res.writeHead(200); res.end('ok');
  });
  try {
    const out = await skill.execute({ url: `${baseUrl}/jump` });
    assert.equal(out.error, 'cross_domain_redirect_blocked');
    assert.equal(out.to, 'evil.example');
  } finally {
    await closeServer(server);
  }
});

test('read_url allows same-domain redirects', async () => {
  const html = '<html><head><title>Final</title></head><body><article><h1>Final</h1><p>' +
    'x'.repeat(400) + '</p></article></body></html>';
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    if (req.url === '/start') {
      res.writeHead(302, { location: '/end' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  try {
    const out = await skill.execute({ url: `${baseUrl}/start` });
    assert.equal(out.error, undefined);
    assert.equal(out.source_url, `${baseUrl}/end`);
  } finally {
    await closeServer(server);
  }
});

test('read_url honors robots.txt Disallow', async () => {
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private');
      return;
    }
    res.writeHead(200); res.end('<html><body>secret</body></html>');
  });
  try {
    const out = await skill.execute({ url: `${baseUrl}/private/leak` });
    assert.equal(out.error, 'robots_disallowed');
  } finally {
    await closeServer(server);
  }
});

test('read_url times out on a hanging server', async () => {
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    // Send headers then hang — exercises the 8 s wall-clock cap.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<html><body>');
    // never end
  });
  try {
    const t0 = Date.now();
    const out = await skill.execute({ url: `${baseUrl}/hang` });
    const elapsed = Date.now() - t0;
    assert.equal(out.error, 'timeout');
    // Must not exceed the hard cap by more than a small grace period
    // (jsdom teardown, robots fetch jitter).
    assert.ok(elapsed < 11000, `elapsed ${elapsed}ms`);
  } finally {
    server.closeAllConnections?.();
    await closeServer(server);
  }
});

test('read_url applies the maxChars cap', async () => {
  const big = '<html><head><title>Big</title></head><body><article><h1>Big</h1><p>' +
    'lorem '.repeat(5000) + '</p></article></body></html>';
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(big);
  });
  try {
    const out = await skill.execute({ url: `${baseUrl}/big`, maxChars: 500 });
    assert.equal(out.error, undefined);
    assert.ok(out.truncated_markdown, 'expected truncated_markdown=true');
    assert.ok(out.content_markdown.length <= 600); // 500 + truncation notice
    assert.match(out.content_markdown, /recortado/);
  } finally {
    await closeServer(server);
  }
});
