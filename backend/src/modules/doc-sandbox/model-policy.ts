import type { PrismaClient } from '@prisma/client';
import type { AnthropicEngineConfig } from './engine/types';
import { DocSandboxError } from './types/errors';

export type DocumentModelTier = 'mechanical' | 'academic';
export type DocumentModelPolicy = (requestedModel: string, userPlan: string) => Promise<DocumentModelTier | null>;

export interface DocumentCatalogPublication { name: string; isActive: boolean; type: string; provider: string; }

/** Configuration identity is exact: neither aliases nor duplicate tiers select a model. */
export function configuredDocumentModelTier(models: Readonly<Record<DocumentModelTier, { readonly id: string }>>, requestedModel: string): DocumentModelTier | null {
  if (!requestedModel || requestedModel !== requestedModel.trim() || requestedModel.length > 200) return null;
  const matching = (['mechanical', 'academic'] as const).filter((tier) => models[tier].id === requestedModel);
  return matching.length === 1 ? matching[0]! : null;
}
/** Publication facts are evaluated separately from the catalog read and plan entitlement. */
export function isPublishedDocumentModel(row: DocumentCatalogPublication | null, requestedModel: string): boolean {
  return row !== null && row.name === requestedModel && row.isActive === true && row.type === 'TEXT' &&
    row.provider.trim().toLowerCase() === 'anthropic';
}

/** Same authoritative AiModel publication table as /api/ai/models; never infer aliases or activate a row. */
export function createDocumentModelPolicy(
  models: AnthropicEngineConfig['models'],
  prisma: Pick<PrismaClient, 'aiModel'>,
  isModelPlanEligible: (modelName: string, userPlan: string) => boolean,
): DocumentModelPolicy {
  return async (requestedModel, userPlan) => {
    const tier = configuredDocumentModelTier(models, requestedModel);
    if (tier === null) return null;
    try {
      const row = await prisma.aiModel.findUnique({ where: { name: requestedModel },
        select: { name: true, isActive: true, type: true, provider: true } });
      if (!isPublishedDocumentModel(row, requestedModel) || !isModelPlanEligible(requestedModel, userPlan)) return null;
      return tier;
    } catch (cause) {
      // A catalog outage is not evidence that this model is available.
      throw new DocSandboxError('E_NOT_READY', 503, { cause });
    }
  };
}
