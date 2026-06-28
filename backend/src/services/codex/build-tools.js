'use strict';

/**
 * codex/build-tools — the tools the build loop can call against the workspace
 * (feature 06), all routed through the runner client (the only process with
 * filesystem access). Five tools: run_command, read_file, write_file,
 * edit_file, web_search. Each declares its `kind` (for the timeline chip icon),
 * how to derive `command`/`path` for the action record, and a pure-ish
 * `execute(args, ctx)` returning a normalised result the loop turns into
 * action_start/action_end events + a CodexAction row.
 *
 * execute never throws for a tool-level failure — it returns `{ isError: true }`
 * so the loop records `action_end status:error` and feeds the error back to the
 * model (the agent can self-correct) without aborting the run.
 */

function lineCount(text) {
  if (!text) return 0;
  const s = String(text);
  if (s.length === 0) return 0;
  return s.split('\n').length;
}

function summarise(text, n = 4000) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}\n…[+${s.length - n} chars]` : s;
}

/**
 * Parse a Prisma schema into a structured shape so the agent can reason about
 * the project's database without a live connection. Prisma block bodies never
 * nest braces, so `[^}]*` is a safe (and ReDoS-free) body matcher.
 */
function parsePrismaSchema(text) {
  const src = String(text || '');
  const provider = (src.match(/datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/) || [])[1] || null;

  const models = [];
  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = modelRe.exec(src))) {
    const fields = [];
    for (const raw of m[2].split('\n')) {
      const t = raw.trim();
      if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
      const fm = t.match(/^(\w+)\s+([\w[\]?.]+)(.*)$/);
      if (fm) fields.push({ name: fm[1], type: fm[2], attrs: fm[3].trim() });
    }
    models.push({ name: m[1], fields });
  }

  const enums = [];
  const enumRe = /enum\s+(\w+)\s*\{([^}]*)\}/g;
  let e;
  while ((e = enumRe.exec(src))) {
    const values = e[2].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    enums.push({ name: e[1], values });
  }

  return { provider, models, enums };
}

function formatSchema(schema) {
  const lines = [];
  if (schema.provider) lines.push(`Provider: ${schema.provider}`);
  lines.push(`Modelos (${schema.models.length}):`);
  for (const model of schema.models) {
    lines.push(`  • ${model.name} (${model.fields.length} campos)`);
    for (const f of model.fields) lines.push(`      - ${f.name}: ${f.type}${f.attrs ? ` ${f.attrs}` : ''}`);
  }
  if (schema.enums.length) {
    lines.push(`Enums (${schema.enums.length}):`);
    for (const en of schema.enums) lines.push(`  • ${en.name}: ${en.values.join(', ')}`);
  }
  return lines.join('\n');
}

const TOOLS = {
  run_command: {
    kind: 'terminal',
    description: 'Ejecuta un comando en el workspace (allowlist: git, bun, bunx, node, ls, cat, wc). cmd es un array de strings.',
    parameters: { type: 'object', properties: { cmd: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' } }, required: ['cmd'] },
    commandFor: (args) => (Array.isArray(args?.cmd) ? args.cmd.join(' ') : String(args?.cmd || '')),
    pathFor: () => null,
    async execute(args, ctx) {
      const cmd = Array.isArray(args?.cmd) ? args.cmd : null;
      if (!cmd) return { isError: true, summary: 'cmd debe ser un array de strings', observation: 'Error: cmd debe ser un array de strings.' };
      try {
        const out = await ctx.runner.exec(ctx.project, cmd, { timeoutMs: args.timeoutMs });
        const body = summarise([out.stdout, out.stderr].filter(Boolean).join('\n'));
        const ok = out.exitCode === 0;
        return {
          isError: !ok,
          summary: `exit ${out.exitCode}\n${body}`,
          observation: `exitCode=${out.exitCode}\n${body}`,
        };
      } catch (err) {
        return { isError: true, summary: `runner error: ${err.message}`, observation: `Error ejecutando comando: ${err.message}` };
      }
    },
  },

  read_file: {
    kind: 'file_read',
    description: 'Lee el contenido de un archivo del workspace. Devuelve el texto y cuenta las líneas leídas.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    commandFor: () => null,
    pathFor: (args) => args?.path || null,
    async execute(args, ctx) {
      if (!args?.path) return { isError: true, summary: 'path requerido', observation: 'Error: path requerido.' };
      try {
        const out = await ctx.runner.readFile(ctx.project, args.path);
        const content = out?.content ?? '';
        const linesRead = lineCount(content);
        return { isError: false, summary: summarise(content), linesRead, observation: summarise(content, 8000) };
      } catch (err) {
        return { isError: true, summary: `no se pudo leer: ${err.message}`, observation: `Error leyendo ${args.path}: ${err.message}` };
      }
    },
  },

  write_file: {
    kind: 'file_write',
    description: 'Crea o sobrescribe un archivo del workspace con el contenido dado.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    commandFor: () => null,
    pathFor: (args) => args?.path || null,
    async execute(args, ctx) {
      if (!args?.path || typeof args.content !== 'string') {
        return { isError: true, summary: 'path y content requeridos', observation: 'Error: path y content (string) requeridos.' };
      }
      try {
        await ctx.runner.writeFiles(ctx.project, [{ path: args.path, content: args.content }]);
        const bytes = Buffer.byteLength(args.content, 'utf8');
        return { isError: false, summary: `escrito ${args.path} (${bytes} bytes)`, observation: `OK: escrito ${args.path} (${bytes} bytes).` };
      } catch (err) {
        return { isError: true, summary: `no se pudo escribir: ${err.message}`, observation: `Error escribiendo ${args.path}: ${err.message}` };
      }
    },
  },

  edit_file: {
    kind: 'file_write',
    description: 'Edita un archivo: reemplaza la primera aparición EXACTA de `find` por `replace`. Falla si `find` no existe.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'find', 'replace'] },
    commandFor: () => null,
    pathFor: (args) => args?.path || null,
    async execute(args, ctx) {
      if (!args?.path || typeof args.find !== 'string' || typeof args.replace !== 'string') {
        return { isError: true, summary: 'path, find y replace requeridos', observation: 'Error: path, find y replace (string) requeridos.' };
      }
      try {
        const cur = await ctx.runner.readFile(ctx.project, args.path);
        const content = cur?.content ?? '';
        if (!content.includes(args.find)) {
          return { isError: true, summary: `texto a reemplazar no encontrado en ${args.path}`, observation: `Error: el texto a reemplazar no existe en ${args.path}.` };
        }
        const next = content.replace(args.find, args.replace);
        await ctx.runner.writeFiles(ctx.project, [{ path: args.path, content: next }]);
        return { isError: false, summary: `editado ${args.path}`, observation: `OK: editado ${args.path}.` };
      } catch (err) {
        return { isError: true, summary: `no se pudo editar: ${err.message}`, observation: `Error editando ${args.path}: ${err.message}` };
      }
    },
  },

  web_search: {
    kind: 'web',
    description: 'Busca en la web información actual (docs, ejemplos). Devuelve títulos y fragmentos.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    commandFor: (args) => (args?.query ? `search: ${args.query}` : null),
    pathFor: () => null,
    async execute(args, ctx) {
      if (!args?.query) return { isError: true, summary: 'query requerido', observation: 'Error: query requerido.' };
      if (typeof ctx.webSearch !== 'function') {
        return { isError: true, summary: 'web_search no disponible', observation: 'web_search no está disponible en este entorno.' };
      }
      try {
        const results = await ctx.webSearch(args.query);
        const list = Array.isArray(results) ? results : results?.results || [];
        const text = list.slice(0, 5).map((r) => `- ${r.title || r.url}: ${summarise(r.snippet || r.content || '', 200)}`).join('\n');
        return { isError: false, summary: summarise(text), observation: text || 'Sin resultados.' };
      } catch (err) {
        return { isError: true, summary: `búsqueda falló: ${err.message}`, observation: `Error en la búsqueda: ${err.message}` };
      }
    },
  },

  inspect_database: {
    kind: 'database',
    description: 'Inspecciona el esquema de base de datos del proyecto (Prisma). Devuelve el provider, los modelos/tablas con sus campos y los enums, para rastrear y razonar sobre la base de datos antes de generar o modificar código que la use. No requiere conexión viva.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta al schema (por defecto prisma/schema.prisma).' } }, required: [] },
    commandFor: (args) => `inspect db: ${args?.path || 'prisma/schema.prisma'}`,
    pathFor: (args) => args?.path || 'prisma/schema.prisma',
    async execute(args, ctx) {
      const path = args?.path || 'prisma/schema.prisma';
      let content;
      try {
        const out = await ctx.runner.readFile(ctx.project, path);
        content = out?.content ?? '';
      } catch (err) {
        // Missing schema is the common case (project has no DB yet) — return it
        // as informational, NOT an error, so the agent can decide to create one.
        return { isError: false, summary: `sin base de datos en ${path}`, observation: `No se encontró un esquema en ${path} (el proyecto aún no tiene base de datos, o el schema vive en otra ruta — pasa "path" para apuntar a ella). Detalle: ${err.message}` };
      }
      if (!content.trim()) {
        return { isError: false, summary: `${path} vacío`, observation: `El archivo ${path} está vacío — el proyecto aún no define una base de datos.` };
      }
      const schema = parsePrismaSchema(content);
      if (!schema.models.length && !schema.provider) {
        return { isError: false, summary: `${path} sin modelos`, observation: `${path} no parece un schema Prisma con modelos. Contenido (recortado):\n${summarise(content, 1200)}` };
      }
      const text = formatSchema(schema);
      return { isError: false, summary: summarise(text), models: schema.models.length, observation: summarise(text, 8000) };
    },
  },
};

/** Registry projection for prompted-tool-calling: [{ name, description, parameters }]. */
function toolRegistry(names = Object.keys(TOOLS)) {
  return names.filter((n) => TOOLS[n]).map((name) => ({ name, description: TOOLS[name].description, parameters: TOOLS[name].parameters }));
}

function getTool(name) {
  return TOOLS[name] || null;
}

module.exports = { TOOLS, toolRegistry, getTool, lineCount, summarise, parsePrismaSchema, formatSchema };
