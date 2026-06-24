'use strict';

/**
 * codex/starter-files — deterministic minimal Vite starter for a freshly
 * provisioned Codex workspace. Pure: same input → identical bytes. User text
 * is HTML-escaped (same anti-injection convention as lib/code-agent/escape.ts).
 */

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function starterFiles({ projectName } = {}) {
  const rawName = String(projectName || '').trim().slice(0, 80);
  const name = escapeHtml(rawName) || 'Proyecto Codex';

  const pkg = {
    name: 'codex-workspace',
    private: true,
    version: '0.0.1',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    devDependencies: { vite: '^7.0.0' },
  };

  const indexHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name} · Codex</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0b0b10; color: #e8e8f0; }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
      p { color: #99a; margin: 0; }
      .dot { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; background: #7c5cff; margin-right: 0.5rem; }
    </style>
  </head>
  <body>
    <main>
      <h1><span class="dot"></span>${name}</h1>
      <p>Workspace listo. Describe en el chat qué quieres construir.</p>
    </main>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;

  return [
    { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'index.html', content: indexHtml },
    { path: 'src/main.js', content: 'console.log("codex workspace ready");\n' },
    { path: '.gitignore', content: 'node_modules\ndist\n' },
  ];
}

module.exports = { starterFiles, escapeHtml };
