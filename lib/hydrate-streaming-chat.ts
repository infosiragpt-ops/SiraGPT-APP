// Pure helper extracted from chat-context-integrated.tsx so the
// "switch back to a still-streaming chat" merge can be unit-tested without
// a browser / React runtime.
//
// When the user navigates away from a chat mid-stream and comes back, the
// cached copy of that chat may hold a stale (or empty) trailing ASSISTANT
// message, because the live token flush only targets the chat the user is
// currently looking at. The background-streams store keeps the full
// partialContent for the streaming chat; this helper splices that partial
// answer into the trailing assistant bubble so the in-progress answer stays
// visible and keeps growing.
//
// Guarantees:
//  - Returns the SAME messages array reference when nothing changes, so
//    React state updates stay cheap and no needless re-render is triggered.
//  - Never shortens an existing answer (length guard) — if the cached copy
//    already has more content than `partial` (e.g. the bg entry was garbage
//    collected), it is left untouched.
//  - Only the LAST assistant message is hydrated (the one being streamed).

type AnyMessage = { role?: unknown; content?: unknown }

export function hydrateTrailingAssistant<T extends AnyMessage>(
  messages: readonly T[] | undefined | null,
  partial: string | undefined | null,
): T[] {
  const list = Array.isArray(messages) ? (messages as T[]) : []
  if (typeof partial !== 'string' || partial.length === 0) return list

  let lastAssistantIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (String(list[i]?.role ?? '').toUpperCase() === 'ASSISTANT') {
      lastAssistantIdx = i
      break
    }
  }
  if (lastAssistantIdx < 0) return list

  const target = list[lastAssistantIdx]
  const current = typeof target.content === 'string' ? target.content : ''
  if (partial.length <= current.length) return list

  // Only clone when we actually change something, so unchanged calls keep the
  // original array reference and don't trigger a needless React re-render.
  const next = list.slice()
  next[lastAssistantIdx] = { ...target, content: partial }
  return next
}
