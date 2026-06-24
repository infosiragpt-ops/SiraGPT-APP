"use client"

/**
 * useWorkspaceRun — owns the "▶ Run" lifecycle for a cloned workspace.
 * Starts/stops the dev server and polls status so Preview (iframe) and
 * Console (logs) tabs share one source of truth.
 */

import * as React from "react"
import { toast } from "sonner"

import { githubService, type RunStatus } from "@/lib/github-service"

const POLL_MS = 2000
const MAX_TRIES = 90 // ~3 min

export function useWorkspaceRun(id: string) {
  const [run, setRun] = React.useState<RunStatus>({ running: false, status: "idle" })
  const [busy, setBusy] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const tries = React.useRef(0)

  const clearTimer = React.useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }, [])

  const poll = React.useCallback(() => {
    clearTimer()
    tries.current = 0
    timer.current = setInterval(async () => {
      tries.current += 1
      try {
        const st = await githubService.runStatus(id)
        setRun(st)
        if (st.status === "ready" || st.status === "error" || st.status === "idle" || tries.current > MAX_TRIES) {
          clearTimer()
          if (st.status === "ready") toast.success("App lista — preview en vivo")
          if (st.status === "error") toast.error(st.error || "El servidor de desarrollo falló")
        }
      } catch {
        clearTimer()
      }
    }, POLL_MS)
  }, [id, clearTimer])

  const start = React.useCallback(async () => {
    setBusy(true)
    try {
      const st = await githubService.run(id)
      setRun(st)
      if (st.status === "ready") {
        toast.success("App lista")
      } else {
        toast.info("Iniciando servidor de desarrollo…")
        poll()
      }
    } catch (e) {
      toast.error((e as Error).message || "No se pudo iniciar")
    } finally {
      setBusy(false)
    }
  }, [id, poll])

  const stop = React.useCallback(async () => {
    setBusy(true)
    clearTimer()
    try {
      await githubService.stop(id)
      setRun({ running: false, status: "idle" })
      toast.success("Detenido")
    } catch (e) {
      toast.error((e as Error).message || "No se pudo detener")
    } finally {
      setBusy(false)
    }
  }, [id, clearTimer])

  // On mount, learn the current run state (survives tab switches).
  React.useEffect(() => {
    githubService
      .runStatus(id)
      .then((st) => {
        setRun(st)
        if (st.status === "starting") poll()
      })
      .catch(() => {})
    return clearTimer
  }, [id, poll, clearTimer])

  return { run, busy, start, stop }
}
