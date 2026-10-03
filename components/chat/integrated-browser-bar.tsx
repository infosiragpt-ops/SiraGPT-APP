"use client"

import * as React from "react"
import { Globe, ArrowRight, ArrowLeft, RefreshCw, Plus, X, Maximize2, Minimize2 } from "lucide-react"
import { PensandoBars } from "@/components/pensando-bars"
import type { ComputerBrowserAction, ComputerBrowserState } from "@/lib/computer-navigate-client"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { sanitizeNavigateUrl } from "@/lib/computer-navigate"
import { postComputerNavigate } from "@/lib/computer-navigate-client"

export type IntegratedBrowserBarProps = {
  conversationId?: string | null
  initialUrl?: string
  autoNavigate?: boolean
  compact?: boolean
  onNavigated?: (url: string) => void
  /** A project address is display-only; it must never navigate the remote computer. */
  readOnlyLabel?: string
  browserControls?: IntegratedBrowserControls
}

export function IntegratedBrowserBar({
  conversationId,
  initialUrl = "",
  compact = false,
  autoNavigate = true,
  onNavigated,
  readOnlyLabel,
  browserControls,
}: IntegratedBrowserBarProps) {
  const readOnly = readOnlyLabel !== undefined
  const [value, setValue] = React.useState(initialUrl)
  const [busy, setBusy] = React.useState(false)
  const lastAutoUrl = React.useRef("")
  const onNavigatedRef = React.useRef(onNavigated)
  onNavigatedRef.current = onNavigated

  React.useEffect(() => {
    if (initialUrl) setValue(initialUrl)
  }, [initialUrl])

  React.useEffect(() => {
    const chatId = String(conversationId || "").trim()
    if (browserControls || readOnly || !autoNavigate || !initialUrl || !chatId) return
    const stamp = `${chatId}::${initialUrl}`
    if (stamp === lastAutoUrl.current) return
    lastAutoUrl.current = stamp
    const parsed = sanitizeNavigateUrl(initialUrl)
    if (!parsed.ok) return
    let cancelled = false
    setBusy(true)
    void postComputerNavigate(chatId, parsed.url)
      .then((url) => {
        if (cancelled) return
        setValue(url)
        onNavigatedRef.current?.(url)
      })
      .catch((error: any) => {
        if (cancelled) return
        toast.error(error?.message || "No se pudo abrir la página")
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [initialUrl, conversationId, autoNavigate, readOnly, browserControls])

  const go = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (readOnly) return
    const parsed = sanitizeNavigateUrl(value)
    if (!parsed.ok) {
      toast.error(parsed.error)
      return
    }
    setBusy(true)
    try {
      const url = await postComputerNavigate(conversationId, parsed.url)
      setValue(url)
      lastAutoUrl.current = `${String(conversationId || "").trim()}::${url}`
      onNavigated?.(url)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo abrir la página")
    } finally {
      setBusy(false)
    }
  }

  if (browserControls) return <BrowserControls {...browserControls} />

  return (
    <form
      onSubmit={(event) => void go(event)}
      data-testid="integrated-browser-bar"
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-black/10 bg-white/80 shadow-inner dark:border-white/10 dark:bg-white/[0.06]",
        compact ? "h-8 px-2" : "h-7 px-2.5",
      )}
    >
      <Globe className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />
      <input
        value={readOnly ? readOnlyLabel : value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Buscar o pegar una URL…"
        aria-label={readOnly ? "Dirección del proyecto" : "Dirección del navegador"}
        readOnly={readOnly}
        data-testid="integrated-browser-url"
        disabled={busy}
        className={cn(
          "min-w-0 flex-1 bg-transparent font-mono text-zinc-700 outline-none placeholder:font-sans placeholder:text-zinc-400 dark:text-zinc-200",
          compact ? "text-[12px]" : "text-[11px]",
        )}
      />
      {readOnly ? null : <button
        type="submit"
        disabled={busy || !value.trim()}
        aria-label="Ir"
        data-testid="integrated-browser-go"
        className="inline-grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-500 hover:bg-black/5 hover:text-zinc-800 disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-zinc-100"
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </button>}
    </form>
  )
}

export type IntegratedBrowserControls = {
  state: ComputerBrowserState | null
  busy: boolean
  error: string | null
  onAction: (action: ComputerBrowserAction) => Promise<unknown>
  onRetry?: () => Promise<unknown>
  onNavigate: (url: string) => Promise<string>
  onClose?: () => void
  onToggleMaximize?: () => void
  maximized?: boolean
}

function visibleAddress(url: string | undefined): string {
  return url && /^https?:\/\//i.test(url) ? url : ""
}

function BrowserControls({ state, busy, error, onAction, onNavigate, onClose, onToggleMaximize, maximized, onRetry }: IntegratedBrowserControls) {
  const active = state?.tabs.find((tab) => tab.id === state.activeTabId)
  const [draft, setDraft] = React.useState(visibleAddress(active?.url))
  const [localError, setLocalError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const dirty = React.useRef(false)
  const tabButtons = React.useRef(new Map<string, HTMLButtonElement>())
  const keyboardTarget = React.useRef<string | null>(null)
  const blankFocus = React.useRef(false)
  const tabRef = React.useRef<string | null | undefined>(undefined)
  React.useEffect(() => {
    const changed = tabRef.current !== state?.activeTabId
    tabRef.current = state?.activeTabId
    if (changed || !dirty.current) {
      setDraft(visibleAddress(active?.url))
      dirty.current = false
      setLocalError(null)
    }
    if (changed && state && !visibleAddress(active?.url)) blankFocus.current = true
    if (!busy && keyboardTarget.current === state?.activeTabId) {
      tabButtons.current.get(keyboardTarget.current!)?.focus()
      keyboardTarget.current = null
      blankFocus.current = false
    } else if (!busy && blankFocus.current) {
      inputRef.current?.focus()
      blankFocus.current = false
    }
  }, [state?.activeTabId, active?.url, state, busy])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || !state) return
    const parsed = sanitizeNavigateUrl(draft)
    if (!parsed.ok) { setLocalError(parsed.error); return }
    setLocalError(null)
    dirty.current = false
    try {
      const actual = await onNavigate(parsed.url)
      setDraft(actual)
      dirty.current = false
    } catch {
      setLocalError("No se pudo abrir la página. Revisa la dirección e inténtalo de nuevo.")
    }
  }
  const action = (value: ComputerBrowserAction) => {
    dirty.current = false
    setLocalError(null)
    void onAction(value).catch(() => { setLocalError("No se pudo completar la acción. Inténtalo de nuevo.") })
  }
  const button = "no-default-focus-ring inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:pointer-events-none disabled:opacity-35 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
  return <div className="relative shrink-0 border-b border-border bg-white text-foreground dark:bg-zinc-950" data-testid="integrated-browser-controls" aria-busy={busy}>
    <div className="flex min-w-0 items-center gap-1 px-2 pt-2 pb-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Pestañas del navegador">
        {state?.tabs.map((tab, index) => <div key={tab.id} className={cn("flex min-w-0 shrink-0 items-center rounded-lg border", tab.id === state.activeTabId ? "border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800" : "border-transparent")}>
          <button ref={(element) => { if (element) tabButtons.current.set(tab.id, element); else tabButtons.current.delete(tab.id) }} type="button" role="tab" aria-selected={tab.id === state.activeTabId}
            tabIndex={tab.id === state.activeTabId ? 0 : -1} disabled={busy}
            className="no-default-focus-ring h-9 min-w-0 max-w-40 truncate rounded-md px-3 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-sky-500 sm:max-w-52"
            title={tab.title || "Nueva pestaña"} onClick={() => action({ type: "browser_tab_select", tabId: tab.id })}
            onKeyDown={(event) => {
              if (!state || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
              event.preventDefault()
              const next = event.key === "Home" ? 0 : event.key === "End" ? state.tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + state.tabs.length) % state.tabs.length
              keyboardTarget.current = state.tabs[next].id
              action({ type: "browser_tab_select", tabId: state.tabs[next].id })
            }}>{tab.title || "Nueva pestaña"}</button>
          <button type="button" disabled={busy} className={cn(button, "mr-0.5 h-7 w-7")} aria-label={`Cerrar pestaña ${tab.title || "Nueva pestaña"}`} onClick={() => action({ type: "browser_tab_close", tabId: tab.id })}><X className="h-3.5 w-3.5" aria-hidden /></button>
        </div>)}
      </div>
      <button type="button" className={button} disabled={busy || !state} aria-label="Nueva pestaña" title="Nueva pestaña" onClick={() => action({ type: "browser_tab_create" })}><Plus className="h-4 w-4" aria-hidden /></button>
      {onToggleMaximize ? <button type="button" className={button} aria-label={maximized ? "Restaurar navegador" : "Maximizar navegador"} title={maximized ? "Restaurar navegador" : "Maximizar navegador"} onClick={onToggleMaximize}>{maximized ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}</button> : null}
      {onClose ? <button type="button" className={button} aria-label="Cerrar navegador" title="Cerrar navegador" data-testid="chat-agent-computer-close" onClick={onClose}><X className="h-4 w-4" aria-hidden /></button> : null}
    </div>
    <form className="flex min-w-0 items-center gap-0.5 px-2 pb-2" data-testid="integrated-browser-bar" onSubmit={(event) => void submit(event)}>
      <button type="button" className={button} disabled={busy || !state?.canGoBack} aria-label="Atrás" title="Atrás" onClick={() => action({ type: "browser_back", tabId: state?.activeTabId || undefined })}><ArrowLeft className="h-4 w-4" aria-hidden /></button>
      <button type="button" className={button} disabled={busy || !state?.canGoForward} aria-label="Adelante" title="Adelante" onClick={() => action({ type: "browser_forward", tabId: state?.activeTabId || undefined })}><ArrowRight className="h-4 w-4" aria-hidden /></button>
      <button type="button" className={button} disabled={busy || !state?.activeTabId} aria-label="Recargar página" title="Recargar página" onClick={() => action({ type: "browser_reload", tabId: state?.activeTabId || undefined })}>{busy ? <PensandoBars size={16} /> : <RefreshCw className="h-4 w-4" aria-hidden />}</button>
      <input ref={inputRef} aria-label="Dirección del navegador" data-testid="integrated-browser-url" placeholder="Escribe una URL" value={draft}
        disabled={!state} readOnly={busy} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        onChange={(event) => { dirty.current = true; setDraft(event.target.value) }}
        className="no-default-focus-ring sira-browser-address ml-1 h-9 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 text-base outline-none transition-shadow disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 sm:text-[13px]" />
      <button type="submit" className={button} disabled={busy || !state || !draft.trim()} aria-label="Ir" data-testid="integrated-browser-go"><ArrowRight className="h-4 w-4" aria-hidden /></button>
    </form>
    {error || localError ? <p className="absolute inset-x-0 top-full z-30 border-b border-red-100 bg-white px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-zinc-950 dark:text-red-300" role="alert" data-testid="browser-error">{error || localError}{(onRetry || !state) && !busy ? <button type="button" className="ml-2 underline underline-offset-2" onClick={() => { if (onRetry) void onRetry().catch(() => setLocalError("No se pudo completar la acción. Inténtalo de nuevo.")); else action({ type: "browser_present" }) }}>Reintentar</button> : null}</p> : null}
    {busy ? <span className="sr-only" role="status">Abriendo página…</span> : null}
  </div>
}
