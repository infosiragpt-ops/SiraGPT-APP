"use client"

/**
 * GithubConnectCard — the "Connections" panel from Replit's Settings.
 * Shows GitHub connect/disconnect state and starts the OAuth flow.
 *
 * OAuth flow: GET /connect → { url } → redirect the browser to GitHub →
 * GitHub → backend /callback → backend redirects to the frontend with
 * ?github=<status>. We read that on mount and refresh status.
 */

import * as React from "react"
import { Github, CheckCircle2, Loader2, LogOut, AlertTriangle } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { githubService, type GithubStatus } from "@/lib/github-service"

export function GithubConnectCard({ onChange }: { onChange?: (s: GithubStatus) => void }) {
  const [status, setStatus] = React.useState<GithubStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const s = await githubService.status()
      setStatus(s)
      onChange?.(s)
    } catch (e) {
      setStatus({ connected: false, configured: false })
    } finally {
      setLoading(false)
    }
  }, [onChange])

  React.useEffect(() => {
    void refresh()
    // React to the OAuth callback return (?github=connected | denied | error …)
    if (typeof window !== "undefined") {
      const result = new URLSearchParams(window.location.search).get("github")
      if (result) {
        if (result === "connected") toast.success("GitHub conectado")
        else if (result === "already_linked") toast.error("Esta cuenta de GitHub ya está vinculada a otro usuario")
        else if (result === "denied") toast.error("Conexión cancelada")
        else toast.error(`GitHub: ${result}`)
        // clean the query param without a reload
        const url = new URL(window.location.href)
        url.searchParams.delete("github")
        window.history.replaceState({}, "", url.toString())
      }
    }
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refresh])

  const connect = async () => {
    setBusy(true)
    try {
      const { url } = await githubService.connectUrl()
      // Replit-style: open OAuth in a popup and poll status so the user stays
      // on this page. If the popup is blocked, fall back to a full redirect.
      const popup = window.open(url, "github-oauth", "width=720,height=820")
      if (!popup) {
        window.location.href = url
        return
      }
      const startedAt = Date.now()
      const poll = window.setInterval(async () => {
        const timedOut = Date.now() - startedAt > 120_000
        let done = false
        try {
          const s = await githubService.status()
          if (s.connected) {
            done = true
            setStatus(s)
            onChange?.(s)
            toast.success("GitHub conectado")
          }
        } catch {
          /* keep polling */
        }
        if (done || popup.closed || timedOut) {
          window.clearInterval(poll)
          setBusy(false)
          try {
            if (!popup.closed) popup.close()
          } catch {
            /* cross-origin close may throw — ignore */
          }
        }
      }, 1500)
    } catch (e) {
      toast.error((e as Error).message || "No se pudo iniciar la conexión con GitHub")
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    try {
      await githubService.disconnect()
      toast.success("GitHub desconectado")
      await refresh()
    } catch (e) {
      toast.error((e as Error).message || "No se pudo desconectar")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-foreground/5">
            <Github className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 font-medium">
              GitHub
              {loading ? null : status?.connected ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Conectado
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Desconectado</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {status?.connected
                ? `@${status.login}${status.scopes?.length ? ` · ${status.scopes.join(", ")}` : ""}`
                : "Control de versiones y colaboración"}
            </div>
          </div>
        </div>

        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : status?.configured === false ? (
          <span className="inline-flex items-center gap-1 text-xs text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5" /> OAuth no configurado
          </span>
        ) : status?.connected ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={disconnect}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <LogOut className="mr-1 h-3.5 w-3.5" />}
            Desconectar
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={connect}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Github className="mr-1 h-3.5 w-3.5" />}
            Sign in
          </Button>
        )}
      </div>

      {status?.configured === false && (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Configura <code>GITHUB_CLIENT_ID</code> y <code>GITHUB_CLIENT_SECRET</code> en el backend para habilitar la
          conexión con GitHub.
        </p>
      )}
    </div>
  )
}
