'use strict';

/**
 * siraGPT Builder · E3+ — real codegen.
 *
 * Turns a ProjectBrief + Blueprint into a *runnable* Next.js 14 (App Router,
 * TypeScript) project — not just starter docs. Output compiles and runs with
 * `npm install && npm run dev`, with no database required: each data entity
 * gets an in-memory CRUD API route plus a list/create page that talks to it.
 *
 * Scope (vertical slice): platforms whose frontend is Next.js — `web` and
 * `landing`. For `mobile`/`desktop` this returns `[]` and the caller keeps the
 * deterministic starter artifacts from scaffold.js. Pure + deterministic: the
 * same brief always yields byte-identical files. No LLM calls.
 *
 * All brief-derived text is escaped before it reaches generated source, so a
 * malicious purpose/feature string can't break out into code or JSX.
 */

const { ProjectBriefSchema } = require('./contracts');
const { planFromBrief } = require('./blueprint');

// ── naming helpers ────────────────────────────────────────────────
function pascalCase(name) {
  return (
    String(name)
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('') || 'Model'
  );
}

function camelCase(name) {
  const pascal = pascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function kebabCase(name) {
  const base = String(name)
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join('-');
  return base || 'item';
}

// ── escaping ──────────────────────────────────────────────────────
/** Safe to embed inside a JS/TS string literal (double-quoted via JSON). */
function jsStr(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

/** Safe to embed as JSX text (no tag/expression injection). */
function jsxText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/{/g, '&#123;')
    .replace(/}/g, '&#125;');
}

// Blueprint field type → TypeScript type + a sensible empty value.
const TS_TYPES = {
  id: 'string',
  string: 'string',
  text: 'string',
  email: 'string',
  url: 'string',
  phone: 'string',
  datetime: 'string',
  decimal: 'number',
  integer: 'number',
  boolean: 'boolean',
};

function tsType(fieldType) {
  return TS_TYPES[fieldType] || 'string';
}

/** Fields a user fills in a create form (skip id + server-managed timestamps). */
function editableFields(fields) {
  return fields.filter(
    // The created-timestamp match is ANCHORED — a bare `/created/` substring
    // wrongly dropped legit data fields like "created_campaigns" / "creator".
    (f) => f.type !== 'id' && !/(^|_)id$/i.test(f.name) && !/^created(_?at)?$/i.test(f.name),
  );
}

// ── individual file builders ──────────────────────────────────────
function buildPackageJson(brief) {
  const name = kebabCase(brief.purpose || 'siragpt-app');
  const pkg = {
    name: name.slice(0, 60),
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      lint: 'next lint',
    },
    dependencies: {
      next: '14.2.5',
      react: '18.3.1',
      'react-dom': '18.3.1',
    },
    devDependencies: {
      typescript: '5.5.4',
      '@types/node': '20.14.0',
      '@types/react': '18.3.3',
      '@types/react-dom': '18.3.0',
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function buildTsConfig() {
  const cfg = {
    compilerOptions: {
      target: 'ES2020',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'preserve',
      incremental: true,
      paths: { '@/*': ['./*'] },
      plugins: [{ name: 'next' }],
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  };
  return JSON.stringify(cfg, null, 2) + '\n';
}

function buildNextConfig() {
  return [
    '/** @type {import("next").NextConfig} */',
    'const nextConfig = {',
    '  reactStrictMode: true,',
    '};',
    '',
    'export default nextConfig;',
    '',
  ].join('\n');
}

// Theme accent by brief.style.theme — deterministic palette.
const THEME_ACCENT = {
  oscuro: '#8b5cf6',
  minimalista: '#111827',
  corporativo: '#2563eb',
  colorido: '#ec4899',
  moderno: '#06b6d4',
};

function accentFor(brief) {
  const theme = String(brief.style && brief.style.theme || '').toLowerCase();
  for (const key of Object.keys(THEME_ACCENT)) {
    if (theme.includes(key)) return THEME_ACCENT[key];
  }
  return '#6366f1';
}

function buildGlobalsCss(brief) {
  const accent = accentFor(brief);
  const dark = /oscuro|dark/i.test(String(brief.style && brief.style.theme || ''));
  const bg = dark ? '#0b0f1a' : '#ffffff';
  const fg = dark ? '#e5e7eb' : '#111827';
  const muted = dark ? '#9ca3af' : '#6b7280';
  const card = dark ? '#111827' : '#f9fafb';
  const border = dark ? '#1f2937' : '#e5e7eb';
  return [
    ':root {',
    '  --accent: ' + accent + ';',
    '  --bg: ' + bg + ';',
    '  --fg: ' + fg + ';',
    '  --muted: ' + muted + ';',
    '  --card: ' + card + ';',
    '  --border: ' + border + ';',
    '}',
    '* { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; }',
    'body {',
    '  background: var(--bg);',
    '  color: var(--fg);',
    '  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;',
    '  line-height: 1.5;',
    '}',
    'a { color: var(--accent); text-decoration: none; }',
    'a:hover { text-decoration: underline; }',
    '.container { max-width: 980px; margin: 0 auto; padding: 2rem 1.25rem; }',
    '.nav { display: flex; gap: 1rem; align-items: center; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; }',
    '.nav .brand { font-weight: 700; }',
    '.btn { display: inline-block; background: var(--accent); color: #fff; padding: 0.6rem 1.1rem; border-radius: 0.5rem; border: none; cursor: pointer; font-size: 0.95rem; }',
    '.btn:hover { opacity: 0.92; text-decoration: none; }',
    '.hero { padding: 3rem 0 2rem; }',
    '.hero h1 { font-size: 2.4rem; margin: 0 0 0.75rem; }',
    '.hero p { color: var(--muted); font-size: 1.1rem; max-width: 60ch; }',
    '.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }',
    '.card { background: var(--card); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.1rem; }',
    'table { width: 100%; border-collapse: collapse; }',
    'th, td { text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.92rem; }',
    'th { color: var(--muted); font-weight: 600; }',
    'form.stack { display: grid; gap: 0.75rem; max-width: 420px; }',
    'label { display: grid; gap: 0.3rem; font-size: 0.85rem; color: var(--muted); }',
    'input { padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--bg); color: var(--fg); }',
    '',
  ].join('\n');
}

function buildSiteNav(brief, entities) {
  const brand = jsxText((brief.purpose || 'App').slice(0, 32));
  const links = entities.map((e) => {
    const slug = e.slug || kebabCase(e.entity);
    return '      <Link href="/' + slug + '">' + jsxText(e.entity) + '</Link>';
  });
  return [
    'import Link from "next/link";',
    '',
    'export function SiteNav() {',
    '  return (',
    '    <nav className="nav">',
    '      <Link href="/" className="brand">' + brand + '</Link>',
    ...links,
    '    </nav>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function buildLayout(brief) {
  const title = jsStr((brief.purpose || 'siraGPT Builder app').slice(0, 70));
  const desc = jsStr((brief.purpose || 'Generated by siraGPT Builder').slice(0, 150));
  return [
    'import type { Metadata } from "next";',
    'import { SiteNav } from "@/components/site-nav";',
    'import "./globals.css";',
    '',
    'export const metadata: Metadata = {',
    '  title: ' + title + ',',
    '  description: ' + desc + ',',
    '};',
    '',
    'export default function RootLayout({ children }: { children: React.ReactNode }) {',
    '  return (',
    '    <html lang="es">',
    '      <body>',
    '        <SiteNav />',
    '        <main className="container">{children}</main>',
    '      </body>',
    '    </html>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function buildHomePage(brief, entities) {
  const heading = jsxText((brief.purpose || 'Tu nueva app').slice(0, 90));
  const sub = jsxText(
    brief.audience
      ? 'Para ' + brief.audience + '.'
      : 'Generado con siraGPT Builder.',
  );
  const features = (brief.coreFeatures || []).slice(0, 8).map(
    (f) => '          <div className="card">' + jsxText(f) + '</div>',
  );
  const entityLinks = entities.map((e) => {
    const slug = e.slug || kebabCase(e.entity);
    return '          <a className="card" href="/' + slug + '">Gestionar ' + jsxText(e.entity) + ' →</a>';
  });
  const lines = [
    'export default function HomePage() {',
    '  return (',
    '    <section>',
    '      <div className="hero">',
    '        <h1>' + heading + '</h1>',
    '        <p>' + sub + '</p>',
    '      </div>',
  ];
  if (features.length) {
    lines.push('      <h2>Funcionalidades</h2>');
    lines.push('      <div className="grid">');
    lines.push(...features);
    lines.push('      </div>');
  }
  if (entityLinks.length) {
    lines.push('      <h2 style={{ marginTop: "2rem" }}>Secciones</h2>');
    lines.push('      <div className="grid">');
    lines.push(...entityLinks);
    lines.push('      </div>');
  }
  lines.push('    </section>');
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function buildStoreLib() {
  // Generic in-memory store — keeps the generated app runnable with no DB.
  return [
    '// Tiny in-memory store. Replace with a real DB (Prisma) for production;',
    '// state resets when the server restarts.',
    'export type Row = { id: string; createdAt: string; [key: string]: unknown };',
    '',
    'const tables: Record<string, Row[]> = {};',
    '',
    'export function list(table: string): Row[] {',
    '  return tables[table] ?? [];',
    '}',
    '',
    'export function create(table: string, data: Record<string, unknown>): Row {',
    '  const row: Row = {',
    '    id: Math.random().toString(36).slice(2, 10),',
    '    createdAt: new Date().toISOString(),',
    '    ...data,',
    '  };',
    '  tables[table] = [row, ...(tables[table] ?? [])];',
    '  return row;',
    '}',
    '',
  ].join('\n');
}

function buildApiRoute(model) {
  const slug = model.slug || kebabCase(model.entity);
  const editable = editableFields(model.fields);
  // Coerce each editable field from the request body to its TS type.
  const coercions = editable.map((f) => {
    const key = camelCase(f.name);
    const t = tsType(f.type);
    if (t === 'number') return '    ' + key + ': Number((body as any)[' + jsStr(key) + '] ?? 0),';
    if (t === 'boolean') return '    ' + key + ': Boolean((body as any)[' + jsStr(key) + ']),';
    return '    ' + key + ': String((body as any)[' + jsStr(key) + '] ?? ""),';
  });
  return [
    'import { NextResponse } from "next/server";',
    'import { list, create } from "@/lib/store";',
    '',
    'const TABLE = ' + jsStr(slug) + ';',
    '',
    'export async function GET() {',
    '  return NextResponse.json({ items: list(TABLE) });',
    '}',
    '',
    'export async function POST(request: Request) {',
    '  const body = await request.json().catch(() => ({}));',
    '  const row = create(TABLE, {',
    ...coercions,
    '  });',
    '  return NextResponse.json({ item: row }, { status: 201 });',
    '}',
    '',
  ].join('\n');
}

function buildEntityPage(model) {
  const slug = model.slug || kebabCase(model.entity);
  const typeName = pascalCase(model.entity);
  const editable = editableFields(model.fields);
  // Assign each field a UNIQUE camelCase key. Two field names that camelCase-
  // collapse (e.g. "user name" + "user_name" → "userName", or accented variants)
  // would otherwise emit duplicate keys across the interface / initial state /
  // inputs / table cells, corrupting the generated row type. editableFields keeps
  // the same object references, so the editable subset reads the same keys.
  const usedKeys = new Set();
  const keyOf = new Map();
  for (const f of model.fields) {
    const base = camelCase(f.name) || 'field';
    let key = base;
    let n = 2;
    while (usedKeys.has(key)) { key = `${base}${n}`; n += 1; }
    usedKeys.add(key);
    keyOf.set(f, key);
  }
  const colKey = (f) => keyOf.get(f) || camelCase(f.name);
  const allCols = model.fields.map(colKey);

  // TS interface for a row.
  const ifaceFields = model.fields.map((f) => '  ' + colKey(f) + ': ' + tsType(f.type) + ';');
  // Initial form state. NOTE the trailing comma — these lines are emitted one
  // per property inside `useState({ … })`, so without it a 2+-field entity
  // produces `{ name: "" price: 0 }`, an invalid object literal that fails to
  // compile (`npm run build`) in the generated project.
  const initialState = editable.map((f) => {
    const key = colKey(f);
    return '    ' + key + ': ' + (tsType(f.type) === 'number' ? '0' : tsType(f.type) === 'boolean' ? 'false' : '""') + ',';
  });
  // Form inputs.
  const inputs = editable.map((f) => {
    const key = colKey(f);
    const t = tsType(f.type);
    const inputType = t === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text';
    const onChange =
      t === 'number'
        ? 'setForm({ ...form, ' + key + ': Number(e.target.value) })'
        : 'setForm({ ...form, ' + key + ': e.target.value })';
    return [
      '        <label>',
      '          ' + jsxText(f.name),
      '          <input',
      '            type="' + inputType + '"',
      '            value={form.' + key + ' as any}',
      '            onChange={(e) => ' + onChange + '}',
      '          />',
      '        </label>',
    ].join('\n');
  });
  // Table header + row cells.
  const headerCells = allCols.map((c) => '            <th>' + jsxText(c) + '</th>');
  const rowCells = allCols.map((c) => '              <td>{String(row.' + c + ' ?? "")}</td>');

  return [
    '"use client";',
    '',
    'import { useEffect, useState } from "react";',
    '',
    'interface ' + typeName + ' {',
    ...ifaceFields,
    '}',
    '',
    'const API = "/api/' + slug + '";',
    '',
    'export default function ' + typeName + 'Page() {',
    '  const [items, setItems] = useState<' + typeName + '[]>([]);',
    '  const [form, setForm] = useState({',
    ...initialState,
    '  });',
    '  const [loading, setLoading] = useState(true);',
    '',
    '  async function load() {',
    '    const res = await fetch(API);',
    '    const data = await res.json();',
    '    setItems(data.items ?? []);',
    '    setLoading(false);',
    '  }',
    '',
    '  useEffect(() => { void load(); }, []);',
    '',
    '  async function onSubmit(e: React.FormEvent) {',
    '    e.preventDefault();',
    '    await fetch(API, {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify(form),',
    '    });',
    '    await load();',
    '  }',
    '',
    '  return (',
    '    <section>',
    '      <h1>' + jsxText(model.entity) + '</h1>',
    '      <form className="stack" onSubmit={onSubmit}>',
    ...inputs,
    '        <button className="btn" type="submit">Crear</button>',
    '      </form>',
    '      {loading ? (',
    '        <p>Cargando…</p>',
    '      ) : (',
    '        <table style={{ marginTop: "1.5rem" }}>',
    '          <thead>',
    '            <tr>',
    ...headerCells,
    '            </tr>',
    '          </thead>',
    '          <tbody>',
    '            {items.map((row) => (',
    '              <tr key={row.id}>',
    ...rowCells,
    '              </tr>',
    '            ))}',
    '          </tbody>',
    '        </table>',
    '      )}',
    '    </section>',
    '  );',
    '}',
    '',
  ].join('\n');
}

// Platforms whose generated frontend is Next.js.
const NEXTJS_PLATFORMS = new Set(['web', 'landing']);

/**
 * Generate a runnable Next.js project from a ProjectBrief.
 * @param {object} rawBrief — must satisfy ProjectBriefSchema.
 * @param {object} [blueprintArg] — optional pre-computed blueprint (else derived).
 * @returns {{ blueprint: object, files: Array<{path:string, language:string, content:string}>, generated: boolean }}
 */
function codegenFromBrief(rawBrief, blueprintArg) {
  const parsed = ProjectBriefSchema.safeParse(rawBrief);
  if (!parsed.success) {
    throw new Error(`codegen: invalid ProjectBrief: ${parsed.error.message}`);
  }
  const brief = parsed.data;
  const blueprint = blueprintArg || planFromBrief(brief);

  // Out of slice scope → no real code, caller keeps starters.
  if (!NEXTJS_PLATFORMS.has(brief.platform)) {
    return { blueprint, files: [], generated: false };
  }

  // Landing pages stay single-page (marketing); apps get entity CRUD.
  const rawEntities = brief.platform === 'landing' ? [] : blueprint.dataModel;
  // Assign each entity a UNIQUE url/file slug up front. Two entity names that
  // kebab-collapse to the same slug (e.g. "User Post" and "user-post") would
  // otherwise emit two files at the same path — the second clobbering the first
  // — and desync the nav links from the pages. Every builder reads model.slug.
  const usedSlugs = new Set();
  const entities = rawEntities.map((m) => {
    const base = kebabCase(m.entity) || 'item';
    let slug = base;
    let n = 2;
    while (usedSlugs.has(slug)) { slug = `${base}-${n}`; n += 1; }
    usedSlugs.add(slug);
    return { ...m, slug };
  });

  const files = [
    { path: 'package.json', language: 'json', content: buildPackageJson(brief) },
    { path: 'tsconfig.json', language: 'json', content: buildTsConfig() },
    { path: 'next.config.mjs', language: 'javascript', content: buildNextConfig() },
    { path: 'app/globals.css', language: 'css', content: buildGlobalsCss(brief) },
    { path: 'components/site-nav.tsx', language: 'tsx', content: buildSiteNav(brief, entities) },
    { path: 'app/layout.tsx', language: 'tsx', content: buildLayout(brief) },
    { path: 'app/page.tsx', language: 'tsx', content: buildHomePage(brief, entities) },
  ];

  if (entities.length > 0) {
    files.push({ path: 'lib/store.ts', language: 'typescript', content: buildStoreLib() });
    for (const model of entities) {
      const slug = model.slug || kebabCase(model.entity);
      files.push({
        path: `app/api/${slug}/route.ts`,
        language: 'typescript',
        content: buildApiRoute(model),
      });
      files.push({
        path: `app/${slug}/page.tsx`,
        language: 'tsx',
        content: buildEntityPage(model),
      });
    }
  }

  return { blueprint, files, generated: true };
}

module.exports = {
  codegenFromBrief,
  NEXTJS_PLATFORMS,
  // exported for reuse / inspection / tests
  pascalCase,
  camelCase,
  kebabCase,
  tsType,
  editableFields,
  jsStr,
  jsxText,
};
