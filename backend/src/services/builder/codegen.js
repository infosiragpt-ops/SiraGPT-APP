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
function buildPackageJson(brief, entities = []) {
  const name = kebabCase(brief.purpose || 'siragpt-app');
  const hasDb = entities.length > 0;
  const pkg = {
    name: name.slice(0, 60),
    version: '0.1.0',
    private: true,
    scripts: {
      // With a database, push the schema to SQLite before `next dev`/`build` so
      // the app is runnable from a clean checkout with a single `npm run dev`.
      dev: hasDb ? 'prisma db push --skip-generate && next dev' : 'next dev',
      build: hasDb ? 'prisma generate && prisma db push --skip-generate && next build' : 'next build',
      start: 'next start',
      lint: 'next lint',
      ...(hasDb ? { postinstall: 'prisma generate', 'db:push': 'prisma db push' } : {}),
    },
    dependencies: {
      next: '14.2.5',
      react: '18.3.1',
      'react-dom': '18.3.1',
      ...(hasDb ? { '@prisma/client': '5.18.0' } : {}),
    },
    devDependencies: {
      typescript: '5.5.4',
      '@types/node': '20.14.0',
      '@types/react': '18.3.3',
      '@types/react-dom': '18.3.0',
      ...(hasDb ? { prisma: '5.18.0' } : {}),
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

// ── Database layer (Prisma + SQLite) ──────────────────────────────
// The generated app is a real 3-tier stack: React/Next pages (frontend) →
// API routes (backend) → Prisma over SQLite (a persistent database that runs
// locally with zero external setup). Swap the datasource for Postgres in prod.

// Blueprint field type → Prisma scalar type.
const PRISMA_TYPES = {
  id: 'String',
  string: 'String',
  text: 'String',
  email: 'String',
  url: 'String',
  phone: 'String',
  // Editable date fields are stored as the raw string the form submits — a
  // user-entered value that isn't a valid Date would otherwise make a Prisma
  // DateTime insert throw. (The server-managed `createdAt` is a real DateTime.)
  datetime: 'String',
  decimal: 'Float',
  integer: 'Int',
  boolean: 'Boolean',
};

function prismaType(fieldType) {
  return PRISMA_TYPES[fieldType] || 'String';
}

// A safe default so a create with partial form data never violates a NOT NULL.
function prismaDefault(fieldType) {
  const t = prismaType(fieldType);
  if (t === 'Int' || t === 'Float') return ' @default(0)';
  if (t === 'Boolean') return ' @default(false)';
  if (t === 'DateTime') return ' @default(now())';
  return ' @default("")';
}

// Prisma model accessor = model name with a lowercased first letter (Event → event).
function prismaAccessor(entityName) {
  const n = pascalCase(entityName);
  return n.charAt(0).toLowerCase() + n.slice(1);
}

function buildPrismaSchema(entities) {
  const lines = [
    '// Data layer. SQLite keeps the app runnable locally with no external',
    '// database; for production swap `provider`/`url` for PostgreSQL or MySQL.',
    'generator client {',
    '  provider = "prisma-client-js"',
    '}',
    '',
    'datasource db {',
    '  provider = "sqlite"',
    '  url      = "file:./dev.db"',
    '}',
    '',
  ];
  for (const model of entities) {
    lines.push(`model ${pascalCase(model.entity)} {`);
    lines.push('  id        String   @id @default(cuid())');
    lines.push('  createdAt DateTime @default(now())');
    for (const f of editableFields(model.fields)) {
      const key = camelCase(f.name);
      lines.push(`  ${key} ${prismaType(f.type)}${prismaDefault(f.type)}`);
    }
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

function buildDbLib() {
  // Prisma client singleton — reused across hot reloads so dev doesn't exhaust
  // database connections. This is the backend's single gateway to the database.
  return [
    'import { PrismaClient } from "@prisma/client";',
    '',
    'const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };',
    '',
    'export const prisma = globalForPrisma.prisma ?? new PrismaClient();',
    '',
    'if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;',
    '',
  ].join('\n');
}

function buildGitignore() {
  return ['node_modules', '.next', 'dev.db', 'dev.db-journal', 'prisma/dev.db', 'prisma/dev.db-journal', ''].join('\n');
}

// Coerce each editable field from the request body to EXACTLY its Prisma column
// type — shared by create (POST) and update (PUT) so neither throws on a type
// mismatch (Int rejects a float; dates are stored as text). Indented for a
// `data: { … }` block.
function dataCoercions(model) {
  return editableFields(model.fields).map((f) => {
    const key = camelCase(f.name);
    const pt = prismaType(f.type);
    if (pt === 'Int') return '      ' + key + ': Math.trunc(Number((body as any)[' + jsStr(key) + '] ?? 0)) || 0,';
    if (pt === 'Float') return '      ' + key + ': Number((body as any)[' + jsStr(key) + '] ?? 0) || 0,';
    if (pt === 'Boolean') return '      ' + key + ': Boolean((body as any)[' + jsStr(key) + ']),';
    return '      ' + key + ': String((body as any)[' + jsStr(key) + '] ?? ""),';
  });
}

function buildApiRoute(model) {
  const accessor = prismaAccessor(model.entity); // prisma.<accessor>
  const coercions = dataCoercions(model);
  return [
    'import { NextResponse } from "next/server";',
    'import { prisma } from "@/lib/db";',
    '',
    'export async function GET() {',
    '  const items = await prisma.' + accessor + '.findMany({ orderBy: { createdAt: "desc" } });',
    '  return NextResponse.json({ items });',
    '}',
    '',
    'export async function POST(request: Request) {',
    '  const body = await request.json().catch(() => ({}));',
    '  const item = await prisma.' + accessor + '.create({',
    '    data: {',
    ...coercions,
    '    },',
    '  });',
    '  return NextResponse.json({ item }, { status: 201 });',
    '}',
    '',
  ].join('\n');
}

// Per-record route: GET one + DELETE (completes the CRUD surface).
function buildItemApiRoute(model) {
  const accessor = prismaAccessor(model.entity);
  return [
    'import { NextResponse } from "next/server";',
    'import { prisma } from "@/lib/db";',
    '',
    'export async function GET(_request: Request, { params }: { params: { id: string } }) {',
    '  const item = await prisma.' + accessor + '.findUnique({ where: { id: params.id } });',
    '  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });',
    '  return NextResponse.json({ item });',
    '}',
    '',
    'export async function PUT(request: Request, { params }: { params: { id: string } }) {',
    '  const body = await request.json().catch(() => ({}));',
    '  const item = await prisma.' + accessor + '.update({',
    '    where: { id: params.id },',
    '    data: {',
    ...dataCoercions(model),
    '    },',
    '  }).catch(() => null);',
    '  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });',
    '  return NextResponse.json({ item });',
    '}',
    '',
    'export async function DELETE(_request: Request, { params }: { params: { id: string } }) {',
    '  await prisma.' + accessor + '.delete({ where: { id: params.id } }).catch(() => {});',
    '  return NextResponse.json({ ok: true });',
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
  // Loads the editable fields of a row into the form for editing.
  const editLoaders = editable.map((f) => {
    const key = colKey(f);
    return '      ' + key + ': row.' + key + ' as any,';
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
    '  const [editingId, setEditingId] = useState<string | null>(null);',
    '',
    '  function resetForm() {',
    '    setEditingId(null);',
    '    setForm({',
    ...initialState,
    '    });',
    '  }',
    '',
    '  function startEdit(row: ' + typeName + ') {',
    '    setEditingId(row.id);',
    '    setForm({',
    ...editLoaders,
    '    });',
    '  }',
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
    '    await fetch(editingId ? API + "/" + editingId : API, {',
    '      method: editingId ? "PUT" : "POST",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify(form),',
    '    });',
    '    resetForm();',
    '    await load();',
    '  }',
    '',
    '  async function onDelete(id: string) {',
    '    await fetch(API + "/" + id, { method: "DELETE" });',
    '    await load();',
    '  }',
    '',
    '  return (',
    '    <section>',
    '      <h1>' + jsxText(model.entity) + '</h1>',
    '      <form className="stack" onSubmit={onSubmit}>',
    ...inputs,
    '        <button className="btn" type="submit">{editingId ? "Guardar" : "Crear"}</button>',
    '        {editingId && (',
    '          <button className="btn" type="button" onClick={resetForm}>Cancelar</button>',
    '        )}',
    '      </form>',
    '      {loading ? (',
    '        <p>Cargando…</p>',
    '      ) : (',
    '        <table style={{ marginTop: "1.5rem" }}>',
    '          <thead>',
    '            <tr>',
    ...headerCells,
    '            <th>Acciones</th>',
    '            </tr>',
    '          </thead>',
    '          <tbody>',
    '            {items.map((row) => (',
    '              <tr key={row.id}>',
    ...rowCells,
    '              <td>',
    '                <button className="btn" onClick={() => startEdit(row)}>Editar</button>{" "}',
    '                <button className="btn" onClick={() => onDelete(row.id)}>Borrar</button>',
    '              </td>',
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
    { path: 'package.json', language: 'json', content: buildPackageJson(brief, entities) },
    { path: 'tsconfig.json', language: 'json', content: buildTsConfig() },
    { path: 'next.config.mjs', language: 'javascript', content: buildNextConfig() },
    { path: 'app/globals.css', language: 'css', content: buildGlobalsCss(brief) },
    { path: 'components/site-nav.tsx', language: 'tsx', content: buildSiteNav(brief, entities) },
    { path: 'app/layout.tsx', language: 'tsx', content: buildLayout(brief) },
    { path: 'app/page.tsx', language: 'tsx', content: buildHomePage(brief, entities) },
  ];

  if (entities.length > 0) {
    // Database layer: Prisma schema (one model per entity) + a client singleton.
    files.push({ path: 'prisma/schema.prisma', language: 'prisma', content: buildPrismaSchema(entities) });
    files.push({ path: 'lib/db.ts', language: 'typescript', content: buildDbLib() });
    files.push({ path: '.gitignore', language: 'text', content: buildGitignore() });
    for (const model of entities) {
      const slug = model.slug || kebabCase(model.entity);
      files.push({
        path: `app/api/${slug}/route.ts`,
        language: 'typescript',
        content: buildApiRoute(model),
      });
      files.push({
        path: `app/api/${slug}/[id]/route.ts`,
        language: 'typescript',
        content: buildItemApiRoute(model),
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
