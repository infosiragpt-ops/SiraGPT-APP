/**
 * server/orchestration/llm-routing.config.ts
 * 
 * Thin re-export from the canonical implementation at
 * backend/src/orchestration/llm-routing.config.js.
 * 
 * TypeScript declaration file providing typings for the
 * JavaScript routing config consumed by the LLM gateway.
 */

export {
  configuredProviders,
  detectTaskType,
  TASK_MODEL_HINTS,
  providerApiKey,
} from '../../backend/src/orchestration/llm-routing.config';

export interface ProviderScore {
  quality: number;
  latency: number;
  cost: number;
}

export interface ProviderConfig {
  id: string;
  envKey: string;
  baseURL?: string;
  models: string[];
  capabilities: string[];
  score: ProviderScore;
  priority?: number;
}
