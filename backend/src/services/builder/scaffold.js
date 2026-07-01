'use strict';

/**
 * siraGPT Builder · E3 — scaffold.
 *
 * Turns the E2 blueprint into concrete starter artifacts: a Prisma schema
 * derived from the data model, a README describing the project + plan, and a
 * .env.example seeded from the chosen integrations. Pure and deterministic —
 * the same brief always yields byte-identical files.
 */

const { ProjectBriefSchema } = require('./contracts');
const { planFromBrief } = require('./blueprint');
const { buildPreviewHtml } = require('./preview');
const { buildLiveApp } = require('./live-app');
const {
  codegenFromBrief,
  buildPrismaSchema: codegenBuildPrismaSchema,
  PRISMA_TYPES,
  pascalCase,
  camelCase,
} = require('./codegen');

// The Prisma schema is now OWNED by codegen (single source of truth), so a
// direct caller of `codegenFromBrief` gets a runnable `prisma generate`. Kept
// here as a thin blueprint-shaped adapter for backward-compat with the
// previously-exported `buildPrismaSchema(blueprint)` signature.
function buildPrismaSchema(blueprint) {
  return codegenBuildPrismaSchema(blueprint.dataModel);
}

function buildReadme(brief, blueprint) {
  const title = brief.purpose ? brief.purpose : 'Proyecto siraGPT Builder';
  const featureList = brief.coreFeatures.length ? brief.coreFeatures.map((f) => `- ${f}`).join('\n') : '- (sin funcionalidades declaradas)';
  const pageList = blueprint.pages.map((p) => `- **${p.name}** — ${p.purpose}`).join('\n');
  const entityList = blueprint.dataModel.length
    ? blueprint.dataModel.map((m) => `- **${m.entity}** (${m.fields.map((f) => f.name).join(', ')})`).join('\n')
    : '- (sin entidades)';
  const milestoneList = blueprint.milestones
    .map((m) => `### ${m.title}\n${m.tasks.map((t) => `- [ ] ${t}`).join('\n')}`)
    .join('\n\n');

  return `# ${title}

> Audiencia: ${brief.audience || 'por definir'} · Plataforma: ${brief.platform} · Complejidad estimada: ${blueprint.estimate.complexity}

## Capas de la aplicación
- **Frontend:** páginas React/Next.js en \`app/**/page.tsx\`
- **Backend:** Route Handlers en \`app/api/**/route.ts\`
- **Base de datos:** Prisma + PostgreSQL en \`prisma/schema.prisma\`
- **Web:** \`npm run build:web\` y \`npm run preview:web\`
- **Celular:** responsive mobile-first + manifest PWA; \`npm run build:mobile\` valida el mismo bundle instalable en móvil.
- **Ejecución local:** \`docker compose up -d db\`, \`npm install\`, \`cp .env.example .env\`, \`npm run db:push\`, \`npm run db:seed\`, \`npm run dev\`

## Stack
- **Frontend:** ${blueprint.stack.frontend}
- **Backend:** ${blueprint.stack.backend}
- **Base de datos:** ${blueprint.stack.database}
- **Hosting:** ${blueprint.stack.hosting}

## Funcionalidades clave
${featureList}

## Pantallas (${blueprint.pages.length})
${pageList}

## Modelo de datos
${entityList}

## Integraciones
${brief.integrations.length ? brief.integrations.map((i) => `- ${i}`).join('\n') : '- (ninguna)'}

## Plan de construcción
${milestoneList}

${brief.constraints ? `## Restricciones\n${brief.constraints}\n` : ''}${brief.openQuestions.length ? `## Preguntas abiertas\n${brief.openQuestions.map((q) => `- ${q}`).join('\n')}\n` : ''}
---
_Generado automáticamente por siraGPT Builder._
`;
}

function buildClientReadme(brief, blueprint) {
  const title = brief.purpose ? brief.purpose : 'Proyecto siraGPT Builder';
  const pageList = blueprint.pages.map((p) => `- **${p.name}** — ${p.purpose}`).join('\n');
  const entityList = blueprint.dataModel.length
    ? blueprint.dataModel.map((m) => `- **${m.entity}** (${m.fields.map((f) => f.name).join(', ')})`).join('\n')
    : '- (sin entidades)';
  const featureList = brief.coreFeatures.length ? brief.coreFeatures.map((f) => `- ${f}`).join('\n') : '- (sin funcionalidades declaradas)';

  return `# ${title}

> Audiencia: ${brief.audience || 'por definir'} · Plataforma: ${brief.platform}

App autónoma de una sola página (\`index.html\`). Se ejecuta directamente en el
navegador — **sin instalar nada, sin servidor y sin base de datos**. Los datos se
guardan localmente en el navegador (localStorage), así que el preview funciona al
instante.

## Cómo usarla
- Abre \`index.html\` (o pulsa **▶ Ejecutar** en el editor) para ver la app en vivo.
- Cada pantalla guarda sus registros en tu navegador automáticamente.

## Pantallas (${blueprint.pages.length})
${pageList}

## Datos que gestiona
${entityList}

## Funcionalidades clave
${featureList}

---
_Generado automáticamente por siraGPT Builder._
`;
}

function buildEnvExample(brief, blueprint) {
  const lines = [];
  if (blueprint.stack.database !== '—') {
    lines.push('DATABASE_URL="postgresql://postgres:postgres@localhost:5432/siragpt_app?schema=public"');
  }
  for (const integration of brief.integrations) {
    const key = String(integration).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (key) lines.push(`${key}_API_KEY=""`);
  }
  lines.push('NODE_ENV="development"');
  return lines.join('\n') + '\n';
}

/**
 * Generate starter files from a ProjectBrief.
 *
 * @param {object} rawBrief — must satisfy ProjectBriefSchema.
 * @param {object} [options]
 * @param {'fullstack'|'client'} [options.mode='fullstack'] — 'fullstack' emits
 *   the runnable Next.js + Prisma project alongside the self-contained preview.
 *   'client' emits ONLY the self-contained single-file app (index.html +
 *   preview.html + README.md) — no package.json/Prisma/.env/codegen — so the
 *   live preview renders instantly on any active tab (a package.json with
 *   next/vite would otherwise gate the preview behind ▶ Ejecutar) and never
 *   500s at runtime for a missing DATABASE_URL.
 * @returns {{ blueprint: object, files: Array<{path:string, language:string, content:string}> }}
 */
function scaffoldFromBrief(rawBrief, options = {}) {
  const mode = options.mode === 'client' ? 'client' : 'fullstack';
  const parsed = ProjectBriefSchema.safeParse(rawBrief);
  if (!parsed.success) {
    throw new Error(`scaffold: invalid ProjectBrief: ${parsed.error.message}`);
  }
  const brief = parsed.data;
  const blueprint = planFromBrief(brief);

  // index.html is a *runnable* single-file app (React via CDN + localStorage
  // CRUD) so the workspace live preview renders a working app immediately —
  // index.html is the preview engine's preferred entry.
  const liveApp = { path: 'index.html', language: 'html', content: buildLiveApp(brief, blueprint) };
  const preview = { path: 'preview.html', language: 'html', content: buildPreviewHtml(brief) };

  // Client mode: ship only the self-contained app + docs. No package.json means
  // isNodeBundlerProject() is false, so buildPreviewDocument() renders index.html
  // regardless of which file is active in the editor.
  if (mode === 'client') {
    const files = [
      liveApp,
      preview,
      { path: 'README.md', language: 'markdown', content: buildClientReadme(brief, blueprint) },
    ];
    return { blueprint, files };
  }

  const files = [
    liveApp,
    preview,
    { path: 'README.md', language: 'markdown', content: buildReadme(brief, blueprint) },
    { path: '.env.example', language: 'dotenv', content: buildEnvExample(brief, blueprint) },
  ];

  // Real codegen (E3+): for Next.js platforms (web/landing) emit a runnable
  // project alongside the starter docs — INCLUDING `prisma/schema.prisma`,
  // which codegen now owns (single source of truth), so there is exactly one
  // schema in the output. Out-of-slice platforms (mobile/desktop) yield no code
  // here and keep just the starters above. Reuse the already-computed blueprint
  // so the plan stays consistent. The path-dedup guard keeps the composition
  // idempotent even if a starter ever collides with a generated path.
  const { files: codeFiles } = codegenFromBrief(brief, blueprint);
  const existingPaths = new Set(files.map((f) => f.path));
  for (const file of codeFiles) {
    if (!existingPaths.has(file.path)) files.push(file);
  }

  return { blueprint, files };
}

module.exports = {
  scaffoldFromBrief,
  // exported for reuse / inspection
  buildPrismaSchema,
  pascalCase,
  camelCase,
  PRISMA_TYPES,
};
