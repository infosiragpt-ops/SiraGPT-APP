import type { Usage } from '../types/contracts';
import { isRecord } from './artifacts';

export interface EnginePriceTable {
  version: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd: number;
  cacheWritePerMillionUsd: number;
  executionPerHourUsd: number;
  minimumExecutionSeconds: number;
}

export function assertPriceTable(price: EnginePriceTable): void {
  if (!price.version.trim() || Object.entries(price).some(([key, value]) => key !== 'version' &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
    throw new Error('DOC_ENGINE_PRICE_TABLE_INVALID');
  }
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costExact: true };
}

/**
 * Provider usage contains token counts, not billable execution seconds. Execution
 * cost is consequently an explicit conservative estimate, never marked exact.
 * Reservations are ledger limits, not a claim of provider-enforced spend caps.
 */
export function calculateUsage(
  raw: unknown,
  prices: EnginePriceTable,
  elapsedMs: number,
  containerPreloaded: boolean,
): Usage {
  assertPriceTable(prices);
  const source = isRecord(raw) ? raw : {};
  const input = count(source.input_tokens);
  const output = count(source.output_tokens);
  const cacheRead = count(source.cache_read_input_tokens);
  const cacheWrite = count(source.cache_creation_input_tokens);
  const countersKnown = [input, output, cacheRead, cacheWrite].every((value) => value !== null);
  const seconds = Math.max(prices.minimumExecutionSeconds, Math.ceil(Math.max(0, elapsedMs) / 1000));
  const tokenCost = ((input ?? 0) * prices.inputPerMillionUsd + (output ?? 0) * prices.outputPerMillionUsd
    + (cacheRead ?? 0) * prices.cacheReadPerMillionUsd + (cacheWrite ?? 0) * prices.cacheWritePerMillionUsd) / 1_000_000;
  const executionCost = containerPreloaded ? seconds * prices.executionPerHourUsd / 3600 : 0;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
    costUsd: countersKnown ? tokenCost + executionCost : null,
    costExact: countersKnown && (!containerPreloaded || prices.executionPerHourUsd === 0),
  };
}

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    costUsd: left.costUsd === null || right.costUsd === null ? null : left.costUsd + right.costUsd,
    costExact: left.costExact && right.costExact,
  };
}

export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
