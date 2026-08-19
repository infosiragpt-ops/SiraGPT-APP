import { z } from 'zod';

export const SkillIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'skill id must be lowercase, start with a letter, may contain digits/_/-');

export const SkillScopeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(:[a-z0-9_*-]+)+$/i, 'scope must look like "domain:action[:resource]"');

export const SkillTriggerSchema = z.object({
  on: z.enum(['message', 'cron', 'event', 'tool']),
  pattern: z.string().optional(),
  event: z.string().optional(),
});

export const SkillToolSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'tool name must be lowercase snake_case'),
  description: z.string().min(1).max(500),
  paramsSchema: z.record(z.unknown()).optional(),
});

export const SkillManifestSchema = z.object({
  name: SkillIdSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.-]+)?$/, 'version must be semver'),
  description: z.string().min(1).max(1000),
  triggers: z.array(SkillTriggerSchema).default([]),
  tools: z.array(SkillToolSchema).default([]),
  scopes: z.array(SkillScopeSchema).default([]),
  entry: z.string().default('index'),
  source: z.enum(['module', 'instructions']).default('module'),
  metadata: z.record(z.unknown()).default({}),
  instructions: z.string().optional(),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;
export type SkillTool = z.infer<typeof SkillToolSchema>;

export interface SkillContext {
  readonly skillName: string;
  readonly version: string;
  readonly logger: SkillLogger;
  readonly fetch: typeof fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly grants: ReadonlySet<string>;
  hasScope(scope: string): boolean;
}

export interface SkillLogger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface SkillToolHandler {
  (args: unknown, ctx: SkillContext): Promise<unknown> | unknown;
}

export interface SkillModule {
  init?(ctx: SkillContext): Promise<void> | void;
  dispose?(ctx: SkillContext): Promise<void> | void;
  tools?: Record<string, SkillToolHandler>;
  onTrigger?(
    trigger: SkillTrigger,
    payload: unknown,
    ctx: SkillContext,
  ): Promise<unknown> | unknown;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  module: SkillModule;
  dir: string;
  loadedAt: number;
}

export interface SkillLoadIssue {
  dir: string;
  reason: string;
  detail?: unknown;
}

export interface SkillRecommendation {
  skill: LoadedSkill;
  score: number;
  matchedTerms: string[];
}
