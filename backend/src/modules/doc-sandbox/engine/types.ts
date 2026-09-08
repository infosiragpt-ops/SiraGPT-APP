import type { Artifact, AgentResult, EditPlan, InputFile, JobEvent, JobForEngine, RunRequest, Usage } from '../types/contracts';
import type { HostedSkillId } from '../agent/skills';
import type { EnginePriceTable } from './cost';

export interface SandboxSession {
  readonly id: string;
  readonly jobId: string;
  readonly userId: string;
  readonly attempt: number;
}

export type RunResult = {
  status: 'planned'; editPlan: EditPlan; usage: Usage; transcript: JobEvent[];
} | {
  status: 'edited' | 'not_possible'; editPlan: EditPlan; agentResult: AgentResult; usage: Usage; transcript: JobEvent[];
};

export interface SandboxEngine {
  createSession(job: JobForEngine): Promise<SandboxSession>;
  uploadInputs(session: SandboxSession, files: InputFile[], signal?: AbortSignal): Promise<void>;
  run(session: SandboxSession, request: RunRequest, onEvent: (event: JobEvent) => Promise<void> | void): Promise<RunResult>;
  downloadOutputs(session: SandboxSession): Promise<Artifact[]>;
  destroy(session: SandboxSession): Promise<void>;
}

export interface EngineModelConfig {
  id: string;
  prices: EnginePriceTable;
  maxOutputTokensPerTurn: number;
  /** Reserved before each paid request. An uncertain response retains this sum. */
  reservationUsdPerTurn: number;
}

export interface AnthropicEngineConfig {
  models: Record<'mechanical' | 'academic', EngineModelConfig>;
  skillVersions: Partial<Record<HostedSkillId, string>>;
  maxFileBytes: number;
  maxOutputBytes: number;
  maxSessionMs: number;
  apiTimeoutMs: number;
  cleanupTimeoutMs: number;
}

/** All callbacks are awaited. Production callbacks must persist, not just log. */
export interface EnginePersistence {
  sessionCreated(session: SandboxSession): Promise<void>;
  containerCreated(session: SandboxSession, reference: { id: string; expiresAt: string | null; stage: 'plan' | 'edit' }): Promise<void>;
  fileChanged(session: SandboxSession, reference: {
    id: string; kind: 'input' | 'output'; state: 'known' | 'deleted' | 'delete_failed';
  }): Promise<void>;
  reserve(session: SandboxSession, reservation: { requestId: string; usd: number }): Promise<void>;
  settle(session: SandboxSession, result: { requestId: string; usage: Usage; uncertain: boolean }): Promise<void>;
  usageChanged(session: SandboxSession, usage: Usage): Promise<void>;
}
