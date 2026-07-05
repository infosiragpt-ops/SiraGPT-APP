'use strict';

/**
 * codex/starter-files — deterministic React 18 + Vite 7 + TypeScript starter for
 * a freshly provisioned Codex workspace. This matches the documented /code
 * contract (Vite 7 + React 18 + TS) and, crucially, what the agent model
 * naturally generates (React/JSX) — so the model builds ON a working React
 * foundation instead of bootstrapping one from a vanilla-JS shell (the old
 * starter), which produced broken Next/Vite hybrids that booted to an error
 * overlay. Pure: same input -> identical bytes. User text is escaped.
 */

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Escape a string for safe embedding as JSX text (no tags/braces that could
// break out of the element).
function jsxText(s) {
  return String(s ?? '')
    .replaceAll('<', '')
    .replaceAll('>', '')
    .replaceAll('{', '')
    .replaceAll('}', '');
}

function starterFiles({ projectName } = {}) {
  const rawName = String(projectName || '').trim().slice(0, 80);
  const htmlName = escapeHtml(rawName) || 'Proyecto Codex';
  const jsxName = jsxText(rawName) || 'Proyecto Codex';

  const pkg = {
    name: 'codex-workspace',
    private: true,
    version: '0.0.1',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: {
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      // Curated quality kit — pre-declared so generated apps can use
      // icons/motion/charts without a mid-build install round-trip (the
      // runner's bun cache keeps reinstalls warm). The agent skills
      // (landing-profesional, dashboard-kpis) prescribe these.
      'lucide-react': '^0.469.0',
      'framer-motion': '^11.15.0',
      recharts: '^2.15.0',
      clsx: '^2.1.1',
    },
    devDependencies: {
      '@vitejs/plugin-react': '^4.5.2',
      '@types/react': '^18.3.3',
      '@types/react-dom': '^18.3.0',
      typescript: '^5.5.4',
      vite: '^7.0.0',
    },
  };

  const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
})
`;

  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
    },
    include: ['src'],
  };

  const indexHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${htmlName} · Codex</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

  const mainTsx = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`;

  // The "Workspace listo" marker keeps isStarterIndex able to detect an
  // untouched starter (so ensureAppsVitePreviewable can tell "still the shell"
  // from "the agent built something").
  const appTsx = `export default function App() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'system-ui, sans-serif',
        background: '#0b0b10',
        color: '#e8e8f0',
        margin: 0,
      }}
    >
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <h1 style={{ fontSize: '1.6rem', margin: '0 0 0.5rem' }}>
          <span
            style={{
              display: 'inline-block',
              width: '0.55rem',
              height: '0.55rem',
              borderRadius: '50%',
              background: '#7c5cff',
              marginRight: '0.5rem',
            }}
          />
          ${jsxName}
        </h1>
        <p style={{ color: '#99a', margin: 0 }}>
          Workspace listo. Describe en el chat que quieres construir.
        </p>
      </div>
    </main>
  )
}
`;

  // Helper de IA de la plataforma: las apps generadas integran chat/IA REAL
  // llamando a este proxy (la key vive en el servidor, nunca en la app).
  const aiHelperTs = `export type AIMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Habla con la IA de la plataforma SiraGPT (sin API key: el proxy del
 * servidor usa el modelo gratuito). Lanza Error con mensaje legible si el
 * servicio no está disponible — muéstralo en la UI, nunca lo silencies.
 */
export async function askAI(messages: AIMessage[], opts?: { system?: string }): Promise<string> {
  const res = await fetch('/api/apps-ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, system: opts?.system }),
  })
  const data = await res.json().catch(() => null)
  if (res.status === 429) throw new Error('La IA está ocupada — espera unos segundos y reintenta.')
  if (!res.ok || !data?.ok) throw new Error('El servicio de IA no está disponible ahora mismo.')
  return String(data.text || '')
}
`;

  const indexCss = `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; }
`;

  return [
    { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'vite.config.ts', content: viteConfig },
    { path: 'tsconfig.json', content: `${JSON.stringify(tsconfig, null, 2)}\n` },
    { path: 'index.html', content: indexHtml },
    { path: 'src/main.tsx', content: mainTsx },
    { path: 'src/App.tsx', content: appTsx },
    { path: 'src/index.css', content: indexCss },
    { path: 'src/lib/ai.ts', content: aiHelperTs },
    { path: '.gitignore', content: 'node_modules\ndist\n' },
  ];
}

module.exports = { starterFiles, escapeHtml };
