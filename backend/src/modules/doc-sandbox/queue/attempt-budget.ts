import { z } from 'zod';
import { emptyUsage, totalTokens } from '../engine/cost';
import type { Usage } from '../types/contracts';
import { DocSandboxError } from '../types/errors';

interface AttemptBudgetSnapshot {
  readonly usage: Readonly<Record<string, unknown>>;
  readonly costReservations: ReadonlyArray<{ readonly reservedUsd: string; readonly actualUsd: string | null }>;
  readonly maxCostUsd: string;
  readonly costUsd: string;
  readonly tokenBudget: number;
}

interface RemainingAttemptBudget {
  baseUsage: Usage;
  previousTurns: number;
  remainingUsd: number;
  remainingTokens: number;
  remainingTurns: number;
}

const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(), costExact: z.boolean() });

/**
 * Remaining authority for one attempt, from the durable job snapshot. Pending
 * reservations stay charged across retries. This is not a ledger reservation:
 * the caller still reserves each provider turn transactionally before spending.
 * Wall-clock deadlines and all IO remain with the processor.
 */
export function calculateAttemptBudget(
  snapshot: AttemptBudgetSnapshot,
  limits: Readonly<{ maxTokens: number; maxTurns: number }>,
): RemainingAttemptBudget {
  const baseUsage = Object.keys(snapshot.usage).length ? usageSchema.parse(snapshot.usage) : emptyUsage();
  const pending = snapshot.costReservations.filter((reservation) => reservation.actualUsd === null)
    .reduce((sum, reservation) => sum + Number(reservation.reservedUsd), 0);
  const remainingUsd = Number(snapshot.maxCostUsd) - Number(snapshot.costUsd) - pending;
  const remainingTokens = Math.min(limits.maxTokens, snapshot.tokenBudget) - totalTokens(baseUsage);
  const previousTurns = typeof snapshot.usage.turns === 'number' && Number.isSafeInteger(snapshot.usage.turns) && snapshot.usage.turns >= 0 ? snapshot.usage.turns : 0;
  const remainingTurns = limits.maxTurns - previousTurns;
  if (remainingUsd <= 0 || remainingTokens <= 0 || remainingTurns <= 0 || baseUsage.costUsd === null) throw new DocSandboxError('E_QUOTA', 429);
  return { baseUsage, previousTurns, remainingUsd, remainingTokens, remainingTurns };
}
