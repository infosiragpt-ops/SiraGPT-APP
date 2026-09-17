import { z } from 'zod';
import path from 'node:path';
import type { AnthropicEngineConfig } from './engine/types';
import { decodeStorageKey } from './storage/private-storage';
import { DocSandboxError } from './types/errors';

const positive = z.number().finite().positive();
const prices = z.object({ version: z.string().min(1), inputPerMillionUsd: positive,
  outputPerMillionUsd: positive, cacheReadPerMillionUsd: positive,
  cacheWritePerMillionUsd: positive, executionPerHourUsd: z.number().finite().nonnegative(),
  minimumExecutionSeconds: z.number().finite().nonnegative() }).strict();
const model = z.object({ id: z.string().min(1).max(200), prices,
  maxOutputTokensPerTurn: z.number().int().min(256).max(16_000), reservationUsdPerTurn: positive }).strict();
const modelsSchema = z.object({ mechanical: model, academic: model }).strict();
const skillVersionsSchema = z.object({ docx: z.string().min(1), xlsx: z.string().min(1), pptx: z.string().min(1), pdf: z.string().min(1) }).strict();

export interface DocumentSandboxConfig {
  redisUrl: string; apiKey: string; bucket: string; storageKey: Buffer; keyId: string; previousKeys: Record<string, Buffer>;
  r2AccountId: string; r2AccessKeyId: string; r2SecretAccessKey: string; r2Endpoint?: string;
  validatorImage: string; validatorStagingRoot: string; engine: AnthropicEngineConfig;
  maxCostUsd: number; maxTurns: number; maxTokens: number; timeoutMs: number;
  retentionDays: number; maxFileBytes: number; concurrency: number; showCost: boolean;
}
function number(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number, integer = true): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new DocSandboxError('E_NOT_READY', 503);
  return value;
}
export function loadDocumentSandboxConfig(env: NodeJS.ProcessEnv = process.env): DocumentSandboxConfig | null {
  // Admission control only. Once enabled, no validation level can be disabled.
  if (!env.DOC_SANDBOX_ENGINE) return null;
  if (env.DOC_SANDBOX_ENGINE !== 'anthropic') throw new DocSandboxError('E_NOT_READY', 503);
  try {
    const required = (key: string): string => { const value = env[key]?.trim(); if (!value) throw new Error('missing configuration'); return value; };
    const models = modelsSchema.parse(JSON.parse(required('DOC_SANDBOX_MODELS_JSON')));
    const skillVersions = skillVersionsSchema.parse(JSON.parse(required('DOC_SANDBOX_SKILL_VERSIONS_JSON')));
    if (Object.values(skillVersions).some((version) => version === 'latest')) throw new Error('unpinned skills');
    const timeoutMs = number(env, 'DOC_SANDBOX_TIMEOUT_MS', 600_000, 1000, 3_600_000);
    const maxFileBytes = number(env, 'DOC_SANDBOX_MAX_FILE_BYTES', 50 * 1024 * 1024, 1, 50 * 1024 * 1024);
    const validatorImage = required('DOC_SANDBOX_VALIDATOR_IMAGE');
    if (!/^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(validatorImage)) throw new Error('unpinned validator');
    const validatorStagingRoot = required('DOC_SANDBOX_VALIDATION_STAGING_ROOT');
    if (!path.isAbsolute(validatorStagingRoot) || path.normalize(validatorStagingRoot) !== validatorStagingRoot ||
      validatorStagingRoot !== env.DOC_SANDBOX_VALIDATION_STAGING_ROOT || validatorStagingRoot.endsWith('/') ||
      /[\x00-\x1f\x7f,]/.test(validatorStagingRoot)) throw new Error('invalid shared staging path');
    const previous = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), z.string()).parse(JSON.parse(env.DOC_SANDBOX_PREVIOUS_KEYS_JSON || '{}'));
    const previousKeys = Object.fromEntries(Object.entries(previous).map(([id, value]) => [id, decodeStorageKey(value)]));
    return {
      redisUrl: required('REDIS_URL'), apiKey: required('ANTHROPIC_API_KEY'),
      bucket: env.R2_BUCKET_NAME || required('R2_BUCKET'),
      storageKey: decodeStorageKey(required('DOC_SANDBOX_ENCRYPTION_KEY')),
      keyId: env.DOC_SANDBOX_ENCRYPTION_KEY_ID || 'v1',
      previousKeys,
      r2AccountId: required('R2_ACCOUNT_ID'), r2AccessKeyId: required('R2_ACCESS_KEY_ID'),
      r2SecretAccessKey: required('R2_SECRET_ACCESS_KEY'), r2Endpoint: env.R2_ENDPOINT,
      validatorImage, validatorStagingRoot, maxCostUsd: number(env, 'DOC_SANDBOX_MAX_COST_USD', 0, 0.001, 100, false),
      maxTurns: number(env, 'DOC_SANDBOX_MAX_TURNS', 8, 2, 30),
      maxTokens: number(env, 'DOC_SANDBOX_MAX_TOKENS', 50_000, 1000, 500_000),
      timeoutMs, maxFileBytes, retentionDays: number(env, 'DOC_SANDBOX_RETENTION_DAYS', 30, 1, 30),
      concurrency: number(env, 'DOC_SANDBOX_CONCURRENCY', 2, 1, 10), showCost: env.DOC_SANDBOX_SHOW_COST === 'true',
      engine: { models, skillVersions, maxFileBytes, maxOutputBytes: 100 * 1024 * 1024,
        maxSessionMs: timeoutMs, apiTimeoutMs: Math.min(timeoutMs, 120_000), cleanupTimeoutMs: 10_000 },
    };
  } catch (cause) { throw new DocSandboxError('E_NOT_READY', 503, { cause }); }
}
