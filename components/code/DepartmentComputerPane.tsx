"use client"

import * as React from "react"
import { ComputerViewer } from "@/components/code/ComputerViewer"
import { isAgentComputerEnabled } from "@/lib/agent-computer-flag"

/**
 * Optional wrapper around the existing department computer surface.
 *
 * Flag OFF (default): render `children` unchanged — Selkies / PNG pane.
 * Flag ON: render ComputerViewer when a noVNC websocket URL is provided.
 *
 * This file is not imported by /chat or /code by default. Callers that
 * already mount a department pane can swap in this wrapper without
 * restyling the off path.
 */
export function DepartmentComputerPane({
  children,
  novncWsUrl,
  password,
}: {
  children?: React.ReactNode
  novncWsUrl?: string | null
  password?: string
}) {
  if (isAgentComputerEnabled() && novncWsUrl) {
    return <ComputerViewer url={novncWsUrl} password={password} />
  }
  return <>{children ?? null}</>
}
