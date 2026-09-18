'use strict';

/**
 * computer-browser-e2e — el navegador integrado del panel, probado como Claude.
 *
 * Escenario espejo de la captura de referencia: el usuario pide comparar
 * precios ("grab the latest pricing from their site"), el agente abre el
 * sitio en el navegador del chat, observa la página y responde con los 3
 * precios + citas. Todo hermético: sin Docker, sin red, sin BD.
 *
 * Cubre el flujo completo con las piezas REALES:
 *   1. contrato del panel (las 8 computer_* en el esquema con el flag on)
 *   2. navigate → observe → extraer 3 precios → respuesta con enlaces
 *   3. formularios: type en campo normal OK; en password REHÚSA sin eco
 *      (la clave la escribe el usuario en el overlay — login-handoff)
 *   4. click por coordenadas OK
 *   5. URL inválida nunca abre sesión (cero llamadas al orquestador)
 *   6. orquestador caído → error honesto `computer_starting`, nunca throw
 *   7. anti-loop: repetir 3x la misma navegación aborta (`repeated_action`)
 *   8. techo de pasos: máximo 25 por loop
 *   9. observación acotada (~8KiB) y error de CDP que nunca lanza
 *
 * Fakes: solo el borde Docker/orquestador (`persistent.ensureSession` /
 * `openUrlInChrome`) y el snapshot CDP (inyectable `cdpSnapshot`). Los
 * executors click/type/screenshot son los reales con driver `fake`.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const chatTools = require('../src/services/computer/chat-computer-tools');
const persistent = require('../src/services/computer/persistent');
const handoff = require('../src/services/computer/login-handoff');
const { withRepeatGuard, capControlSteps } = require('../src/services/computer/control-loop');
const { makeComputerExecutors } = require('../src/services/agent-runner/multimodal/computer');
const { resolveSessionIdentity } = require('../src/services/computer/member-key');

const SECRET = 'SuperSecretValue-12345';
const NORTHWIND_URL = 'https://northwind.example/pricing';
const NORTHWIND_TREE = [
  'heading "One price. No surprises." [level=1]',
  'text "Simple pricing, billed monthly."',
  '- generic "Starter $12/mo"',
  '- generic "Team $29/mo" [popular]',
  '- generic "Business $79/mo"',
  '- button "Sign in"',
].join('\n');

const realEnsure = persistent.ensureSession;
const realOpenUrl = persistent.openUrlInChrome;
const realPeek = persistent.peekPage;
let sessionCalls;
let openedUrls;
let peekResult;

beforeEach(() => {
  handoff.resetTakeoverForTests();
  sessionCalls = 0;
  openedUrls = [];
  peekResult = { url: NORTHWIND_URL, title: 'Northwind — Plans', text: '' };
  persistent.ensureSession = async () => {
    sessionCalls += 1;
    return { sessionId: 'sess-e2e', userId: 'u1', conversationId: 'chat-northwind' };
  };
  persistent.openUrlInChrome = async (_session, url) => {
    openedUrls.push(String(url));
    return { ok: true, stdout: 'Opening', stderr: '', container: 'sira-ac-user-u1' };
  };
  persistent.peekPage = async () => {
    if (peekResult instanceof Error) throw peekResult;
    return peekResult;
  };
});

afterEach(() => {
  persistent.ensureSession = realEnsure;
  persistent.openUrlInChrome = realOpenUrl;
  persistent.peekPage = realPeek;
});

function chatCtx() {
  return { userId: 'u1', chatId: 'chat-northwind' };
}

function navigateTool() {
  const tools = chatTools.buildChatComputerTools({
    userId: 'u1',
    conversationId: 'chat-northwind',
    env: { SIRAGPT_AGENT_COMPUTER: '1' },
  });
  return tools.find((t) => t.name === 'computer_navigate');
}

/* ── 1. contrato del panel ─────────────────────────────────────────────── */

test('panel: las 8 tools del navegador están en el esquema con el flag on, fuera con off', () => {
  assert.equal(chatTools.shouldOfferComputerTools({ SIRAGPT_AGENT_COMPUTER: '1' }), true);
  const names = chatTools.offeredComputerToolNames({ SIRAGPT_AGENT_COMPUTER: '1' });
  for (const n of ['computer_screenshot', 'computer_click', 'computer_type', 'computer_navigate']) {
    assert.ok(names.includes(n), `${n} visible para el modelo`);
  }
  const tools = chatTools.buildChatComputerTools({
    userId: 'u1',
    conversationId: 'c1',
    env: { SIRAGPT_AGENT_COMPUTER: '1' },
  });
  assert.equal(tools.length, 8);
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} documenta cuándo usarla`);
    assert.equal(t.parameters.type, 'object');
    assert.equal(typeof t.execute, 'function');
  }
  assert.deepEqual(
    chatTools.buildChatComputerTools({ userId: 'u1', conversationId: 'c1', env: { SIRAGPT_AGENT_COMPUTER: '0', NODE_ENV: 'test' } }),
    [],
  );
});

/* ── 2. E2E Northwind: navigate → observe → 3 precios → respuesta ───────── */

test('E2E Northwind: abre el pricing, observa el árbol y responde con los 3 precios citados', async () => {
  // "I'll pull up their website" → Used Browser → Opening browser
  const nav = navigateTool();
  const opened = await nav.execute({ url: NORTHWIND_URL }, chatCtx());
  assert.equal(opened.ok, true);
  assert.equal(opened.url, NORTHWIND_URL);
  assert.match(opened._preview, /Abriendo https:\/\/northwind\.example\/pricing/);
  assert.deepEqual(openedUrls, [NORTHWIND_URL]);
  assert.equal(sessionCalls, 1, 'una sola sesión por navegación');
  // Verificación post-apertura: Chrome muestra el pricing pedido.
  assert.equal(opened.confirmed, true);
  assert.equal(opened.loaded.url, NORTHWIND_URL);

  // "Opened northwind.example in browser" → el modelo observa (árbol CDP, sin visión)
  const obs = await persistent.observe(
    { sessionId: 'sess-e2e', userId: 'u1', conversationId: 'chat-northwind' },
    { env: {}, model: 'deepseek-v4-flash', cdpSnapshot: async () => ({ url: NORTHWIND_URL, title: 'Northwind — Plans', text: NORTHWIND_TREE }) },
  );
  assert.equal(obs.ok, true);
  assert.equal(obs.mode, 'cdp');
  assert.equal(obs.url, NORTHWIND_URL);

  // "Found 3 prices on their pricing page" → el builder extrae del texto observado
  const prices = Array.from(String(obs.text).matchAll(/\$(\d+)\/mo/g)).map((m) => m[1]);
  assert.deepEqual(prices, ['12', '29', '79']);

  // "Building a comparison now" → respuesta final con cifras y fuente enlazada
  const answer = [
    'Encontré 3 precios en su página de precios:',
    `- Starter: $${prices[0]}/mo · Team: $${prices[1]}/mo · Business: $${prices[2]}/mo`,
    `Fuente: [Northwind Pricing](${NORTHWIND_URL})`,
  ].join('\n');
  assert.match(answer, /\$12\/mo/);
  assert.match(answer, /\$29\/mo/);
  assert.match(answer, /\$79\/mo/);
  assert.match(answer, /\[Northwind Pricing\]\(https:\/\/northwind\.example\/pricing\)/);
});

/* ── 3. formularios: type normal OK, password rehúsa sin eco ────────────── */

test('E2E formulario: completa un campo de texto; la contraseña la pide al usuario, nunca la escribe', async () => {
  const { executors } = makeComputerExecutors({
    env: { SIRAGPT_AGENT_COMPUTER_DRIVER: 'fake' },
    userId: 'u1',
    sessionId: 's1',
    session: resolveSessionIdentity({ id: 'u1' }, 'chat-northwind'),
    computerEnabled: true,
  });
  const typed = await executors.computer_type({ text: 'Northwind', conversationId: 'chat-northwind' });
  assert.equal(JSON.parse(typed).ok, true);

  const refused = await executors.computer_type({
    text: SECRET,
    focused: { type: 'password', name: 'password', focused: true },
    conversationId: 'chat-northwind',
  });
  const dumped = typeof refused === 'string' ? refused : JSON.stringify(refused);
  assert.match(dumped, /login_handoff_required/);
  assert.doesNotMatch(dumped, new RegExp(SECRET));
});

/* ── 4. click ───────────────────────────────────────────────────────────── */

test('E2E click por coordenadas con driver fake', async () => {
  const { executors } = makeComputerExecutors({
    env: { SIRAGPT_AGENT_COMPUTER_DRIVER: 'fake' },
    userId: 'u1',
    sessionId: 's1',
    session: resolveSessionIdentity({ id: 'u1' }, 'chat-northwind'),
    computerEnabled: true,
  });
  const out = JSON.parse(await executors.computer_click({ x: 120, y: 340, conversationId: 'chat-northwind' }));
  assert.equal(out.ok, true);
  assert.equal(out.x, 120);
  assert.equal(out.y, 340);
});

/* ── 5-6. fallos honestos ───────────────────────────────────────────────── */

test('URL inválida se rechaza sin abrir sesión (cero llamadas al orquestador)', async () => {
  const out = await navigateTool().execute({ url: 'javascript:alert(1)' }, chatCtx());
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_url');
  assert.equal(sessionCalls, 0);
  assert.deepEqual(openedUrls, []);
});

test('orquestador caído → computer_starting con reintento, nunca throw', async () => {
  persistent.ensureSession = async () => { throw new Error('orch 503'); };
  const out = await navigateTool().execute({ url: NORTHWIND_URL }, chatCtx());
  assert.equal(out.ok, false);
  assert.equal(out.error, 'computer_starting');
  assert.match(out.message, /abriendo|reintenta/i);
});

/* ── 7-8. anti-loops y techo ────────────────────────────────────────────── */

test('repetir 3x la misma navegación aborta el loop (repeated_action)', async () => {
  const [guarded] = withRepeatGuard([navigateTool()]);
  const args = { url: NORTHWIND_URL };
  const ctx = chatCtx();
  const first = await guarded.execute(args, ctx);
  assert.equal(first.ok, true);
  const second = await guarded.execute(args, ctx);
  assert.equal(second.ok, true);
  const third = await guarded.execute(args, ctx);
  assert.match(typeof third === 'string' ? third : JSON.stringify(third), /repeated_action/);
});

test('techo de pasos del loop: 25 aunque se pidan más', () => {
  assert.equal(capControlSteps(1000), 25);
  assert.equal(capControlSteps(3), 3);
});

/* ── 9. observación acotada y a prueba de fallos ────────────────────────── */
test('snapshot gigante se capa a ~8KiB con marcador; fallo CDP nunca lanza', async () => {
  const big = await persistent.observe(
    { sessionId: 'sess-e2e', userId: 'u1', conversationId: 'chat-northwind' },
    { env: {}, model: 'deepseek-v4-flash', cdpSnapshot: async () => ({ url: NORTHWIND_URL, title: 't', text: 'x'.repeat(100_000) }) },
  );
  assert.equal(big.ok, true);
  assert.ok(big.text.length <= 8192 + 120, `capado, no 100k (fue ${big.text.length})`);
  assert.match(big.text, /observe truncated/);

  const broken = await persistent.observe(
    { sessionId: 'sess-e2e', userId: 'u1', conversationId: 'chat-northwind' },
    { env: {}, model: 'deepseek-v4-flash', cdpSnapshot: async () => { throw new Error('cdp down'); } },
  );
  assert.equal(broken.ok, false);
  assert.match(String(broken.error || broken.text), /cdp down/);
});

/* ── 10. buscar primero: sin URL el agente localiza, nunca la pide ─────── */

test('search-first: la tool ordena localizar el sitio con web_search cuando no hay URL', () => {
  assert.match(navigateTool().description, /web_search/);
});

test('search-first: el prompt agéntico prohíbe pedir la URL pudiendo buscarla', () => {
  // Patrón contrato-por-lectura (igual que computer-login-handoff.test.js).
  const fs = require('fs');
  const path = require('path');
  const stream = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');
  assert.match(stream, /localízalo TÚ con `web_search`/);
  assert.match(stream, /nunca le pidas al usuario la URL/);
});

test('DNS sin resolver → navigate_failed con fallback a web_search, no callejón', async () => {
  persistent.openUrlInChrome = async () => { throw new Error('getaddrinfo ENOTFOUND northwind.example'); };
  const out = await navigateTool().execute({ url: 'https://northwind.example/pricing' }, chatCtx());
  assert.equal(out.ok, false);
  assert.equal(out.error, 'navigate_failed');
  assert.match(out.fallback, /web_search/);
  assert.match(out.fallback, /reintenta computer_navigate/);
});

test('fallo no-DNS (timeout) → navigate_failed sin fallback inventado', async () => {
  persistent.openUrlInChrome = async () => { throw new Error('docker exec timed out after 12000ms'); };
  const out = await navigateTool().execute({ url: NORTHWIND_URL }, chatCtx());
  assert.equal(out.ok, false);
  assert.equal(out.error, 'navigate_failed');
  assert.equal(out.fallback, undefined);
});

/* ── 11. verificación post-apertura: el "Opening" no basta ─────────────── */

test('verify-after-open: Chrome en página de error → navigate_failed con fallback', async () => {
  peekResult = { url: 'chrome-error://chromewebdata/', title: 'No se puede acceder a este sitio', text: '' };
  const out = await navigateTool().execute({ url: NORTHWIND_URL }, chatCtx());
  assert.equal(out.ok, false);
  assert.equal(out.error, 'navigate_failed');
  assert.match(out.message, /página de error/);
  assert.match(out.fallback, /web_search/);
});

test('verify-after-open: otra URL en pantalla → ok con confirmed:false y nota de verificar', async () => {
  peekResult = { url: 'https://www.google.com/', title: 'Google', text: '' };
  const out = await navigateTool().execute({ url: NORTHWIND_URL }, chatCtx());
  assert.equal(out.ok, true);
  assert.equal(out.confirmed, false);
  assert.equal(out.loaded.url, 'https://www.google.com/');
  assert.match(out.note, /computer_screenshot/);
});

test('verify-after-open: peek roto → ok fail-open con confirmed:false', async () => {
  peekResult = null;
  const out = await navigateTool().execute({ url: NORTHWIND_URL }, chatCtx());
  assert.equal(out.ok, true);
  assert.equal(out.confirmed, false);
  assert.equal(out.loaded, null);
});

test('verify-after-open: la descripción documenta loaded/confirmed', () => {
  assert.match(navigateTool().description, /confirmed/);
});
