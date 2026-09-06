import type { PrismaClient } from '@prisma/client';
import type { AnthropicEngineConfig } from './engine/types';
import { DocSandboxError } from './types/errors';

export type DocumentModelTier = 'mechanical' | 'academic';
export type DocumentModelPolicy = (requestedModel: string, userPlan: string) => Promise<DocumentModelTier | null>;

/** Same authoritative AiModel publication table as /api/ai/models; never infer aliases or activate a row. */
export function createDocumentModelPolicy(
  models: AnthropicEngineConfig['models'],
  prisma: Pick<PrismaClient, 'aiModel'>,
  isModelPlanEligible: (modelName: string, userPlan: string) => boolean,
): DocumentModelPolicy {
  return async (requestedModel, userPlan) => {
    if (!requestedModel || requestedModel !== requestedModel.trim() || requestedModel.length > 200) return null;
    const matching = (['mechanical', 'academic'] as const).filter((tier) => models[tier].id === requestedModel);
    // Ambiguous configuration must not silently select one price/effort tier.
    if (matching.length !== 1) return null;
    try {
      const row = await prisma.aiModel.findUnique({ where: { name: requestedModel },
        select: { name: true, isActive: true, type: true, provider: true } });
      if (!row || row.name !== requestedModel || row.isActive !== true || row.type !== 'TEXT' ||
        row.provider.trim().toLowerCase() !== 'anthropic' || !isModelPlanEligible(row.name, userPlan)) return null;
      return matching[0]!;
    } catch (cause) {
      // A catalog outage is not evidence that this model is available.
      throw new DocSandboxError('E_NOT_READY', 503, { cause });
    }
  };
}
