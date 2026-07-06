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
      // Tailwind v4 via the Vite plugin: zero config files, design tokens in
      // src/index.css. Same stack the /code landing scaffold already proved.
      '@tailwindcss/vite': '^4.1.0',
      tailwindcss: '^4.1.0',
      '@types/react': '^18.3.3',
      '@types/react-dom': '^18.3.0',
      typescript: '^5.5.4',
      vite: '^7.0.0',
    },
  };

  const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Sandboxed single-tenant container: the platform proxy and the browser
  // verifier reach this dev server by container hostname, so Vite's default
  // localhost-only host check must be disabled or they get 403 Blocked.
  server: { host: true, allowedHosts: true },
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
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>" />
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
  // from "the agent built something"). Uses the Tailwind tokens + UI kit so
  // the model sees a working in-repo example of the intended idiom.
  const appTsx = `import { Badge, Card, CardContent } from './ui'

export default function App() {
  return (
    <main className="grid min-h-screen place-items-center bg-bg text-fg">
      <Card className="max-w-md text-center">
        <CardContent className="p-8">
          <Badge>SiraGPT Apps</Badge>
          <h1 className="mt-4 text-2xl font-bold">${jsxName}</h1>
          <p className="mt-2 text-muted">
            Workspace listo. Describe en el chat que quieres construir.
          </p>
        </CardContent>
      </Card>
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

/**
 * Streaming: tokens fluyen en tiempo real como ChatGPT. Pasa un callback
 * que recibe cada fragmento (delta). La promesa resuelve al completar.
 */
export async function askAIStream(
  messages: AIMessage[],
  opts: { system?: string; onDelta: (delta: string) => void },
): Promise<string> {
  const res = await fetch('/api/apps-ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, system: opts.system, stream: true }),
  })
  if (res.status === 429) throw new Error('La IA está ocupada — espera unos segundos y reintenta.')
  if (!res.ok) throw new Error('El servicio de IA no está disponible ahora mismo.')
  if (!res.body) throw new Error('Streaming no soportado en este navegador.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue
      const payload = trimmed.slice(6)
      if (payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload)
        if (parsed.delta) {
          full += parsed.delta
          opts.onDelta(parsed.delta)
        }
        if (parsed.error) throw new Error(parsed.error)
      } catch (e) {
        if (e instanceof SyntaxError) continue
        throw e
      }
    }
  }
  return full
}
`;

  // Persistencia REAL sin backend propio: habla con el store KV de la
  // plataforma (/api/apps-kv). Dos ámbitos: `storage` (personal, por
  // dispositivo) y `storage.shared` (compartido entre todos los visitantes de
  // la app). Cae a localStorage si el servicio no responde, así la app nunca
  // se rompe. Ideal para trackers, diarios, tableros, ajustes guardados.
  const storageHelperTs = `// Store KV persistente de SiraGPT (sin API key ni backend propio).
type Json = unknown

// namespace = identidad de la app. En el preview se deriva de la URL
// (/api/codex/projects/<id>/preview/...); si no, un bucket estable por origen.
function appNamespace(): string {
  try {
    const m = /\\/projects\\/([^/]+)\\/preview\\//.exec(location.pathname)
    if (m) return m[1]
    return 'app_' + btoa(location.host).replace(/[^A-Za-z0-9]/g, '').slice(0, 24)
  } catch {
    return 'app_default'
  }
}

// uid por dispositivo para el ámbito personal (persistido en localStorage).
function deviceUid(): string {
  try {
    const k = 'sira-app-uid'
    let v = localStorage.getItem(k)
    if (!v) {
      v = (crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9-]/g, '')
      localStorage.setItem(k, v)
    }
    return v
  } catch {
    return 'anon'
  }
}

const NS = appNamespace()

function makeScope(owner: string) {
  const base = \`/api/apps-kv/\${encodeURIComponent(NS)}/\${encodeURIComponent(owner)}\`
  const lkey = (key: string) => \`sira-kv:\${NS}:\${owner}:\${key}\`
  return {
    /** Lee un valor; null si no existe. Cae a localStorage si el servicio falla. */
    async get<T = Json>(key: string): Promise<T | null> {
      try {
        const r = await fetch(\`\${base}/\${encodeURIComponent(key)}\`)
        if (r.status === 404) return null
        if (r.ok) return ((await r.json())?.value ?? null) as T | null
      } catch { /* offline → fallback */ }
      try {
        const raw = localStorage.getItem(lkey(key))
        return raw == null ? null : (JSON.parse(raw) as T)
      } catch { return null }
    },
    /** Guarda un valor (cualquier JSON). Persiste también en localStorage como respaldo. */
    async set(key: string, value: Json): Promise<void> {
      try { localStorage.setItem(lkey(key), JSON.stringify(value)) } catch { /* quota */ }
      try {
        await fetch(\`\${base}/\${encodeURIComponent(key)}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        })
      } catch { /* offline: queda el respaldo local */ }
    },
    /** Borra una clave. */
    async remove(key: string): Promise<void> {
      try { localStorage.removeItem(lkey(key)) } catch { /* ignore */ }
      try { await fetch(\`\${base}/\${encodeURIComponent(key)}\`, { method: 'DELETE' }) } catch { /* offline */ }
    },
    /** Lista las claves guardadas (para trackers/listas). */
    async keys(): Promise<string[]> {
      try {
        const r = await fetch(base)
        if (r.ok) return (((await r.json())?.keys ?? []) as Array<{ key: string }>).map((k) => k.key)
      } catch { /* offline */ }
      return []
    },
  }
}

/** Ámbito PERSONAL (por dispositivo). \`storage.shared\` = ámbito COMPARTIDO. */
export const storage = Object.assign(makeScope(deviceUid()), {
  shared: makeScope('_shared'),
})
`;

  // Tailwind v4 entry + design tokens. Re-theme an app by editing the six
  // :root vars (light theme: flip color-scheme + the values); every class
  // like bg-surface / text-muted / border-line follows automatically.
  const indexCss = `@import "tailwindcss";

:root {
  color-scheme: dark;
  --bg: #0b0b10;
  --surface: #14141c;
  --fg: #e8e8f0;
  --muted: #9a9ab0;
  --accent: #7c5cff;
  --line: #26263a;
}

@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-fg: var(--fg);
  --color-muted: var(--muted);
  --color-accent: var(--accent);
  --color-line: var(--line);
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
}
`;

  // ── src/ui — shadcn-style copy-paste kit (own the code, no dependency) ──
  const uiButton = `import { ButtonHTMLAttributes, forwardRef } from 'react'
import clsx from 'clsx'

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:opacity-90',
  secondary: 'border border-line bg-surface text-fg hover:border-accent/60',
  ghost: 'bg-transparent text-muted hover:bg-surface hover:text-fg',
  destructive: 'bg-red-600 text-white hover:bg-red-500',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 rounded-md px-3 text-sm',
  md: 'h-10 rounded-lg px-4 text-sm',
  lg: 'h-12 rounded-lg px-6 text-base',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={clsx(
        'inline-flex items-center justify-center gap-2 font-semibold transition-colors',
        'focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
`;

  const uiCard = `import { HTMLAttributes } from 'react'
import clsx from 'clsx'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('rounded-xl border border-line bg-surface', className)} {...props} />
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('flex flex-col gap-1.5 p-5', className)} {...props} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={clsx('text-lg font-semibold text-fg', className)} {...props} />
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={clsx('text-sm text-muted', className)} {...props} />
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('p-5 pt-0', className)} {...props} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('flex items-center gap-3 p-5 pt-0', className)} {...props} />
}
`;

  const uiInput = `import { InputHTMLAttributes, LabelHTMLAttributes, TextareaHTMLAttributes, forwardRef } from 'react'
import clsx from 'clsx'

const field =
  'w-full rounded-lg border border-line bg-bg px-3 text-sm text-fg placeholder:text-muted ' +
  'focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={clsx(field, 'h-10', className)} {...props} />,
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={clsx(field, 'min-h-24 py-2', className)} {...props} />,
)
Textarea.displayName = 'Textarea'

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={clsx('mb-1.5 block text-sm font-medium text-fg', className)} {...props} />
}
`;

  const uiBadge = `import { HTMLAttributes } from 'react'
import clsx from 'clsx'

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'outline'

const variants: Record<Variant, string> = {
  default: 'bg-accent/15 text-accent',
  success: 'bg-emerald-500/15 text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-400',
  danger: 'bg-red-500/15 text-red-400',
  outline: 'border border-line text-muted',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', variants[variant], className)}
      {...props}
    />
  )
}
`;

  const uiIndex = `export { Button, type ButtonProps } from './button'
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './card'
export { Input, Textarea, Label } from './input'
export { Badge, type BadgeProps } from './badge'
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
    { path: 'src/lib/storage.ts', content: storageHelperTs },
    { path: 'src/ui/button.tsx', content: uiButton },
    { path: 'src/ui/card.tsx', content: uiCard },
    { path: 'src/ui/input.tsx', content: uiInput },
    { path: 'src/ui/badge.tsx', content: uiBadge },
    { path: 'src/ui/index.ts', content: uiIndex },
    { path: '.gitignore', content: 'node_modules\ndist\nserver/node_modules\nserver/*.db\n' },
  ];
}

/**
 * Full-stack starter: React+Vite frontend + Express API + SQLite backend
 * (built-in drivers via server/db.js — bun:sqlite in the runner, node:sqlite
 * on an export; zero native deps). The runner starts both with `concurrently`
 * so the preview shows a real app with persistent data — not just localStorage.
 *
 * Used when the skill `backend-real` triggers (user asks for "base de datos
 * real", "backend", "API", "que guarde de verdad"). The agent builds ON this
 * foundation, adding routes/entities as needed.
 */
function fullStackStarterFiles({ projectName } = {}) {
  const base = starterFiles({ projectName });
  const jsxName = jsxText(projectName) || 'Proyecto Codex';

  // Override package.json to add the server deps + concurrently script.
  const pkg = {
    name: 'codex-workspace',
    private: true,
    version: '0.0.1',
    type: 'module',
    scripts: {
      // Direct commands (no `npm run` nesting): the preview runner is a Bun
      // image without npm; its node shim handles `node --watch` fine and the
      // same script works verbatim on real Node after an export.
      dev: 'concurrently -n api,web -c blue,green "node --watch server/index.js" "vite"',
      'dev:api': 'node --watch server/index.js',
      'dev:web': 'vite',
      build: 'vite build',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      'lucide-react': '^0.469.0',
      'framer-motion': '^11.15.0',
      recharts: '^2.15.0',
      clsx: '^2.1.1',
      express: '^4.21.0',
      cors: '^2.8.5',
    },
    devDependencies: {
      '@vitejs/plugin-react': '^4.5.2',
      '@tailwindcss/vite': '^4.1.0',
      tailwindcss: '^4.1.0',
      '@types/react': '^18.3.3',
      '@types/react-dom': '^18.3.0',
      '@types/express': '^4.17.21',
      '@types/cors': '^2.8.17',
      concurrently: '^9.1.0',
      typescript: '^5.5.4',
      vite: '^7.0.0',
    },
  };

  // Vite config with proxy to the Express API. The runner launches this
  // project with `bun run dev` (concurrently: API + web) instead of the vite
  // CLI, so port/base come from ENV, not flags. The proxy key is a REGEX so
  // `/api` also matches under SiraGPT's tokenized preview base (the frontend
  // calls `${import.meta.env.BASE_URL}api/...`); the rewrite strips the base
  // back off before hitting Express. API port = web port + 1000 so several
  // full-stack previews can run side by side without colliding on 3001.
  const viteConfigProxy = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const port = Number(process.env.PORT) || 5173
const apiPort = Number(process.env.API_PORT) || port + 1000

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: process.env.VITE_BASE || '/',
  server: {
    host: true,
    allowedHosts: true,
    port,
    strictPort: true,
    proxy: {
      '^.*/api/': {
        target: \`http://localhost:\${apiPort}\`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^.*?\\/api\\//, '/api/'),
      },
    },
  },
})
`;

  // SQLite WITHOUT native dependencies: better-sqlite3's install script can't
  // build inside the slim Bun runner image (exit 127), so the starter uses the
  // runtimes' BUILT-IN drivers behind a tiny adapter — bun:sqlite in the
  // preview runner, node:sqlite (Node 22+) after a standalone export. Same
  // prepare/exec surface the agent already knows.
  const serverDb = `// server/db.js — SQLite integrado, cero dependencias nativas.
// Bun (runner del preview) → bun:sqlite · Node 22+ (export) → node:sqlite.
// API mínima común: db.exec(sql) y db.prepare(sql).{all,get,run}(...params).
let db

if (typeof Bun !== 'undefined') {
  const { Database } = await import('bun:sqlite')
  const raw = new Database('server/data.db')
  db = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const q = raw.query(sql)
      return { all: (...p) => q.all(...p), get: (...p) => q.get(...p), run: (...p) => q.run(...p) }
    },
  }
} else {
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync('server/data.db')
  db = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const st = raw.prepare(sql)
      return { all: (...p) => st.all(...p), get: (...p) => st.get(...p), run: (...p) => st.run(...p) }
    },
  }
}

export default db
`;

  // Express server with SQLite — a working API the agent extends.
  const serverIndex = `import express from 'express'
import cors from 'cors'
import db from './db.js'

const app = express()
// Mirrors vite.config: API port = web port + 1000, so multiple previews of
// full-stack apps never fight over a fixed 3001.
const PORT = Number(process.env.API_PORT) || (Number(process.env.PORT) ? Number(process.env.PORT) + 1000 : 3001)

// WAL for better concurrent read performance.
db.exec('PRAGMA journal_mode = WAL')

// Seed data on first boot — the agent adds more entities.
db.exec(\`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    done INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
\`)
const count = db.prepare('SELECT COUNT(*) as n FROM items').get()
if (count.n === 0) {
  const insert = db.prepare('INSERT INTO items (title) VALUES (?)')
  insert.run('Bienvenido a tu app con backend real')
  insert.run('Los datos se guardan en SQLite')
  insert.run('Borra esto y crea los tuyos')
}

app.use(cors())
app.use(express.json())

// Health check — the runner probes this.
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// RESTful CRUD for 'items' — the agent replaces this with real entities.
app.get('/api/items', (_req, res) => {
  res.json(db.prepare('SELECT * FROM items ORDER BY id DESC').all())
})
app.post('/api/items', (req, res) => {
  const { title } = req.body
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title required' })
  const info = db.prepare('INSERT INTO items (title) VALUES (?)').run(title)
  res.status(201).json({ id: info.lastInsertRowid, title, done: 0 })
})
app.patch('/api/items/:id', (req, res) => {
  const { done } = req.body
  db.prepare('UPDATE items SET done = ? WHERE id = ?').run(done ? 1 : 0, req.params.id)
  res.json({ ok: true })
})
app.delete('/api/items/:id', (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(\`API on http://localhost:\${PORT}\`))
`;

  // Frontend App that consumes the real API (replaces the placeholder shell).
  // API calls go through import.meta.env.BASE_URL so they resolve under the
  // tokenized preview base AND at '/' in a standalone `vite` run — a bare
  // fetch('/api/...') escapes the base and 404s behind the preview proxy.
  const appWithApi = `import { useEffect, useState } from 'react'
import { Button, Card, CardContent, Input, Badge } from './ui'

// Prefija SIEMPRE las llamadas al backend con esta constante (ver vite.config).
const API = import.meta.env.BASE_URL.replace(/\\/+$/, '') + '/api'

type Item = { id: number; title: string; done: number }

export default function App() {
  const [items, setItems] = useState<Item[]>([])
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      setError(null)
      const res = await fetch(\`\${API}/items\`)
      if (!res.ok) throw new Error('Error al cargar')
      setItems(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const add = async () => {
    if (!title.trim()) return
    const res = await fetch(\`\${API}/items\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    if (res.ok) {
      setTitle('')
      load()
    }
  }

  const toggle = async (item: Item) => {
    await fetch(\`\${API}/items/\${item.id}\`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: !item.done }),
    })
    load()
  }

  const remove = async (id: number) => {
    await fetch(\`\${API}/items/\${id}\`, { method: 'DELETE' })
    load()
  }

  return (
    <main className="mx-auto max-w-2xl p-6 bg-bg text-fg min-h-screen">
      <Badge>App con backend real · SQLite</Badge>
      <h1 className="mt-3 text-3xl font-bold">${jsxName}</h1>
      <p className="mt-1 text-muted">Los datos se guardan de verdad. Recarga y siguen ahí.</p>

      <div className="mt-6 flex gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Agregar item…" />
        <Button onClick={add}>Agregar</Button>
      </div>

      {error && <p className="mt-4 text-red-400">{error}</p>}
      {loading ? (
        <p className="mt-4 text-muted">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="mt-4 text-muted">Sin items todavía. Agrega el primero.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {items.map((item) => (
            <Card key={item.id} className="flex items-center justify-between">
              <CardContent className="flex flex-1 items-center gap-3 p-4">
                <input type="checkbox" checked={!!item.done} onChange={() => toggle(item)} />
                <span className={item.done ? 'line-through text-muted' : ''}>{item.title}</span>
              </CardContent>
              <Button variant="ghost" size="sm" onClick={() => remove(item.id)} className="mr-2">
                Eliminar
              </Button>
            </Card>
          ))}
        </div>
      )}
    </main>
  )
}
`;

  // Replace package.json, vite.config.ts and App.tsx with the full-stack versions.
  const overrides = new Map([
    ['package.json', `${JSON.stringify(pkg, null, 2)}\n`],
    ['vite.config.ts', viteConfigProxy],
    ['src/App.tsx', appWithApi],
  ]);

  return base
    .filter((f) => !overrides.has(f.path))
    .concat([
      { path: 'package.json', content: overrides.get('package.json') },
      { path: 'vite.config.ts', content: overrides.get('vite.config.ts') },
      { path: 'src/App.tsx', content: overrides.get('src/App.tsx') },
      { path: 'server/db.js', content: serverDb },
      { path: 'server/index.js', content: serverIndex },
      { path: 'server/.gitignore', content: 'node_modules\n*.db\n*.db-wal\n*.db-shm\n' },
    ]);
}

module.exports = { starterFiles, fullStackStarterFiles, escapeHtml };
