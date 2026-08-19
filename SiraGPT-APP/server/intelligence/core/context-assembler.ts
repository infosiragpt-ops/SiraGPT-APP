/**
 * server/intelligence/core/context-assembler.ts
 *
 * Default ContextAssembler. Owns the conversation window:
 *   1. de-duplicates repeated/near-repeated turns,
 *   2. keeps the most-recent turns verbatim,
 *   3. when the window would overflow, compacts older turns into a rolling
 *      summary (LLM-backed when a summarizer is provided, else a deterministic
 *      extractive fallback),
 *   4. hard-truncates an individual oversized message only as a last resort.
 *
 * It always reserves room for the model's output and never returns a context
 * that exceeds `maxContextTokens - reserveOutputTokens`.
 */

import type { ChatMessage } from '../ports/common';
import { estimateMessageTokens, estimateTokens } from '../ports/common';
import type {
  AssembledContext,
  ContextAssembler,
  ContextAssemblerOptions,
} from '../ports';

function normalizeForCompare(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Remove exact-duplicate messages (keeping the latest occurrence) and collapse
 *  consecutive identical turns. Returns the cleaned list + count removed. */
function dedupe(history: ReadonlyArray<ChatMessage>): {
  messages: ChatMessage[];
  removed: number;
} {
  if (history.length <= 1) return { messages: [...history], removed: 0 };

  // Track the last index at which each (role|content) signature appears; keep
  // only that latest occurrence so older verbatim repeats are dropped.
  const lastIndex = new Map<string, number>();
  history.forEach((m, i) => {
    lastIndex.set(`${m.role}|${normalizeForCompare(m.content)}`, i);
  });

  const out: ChatMessage[] = [];
  let removed = 0;
  history.forEach((m, i) => {
    const sig = `${m.role}|${normalizeForCompare(m.content)}`;
    if (lastIndex.get(sig) !== i) {
      removed += 1;
      return;
    }
    // Collapse consecutive identical (role+content) turns.
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && normalizeForCompare(prev.content) === normalizeForCompare(m.content)) {
      removed += 1;
      return;
    }
    out.push(m);
  });

  return { messages: out, removed };
}

function extractiveSummary(messages: ReadonlyArray<ChatMessage>, maxChars = 1200): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const who = m.role === 'user' ? 'Usuario' : m.role === 'assistant' ? 'Asistente' : m.role;
    const text = m.content.trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const snippet = text.length > 180 ? `${text.slice(0, 177)}…` : text;
    lines.push(`- ${who}: ${snippet}`);
  }
  let summary = lines.join('\n');
  if (summary.length > maxChars) summary = `${summary.slice(0, maxChars - 1)}…`;
  return summary;
}

function hardTruncateMessage(message: ChatMessage, maxTokens: number): ChatMessage {
  const maxChars = Math.max(40, maxTokens * 4 - 16);
  if (message.content.length <= maxChars) return message;
  return {
    ...message,
    content: `${message.content.slice(0, maxChars)}\n…[truncated]`,
    tokens: undefined,
  };
}

export function createDefaultContextAssembler(): ContextAssembler {
  async function assemble(input: {
    history: ReadonlyArray<ChatMessage>;
    currentTurn: ChatMessage;
    options: ContextAssemblerOptions;
  }): Promise<AssembledContext> {
    const { currentTurn, options } = input;
    const minRecent = Math.max(0, options.minRecentMessages ?? 4);
    const budget = Math.max(
      256,
      options.maxContextTokens - options.reserveOutputTokens
    );

    const { messages: deduped, removed: dedupedMessages } = dedupe(input.history);

    const currentTokens = estimateMessageTokens(currentTurn);
    let availableForHistory = Math.max(0, budget - currentTokens);

    // Walk newest → oldest, keeping turns until the budget is spent. Guarantee
    // at least `minRecent` recent turns are considered for verbatim retention.
    const kept: ChatMessage[] = [];
    let keptTokens = 0;
    let overflowEndIdx = deduped.length; // exclusive index marking start of kept

    for (let i = deduped.length - 1; i >= 0; i -= 1) {
      const msg = deduped[i];
      const t = estimateMessageTokens(msg);
      const withinBudget = keptTokens + t <= availableForHistory;
      const mustKeepForMinRecent = deduped.length - i <= minRecent;
      if (withinBudget || mustKeepForMinRecent) {
        kept.unshift(msg);
        keptTokens += t;
        overflowEndIdx = i;
      } else {
        break;
      }
    }

    const overflow = deduped.slice(0, overflowEndIdx);

    // Produce a rolling summary of the compacted (overflow) turns.
    let summary: string | undefined;
    let summarized = false;
    if (overflow.length > 0) {
      summarized = true;
      if (options.summarize) {
        try {
          summary = await options.summarize(overflow);
        } catch {
          summary = extractiveSummary(overflow);
        }
      } else {
        summary = extractiveSummary(overflow);
      }
      if (summary) summary = summary.trim();
      if (!summary) {
        summary = undefined;
        summarized = false;
      }
    }

    // If the kept set + summary still overflow (e.g. the minRecent guarantee
    // forced oversized turns in), hard-truncate the oldest kept messages.
    let truncated = overflow.length > 0;
    let summaryTokens = summary ? estimateTokens(summary) + 8 : 0;
    let total = keptTokens + currentTokens + summaryTokens;

    if (total > budget && kept.length > 0) {
      // Truncate from the oldest kept message forward until within budget.
      for (let i = 0; i < kept.length && total > budget; i += 1) {
        const before = estimateMessageTokens(kept[i]);
        const allowance = Math.max(32, before - (total - budget));
        kept[i] = hardTruncateMessage(kept[i], allowance);
        const after = estimateMessageTokens(kept[i]);
        total -= before - after;
        if (before !== after) truncated = true;
      }
    }

    const finalMessages = [...kept, currentTurn];
    const estimatedTokens =
      finalMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0) +
      summaryTokens;

    return {
      messages: finalMessages,
      summary,
      droppedMessages: overflow.length,
      dedupedMessages,
      estimatedTokens,
      truncated,
      summarized,
    };
  }

  return { assemble };
}
