/**
 * server/intelligence/core/memory.ts
 *
 * Default in-memory MemoryStore: derives durable facts from a finished turn,
 * recalls them by relevance, and supports right-to-be-forgotten deletion — all
 * with STRICT per-user isolation (a user can never read or delete another
 * user's memory).
 *
 * This is the deterministic, dependency-free default used in tests and when the
 * pgvector/Mem0 adapter is not wired. The production adapter
 * (adapters/memory.adapter.ts) implements the same port over the existing
 * backend memory subsystem.
 */

import type { MemoryFact, MemoryStore, RecalledMemory } from '../ports';

interface StoredFact {
  readonly content: string;
  readonly category: string;
  importance: number;
  confidence: number;
  readonly source: string;
  readonly hash: string;
  accessCount: number;
  createdAt: number;
}

interface ReflectionRule {
  readonly category: string;
  readonly re: RegExp;
  readonly importance: number;
}

// Bilingual durable-fact extraction. Conservative on purpose: we only persist
// statements that look like stable preferences / identity / context.
const REFLECTION_RULES: ReadonlyArray<ReflectionRule> = [
  { category: 'identity', importance: 0.85, re: /\b(?:my name is|i am|i'm)\s+([A-Z][\w'-]{1,40})\b/i },
  { category: 'identity', importance: 0.85, re: /\b(?:me llamo|mi nombre es|soy)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ'-]{1,40})\b/i },
  { category: 'preference', importance: 0.7, re: /\b(?:i prefer|i like|i love|i always)\s+(.{3,80})/i },
  { category: 'preference', importance: 0.7, re: /\b(?:prefiero|me gusta|me encanta|siempre)\s+(.{3,80})/i },
  { category: 'work', importance: 0.75, re: /\b(?:i work (?:at|as|in)|my job is|my company is)\s+(.{2,80})/i },
  { category: 'work', importance: 0.75, re: /\b(?:trabajo (?:en|como|de)|mi empresa es|mi trabajo es)\s+(.{2,80})/i },
  { category: 'project', importance: 0.7, re: /\b(?:i'?m (?:building|working on)|my project is)\s+(.{3,80})/i },
  { category: 'project', importance: 0.7, re: /\b(?:estoy (?:construyendo|trabajando en)|mi proyecto es)\s+(.{3,80})/i },
  { category: 'goal', importance: 0.65, re: /\b(?:my goal is|i want to|i need to)\s+(.{3,80})/i },
  { category: 'goal', importance: 0.65, re: /\b(?:mi (?:meta|objetivo) es|quiero|necesito)\s+(.{3,80})/i },
];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'una', 'unos', 'unas', 'los', 'las',
  'que', 'para', 'con', 'por', 'del', 'sobre', 'como', 'are', 'was', 'you', 'your',
  'his', 'her', 'their', 'mi', 'tu', 'su', 'is', 'a', 'an', 'of', 'to', 'in', 'on',
]);

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9áéíóúñ]{3,}/gi) || []).filter(
    (t) => !STOPWORDS.has(t)
  );
}

function cleanFact(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').replace(/[.;,]+$/, '');
}

export interface InMemoryMemoryOptions {
  readonly now?: () => number;
  readonly maxFactsPerUser?: number;
}

export function createInMemoryMemoryStore(
  options: InMemoryMemoryOptions = {}
): MemoryStore {
  const now = options.now ?? (() => Date.now());
  const maxFactsPerUser = Math.max(16, options.maxFactsPerUser ?? 1000);
  const byUser = new Map<string, Map<string, StoredFact>>();

  function bucket(userId: string): Map<string, StoredFact> {
    let b = byUser.get(userId);
    if (!b) {
      b = new Map();
      byUser.set(userId, b);
    }
    return b;
  }

  function insert(userId: string, fact: MemoryFact): boolean {
    const content = cleanFact(fact.content);
    if (!content) return false;
    const hash = fnv1a(`${content.toLowerCase()}`);
    const b = bucket(userId);
    const existing = b.get(hash);
    if (existing) {
      existing.importance = Math.min(1, existing.importance + 0.05);
      existing.confidence = Math.max(existing.confidence, fact.confidence ?? existing.confidence);
      existing.accessCount += 1;
      return false;
    }
    b.set(hash, {
      content,
      category: fact.category ?? 'knowledge',
      importance: Math.max(0, Math.min(1, fact.importance ?? 0.5)),
      confidence: Math.max(0, Math.min(1, fact.confidence ?? 0.8)),
      source: fact.source ?? 'derived',
      hash,
      accessCount: 0,
      createdAt: now(),
    });
    // Evict the least-important, oldest facts if over the cap.
    if (b.size > maxFactsPerUser) {
      const sorted = [...b.values()].sort(
        (x, y) => x.importance - y.importance || x.createdAt - y.createdAt
      );
      const toRemove = b.size - maxFactsPerUser;
      for (let i = 0; i < toRemove; i += 1) b.delete(sorted[i].hash);
    }
    return true;
  }

  function deriveFacts(userMessage: string): MemoryFact[] {
    const facts: MemoryFact[] = [];
    for (const rule of REFLECTION_RULES) {
      const m = rule.re.exec(userMessage);
      if (m && m[1]) {
        facts.push({
          content: `${rule.category}: ${cleanFact(m[1])}`,
          category: rule.category,
          importance: rule.importance,
          confidence: 0.8,
          source: 'reflection',
        });
      }
    }
    return facts;
  }

  async function deriveAndStore(input: {
    userId: string;
    userMessage: string;
    assistantMessage: string;
  }): Promise<{ stored: number }> {
    if (!input?.userId) return { stored: 0 };
    const facts = deriveFacts(String(input.userMessage ?? ''));
    let stored = 0;
    for (const f of facts) if (insert(input.userId, f)) stored += 1;
    return { stored };
  }

  async function recall(input: {
    userId: string;
    query: string;
    k?: number;
  }): Promise<RecalledMemory[]> {
    if (!input?.userId) return [];
    const b = byUser.get(input.userId);
    if (!b || b.size === 0) return [];
    const k = Math.max(1, Math.min(50, input.k ?? 5));
    const qTokens = new Set(tokenize(String(input.query ?? '')));

    const scored: RecalledMemory[] = [];
    for (const fact of b.values()) {
      const fTokens = tokenize(fact.content);
      let overlap = 0;
      for (const t of fTokens) if (qTokens.has(t)) overlap += 1;
      const denom = Math.max(1, fTokens.length);
      const lexical = overlap / denom;
      // Blend lexical relevance with stored importance so strong, stable facts
      // surface even on weak lexical overlap.
      const score = lexical * 0.7 + fact.importance * 0.3;
      if (score > 0.05) {
        fact.accessCount += 1;
        scored.push({ content: fact.content, category: fact.category, score });
      }
    }
    scored.sort((a, b2) => b2.score - a.score);
    return scored.slice(0, k);
  }

  async function forget(input: { userId: string }): Promise<{ removed: number }> {
    if (!input?.userId) return { removed: 0 };
    const b = byUser.get(input.userId);
    const removed = b ? b.size : 0;
    byUser.delete(input.userId);
    return { removed };
  }

  async function storeFacts(input: {
    userId: string;
    facts: ReadonlyArray<MemoryFact>;
  }): Promise<{ stored: number }> {
    if (!input?.userId) return { stored: 0 };
    let stored = 0;
    for (const f of input.facts ?? []) if (insert(input.userId, f)) stored += 1;
    return { stored };
  }

  return { deriveAndStore, recall, forget, storeFacts };
}
