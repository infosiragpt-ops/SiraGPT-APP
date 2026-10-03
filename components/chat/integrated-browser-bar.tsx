"use client"

import * as React from "react"
import Image from "next/image"
import { Globe, ArrowRight, ArrowLeft, RotateCw, Plus, X, Maximize2, Minimize2, MoreVertical, ExternalLink, Pencil, MousePointer2, Copy, Eraser, Folder, TerminalSquare, Monitor } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
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
  annotationMode?: "interact" | "draw"
  annotationAvailable?: boolean
  onAnnotationModeChange?: (mode: "interact" | "draw") => void
  hasAnnotations?: boolean
  onClearAnnotations?: () => void
  onOpenDesktopApp?: (app: "desktop" | "files" | "terminal") => void
}

function visibleAddress(url: string | undefined): string {
  return url && /^https?:\/\//i.test(url) ? url : ""
}

// Only bundled icons for exact known hosts: no third-party requests revealing
// which sites are open in the user's remote session.
function siteIcon(url: string): string | null {
  try {
    const target = new URL(url)
    if (target.protocol === "https:" && ["google.com", "www.google.com"].includes(target.hostname)) return "/conexiones-logos/google.svg"
  } catch { /* A blank or internal page has no site icon. */ }
  return null
}

function BrowserControls({ state, busy, error, onAction, onNavigate, onClose, onToggleMaximize, maximized, onRetry,
  annotationMode = "interact", annotationAvailable = false, onAnnotationModeChange, hasAnnotations, onClearAnnotations, onOpenDesktopApp,
}: IntegratedBrowserControls) {
  const active = state?.tabs.find((tab) => tab.id === state.activeTabId)
  const [draft, setDraft] = React.useState(visibleAddress(active?.url))
  const [addressFocused, setAddressFocused] = React.useState(false)
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
    // Keep the entered address through queued work and failures; only a
    // confirmed navigation may replace it with the actual destination.
    dirty.current = true
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
  const button = "no-default-focus-ring sira-browser-button"
  const currentAddress = visibleAddress(active?.url)
  const currentParsed = sanitizeNavigateUrl(currentAddress)
  const externalUrl = currentParsed.ok ? currentParsed.url : null
  const addressParts = (() => {
    if (!currentAddress || dirty.current || addressFocused) return null
    try { const url = new URL(currentAddress); return { host: url.host, tail: `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}` } }
    catch { return null }
  })()
  const copyAddress = async () => {
    if (!externalUrl) return
    try {
      await navigator.clipboard.writeText(externalUrl)
      toast.success("Dirección copiada")
    } catch {
      inputRef.current?.focus()
      inputRef.current?.select()
      toast.error("Selecciona la dirección y cópiala desde la barra.")
    }
  }
  return <div className="sira-browser-toolbar relative shrink-0 border-b border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100" data-testid="integrated-browser-controls" aria-busy={busy}>
    <div className="sira-browser-tab-row">
      <div className="sira-browser-tab-group">
        <div className="sira-browser-tabs" role="tablist" aria-label="Pestañas del navegador">
          {state?.tabs.map((tab, index) => <div key={tab.id} className={cn("sira-browser-tab", tab.id === state.activeTabId && "sira-browser-tab-active")}>
            <button ref={(element) => { if (element) tabButtons.current.set(tab.id, element); else tabButtons.current.delete(tab.id) }} type="button" role="tab" aria-selected={tab.id === state.activeTabId}
              tabIndex={tab.id === state.activeTabId ? 0 : -1} disabled={busy}
              className="no-default-focus-ring sira-browser-tab-label"
              title={tab.title || "Nueva pestaña"} onClick={() => action({ type: "browser_tab_select", tabId: tab.id })}
              onKeyDown={(event) => {
                if (!state || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
                event.preventDefault()
                const next = event.key === "Home" ? 0 : event.key === "End" ? state.tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + state.tabs.length) % state.tabs.length
                keyboardTarget.current = state.tabs[next].id
                action({ type: "browser_tab_select", tabId: state.tabs[next].id })
              }}>
                {visibleAddress(tab.url) ? (siteIcon(tab.url)
                  ? <Image src={siteIcon(tab.url)!} alt="" width={14} height={14} className="sira-browser-site-icon" draggable={false} />
                  : <Globe className="sira-browser-site-icon" aria-hidden />) : null}
                <span className="truncate">{tab.title || "Nueva pestaña"}</span>
            </button>
            <button type="button" disabled={busy} className={cn(button, "sira-browser-tab-close")} aria-label={`Cerrar pestaña ${tab.title || "Nueva pestaña"}`} onClick={() => action({ type: "browser_tab_close", tabId: tab.id })}><X aria-hidden /></button>
          </div>)}
        </div>
        <button type="button" className={button} disabled={busy || !state} aria-label="Nueva pestaña" title="Nueva pestaña" onClick={() => action({ type: "browser_tab_create" })}><Plus aria-hidden /></button>
      </div>
      <div className="sira-browser-window-controls">
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className={button} aria-label="Más opciones del navegador" title="Más opciones"><MoreVertical aria-hidden /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[80] min-w-48">
            <DropdownMenuItem disabled={!externalUrl} onSelect={copyAddress}><Copy className="mr-2 h-4 w-4" />Copiar dirección</DropdownMenuItem>
            <DropdownMenuItem disabled={!hasAnnotations} onSelect={onClearAnnotations}><Eraser className="mr-2 h-4 w-4" />Borrar anotaciones</DropdownMenuItem>
            {onOpenDesktopApp ? <><DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onOpenDesktopApp("files")}><Folder className="mr-2 h-4 w-4" />Archivos</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpenDesktopApp("terminal")}><TerminalSquare className="mr-2 h-4 w-4" />Terminal</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpenDesktopApp("desktop")}><Monitor className="mr-2 h-4 w-4" />Escritorio</DropdownMenuItem>
            </> : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {onToggleMaximize ? <button type="button" className={button} aria-label={maximized ? "Restaurar navegador" : "Maximizar navegador"} title={maximized ? "Restaurar navegador" : "Maximizar navegador"} onClick={onToggleMaximize}>{maximized ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}</button> : null}
        {onClose ? <button type="button" className={button} aria-label="Cerrar navegador" title="Cerrar navegador" data-testid="chat-agent-computer-close" onClick={onClose}><X aria-hidden /></button> : null}
      </div>
    </div>
    <form className="sira-browser-navigation" data-testid="integrated-browser-bar" onSubmit={(event) => void submit(event)}>
      <button type="button" className={button} disabled={busy || !state?.canGoBack} aria-label="Atrás" title="Atrás" onClick={() => action({ type: "browser_back", tabId: state?.activeTabId || undefined })}><ArrowLeft aria-hidden /></button>
      <button type="button" className={button} disabled={busy || !state?.canGoForward} aria-label="Adelante" title="Adelante" onClick={() => action({ type: "browser_forward", tabId: state?.activeTabId || undefined })}><ArrowRight aria-hidden /></button>
      <button type="button" className={button} disabled={busy || !state?.activeTabId} aria-label="Recargar página" title="Recargar página" onClick={() => action({ type: "browser_reload", tabId: state?.activeTabId || undefined })}>{busy ? <PensandoBars size={16} /> : <RotateCw aria-hidden />}</button>
      <div className="sira-browser-address-wrap">
        <input ref={inputRef} aria-label="Dirección del navegador" data-testid="integrated-browser-url" placeholder="Escribe una URL" value={draft}
          disabled={!state} readOnly={busy} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          onFocus={() => setAddressFocused(true)} onBlur={() => setAddressFocused(false)}
          onChange={(event) => { dirty.current = true; setDraft(event.target.value) }}
          className={cn("no-default-focus-ring sira-browser-address", addressParts && "sira-browser-address-display")} />
        {addressParts ? <span aria-hidden className="sira-browser-address-label"><span>{addressParts.host}</span><span className="text-zinc-400">{addressParts.tail}</span></span> : null}
        {addressFocused || dirty.current ? <button type="submit" className={cn(button, "sira-browser-address-action")} disabled={busy || !state || !draft.trim()} aria-label="Ir" data-testid="integrated-browser-go"><ArrowRight aria-hidden /></button>
          : externalUrl ? <a href={externalUrl} target="_blank" rel="noopener noreferrer" className={cn(button, "sira-browser-address-action")} aria-label="Abrir en otra pestaña" title="Abrir en otra pestaña"><ExternalLink aria-hidden /></a>
          : <button type="button" disabled className={cn(button, "sira-browser-address-action")} aria-label="Abrir en otra pestaña"><ExternalLink aria-hidden /></button>}
      </div>
      <button type="button" className={button} disabled={!annotationAvailable || !onAnnotationModeChange} aria-pressed={annotationMode === "draw"} aria-label="Anotar página" title="Anotar página" onClick={() => onAnnotationModeChange?.(annotationMode === "draw" ? "interact" : "draw")}><Pencil aria-hidden /></button>
      <button type="button" className={button} disabled={!onAnnotationModeChange} aria-pressed={annotationMode === "interact"} aria-label="Interactuar con la página" title="Interactuar con la página" onClick={() => onAnnotationModeChange?.("interact")}><MousePointer2 aria-hidden /></button>
    </form>
    {error || localError ? <p className="absolute inset-x-0 top-full z-30 border-b border-red-100 bg-white px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-zinc-950 dark:text-red-300" role="alert" data-testid="browser-error">{error || localError}{(onRetry || !state) && !busy ? <button type="button" className="ml-2 underline underline-offset-2" onClick={() => { setLocalError(null); if (onRetry) void onRetry().catch(() => setLocalError("No se pudo completar la acción. Inténtalo de nuevo.")); else action({ type: "browser_present" }) }}>Reintentar</button> : null}</p> : null}
    {busy ? <span className="sr-only" role="status">Abriendo página…</span> : null}
  </div>
}
