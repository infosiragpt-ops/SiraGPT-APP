#!/usr/bin/env node
/**
 * CLI for the skill registry.
 *
 *   skill:list                    list all loadable skills under backend/skills
 *   skill:validate <path>         validate a single skill folder (or skill.json)
 *
 * Run via npm script (`npm run skill:list`) or directly with a TS-aware
 * runtime (Node 22+ with --experimental-strip-types, tsx, etc.).
 */
import * as path from 'path';
import { promises as fsp } from 'fs';

import { SkillRegistry, readManifest } from './registry.ts';

const DEFAULT_ROOT = path.resolve(process.cwd(), 'backend', 'skills');

interface ListOptions {
  rootDir: string;
  json: boolean;
}

async function cmdList(opts: ListOptions): Promise<number> {
  const registry = new SkillRegistry({ rootDir: opts.rootDir });
  const { loaded, issues } = await registry.load();
  await registry.dispose();

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          rootDir: opts.rootDir,
          skills: loaded.map((s) => ({
            name: s.manifest.name,
            version: s.manifest.version,
            description: s.manifest.description,
            tools: s.manifest.tools.map((t) => t.name),
            scopes: s.manifest.scopes,
            dir: s.dir,
          })),
          issues,
        },
        null,
        2,
      ) + '\n',
    );
    return issues.length === 0 ? 0 : 1;
  }

  if (loaded.length === 0 && issues.length === 0) {
    console.log(`No skills found under ${opts.rootDir}`);
    return 0;
  }
  for (const skill of loaded) {
    const tools = skill.manifest.tools.map((t) => t.name).join(', ') || '—';
    console.log(
      `${skill.manifest.name}@${skill.manifest.version} — ${skill.manifest.description}\n  tools: ${tools}\n  scopes: ${skill.manifest.scopes.join(', ') || '—'}\n  dir: ${skill.dir}`,
    );
  }
  if (issues.length > 0) {
    console.error(`\n${issues.length} skill(s) failed to load:`);
    for (const issue of issues) {
      console.error(`  - ${issue.dir}: ${issue.reason}`);
    }
    return 1;
  }
  return 0;
}

async function cmdRecommend(opts: ListOptions, input: string): Promise<number> {
  const registry = new SkillRegistry({ rootDir: opts.rootDir });
  const { issues } = await registry.load();
  const recommendations = registry.recommend(input, 8);
  await registry.dispose();

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          rootDir: opts.rootDir,
          query: input,
          recommendations: recommendations.map((r) => ({
            name: r.skill.manifest.name,
            version: r.skill.manifest.version,
            description: r.skill.manifest.description,
            score: r.score,
            matchedTerms: r.matchedTerms,
            source: r.skill.manifest.source,
            dir: r.skill.dir,
          })),
          issues,
        },
        null,
        2,
      ) + '\n',
    );
    return issues.length === 0 ? 0 : 1;
  }

  if (recommendations.length === 0) {
    console.log('No matching skills found.');
  } else {
    for (const rec of recommendations) {
      console.log(
        `${rec.skill.manifest.name}@${rec.skill.manifest.version} (${rec.score}) — ${rec.skill.manifest.description}\n  matched: ${rec.matchedTerms.join(', ')}\n  dir: ${rec.skill.dir}`,
      );
    }
  }
  if (issues.length > 0) {
    console.error(`\n${issues.length} skill(s) failed to load while recommending.`);
    return 1;
  }
  return 0;
}

async function cmdValidate(target: string): Promise<number> {
  const resolved = path.resolve(target);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat) {
    console.error(`No such path: ${resolved}`);
    return 2;
  }
  const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
  try {
    const manifest = await readManifest(dir);
    console.log(
      `OK — ${manifest.name}@${manifest.version} (${manifest.tools.length} tool(s), ${manifest.scopes.length} scope(s))`,
    );
    return 0;
  } catch (err) {
    console.error(`FAIL — ${(err as Error).message}`);
    return 1;
  }
}

function parseArgs(argv: string[]): {
  cmd: 'list' | 'recommend' | 'validate' | 'help';
  target?: string;
  rootDir: string;
  json: boolean;
} {
  const args = argv.slice(2);
  let cmd: 'list' | 'recommend' | 'validate' | 'help' = 'help';
  let target: string | undefined;
  let rootDir = DEFAULT_ROOT;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'list' || arg === 'recommend' || arg === 'validate' || arg === 'help') {
      cmd = arg;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--root' && args[i + 1]) {
      rootDir = path.resolve(args[++i]);
    } else if ((cmd === 'validate' || cmd === 'recommend') && !target) {
      target = arg;
    } else if (cmd === 'recommend' && target) {
      target = `${target} ${arg}`;
    }
  }
  return { cmd, target, rootDir, json };
}

function printHelp(): void {
  console.log(`Usage:
  skills list [--root <dir>] [--json]
  skills recommend <request text> [--root <dir>] [--json]
  skills validate <path-to-skill-or-manifest>
`);
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.cmd === 'list') return cmdList({ rootDir: parsed.rootDir, json: parsed.json });
  if (parsed.cmd === 'recommend') {
    if (!parsed.target) {
      console.error('skills recommend requires request text');
      return 2;
    }
    return cmdRecommend({ rootDir: parsed.rootDir, json: parsed.json }, parsed.target);
  }
  if (parsed.cmd === 'validate') {
    if (!parsed.target) {
      console.error('skills validate requires a path argument');
      return 2;
    }
    return cmdValidate(parsed.target);
  }
  printHelp();
  return parsed.cmd === 'help' ? 0 : 2;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  /skills[\\/](?:cli\.(?:ts|js|mjs|cjs))$/.test(process.argv[1]);

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
