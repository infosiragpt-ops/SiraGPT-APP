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
    description: 'Lee el contenido de un archivo del workspace. Acepta offset (línea inicial, 1-based) y limit (número de líneas) para leer archivos grandes por partes. Devuelve el texto y cuenta las líneas leídas.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number', description: 'Línea inicial 1-based (opcional).' }, limit: { type: 'number', description: 'Máximo de líneas a devolver (opcional).' } }, required: ['path'] },
    commandFor: () => null,
    pathFor: (args) => args?.path || null,
    async execute(args, ctx) {
      if (!args?.path) return { isError: true, summary: 'path requerido', observation: 'Error: path requerido.' };
      try {
        const out = await ctx.runner.readFile(ctx.project, args.path);
        let content = out?.content ?? '';
        const totalLines = lineCount(content);
        const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) > 1 ? Math.floor(Number(args.offset)) : 1;
        const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 0;
        if (offset > 1 || limit) {
          const lines = content.split('\n');
          const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined);
          content = slice.join('\n');
          const header = `[líneas ${offset}-${offset - 1 + slice.length} de ${totalLines}]`;
          const linesRead = slice.length;
          return { isError: false, summary: summarise(`${header}\n${content}`), linesRead, observation: `${header}\n${summarise(content, 8000)}` };
        }
        return { isError: false, summary: summarise(content), linesRead: totalLines, observation: summarise(content, 8000) };
      } catch (err) {
        return { isError: true, summary: `no se pudo leer: ${err.message}`, observation: `Error leyendo ${args.path}: ${err.message}` };
      }
    },
  },

  list_files: {
    kind: 'file_read',
    description: 'Lista los archivos del workspace (tracked + nuevos, sin node_modules). Úsalo para orientarte antes de leer o editar.',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Substring o glob simple para filtrar rutas (opcional).' } }, required: [] },
    commandFor: (args) => (args?.pattern ? `list: ${args.pattern}` : 'list files'),
    pathFor: () => null,
    async execute(args, ctx) {
      try {
        const out = await ctx.runner.exec(ctx.project, ['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { timeoutMs: 15000 });
        if (out.exitCode !== 0) {
          return { isError: true, summary: `git ls-files exit ${out.exitCode}`, observation: `Error listando archivos: ${summarise(out.stderr || out.stdout, 1000)}` };
        }
        let files = String(out.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
        const pattern = String(args?.pattern || '').trim();
        if (pattern) {
          // Glob "*"→cualquier tramo; sin comodines se trata como substring.
          const rx = pattern.includes('*')
            ? new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i')
            : null;
          files = files.filter((f) => (rx ? rx.test(f) : f.toLowerCase().includes(pattern.toLowerCase())));
        }
        const text = files.slice(0, 400).join('\n') + (files.length > 400 ? `\n…[+${files.length - 400} más]` : '');
        return { isError: false, summary: `${files.length} archivos`, observation: text || 'Sin archivos que coincidan.' };
      } catch (err) {
        return { isError: true, summary: `no se pudo listar: ${err.message}`, observation: `Error listando archivos: ${err.message}` };
      }
    },
  },

  grep_search: {
    kind: 'file_read',
    description: 'Busca un texto o regex en los archivos del workspace (como grep). Devuelve archivo:línea:contenido. Úsalo para localizar código antes de editar.',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Texto o regex POSIX a buscar.' }, path: { type: 'string', description: 'Limitar a un archivo o directorio (opcional).' }, ignoreCase: { type: 'boolean' } }, required: ['pattern'] },
    commandFor: (args) => (args?.pattern ? `grep: ${args.pattern}` : null),
    pathFor: (args) => args?.path || null,
    async execute(args, ctx) {
      const pattern = String(args?.pattern || '');
      if (!pattern) return { isError: true, summary: 'pattern requerido', observation: 'Error: pattern requerido.' };
      const cmd = ['git', 'grep', '-In', '--untracked'];
      if (args?.ignoreCase) cmd.push('-i');
      cmd.push('-e', pattern);
      if (args?.path) cmd.push('--', String(args.path));
      try {
        const out = await ctx.runner.exec(ctx.project, cmd, { timeoutMs: 15000 });
        // git grep exit 1 = sin coincidencias (no es un error del tool).
        if (out.exitCode === 1) return { isError: false, summary: 'sin coincidencias', observation: `Sin coincidencias para: ${pattern}` };
        if (out.exitCode !== 0) {
          return { isError: true, summary: `grep exit ${out.exitCode}`, observation: `Error buscando: ${summarise(out.stderr || out.stdout, 1000)}` };
        }
        const lines = String(out.stdout || '').split('\n').filter(Boolean);
        const text = lines.slice(0, 120).join('\n') + (lines.length > 120 ? `\n…[+${lines.length - 120} coincidencias más]` : '');
        return { isError: false, summary: `${lines.length} coincidencias`, observation: summarise(text, 8000) };
      } catch (err) {
        return { isError: true, summary: `búsqueda falló: ${err.message}`, observation: `Error buscando: ${err.message}` };
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
    description: 'Edita un archivo: reemplaza la aparición EXACTA de `find` por `replace`. Si `find` aparece más de una vez, falla salvo que pases replaceAll:true — amplía `find` con más contexto para hacerlo único. Falla si `find` no existe.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, replaceAll: { type: 'boolean', description: 'Reemplazar TODAS las apariciones (opcional).' } }, required: ['path', 'find', 'replace'] },
    commandFor: () => null,
    pathFor: (args) => args?.path || null,
    async execute(args, ctx) {
      if (!args?.path || typeof args.find !== 'string' || typeof args.replace !== 'string') {
        return { isError: true, summary: 'path, find y replace requeridos', observation: 'Error: path, find y replace (string) requeridos.' };
      }
      try {
        const cur = await ctx.runner.readFile(ctx.project, args.path);
        const content = cur?.content ?? '';
        const occurrences = args.find.length ? content.split(args.find).length - 1 : 0;
        if (occurrences === 0) {
          return { isError: true, summary: `texto a reemplazar no encontrado en ${args.path}`, observation: `Error: el texto a reemplazar no existe en ${args.path}. Lee el archivo con read_file y copia el fragmento EXACTO (espacios e indentación incluidos).` };
        }
        if (occurrences > 1 && !args.replaceAll) {
          return { isError: true, summary: `find ambiguo (${occurrences} apariciones) en ${args.path}`, observation: `Error: \`find\` aparece ${occurrences} veces en ${args.path}. Amplía \`find\` con líneas de contexto para hacerlo único, o pasa replaceAll:true para reemplazar todas.` };
        }
        const next = args.replaceAll ? content.split(args.find).join(args.replace) : content.replace(args.find, args.replace);
        await ctx.runner.writeFiles(ctx.project, [{ path: args.path, content: next }]);
        const n = args.replaceAll ? occurrences : 1;
        return { isError: false, summary: `editado ${args.path} (${n} reemplazo${n === 1 ? '' : 's'})`, observation: `OK: editado ${args.path} (${n} reemplazo${n === 1 ? '' : 's'}).` };
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
      // Track whether WE started the server: if the user's preview was already
      // running for this project we must NOT stop it (that would kill the live
      // preview). If we started it only for the check, stop it at the end so we
      // don't leak a runner pool slot (mirrors agent-loop.verifyDevServer).
      let startedByUs = false;
      try {
        let status = await ctx.runner.devStatus(ctx.project);
        // Not running (or running another project) → (re)start it for this one.
        if (!status?.running || (status.project && status.project !== ctx.project)) {
          await ctx.runner.startDev(ctx.project);
          startedByUs = true;
        }
        const deadline = Date.now() + Math.min(Math.max(Number(args?.waitMs) || 20000, 2000), 60000);
        do {
          await sleep(1500);
          status = await ctx.runner.devStatus(ctx.project);
          if (status?.ready || status?.error) break;
        } while (Date.now() < deadline);

        // Capture the tail/status the agent needs BEFORE releasing the slot.
        const tail = Array.isArray(status?.tail) ? status.tail.join('\n') : '';
        const errLines = tail.split('\n').filter((l) => /error|failed|cannot|not found|exception/i.test(l)).join('\n');
        // We only started a throwaway server for the check → release it now that
        // we've read the status. A pre-existing server (the user's preview) is
        // left running.
        if (startedByUs && typeof ctx.runner.stopDev === 'function') {
          await ctx.runner.stopDev(ctx.project).catch(() => {});
        }
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
        // On a failure after we started it, still release the slot we grabbed.
        if (startedByUs && typeof ctx.runner.stopDev === 'function') {
          await ctx.runner.stopDev(ctx.project).catch(() => {});
        }
        return { isError: true, summary: `runner error: ${err.message}`, observation: `No pude consultar el dev server: ${err.message}` };
      }
    },
  },

  run_subagent: {
    kind: 'agent',
    description: 'Delega una tarea grande o especializada en un subagente experto con contexto fresco: planner (plan de construcción), frontend_builder (UI React/TS), backend_engineer (APIs y datos), db_architect (modelo de datos), qa_reviewer (revisión y verificación), debugger (diagnóstico y fix de errores reales), enterprise_analyst (especificación de software empresarial: CRM/ERP/inventario/facturación/RRHH), más los agentes custom que el proyecto defina en .sira/agents.json. Puedes emitir VARIOS run_subagent en el mismo turno y correrán en paralelo. Recibes solo su informe final.',
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
        const customAgents = await sdk.loadWorkspaceAgents({ runner: ctx.runner, project: ctx.project });
        const outcome = await sdk.runSubagent({
          name: String(args?.agent || ''),
          task: String(args?.task || ''),
          context: String(args?.context || ''),
          deps: { runner: ctx.runner, project: ctx.project, webSearch: ctx.webSearch, env: ctx.env, llmTurn: ctx.llmTurn, tier: ctx.tier || null, signal: ctx.signal, onUsage: ctx.onUsage, emitAction: ctx.emitAction, customAgents },
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
