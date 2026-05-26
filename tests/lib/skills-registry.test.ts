// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';

import {
  SkillManifestSchema,
  SkillRegistry,
  buildSkillContext,
  readManifest,
} from '../../backend/src/skills/index.ts';

// Bypass Vite's module graph: load skill entry files via the host's CJS
// require, which resolves real paths off disk and ignores Vite's resolver.
const requireFromHere = createRequire(import.meta.url);
const testImporter = async (url: string): Promise<unknown> => {
  const filePath = decodeURIComponent(new URL(url).pathname);
  const resolved = requireFromHere.resolve(filePath);
  for (const key of Object.keys(requireFromHere.cache)) {
    if (key === resolved) delete requireFromHere.cache[key];
  }
  return requireFromHere(resolved);
};

async function mkSkill(
  rootDir: string,
  name: string,
  manifestOverrides: Record<string, unknown> = {},
  source = `module.exports = { default: { tools: { ping: () => ({ ok: true }) } } };`,
): Promise<string> {
  const dir = path.join(rootDir, name);
  await fsp.mkdir(dir, { recursive: true });
  const manifest = {
    name,
    version: '0.1.0',
    description: 'test skill',
    triggers: [],
    tools: [{ name: 'ping', description: 'returns ok' }],
    scopes: [],
    entry: 'index.cjs',
    ...manifestOverrides,
  };
  await fsp.writeFile(path.join(dir, 'skill.json'), JSON.stringify(manifest));
  await fsp.writeFile(path.join(dir, 'index.cjs'), source);
  return dir;
}

describe('SkillManifestSchema', () => {
  it('accepts a minimal manifest and applies defaults', () => {
    const parsed = SkillManifestSchema.parse({
      name: 'foo',
      version: '1.2.3',
      description: 'hi',
    });
    expect(parsed.tools).toEqual([]);
    expect(parsed.triggers).toEqual([]);
    expect(parsed.scopes).toEqual([]);
    expect(parsed.entry).toBe('index');
  });

  it('rejects an invalid name', () => {
    const r = SkillManifestSchema.safeParse({
      name: 'BadName',
      version: '1.0.0',
      description: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a bad version', () => {
    const r = SkillManifestSchema.safeParse({
      name: 'foo',
      version: 'not-semver',
      description: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed scope', () => {
    const r = SkillManifestSchema.safeParse({
      name: 'foo',
      version: '1.0.0',
      description: 'x',
      scopes: ['plain-string'],
    });
    expect(r.success).toBe(false);
  });
});

describe('readManifest', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skills-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('throws when skill.json is missing', async () => {
    const dir = path.join(tmp, 'orphan');
    await fsp.mkdir(dir);
    await expect(readManifest(dir)).rejects.toThrow(/missing skill\.json/);
  });

  it('throws when name and folder disagree', async () => {
    const dir = path.join(tmp, 'folder_a');
    await fsp.mkdir(dir);
    await fsp.writeFile(
      path.join(dir, 'skill.json'),
      JSON.stringify({ name: 'other_name', version: '1.0.0', description: 'x' }),
    );
    await expect(readManifest(dir)).rejects.toThrow(/does not match folder/);
  });

  it('reads and validates a valid manifest', async () => {
    await mkSkill(tmp, 'good_one');
    const m = await readManifest(path.join(tmp, 'good_one'));
    expect(m.name).toBe('good_one');
  });
});

describe('SkillRegistry', () => {
  let tmp: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skills-'));
  });
  afterEach(async () => {
    await registry?.dispose();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('loads a skill and invokes its tool', async () => {
    await mkSkill(tmp, 'alpha');
    registry = new SkillRegistry({ rootDir: tmp, importer: testImporter });
    const result = await registry.load();
    expect(result.issues).toEqual([]);
    expect(result.loaded.map((s) => s.manifest.name)).toEqual(['alpha']);

    const out = (await registry.invokeTool('alpha', 'ping', {})) as { ok: boolean };
    expect(out.ok).toBe(true);
  });

  it('returns issues for invalid skills without aborting the load', async () => {
    await mkSkill(tmp, 'good');
    const badDir = path.join(tmp, 'bad');
    await fsp.mkdir(badDir);
    await fsp.writeFile(
      path.join(badDir, 'skill.json'),
      JSON.stringify({ name: 'bad', version: 'oops', description: 'x' }),
    );
    await fsp.writeFile(path.join(badDir, 'index.cjs'), 'module.exports = {};');

    registry = new SkillRegistry({ rootDir: tmp, importer: testImporter });
    const result = await registry.load();

    expect(result.loaded.map((s) => s.manifest.name)).toEqual(['good']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toMatch(/version/);
  });

  it('refuses to invoke a tool not declared in the manifest', async () => {
    await mkSkill(
      tmp,
      'undeclared',
      { tools: [] },
      `module.exports = { default: { tools: { ping: () => ({ ok: true }) } } };`,
    );
    registry = new SkillRegistry({ rootDir: tmp, importer: testImporter });
    await registry.load();

    await expect(registry.invokeTool('undeclared', 'ping', {})).rejects.toThrow(
      /not declared/,
    );
  });

  it('reloads a skill on demand and surfaces the new behaviour', async () => {
    const dir = await mkSkill(
      tmp,
      'reloadable',
      {},
      `module.exports = { default: { tools: { ping: () => ({ v: 1 }) } } };`,
    );
    registry = new SkillRegistry({ rootDir: tmp, importer: testImporter });
    await registry.load();
    expect(await registry.invokeTool('reloadable', 'ping', {})).toEqual({ v: 1 });

    await fsp.writeFile(
      path.join(dir, 'index.cjs'),
      `module.exports = { default: { tools: { ping: () => ({ v: 2 }) } } };`,
    );
    await registry.loadOne(dir);

    expect(await registry.invokeTool('reloadable', 'ping', {})).toEqual({ v: 2 });
  });

  it('returns no skills when the root directory does not exist', async () => {
    registry = new SkillRegistry({ rootDir: path.join(tmp, 'does-not-exist') });
    const result = await registry.load();
    expect(result.loaded).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});

describe('buildSkillContext', () => {
  const baseManifest = {
    name: 'sb',
    version: '1.0.0',
    description: 'x',
    triggers: [],
    tools: [],
    scopes: [],
    entry: 'index',
  };

  it('blocks fetch when net:outbound scope is missing', async () => {
    const ctx = buildSkillContext({ ...baseManifest });
    await expect(ctx.fetch('https://example.com')).rejects.toThrow(/net:outbound/);
  });

  it('allows fetch when scope is granted', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const ctx = buildSkillContext(
      { ...baseManifest, scopes: ['net:outbound'] },
      { fetchImpl },
    );
    await ctx.fetch('https://example.com');
    expect(called).toBe(true);
  });

  it('exposes only env vars listed as env: scopes', () => {
    process.env.SKILL_TEST_ALLOWED = 'yes';
    process.env.SKILL_TEST_FORBIDDEN = 'no';
    const ctx = buildSkillContext({
      ...baseManifest,
      scopes: ['env:SKILL_TEST_ALLOWED'],
    });
    expect(ctx.env.SKILL_TEST_ALLOWED).toBe('yes');
    expect(ctx.env.SKILL_TEST_FORBIDDEN).toBeUndefined();
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});
