'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLiveApp } = require('../src/services/builder/live-app');
const { scaffoldFromBrief } = require('../src/services/builder/scaffold');

function makeBrief(overrides = {}) {
  return {
    purpose: 'Sistema de barbería',
    platform: 'web',
    audience: 'clientes',
    coreFeatures: ['turnos'],
    dataEntities: [{ name: 'Cliente', fields: ['nombre'] }, { name: 'Turno', fields: ['fecha'] }],
    style: { theme: 'oscuro', refs: [] },
    integrations: [],
    constraints: '',
    openQuestions: [],
    ...overrides,
  };
}

/** Pull the runtime <script> body (the multi-line one, not the data blob). */
function runtimeScript(html) {
  const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  return m ? m[1] : null;
}

test('buildLiveApp returns a complete, self-contained HTML app', () => {
  const html = buildLiveApp(makeBrief());
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/i);
  assert.ok(html.includes('react.production.min.js'), 'loads React from CDN');
  assert.ok(html.includes('id="root"'), 'has a mount node');
  assert.ok(html.includes('window.__APP__'), 'injects app data');
  assert.ok(html.includes('Cliente') && html.includes('Turno'), 'includes the entities');
});

test('the embedded runtime is syntactically valid JavaScript', () => {
  const script = runtimeScript(buildLiveApp(makeBrief()));
  assert.ok(script && script.includes('ReactDOM.createRoot'), 'runtime script present');
  // new Function throws SyntaxError on invalid JS — this catches typos I can't
  // catch in a browser here.
  assert.doesNotThrow(() => new Function(script)); // eslint-disable-line no-new-func
});

test('user data is injection-safe (no breakout from the data script)', () => {
  const html = buildLiveApp(makeBrief({ purpose: 'hola</script><script>alert(1)</script>' }));
  // The injected "<" is unicode-escaped inside the JSON blob.
  assert.ok(html.includes('\\u003c'), 'dangerous < is escaped in the data blob');
  // No raw injected alert script survives as live markup.
  assert.ok(!html.includes('<script>alert(1)'), 'no injected executable script');
});

test('buildLiveApp rejects an invalid brief', () => {
  assert.throws(() => buildLiveApp({ platform: 'smartwatch' }), /invalid ProjectBrief/);
});

test('scaffold ships a runnable index.html as the preview entry', () => {
  const { files } = scaffoldFromBrief(makeBrief());
  const index = files.find((f) => f.path === 'index.html');
  assert.ok(index, 'index.html present');
  assert.equal(index.language, 'html');
  assert.ok(index.content.includes('react.production.min.js'), 'index.html is the live React app');
});
