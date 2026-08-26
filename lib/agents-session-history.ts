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

// useSyncExternalStore requires Object.is-stable getSnapshot. A fresh
// object every read causes React 185 (Maximum update depth exceeded).
let cachedSnapshot: AgentsHistorySnapshot = {
  canBack: false,
  canForward: false,
  current: "",
}

function keyOf(chatId: string | null | undefined): string {
  return String(chatId || "")
}

function refreshCachedSnapshot(): boolean {
  const canBack = index > 0
  const canForward = index >= 0 && index < stack.length - 1
  const current = index >= 0 ? stack[index] : ""
  if (
    cachedSnapshot.canBack === canBack &&
    cachedSnapshot.canForward === canForward &&
    cachedSnapshot.current === current
  ) {
    return false
  }
  cachedSnapshot = { canBack, canForward, current }
  return true
}

function emit() {
  refreshCachedSnapshot()
  for (const listener of listeners) listener()
}

export function snapshotAgentsHistory(): AgentsHistorySnapshot {
  refreshCachedSnapshot()
  return cachedSnapshot
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
