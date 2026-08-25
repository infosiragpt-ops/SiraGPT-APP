/**
 * In-app visit stack for /agentes conversations.
 * Back/forward stay inside the agents surface (never pop to login).
 */

export type AgentsHistorySnapshot = {
  canBack: boolean
  canForward: boolean
  current: string
}

type Listener = () => void

let stack: string[] = []
let index = -1
const listeners = new Set<Listener>()

function keyOf(chatId: string | null | undefined): string {
  return String(chatId || "")
}

function emit() {
  for (const listener of listeners) listener()
}

export function snapshotAgentsHistory(): AgentsHistorySnapshot {
  return {
    canBack: index > 0,
    canForward: index >= 0 && index < stack.length - 1,
    current: index >= 0 ? stack[index] : "",
  }
}

export function subscribeAgentsHistory(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function recordAgentsVisit(chatId: string | null | undefined): void {
  const key = keyOf(chatId)
  if (index >= 0 && stack[index] === key) return
  if (index < 0) {
    stack = [key]
    index = 0
    emit()
    return
  }
  stack = stack.slice(0, index + 1)
  stack.push(key)
  index = stack.length - 1
  emit()
}

export function goAgentsHistory(delta: -1 | 1): string | null {
  const next = index + delta
  if (next < 0 || next >= stack.length) return null
  index = next
  emit()
  return stack[index]
}

export function resetAgentsSessionHistory(): void {
  stack = []
  index = -1
  emit()
}
