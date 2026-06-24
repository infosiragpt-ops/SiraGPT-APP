"use client"

// codex/use-codex-run — owns a run's live timeline (feature 10): opens the SSE
// stream (replay from seq 0 on mount, so a reload reconstructs the full
// timeline), folds events through the pure reducer, and exposes the state +
// current status. Stream lives in the hook (not a tab), so navigating tabs
// (feature 13) doesn't drop it.

import { useEffect, useReducer, useRef, useState } from "react"
import { openRunStream, type RunStreamHandle } from "./run-stream"
import { timelineReducer, initialTimelineState, markPlanApproved, type TimelineState, type CodexEventEnvelope } from "./timeline-reducer"

type Action = { kind: "event"; event: CodexEventEnvelope } | { kind: "approve" } | { kind: "reset" }

function reducer(state: TimelineState, action: Action): TimelineState {
  switch (action.kind) {
    case "event": return timelineReducer(state, action.event)
    case "approve": return markPlanApproved(state)
    case "reset": return initialTimelineState()
    default: return state
  }
}

export function useCodexRun(runId: string | null) {
  const [state, dispatch] = useReducer(reducer, undefined, initialTimelineState)
  const [status, setStatus] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const handleRef = useRef<RunStreamHandle | null>(null)

  useEffect(() => {
    dispatch({ kind: "reset" })
    setStatus(null)
    if (!runId) return
    setConnected(true)
    const handle = openRunStream({
      runId,
      afterSeq: 0,
      onEvent: (event) => dispatch({ kind: "event", event }),
      onStatus: (s) => setStatus(s),
      onError: () => setConnected(false),
    })
    handleRef.current = handle
    handle.done.finally(() => setConnected(false))
    return () => { handle.close(); handleRef.current = null }
  }, [runId])

  const active = status != null && !["done", "error", "cancelled"].includes(status)
  return { state, status, connected, active, markApproved: () => dispatch({ kind: "approve" }) }
}
