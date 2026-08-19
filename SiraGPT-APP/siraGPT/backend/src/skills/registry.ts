import { promises as fsp } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { EventEmitter } from 'events';

import {
  SkillManifestSchema,
  type LoadedSkill,
  type SkillContext,
  type SkillLoadIssue,
  type SkillManifest,
  type SkillModule,
  type SkillLogger,
} from './types.ts';
import { buildSkillContext } from './sandbox.ts';

const ENTRY_CANDIDATES = ['index.ts', 'index.mjs', 'index.js', 'index.cjs'];

export interface SkillRegistryOptions {
  rootDir: string;
  logger?: SkillLogger;
  fetchImpl?: typeof fetch;
  extraGrants?: Iterable<string>;
  /**
   * If true and chokidar is installed, watch `rootDir` for changes and
   * hot-reload affected skills. Off by default; only meant for `NODE_ENV=development`.
   */
  watch?: boolean;
  /**
   * Override the dynamic importer used to load skill entry files. The
   * default delegates to native ESM `import()`. Tests bypass this so the
   * importer is not rewritten by their bundler.
   */
  importer?: (url: string) => Promise<unknown>;
}

interface InternalLoaded extends LoadedSkill {
  ctx: SkillContext;
}

export interface ReloadResult {
  loaded: LoadedSkill[];
  issues: SkillLoadIssue[];
}

/**
 * Registry for runtime-loadable skills.
 *
 * A skill lives in `<rootDir>/<name>/` with two files:
 *   - `skill.json` — manifest validated against `SkillManifestSchema`
 *   - `index.{ts,mjs,js,cjs}` — module exporting `SkillModule`
 *
 * The registry never gives skill code access to `process` or globals beyond
 * what `buildSkillContext` exposes. Skills declare scopes (e.g. `net:outbound`,
 * `env:OPENAI_API_KEY`) in their manifest; the sandbox uses those to gate
 * fetch and filter `ctx.env`.
 */
export class SkillRegistry extends EventEmitter {
  private readonly rootDir: string;
  private readonly logger?: SkillLogger;
  private readonly fetchImpl?: typeof fetch;
  private readonly extraGrants?: Iterable<string>;
  private readonly importer: (url: string) => Promise<unknown>;
  private readonly skills = new Map<string, InternalLoaded>();
  private watcher: { close: () => Promise<void> | void } | null = null;
  private reloadInFlight: Promise<ReloadResult> | null = null;

  constructor(opts: SkillRegistryOptions) {
    super();
    this.rootDir = path.resolve(opts.rootDir);
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl;
    this.extraGrants = opts.extraGrants;
    this.importer = opts.importer ?? nativeImport;
    if (opts.watch) {
      this.startWatching().catch((err) => this.emit('error', err));
    }
  }

  /** All skills currently loaded. */
  list(): LoadedSkill[] {
    return [...this.skills.values()].map(({ ctx: _ctx, ...rest }) => rest);
  }

  get(name: string): LoadedSkill | undefined {
    const entry = this.skills.get(name);
    if (!entry) return undefined;
    const { ctx: _ctx, ...rest } = entry;
    return rest;
  }

  /**
   * Discover every skill folder under rootDir and load it. Existing skills
   * are disposed first so callers can use `load()` as a full reload.
   */
  async load(): Promise<ReloadResult> {
    if (this.reloadInFlight) return this.reloadInFlight;
    this.reloadInFlight = this.doLoad();
    try {
      return await this.reloadInFlight;
    } finally {
      this.reloadInFlight = null;
    }
  }

  private async doLoad(): Promise<ReloadResult> {
    await this.disposeAll();

    const issues: SkillLoadIssue[] = [];
    const loaded: LoadedSkill[] = [];

    let entries: string[] = [];
    try {
      const dirents = await fsp.readdir(this.rootDir, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.emit('loaded', { loaded, issues });
      return { loaded, issues };
    }

    for (const name of entries) {
      const dir = path.join(this.rootDir, name);
      try {
        const skill = await this.loadOne(dir);
        loaded.push(stripCtx(skill));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        issues.push({ dir, reason });
        this.logger?.warn(`skill "${name}" failed to load: ${reason}`);
      }
    }

    this.emit('loaded', { loaded, issues });
    return { loaded, issues };
  }

  /**
   * Load (or reload) a single skill from a directory. Used both by `load()`
   * and the watcher. If a skill with the same name already exists, it is
   * disposed first.
   */
  async loadOne(dir: string): Promise<InternalLoaded> {
    const manifest = await readManifest(dir);
    const entryPath = await resolveEntry(dir, manifest.entry);
    const mod = await importFresh(entryPath, this.importer);
    const skillModule = normalizeModule(mod, manifest.name);

    const existing = this.skills.get(manifest.name);
    if (existing && existing.dir !== dir) {
      throw new Error(
        `skill name collision: "${manifest.name}" loaded from both ` +
          `${existing.dir} and ${dir}`,
      );
    }
    if (existing) await disposeSkill(existing);

    const ctx = buildSkillContext(manifest, {
      logger: this.logger,
      fetchImpl: this.fetchImpl,
      extraGrants: this.extraGrants,
    });

    if (typeof skillModule.init === 'function') {
      await skillModule.init(ctx);
    }

    const loaded: InternalLoaded = {
      manifest,
      module: skillModule,
      dir,
      loadedAt: Date.now(),
      ctx,
    };
    this.skills.set(manifest.name, loaded);
    this.emit('skill:loaded', stripCtx(loaded));
    return loaded;
  }

  /** Dispose and remove a single skill by name. */
  async unload(name: string): Promise<boolean> {
    const existing = this.skills.get(name);
    if (!existing) return false;
    await disposeSkill(existing);
    this.skills.delete(name);
    this.emit('skill:unloaded', { name });
    return true;
  }

  /** Invoke a tool exposed by a skill. */
  async invokeTool(skillName: string, toolName: string, args: unknown): Promise<unknown> {
    const entry = this.skills.get(skillName);
    if (!entry) throw new Error(`unknown skill "${skillName}"`);
    const tool = entry.module.tools?.[toolName];
    if (typeof tool !== 'function') {
      throw new Error(`skill "${skillName}" does not expose tool "${toolName}"`);
    }
    const declared = entry.manifest.tools.find((t) => t.name === toolName);
    if (!declared) {
      throw new Error(
        `skill "${skillName}" tool "${toolName}" is exported but not declared in skill.json`,
      );
    }
    return tool(args, entry.ctx);
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await this.disposeAll();
  }

  private async disposeAll(): Promise<void> {
    const all = [...this.skills.values()];
    this.skills.clear();
    await Promise.all(all.map(disposeSkill));
  }

  private async startWatching(): Promise<void> {
    let chokidar: typeof import('chokidar');
    try {
      chokidar = await import('chokidar');
    } catch {
      this.logger?.warn('chokidar not installed; hot-reload disabled');
      return;
    }
    const watcher = chokidar.watch(this.rootDir, {
      ignoreInitial: true,
      depth: 4,
    });
    this.watcher = watcher;

    const trigger = (filePath: string) => {
      const rel = path.relative(this.rootDir, filePath);
      const segments = rel.split(path.sep);
      if (segments.length < 2) return;
      const skillDir = path.join(this.rootDir, segments[0]);
      this.loadOne(skillDir).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`hot-reload of "${segments[0]}" failed: ${reason}`);
        this.emit('reload:error', { dir: skillDir, reason });
      });
    };

    watcher.on('add', trigger).on('change', trigger).on('unlink', trigger);
  }
}

function stripCtx(loaded: InternalLoaded): LoadedSkill {
  const { ctx: _ctx, ...rest } = loaded;
  return rest;
}

async function disposeSkill(loaded: InternalLoaded): Promise<void> {
  if (typeof loaded.module.dispose === 'function') {
    try {
      await loaded.module.dispose(loaded.ctx);
    } catch {
      /* swallow — disposal must not throw */
    }
  }
}

export async function readManifest(dir: string): Promise<SkillManifest> {
  const manifestPath = path.join(dir, 'skill.json');
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`missing skill.json in ${dir}`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`skill.json in ${dir} is not valid JSON: ${(err as Error).message}`);
  }
  const result = SkillManifestSchema.safeParse(parsed);
  if (!result.success) {
    const flat = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`skill.json in ${dir} failed validation: ${flat}`);
  }
  const folder = path.basename(dir);
  if (result.data.name !== folder) {
    throw new Error(
      `skill.json name "${result.data.name}" does not match folder "${folder}"`,
    );
  }
  return result.data;
}

async function resolveEntry(dir: string, entryHint: string): Promise<string> {
  const candidates = entryHint && entryHint !== 'index'
    ? [entryHint, ...ENTRY_CANDIDATES.map((c) => `${entryHint.replace(/\.\w+$/, '')}${path.extname(c)}`)]
    : ENTRY_CANDIDATES;
  for (const name of candidates) {
    const p = path.join(dir, name);
    try {
      await fsp.access(p);
      return p;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `no entry file in ${dir} (looked for ${candidates.join(', ')})`,
  );
}

// Hide the dynamic import from bundlers (Vite, Rollup, esbuild). Skill files
// live outside the dependency graph, so a bundler that intercepts this
// import() will fail to resolve them. Using indirect eval keeps the host
// realm's module loader, unlike `new Function`.
const nativeImport: (url: string) => Promise<unknown> = (0, eval)(
  '(u) => import(u)',
);

async function importFresh(
  filePath: string,
  importer: (url: string) => Promise<unknown>,
): Promise<unknown> {
  // Cache-bust so hot-reload sees the new version. Safe because skills
  // are leaf modules — they import their own deps which stay cached.
  const url = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  return importer(url);
}

function normalizeModule(mod: unknown, name: string): SkillModule {
  if (!mod || typeof mod !== 'object') {
    throw new Error(`skill "${name}" entry did not export an object`);
  }
  const record = mod as Record<string, unknown>;
  const candidate = (record.default && typeof record.default === 'object'
    ? (record.default as Record<string, unknown>)
    : record);
  const out: SkillModule = {};
  if (typeof candidate.init === 'function') out.init = candidate.init as SkillModule['init'];
  if (typeof candidate.dispose === 'function') out.dispose = candidate.dispose as SkillModule['dispose'];
  if (typeof candidate.onTrigger === 'function') out.onTrigger = candidate.onTrigger as SkillModule['onTrigger'];
  if (candidate.tools && typeof candidate.tools === 'object') {
    const tools: Record<string, SkillModule['tools'] extends infer T ? T extends Record<string, infer V> ? V : never : never> = {};
    for (const [k, v] of Object.entries(candidate.tools as Record<string, unknown>)) {
      if (typeof v === 'function') {
        tools[k] = v as never;
      }
    }
    out.tools = tools as SkillModule['tools'];
  }
  return out;
}
