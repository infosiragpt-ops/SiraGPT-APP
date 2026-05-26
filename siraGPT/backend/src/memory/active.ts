/**
 * Active memory subsystem.
 *
 * Maintains compacted, per-user/per-session "active memory" snapshots derived
 * from the conversation history. Snapshots are cached and tagged with an etag
 * computed from the source history. When the source history shrinks (entries
 * removed, edited, or rewound), the etag mismatches and the cache is
 * invalidated so the snapshot is rebuilt from scratch — guaranteeing strong
 * consistency between the snapshot and its source.
 *
 * Persistence is delegated to a Drizzle-style store passed by the caller, so
 * this module is testable without a real database.
 */

import { createHash } from 'node:crypto';

export interface HistoryEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Approximate token count. Falls back to char-based estimation. */
  tokens?: number;
  /** Optional epoch ms timestamp; used as a stable secondary signal. */
  ts?: number;
}

export interface ActiveMemoryRecord {
  userId: string;
  sessionId: string;
  /** Snapshot of compacted memory, ready to inject into the next prompt. */
  snapshot: string;
  /** Hash of the source history that produced `snapshot`. */
  etag: string;
  /** Number of source entries the snapshot covers. */
  sourceLength: number;
  /** Token count of the snapshot itself, post-clamp. */
  tokens: number;
  /** Epoch ms when the snapshot was computed. */
  updatedAt: number;
}

export interface ActiveMemoryStore {
  get(userId: string, sessionId: string): Promise<ActiveMemoryRecord | null>;
  put(record: ActiveMemoryRecord): Promise<void>;
  delete(userId: string, sessionId: string): Promise<void>;
}

export interface AdminScope {
  /** Admin actor performing the toggle. */
  actorId: string;
  /** Whether the actor has admin clearance. */
  isAdmin: boolean;
}

export interface ActiveMemoryConfig {
  /** Hard token cap for the compacted snapshot. */
  maxTokens: number;
  /** Soft target for compaction; oldest entries dropped first. */
  targetTokens?: number;
  /** Compactor — receives history, returns plain-text snapshot. */
  compactor?: (history: HistoryEntry[], opts: { maxTokens: number }) => string;
  /** Default enabled state if env var is not set. */
  defaultEnabled?: boolean;
  /** Override env reader (useful for tests). */
  envReader?: () => string | undefined;
}

export const ENV_FLAG = 'SIRA_ACTIVE_MEMORY_ENABLED';

const defaultEnvReader = () =>
  typeof process !== 'undefined' && process.env ? process.env[ENV_FLAG] : undefined;

const truthyEnv = (v: string | undefined) => {
  if (v == null) return undefined;
  const norm = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(norm)) return true;
  if (['0', 'false', 'no', 'off'].includes(norm)) return false;
  return undefined;
};

const estimateTokens = (e: HistoryEntry): number => {
  if (typeof e.tokens === 'number' && e.tokens >= 0) return e.tokens;
  // Cheap heuristic: ~4 chars/token.
  return Math.max(1, Math.ceil((e.content?.length ?? 0) / 4));
};

const stableSerialize = (history: HistoryEntry[]): string =>
  history.map((e) => `${e.id}${e.role}${e.content}`).join('');

export const computeEtag = (history: HistoryEntry[]): string => {
  const h = createHash('sha256');
  h.update(`v1${history.length}`);
  h.update(stableSerialize(history));
  return h.digest('hex');
};

const defaultCompactor = (
  history: HistoryEntry[],
  { maxTokens }: { maxTokens: number },
): string => {
  // Keep newest entries first; drop oldest until under cap.
  const lines: string[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    const t = estimateTokens(e);
    if (used + t > maxTokens && lines.length > 0) break;
    const line = `[${e.role}] ${e.content}`;
    lines.unshift(line);
    used += t;
    if (used >= maxTokens) break;
  }
  return lines.join('\n');
};

const clampSnapshot = (snapshot: string, maxTokens: number): { text: string; tokens: number } => {
  const maxChars = maxTokens * 4;
  if (snapshot.length <= maxChars) {
    return { text: snapshot, tokens: Math.ceil(snapshot.length / 4) };
  }
  // Truncate from the start (oldest context goes first); preserve the tail.
  const truncated = snapshot.slice(snapshot.length - maxChars);
  return { text: truncated, tokens: Math.ceil(truncated.length / 4) };
};

export class ActiveMemory {
  private readonly store: ActiveMemoryStore;
  private readonly config: Required<Omit<ActiveMemoryConfig, 'envReader' | 'compactor'>> & {
    envReader: () => string | undefined;
    compactor: NonNullable<ActiveMemoryConfig['compactor']>;
  };
  private overrideEnabled: boolean | undefined;

  constructor(store: ActiveMemoryStore, config: ActiveMemoryConfig) {
    if (!store) throw new Error('ActiveMemory: store is required');
    if (!config || typeof config.maxTokens !== 'number' || config.maxTokens <= 0) {
      throw new Error('ActiveMemory: maxTokens must be a positive number');
    }
    this.store = store;
    this.config = {
      maxTokens: config.maxTokens,
      targetTokens: config.targetTokens ?? Math.floor(config.maxTokens * 0.8),
      compactor: config.compactor ?? defaultCompactor,
      defaultEnabled: config.defaultEnabled ?? true,
      envReader: config.envReader ?? defaultEnvReader,
    };
  }

  /** Resolve current enabled state: admin override > env flag > default. */
  isEnabled(): boolean {
    if (this.overrideEnabled !== undefined) return this.overrideEnabled;
    const env = truthyEnv(this.config.envReader());
    if (env !== undefined) return env;
    return this.config.defaultEnabled;
  }

  /** Toggle the global enabled flag. Requires admin clearance. */
  setEnabled(enabled: boolean, scope: AdminScope): void {
    if (!scope || !scope.isAdmin) {
      const err = new Error('ActiveMemory: admin clearance required to toggle global state');
      (err as Error & { code?: string }).code = 'E_FORBIDDEN';
      throw err;
    }
    this.overrideEnabled = enabled;
  }

  /** Build a compacted snapshot from history, clamped to maxTokens. */
  compact(history: HistoryEntry[]): { snapshot: string; tokens: number } {
    const raw = this.config.compactor(history, { maxTokens: this.config.targetTokens });
    return (() => {
      const { text, tokens } = clampSnapshot(raw, this.config.maxTokens);
      return { snapshot: text, tokens };
    })();
  }

  /**
   * Resolve the active memory record for a (user, session). Reuses the cached
   * snapshot when the etag still matches the current history; rebuilds from
   * scratch otherwise. Returns null when disabled.
   */
  async resolve(
    userId: string,
    sessionId: string,
    history: HistoryEntry[],
  ): Promise<ActiveMemoryRecord | null> {
    if (!this.isEnabled()) return null;
    if (!Array.isArray(history)) {
      throw new TypeError('ActiveMemory.resolve: history must be an array');
    }

    const etag = computeEtag(history);
    const cached = await this.store.get(userId, sessionId);

    if (cached && cached.etag === etag && cached.sourceLength === history.length) {
      return cached;
    }

    // Detect a shrink (or any divergence) — rebuild.
    const { snapshot, tokens } = this.compact(history);
    const record: ActiveMemoryRecord = {
      userId,
      sessionId,
      snapshot,
      etag,
      sourceLength: history.length,
      tokens,
      updatedAt: Date.now(),
    };
    await this.store.put(record);
    return record;
  }

  /** Force-invalidate a session's cached snapshot. */
  async invalidate(userId: string, sessionId: string): Promise<void> {
    await this.store.delete(userId, sessionId);
  }
}

/** In-memory store, useful for tests and fallback runtime. */
export class InMemoryActiveMemoryStore implements ActiveMemoryStore {
  private readonly map = new Map<string, ActiveMemoryRecord>();
  private key(u: string, s: string) {
    return `${u}${s}`;
  }
  async get(userId: string, sessionId: string) {
    return this.map.get(this.key(userId, sessionId)) ?? null;
  }
  async put(record: ActiveMemoryRecord) {
    this.map.set(this.key(record.userId, record.sessionId), { ...record });
  }
  async delete(userId: string, sessionId: string) {
    this.map.delete(this.key(userId, sessionId));
  }
  /** Test helper. */
  size() {
    return this.map.size;
  }
}
