'use strict';

/**
 * siraGPT Builder · E3+ — real codegen.
 *
 * Turns a ProjectBrief + Blueprint into a *runnable* full-stack Next.js 14
 * (App Router, TypeScript) project — not just starter docs. Output compiles
 * with `npm install && npm run dev`: each data entity gets a frontend CRUD
 * page, a backend Route Handler, and a Prisma/PostgreSQL persistence layer.
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
const PRISMA_RESERVED_MODEL_NAMES = new Set([
  'Prisma',
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
  'Null',
  'True',
  'False',
  'Datasource',
  'Generator',
  'Enum',
]);

function pascalCase(name) {
  const candidate = (
    String(name)
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('') || 'Model'
  );
  return PRISMA_RESERVED_MODEL_NAMES.has(candidate) ? `${candidate}Record` : candidate;
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
    (f) => f.type !== 'id' && !/(^|_)id$/i.test(f.name) && !/created/i.test(f.name),
  );
}

// ── individual file builders ──────────────────────────────────────
function buildPackageJson(brief, hasDatabase = false) {
  const name = kebabCase(brief.purpose || 'siragpt-app');
  const pkg = {
    name: name.slice(0, 60),
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      'build:web': 'next build',
      'build:mobile': 'next build',
      start: 'next start',
      'preview:web': 'next start',
      'preview:mobile': 'next start',
      lint: 'next lint',
    },
    dependencies: {
      next: '15.5.19',
      react: '18.3.1',
      'react-dom': '18.3.1',
    },
    devDependencies: {
      '@types/node': '20.14.0',
      '@types/react': '18.3.3',
      '@types/react-dom': '18.3.0',
      typescript: '5.5.4',
    },
  };
  if (hasDatabase) {
    pkg.scripts.dev = 'prisma generate && next dev';
    pkg.scripts.build = 'prisma generate && next build';
    pkg.scripts['build:web'] = 'prisma generate && next build';
    pkg.scripts['build:mobile'] = 'prisma generate && next build';
    Object.assign(pkg.scripts, {
      'db:generate': 'prisma generate',
      'db:migrate': 'prisma migrate dev',
      'db:push': 'prisma db push',
      'db:seed': 'tsx prisma/seed.ts',
    });
    pkg.prisma = { seed: 'tsx prisma/seed.ts' };
    pkg.dependencies['@prisma/client'] = '5.19.1';
    pkg.devDependencies.prisma = '5.19.1';
    pkg.devDependencies.tsx = '4.19.1';
  }
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
    "const previewBasePath = process.env.SIRA_PREVIEW_BASE_PATH || '';",
    '',
    'const nextConfig = {',
    '  reactStrictMode: true,',
    '  ...(previewBasePath ? {',
    '    basePath: previewBasePath,',
    '    assetPrefix: previewBasePath,',
    '  } : {}),',
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
    '@media (max-width: 680px) {',
    '  .container { padding: 1.25rem 1rem; }',
    '  .nav { align-items: flex-start; gap: 0.75rem; overflow-x: auto; }',
    '  .nav .brand { flex: 0 0 100%; }',
    '  .hero { padding: 2rem 0 1rem; }',
    '  .hero h1 { font-size: 1.9rem; line-height: 1.08; }',
    '  .grid { grid-template-columns: 1fr; }',
    '  table { display: block; overflow-x: auto; white-space: nowrap; }',
    '  form.stack { max-width: none; }',
    '}',
    '',
  ].join('\n');
}

function buildSiteNav(brief, entities) {
  const brand = jsxText((brief.purpose || 'App').slice(0, 32));
  const links = entities.map((e) => {
    const slug = kebabCase(e.entity);
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

function buildPrismaClientLib() {
  return [
    'import { PrismaClient } from "@prisma/client";',
    '',
    'const globalForPrisma = globalThis as unknown as {',
    '  prisma?: PrismaClient;',
    '};',
    '',
    'export const prisma =',
    '  globalForPrisma.prisma ??',
    '  new PrismaClient({',
    '    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],',
    '  });',
    '',
    'if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;',
    '',
  ].join('\n');
}

function buildDockerCompose() {
  return [
    'services:',
    '  db:',
    '    image: postgres:16-alpine',
    '    restart: unless-stopped',
    '    environment:',
    '      POSTGRES_DB: siragpt_app',
    '      POSTGRES_USER: postgres',
    '      POSTGRES_PASSWORD: postgres',
    '    ports:',
    '      - "5432:5432"',
    '    volumes:',
    '      - postgres-data:/var/lib/postgresql/data',
    '',
    'volumes:',
    '  postgres-data:',
    '',
  ].join('\n');
}

function buildLayout(brief) {
  const title = jsStr((brief.purpose || 'siraGPT Builder app').slice(0, 70));
  const desc = jsStr((brief.purpose || 'Generated by siraGPT Builder').slice(0, 150));
  const accent = jsStr(accentFor(brief));
  return [
    'import type { Metadata, Viewport } from "next";',
    'import { SiteNav } from "@/components/site-nav";',
    'import "./globals.css";',
    '',
    'export const metadata: Metadata = {',
    '  title: ' + title + ',',
    '  description: ' + desc + ',',
    '};',
    '',
    'export const viewport: Viewport = {',
    '  width: "device-width",',
    '  initialScale: 1,',
    '  themeColor: ' + accent + ',',
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

function buildManifest(brief) {
  const name = jsStr((brief.purpose || 'siraGPT Builder app').slice(0, 80));
  const shortName = jsStr((brief.purpose || 'App').slice(0, 24));
  const desc = jsStr((brief.purpose || 'Generated by siraGPT Builder').slice(0, 150));
  const accent = jsStr(accentFor(brief));
  return [
    'import type { MetadataRoute } from "next";',
    '',
    'export default function manifest(): MetadataRoute.Manifest {',
    '  return {',
    '    name: ' + name + ',',
    '    short_name: ' + shortName + ',',
    '    description: ' + desc + ',',
    '    start_url: "/",',
    '    scope: "/",',
    '    display: "standalone",',
    '    background_color: "#ffffff",',
    '    theme_color: ' + accent + ',',
    '    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],',
    '  };',
    '}',
    '',
  ].join('\n');
}

function buildIconSvg(brief) {
  const accent = accentFor(brief);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">',
    '  <rect width="128" height="128" rx="28" fill="' + accent + '"/>',
    '  <path d="M35 77c13 15 45 15 58 0M38 52h52M44 36h40" fill="none" stroke="white" stroke-width="10" stroke-linecap="round"/>',
    '  <circle cx="44" cy="58" r="5" fill="white"/>',
    '  <circle cx="64" cy="58" r="5" fill="white"/>',
    '  <circle cx="84" cy="58" r="5" fill="white"/>',
    '</svg>',
    '',
  ].join('\n');
}

function exactDisplayTextFromBrief(brief) {
  const match = String((brief && brief.constraints) || '').match(/Texto exacto en pantalla principal:\s*([^\n]+)/i);
  return match ? String(match[1] || '').trim().slice(0, 120) : '';
}

function buildHomePage(brief, entities) {
  const heading = jsxText((brief.purpose || 'Tu nueva app').slice(0, 90));
  const sub = jsxText(
    brief.audience
      ? 'Para ' + brief.audience + '.'
      : 'Generado con siraGPT Builder.',
  );
  const exactDisplayText = exactDisplayTextFromBrief(brief);
  const features = (brief.coreFeatures || []).slice(0, 8).map(
    (f) => '          <div className="card">' + jsxText(f) + '</div>',
  );
  const entityLinks = entities.map((e) => {
    const slug = kebabCase(e.entity);
    return '          <Link className="card" href="/' + slug + '">Gestionar ' + jsxText(e.entity) + ' →</Link>';
  });
  const lines = [
    ...(entityLinks.length ? ['import Link from "next/link";', ''] : []),
    'export default function HomePage() {',
    '  return (',
    '    <section>',
    '      <div className="hero">',
    '        <h1>' + heading + '</h1>',
    '        <p>' + sub + '</p>',
    '      </div>',
  ];
  if (exactDisplayText) {
    lines.push('      <p className="card" data-testid="required-output">' + jsxText(exactDisplayText) + '</p>');
  }
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

function buildApiRoute(model) {
  const modelAccessor = camelCase(model.entity);
  const editable = editableFields(model.fields);
  // Coerce each editable field from the request body to its TS type.
  const coercions = editable.map((f) => {
    const key = camelCase(f.name);
    const t = tsType(f.type);
    if (t === 'number') return '    ' + key + ': Number((body as any)[' + jsStr(key) + '] ?? 0),';
    if (t === 'boolean') return '    ' + key + ': toBoolean((body as any)[' + jsStr(key) + ']),';
    if (f.type === 'datetime') {
      return '    ' + key + ': new Date(String((body as any)[' + jsStr(key) + '] || new Date().toISOString())),';
    }
    return '    ' + key + ': String((body as any)[' + jsStr(key) + '] ?? ""),';
  });
  const fallbackFields = model.fields.map((f) => {
    const key = camelCase(f.name);
    const t = tsType(f.type);
    if (f.type === 'id' || key === 'id') return '    ' + key + ': String(body.' + key + ' ?? `preview-${Date.now()}`),';
    if (f.type === 'datetime' || /created|updated/i.test(key)) {
      return '    ' + key + ': String(body.' + key + ' ?? new Date().toISOString()),';
    }
    if (t === 'number') return '    ' + key + ': Number(body.' + key + ' ?? 0),';
    if (t === 'boolean') return '    ' + key + ': toBoolean(body.' + key + '),';
    if (f.type === 'email') return '    ' + key + ': String(body.' + key + ' ?? ' + jsStr(`${camelCase(model.entity)}@example.com`) + '),';
    if (f.type === 'phone') return '    ' + key + ': String(body.' + key + ' ?? "+51 999 999 999"),';
    if (f.type === 'url') return '    ' + key + ': String(body.' + key + ' ?? "https://example.com"),';
    return '    ' + key + ': String(body.' + key + ' ?? ' + jsStr(`${model.entity} demo`) + '),';
  });
  return [
    'import { NextResponse } from "next/server";',
    'import { prisma } from "@/lib/db";',
    '',
    'function toBoolean(value: unknown): boolean {',
    '  return value === true || value === "true" || value === "1" || value === 1;',
    '}',
    '',
    'function previewFallbackItem(body: Record<string, unknown> = {}) {',
    '  return {',
    ...fallbackFields,
    '  };',
    '}',
    '',
    'export async function GET() {',
    '  try {',
    '    const items = await prisma.' + modelAccessor + '.findMany({ orderBy: { createdAt: "desc" } });',
    '    return NextResponse.json({ items });',
    '  } catch {',
    '    return NextResponse.json({',
    '      items: [previewFallbackItem()],',
    '      preview: true,',
    '      warning: "Base de datos no disponible en preview; conecta DATABASE_URL para persistencia real.",',
    '    });',
    '  }',
    '}',
    '',
    'export async function POST(request: Request) {',
    '  const body = await request.json().catch(() => ({}));',
    '  try {',
    '    const item = await prisma.' + modelAccessor + '.create({',
    '      data: {',
    ...coercions,
    '      },',
    '    });',
    '    return NextResponse.json({ item }, { status: 201 });',
    '  } catch {',
    '    return NextResponse.json({',
    '      item: previewFallbackItem(body as Record<string, unknown>),',
    '      preview: true,',
    '      warning: "Base de datos no disponible en preview; conecta DATABASE_URL para persistencia real.",',
    '    }, { status: 202 });',
    '  }',
    '}',
    '',
  ].join('\n');
}

function seedValue(field, entity) {
  const key = String(field.name || '').toLowerCase();
  if (field.type === 'decimal') return '129.9';
  if (field.type === 'integer') return key.includes('stock') ? '24' : '1';
  if (field.type === 'boolean') return 'true';
  if (field.type === 'datetime') return 'new Date()';
  if (field.type === 'email') return jsStr(`${camelCase(entity)}@example.com`);
  if (field.type === 'url') return jsStr('https://example.com');
  if (field.type === 'phone') return jsStr('+51 999 999 999');
  if (field.type === 'text') return jsStr(`Registro demo para ${entity}`);
  return jsStr(`${entity} demo`);
}

function buildPrismaSeed(entities) {
  const blocks = entities.map((model) => {
    const accessor = camelCase(model.entity);
    const fields = editableFields(model.fields);
    const data = fields.length
      ? fields.map((f) => '        ' + camelCase(f.name) + ': ' + seedValue(f, model.entity) + ',')
      : ['        // solo campos generados por Prisma'];
    return [
      '  await prisma.' + accessor + '.createMany({',
      '    data: [',
      '      {',
      ...data,
      '      },',
      '    ],',
      '  });',
    ].join('\n');
  });
  return [
    'import { PrismaClient } from "@prisma/client";',
    '',
    'const prisma = new PrismaClient();',
    '',
    'async function main() {',
    ...blocks,
    '}',
    '',
    'main()',
    '  .then(async () => {',
    '    await prisma.$disconnect();',
    '  })',
    '  .catch(async (error) => {',
    '    console.error(error);',
    '    await prisma.$disconnect();',
    '    process.exit(1);',
    '  });',
    '',
  ].join('\n');
}

function buildEntityPage(model) {
  const slug = kebabCase(model.entity);
  const typeName = pascalCase(model.entity);
  const editable = editableFields(model.fields);
  const allCols = model.fields.map((f) => camelCase(f.name));

  // TS interface for a row.
  const ifaceFields = model.fields.map((f) => '  ' + camelCase(f.name) + ': ' + tsType(f.type) + ';');
  // Initial form state.
  const initialState = editable.map((f) => {
    const key = camelCase(f.name);
    return '    ' + key + ': ' + (tsType(f.type) === 'number' ? '0' : tsType(f.type) === 'boolean' ? 'false' : '""') + ',';
  });
  // Form inputs.
  const inputs = editable.map((f) => {
    const key = camelCase(f.name);
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
    'const API = "../api/' + slug + '";',
    '',
    'export default function ' + typeName + 'Page() {',
    '  const [items, setItems] = useState<' + typeName + '[]>([]);',
    '  const [form, setForm] = useState({',
    ...initialState,
    '  });',
    '  const [loading, setLoading] = useState(true);',
    '',
    '  async function load() {',
    '    try {',
    '      const res = await fetch(API);',
    '      const data = await res.json().catch(() => ({ items: [] }));',
    '      setItems(Array.isArray(data.items) ? data.items : []);',
    '    } finally {',
    '      setLoading(false);',
    '    }',
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
  const entities = brief.platform === 'landing' ? [] : blueprint.dataModel;

  const files = [
    { path: 'package.json', language: 'json', content: buildPackageJson(brief, entities.length > 0) },
    { path: 'tsconfig.json', language: 'json', content: buildTsConfig() },
    { path: 'next.config.mjs', language: 'javascript', content: buildNextConfig() },
    { path: 'app/globals.css', language: 'css', content: buildGlobalsCss(brief) },
    { path: 'components/site-nav.tsx', language: 'tsx', content: buildSiteNav(brief, entities) },
    { path: 'app/layout.tsx', language: 'tsx', content: buildLayout(brief) },
    { path: 'app/manifest.ts', language: 'typescript', content: buildManifest(brief) },
    { path: 'app/icon.svg', language: 'svg', content: buildIconSvg(brief) },
    { path: 'app/page.tsx', language: 'tsx', content: buildHomePage(brief, entities) },
  ];

  if (entities.length > 0) {
    files.push({ path: 'docker-compose.yml', language: 'yaml', content: buildDockerCompose() });
    files.push({ path: 'lib/db.ts', language: 'typescript', content: buildPrismaClientLib() });
    files.push({ path: 'prisma/seed.ts', language: 'typescript', content: buildPrismaSeed(entities) });
    for (const model of entities) {
      const slug = kebabCase(model.entity);
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
