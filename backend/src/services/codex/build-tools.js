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
    description: 'Ejecuta un comando no interactivo en el workspace (allowlist: git, bun, bunx, node, ls, cat, wc). No uses scaffolds interactivos como create-next-app/create-vite; para landings/apps simples escribe archivos con write_file/edit_file.',
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

  list_files: {
    kind: 'file_read',
    description: 'Lista los archivos del workspace (tracked + nuevos, sin node_modules). Úsalo para orientarte antes de leer o editar.',
    parameters: { type: 'object', properties: {}, required: [] },
    commandFor: () => 'list files',
    pathFor: () => null,
    async execute(_args, ctx) {
      try {
        const out = await ctx.runner.exec(ctx.project, ['git', 'ls-files', '--cached', '--others', '--exclude-standard']);
        if (out.exitCode !== 0) {
          return { isError: true, summary: `exit ${out.exitCode}`, observation: `No pude listar archivos: ${summarise(out.stderr || out.stdout, 500)}` };
        }
        const text = summarise(out.stdout, 4000);
        return { isError: false, summary: text, observation: text || '(workspace vacío)' };
      } catch (err) {
        return { isError: true, summary: `runner error: ${err.message}`, observation: `Error listando archivos: ${err.message}` };
      }
    },
  },

  type_check: {
    kind: 'terminal',
    description: 'Compila el proyecto con TypeScript (tsc --noEmit) y devuelve los errores REALES de tipos/imports. Úsalo SIEMPRE después de crear o editar código, y corrige lo que salga antes de terminar.',
    parameters: { type: 'object', properties: { timeoutMs: { type: 'number' } }, required: [] },
    commandFor: () => 'bunx tsc --noEmit',
    pathFor: () => null,
    async execute(args, ctx) {
      try {
        const out = await ctx.runner.exec(ctx.project, ['bunx', 'tsc', '--noEmit', '--pretty', 'false'], { timeoutMs: args?.timeoutMs || 120000 });
        if (out.exitCode === 0) {
          return { isError: false, summary: 'type check limpio', observation: 'OK: el proyecto compila sin errores de TypeScript.' };
        }
        const diagnostics = summarise([out.stdout, out.stderr].filter(Boolean).join('\n'), 6000);
        return {
          isError: true,
          summary: `errores de tipos (exit ${out.exitCode})`,
          observation: `El proyecto NO compila. Errores de TypeScript:\n${diagnostics}\nCorrige estos errores editando los archivos afectados.`,
        };
      } catch (err) {
        // A missing tsconfig / offline bunx is informational, not a build failure.
        return { isError: false, summary: `type check no disponible: ${err.message}`, observation: `No pude ejecutar el type check (${err.message}). Continúa con cuidado.` };
      }
    },
  },

  dev_server_check: {
    kind: 'terminal',
    description: 'Arranca (o consulta) el dev server del workspace y devuelve su estado real: si está listo, y las últimas líneas de log con los errores en vivo (module not found, syntax error, overlay de Vite…). Úsalo para verificar que la app realmente corre y para leer errores de runtime.',
    parameters: { type: 'object', properties: { waitMs: { type: 'number', description: 'Tiempo máximo de espera a que esté listo (default 20000).' } }, required: [] },
    commandFor: () => 'dev server check',
    pathFor: () => null,
    async execute(args, ctx) {
      const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
      try {
        let status = await ctx.runner.devStatus();
        // Not running (or running another project) → (re)start it for this one.
        if (!status?.running || (status.project && status.project !== ctx.project)) {
          await ctx.runner.startDev(ctx.project);
        }
        const deadline = Date.now() + Math.min(Math.max(Number(args?.waitMs) || 20000, 2000), 60000);
        do {
          await sleep(1500);
          status = await ctx.runner.devStatus();
          if (status?.ready || status?.error) break;
        } while (Date.now() < deadline);

        const tail = Array.isArray(status?.tail) ? status.tail.join('\n') : '';
        const errLines = tail.split('\n').filter((l) => /error|failed|cannot|not found|exception/i.test(l)).join('\n');
        if (status?.ready && !errLines) {
          return { isError: false, summary: 'dev server listo', observation: `OK: el dev server está corriendo y responde.\nÚltimos logs:\n${summarise(tail, 1500)}` };
        }
        if (status?.ready && errLines) {
          return { isError: false, summary: 'dev server listo con avisos', observation: `El dev server responde pero los logs muestran posibles problemas:\n${summarise(errLines, 2000)}\nLogs completos:\n${summarise(tail, 1500)}` };
        }
        return {
          isError: true,
          summary: `dev server no listo${status?.error ? `: ${status.error}` : ''}`,
          observation: `El dev server NO está listo${status?.error ? ` (error: ${status.error})` : ''}.\nLogs:\n${summarise(tail, 2500)}\nDiagnostica y corrige el problema (revisa imports, package.json y sintaxis).`,
        };
      } catch (err) {
        return { isError: true, summary: `runner error: ${err.message}`, observation: `No pude consultar el dev server: ${err.message}` };
      }
    },
  },

  run_subagent: {
    kind: 'agent',
    description: 'Delega una tarea grande o especializada en un subagente experto con contexto fresco: planner (plan de construcción), frontend_builder (UI React/TS), backend_engineer (APIs y datos), db_architect (modelo de datos), qa_reviewer (revisión y verificación), enterprise_analyst (especificación de software empresarial: CRM/ERP/inventario/facturación/RRHH). Recibes solo su informe final.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Nombre del subagente.' },
        task: { type: 'string', description: 'Tarea concreta y autocontenida para el subagente.' },
        context: { type: 'string', description: 'Contexto extra del proyecto que el subagente necesita.' },
      },
      required: ['agent', 'task'],
    },
    commandFor: (args) => `subagent ${args?.agent || '?'}: ${String(args?.task || '').slice(0, 80)}`,
    pathFor: () => null,
    async execute(args, ctx) {
      // Lazy require to avoid a module cycle (agent-sdk requires build-tools).
      // eslint-disable-next-line global-require
      const sdk = require('./agent-sdk');
      try {
        const outcome = await sdk.runSubagent({
          name: String(args?.agent || ''),
          task: String(args?.task || ''),
          context: String(args?.context || ''),
          deps: { runner: ctx.runner, project: ctx.project, webSearch: ctx.webSearch, env: ctx.env, llmTurn: ctx.llmTurn, signal: ctx.signal, onUsage: ctx.onUsage },
        });
        const report = sdk.formatSubagentReport(outcome);
        return { isError: !outcome.ok, summary: `${outcome.agent}: ${outcome.ok ? 'completado' : 'falló'} (${outcome.toolCallsCount} herramientas)`, observation: report };
      } catch (err) {
        return { isError: true, summary: `subagente falló: ${err.message}`, observation: `Error ejecutando el subagente: ${err.message}` };
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
