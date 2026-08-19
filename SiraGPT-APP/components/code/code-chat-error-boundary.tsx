"use client"

import React from "react"
import { AlertTriangle } from "lucide-react"
import { reportErrorBoundary } from "@/lib/client-logs"

type Props = {
  children: React.ReactNode
  label?: string
}

type State = { hasError: boolean }

// Per-turn render guard for the /code chat. A single corrupt or legacy
// localStorage turn (e.g. malformed actions/phases persisted by an older
// build) must NOT take down the whole page via the route error boundary.
// When a child throws, we report it to the telemetry pipeline and render a
// compact inline notice so the rest of the conversation stays usable.
export class CodeChatErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    reportErrorBoundary(this.props.label || "code-chat", error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            No se pudo mostrar este mensaje. El resto de la conversación sigue
            disponible.
          </span>
        </div>
      )
    }
    return this.props.children
  }
}
