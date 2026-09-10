'use strict';

/**
 * Deterministic CONSTRUIR project scaffold.
 * Produces a real HTML/JS app plus a Node file-DB server (no prod Postgres).
 */

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsStr(value) {
  return JSON.stringify(String(value ?? ''));
}

function titleFromPrompt(prompt) {
  const raw = String(prompt || '').trim();
  const n = normalize(raw);
  const match = n.match(
    /(?:sitio web|pagina web|website|landing|web app|aplicacion|ecommerce|tienda online|software|app|web|pagina|sitio)\s+(?:de|para|del|con)\s+(.{2,72})/,
  );
  let title = match ? match[1] : n.replace(
    /^(crea(?:r|me)?|haz(?:me)?|genera(?:r|me)?|desarrolla(?:r|me)?|programa(?:r|me)?|construye(?:r|me)?|implementa(?:r|me)?|quiero|necesito|arma(?:r|me)?)\s+/,
    '',
  );
  title = title.replace(/[.!?].*$/, '').trim();
  if (!title || title.length < 2) title = 'Mi app';
  return title.replace(/\b\w/g, (ch) => ch.toUpperCase()).slice(0, 72);
}

function slugify(text) {
  const slug = normalize(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'app';
}

function pickKind(prompt) {
  const n = normalize(prompt);
  if (/\b(nota|notas|todo|tareas|crud|inventario|agenda|contactos|kanban)\b/.test(n)) {
    return 'notes';
  }
  return 'landing';
}

function repoNameFromTitle(title) {
  const slug = slugify(title);
  const name = `sira-${slug}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);
  return name || 'sira-app';
}

function buildDbJs() {
  return `'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'app.json');

function readStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) { /* first run */ }
  return { notes: [], leads: [] };
}

function writeStore(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function createFileDb(filePath = DEFAULT_FILE) {
  const file = filePath;
  return {
    file,
    list(collection) {
      const store = readStore(file);
      return Array.isArray(store[collection]) ? store[collection] : [];
    },
    insert(collection, row) {
      const store = readStore(file);
      if (!Array.isArray(store[collection])) store[collection] = [];
      store[collection].unshift(row);
      writeStore(file, store);
      return row;
    },
    update(collection, id, patch) {
      const store = readStore(file);
      const items = Array.isArray(store[collection]) ? store[collection] : [];
      const idx = items.findIndex((item) => item && item.id === id);
      if (idx < 0) return null;
      items[idx] = { ...items[idx], ...patch, id, updatedAt: new Date().toISOString() };
      store[collection] = items;
      writeStore(file, store);
      return items[idx];
    },
    remove(collection, id) {
      const store = readStore(file);
      const items = Array.isArray(store[collection]) ? store[collection] : [];
      const next = items.filter((item) => !(item && item.id === id));
      const removed = next.length !== items.length;
      store[collection] = next;
      if (removed) writeStore(file, store);
      return removed;
    },
  };
}

module.exports = { createFileDb };
`;
}

function buildServerJs() {
  return `'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createFileDb } = require('./lib/db');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5173;
const db = createFileDb(path.join(ROOT, 'data', 'app.json'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  res.writeHead(status, { 'Content-Length': payload.length, ...headers });
  res.end(payload);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 200_000) {
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel.includes('..') || rel.includes('\\0')) return send(res, 400, 'bad path');
  const file = path.join(ROOT, rel.replace(/^\\/+/g, ''));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found');
  const ext = path.extname(file).toLowerCase();
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[ext] || 'application/octet-stream' });
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, db: 'file', file: 'data/app.json' });
  }
  if (url.pathname === '/api/notes' && req.method === 'GET') {
    return sendJson(res, 200, { items: db.list('notes') });
  }
  if (url.pathname === '/api/notes' && req.method === 'POST') {
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 120);
    const bodyText = String(body.body || '').trim().slice(0, 4000);
    if (!title) return sendJson(res, 400, { error: 'title_required' });
    const row = {
      id: 'n_' + Date.now().toString(36),
      title,
      body: bodyText,
      createdAt: new Date().toISOString(),
    };
    return sendJson(res, 201, db.insert('notes', row));
  }
  const noteMatch = url.pathname.match(/^\\/api\\/notes\\/([^/]+)$/);
  if (noteMatch && req.method === 'DELETE') {
    const ok = db.remove('notes', decodeURIComponent(noteMatch[1]));
    return sendJson(res, ok ? 200 : 404, { ok });
  }
  if (url.pathname === '/api/leads' && req.method === 'GET') {
    return sendJson(res, 200, { items: db.list('leads') });
  }
  if (url.pathname === '/api/leads' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().slice(0, 120);
    const message = String(body.message || '').trim().slice(0, 2000);
    if (!name || !email) return sendJson(res, 400, { error: 'name_email_required' });
    const row = {
      id: 'l_' + Date.now().toString(36),
      name,
      email,
      message,
      createdAt: new Date().toISOString(),
    };
    return sendJson(res, 201, db.insert('leads', row));
  }
  return sendJson(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (String(req.url || '').startsWith('/api/')) return await handleApi(req, res);
    return serveStatic(req, res);
  } catch (err) {
    const status = err && err.message === 'payload_too_large' ? 413 : 400;
    return sendJson(res, status, { error: err && err.message ? err.message : 'bad_request' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('Sira app en http://127.0.0.1:' + PORT + '\\n');
});
`;
}

function buildPackageJson(slug, title) {
  return JSON.stringify({
    name: slug,
    private: true,
    version: '1.0.0',
    description: title,
    scripts: { start: 'node server.js' },
  }, null, 2) + '\n';
}

function buildReadme({ title, slug, kind }) {
  return `# ${title}

App generada desde Sira (\`/agentes\`). Código real: HTML + JS + servidor Node con **base de datos en archivo** (\`data/app.json\`). No usa la base de producción.

## Cómo correrla

\`\`\`bash
node server.js
\`\`\`

Abre http://127.0.0.1:5173

- Vista previa en el chat: abre el HTML (funciona sin servidor, guarda en el navegador).
- Con servidor: los datos persisten en \`data/app.json\` (variante ${kind}).

## GitHub

Si tu cuenta de GitHub está conectada en **Conexiones**, pide en el chat: «súbelo a GitHub».
Si no está conectada: ve a \`/conexiones\` y conecta GitHub. Sira no inventa tokens.

## Base de datos

Esta demo usa un archivo JSON (\`lib/db.js\`) a propósito: cero riesgo a Postgres de producción.

Para un Postgres local de **desarrollo** (nunca el de prod):

1. Levanta Postgres en \`127.0.0.1\` solamente.
2. Crea una base vacía.
3. Sustituye \`lib/db.js\` por un cliente que lea \`DATABASE_URL\` **solo si el host es localhost / 127.0.0.1**.
4. No copies URLs de producción ni dumps de \`.env\`.

## IDE experimental

El shell IDE de \`/agentes\` (árbol + terminal + preview live) solo aparece si \`AGENTES_CODING_V2\` está ON en un entorno que no sea production. Este proyecto **no lo necesita**.

Proyecto: \`${slug}\`
`;
}

function buildNotesHtml(title) {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root { --bg:#0b1220; --card:#121a2b; --line:#243049; --text:#e8eefc; --muted:#93a0b8; --accent:#38BDF8; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
    header { padding:20px 24px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
    h1 { margin:0; font-size:1.15rem; }
    .wrap { display:grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 64px); }
    aside { border-right:1px solid var(--line); padding:16px; }
    main { padding:24px; }
    input, textarea { width:100%; background:#0e1626; color:var(--text); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
    textarea { min-height:160px; margin-top:10px; }
    button { background:var(--accent); color:#042033; border:0; border-radius:10px; padding:10px 14px; font-weight:700; cursor:pointer; }
    .note { padding:10px 12px; border:1px solid var(--line); border-radius:10px; margin-bottom:8px; cursor:pointer; background:var(--card); }
    .muted { color:var(--muted); font-size:.86rem; }
    .row { display:flex; gap:8px; margin-top:12px; }
    @media (max-width: 720px) { .wrap { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>${safeTitle}</h1>
    <span class="muted" id="status">Listo</span>
  </header>
  <div class="wrap">
    <aside>
      <p class="muted">Notas guardadas en este navegador o en el archivo del servidor.</p>
      <div id="list"></div>
    </aside>
    <main>
      <form id="form">
        <input id="title" maxlength="120" placeholder="Título" required>
        <textarea id="body" maxlength="4000" placeholder="Escribe aquí"></textarea>
        <div class="row">
          <button type="submit">Guardar</button>
          <button type="button" id="clear" style="background:#243049;color:var(--text)">Nueva</button>
        </div>
      </form>
    </main>
  </div>
  <script>
    const TITLE = ${jsStr(title)};
    const KEY = 'sira-construir-notes';
    const statusEl = document.getElementById('status');
    const listEl = document.getElementById('list');
    const form = document.getElementById('form');
    const titleEl = document.getElementById('title');
    const bodyEl = document.getElementById('body');

    function localAll() {
      try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
    }
    function localSave(items) { localStorage.setItem(KEY, JSON.stringify(items)); }

    async function load() {
      try {
        const res = await fetch('/api/notes');
        if (res.ok) {
          const data = await res.json();
          statusEl.textContent = 'Servidor + archivo';
          return Array.isArray(data.items) ? data.items : [];
        }
      } catch (_) { /* preview without server */ }
      statusEl.textContent = 'Navegador (localStorage)';
      return localAll();
    }

    function render(items) {
      listEl.innerHTML = items.map((item) => (
        '<div class="note" data-id="' + String(item.id) + '"><strong>' +
        String(item.title || '').replace(/[<>&]/g, '') +
        '</strong><div class="muted">' + String(item.body || '').slice(0, 80).replace(/[<>&]/g, '') + '</div></div>'
      )).join('') || '<p class="muted">Sin notas todavía.</p>';
    }

    async function refresh() { render(await load()); }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = { title: titleEl.value.trim(), body: bodyEl.value.trim() };
      if (!payload.title) return;
      try {
        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          titleEl.value = '';
          bodyEl.value = '';
          return refresh();
        }
      } catch (_) { /* fall through */ }
      const items = localAll();
      items.unshift({ id: 'n_' + Date.now(), ...payload, createdAt: new Date().toISOString() });
      localSave(items);
      titleEl.value = '';
      bodyEl.value = '';
      refresh();
    });
    document.getElementById('clear').addEventListener('click', () => {
      titleEl.value = '';
      bodyEl.value = '';
    });
    refresh();
    document.title = TITLE;
  </script>
</body>
</html>
`;
}

function buildLandingHtml(title) {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root { --bg:#071018; --card:#101826; --text:#f4f7fb; --muted:#9aa8bd; --accent:#38BDF8; --line:#1e2a3d; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:
      radial-gradient(1200px 500px at 10% -10%, #123154 0%, transparent 50%), var(--bg); color:var(--text); }
    header, footer { padding:20px 8vw; display:flex; justify-content:space-between; align-items:center; }
    .hero { padding:72px 8vw 48px; max-width: 920px; }
    h1 { font-size: clamp(2rem, 5vw, 3.4rem); line-height:1.1; margin:0 0 16px; }
    p { color:var(--muted); font-size:1.05rem; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:16px; padding:0 8vw 48px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px; }
    form { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px; margin:0 8vw 64px; max-width:560px; }
    input, textarea { width:100%; margin:8px 0; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:#0b1320; color:var(--text); }
    button { background:var(--accent); color:#042033; border:0; border-radius:999px; padding:12px 18px; font-weight:700; cursor:pointer; }
    .ok { color:#7dd3fc; margin-top:10px; }
  </style>
</head>
<body>
  <header>
    <strong>${safeTitle}</strong>
    <button onclick="document.getElementById('lead').scrollIntoView({behavior:'smooth'})">Empezar</button>
  </header>
  <section class="hero">
    <h1>${safeTitle}</h1>
    <p>Sitio funcional generado desde Sira. La página se previsualiza aquí y se descarga como proyecto con servidor y base de datos en archivo.</p>
  </section>
  <section class="grid">
    <article class="card"><h3>Código real</h3><p>HTML, JS y un servidor Node. No es un Word.</p></article>
    <article class="card"><h3>Datos locales</h3><p>Los leads se guardan en el navegador o en <code>data/app.json</code>.</p></article>
    <article class="card"><h3>GitHub</h3><p>Conecta GitHub en Conexiones y pide publicar el repo.</p></article>
  </section>
  <form id="lead">
    <h2>Contacto</h2>
    <input id="name" maxlength="80" placeholder="Nombre" required>
    <input id="email" type="email" maxlength="120" placeholder="Email" required>
    <textarea id="message" maxlength="2000" placeholder="Mensaje" rows="4"></textarea>
    <button type="submit">Enviar</button>
    <div class="ok" id="status" hidden>Guardado.</div>
  </form>
  <footer><span>${safeTitle}</span><span>Sira</span></footer>
  <script>
    const KEY = 'sira-construir-leads';
    document.getElementById('lead').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        name: document.getElementById('name').value.trim(),
        email: document.getElementById('email').value.trim(),
        message: document.getElementById('message').value.trim(),
      };
      let saved = false;
      try {
        const res = await fetch('/api/leads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        saved = res.ok;
      } catch (_) { saved = false; }
      if (!saved) {
        const items = JSON.parse(localStorage.getItem(KEY) || '[]');
        items.unshift({ id: 'l_' + Date.now(), ...payload, createdAt: new Date().toISOString() });
        localStorage.setItem(KEY, JSON.stringify(items));
      }
      document.getElementById('status').hidden = false;
      event.target.reset();
    });
  </script>
</body>
</html>
`;
}

function isCompleteHtml(html) {
  const text = String(html || '');
  return /<html[\s>]/i.test(text) && /<body[\s>]/i.test(text) && text.length > 40;
}

function scaffoldConstruirProject(opts = {}) {
  const prompt = String(opts.prompt || '').trim();
  const title = String(opts.title || titleFromPrompt(prompt) || 'Mi app').slice(0, 72);
  const kind = opts.kind || pickKind(prompt);
  const slug = repoNameFromTitle(title);
  const html = isCompleteHtml(opts.html)
    ? String(opts.html)
    : (kind === 'notes' ? buildNotesHtml(title) : buildLandingHtml(title));

  const files = {
    'index.html': html,
    'server.js': buildServerJs(),
    'lib/db.js': buildDbJs(),
    'data/app.json': '{\n  "notes": [],\n  "leads": []\n}\n',
    'package.json': buildPackageJson(slug, title),
    'README.md': buildReadme({ title, slug, kind }),
  };

  return {
    title,
    slug,
    kind,
    files,
    fileNames: Object.keys(files),
  };
}

module.exports = {
  normalize,
  escapeHtml,
  titleFromPrompt,
  slugify,
  pickKind,
  repoNameFromTitle,
  isCompleteHtml,
  scaffoldConstruirProject,
};
