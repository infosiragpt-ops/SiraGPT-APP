"use client"

import * as React from "react"
import { toast } from "sonner"
import { githubService } from "@/lib/github-service"
import { getSameOriginApiBaseUrl } from "@/lib/api-base-url"
import { GITHUB_CONNECTION_REQUIRED_EVENT, GITHUB_CONNECTION_CANCEL_EVENT, GITHUB_CONNECTION_TURN_SETTLED_EVENT, isExplicitGithubConnectRequest, isGithubAuthorizeUrl, parseGithubConnectionPayload, type GithubConnectionDetail } from "@/lib/chat/github-connect-handoff"

const MAX_WAIT_MS = 10 * 60_000
const POLL_MS = 3_000
const consumedKey = (owner: string) => `siragpt:github-handoff-consumed:${owner}`
const storageKey = (owner: string) => `siragpt:github-handoff:${owner}`
type Pending = GithubConnectionDetail & { expiresAt: number }
type Live = Pending & { popup: Window | null; controller: AbortController; timer?: ReturnType<typeof setTimeout>; expiryTimer?: ReturnType<typeof setTimeout>; busy: boolean; navigated: boolean; authorizeUrl?: string }
type Options = { userId?: string; chatId?: string | null; busy: boolean; onConnected: (detail: GithubConnectionDetail) => Promise<void> | void }

function closePopup(popup: Window | null) { try { popup?.close() } catch { /* Cross-origin context may already be gone. */ } }
function readPending(owner: string): Pending[] {
  try {
    const rows: unknown = JSON.parse(sessionStorage.getItem(storageKey(owner)) || "[]")
    if (!Array.isArray(rows)) return []
    return rows.slice(0, 8).filter((row): row is Pending => Boolean(parseGithubConnectionPayload(row)
      && row.userId === owner && Number.isFinite(row.expiresAt) && row.expiresAt > Date.now()
      && row.expiresAt <= Date.now() + MAX_WAIT_MS))
  } catch { return [] }
}

/** OAuth owns credentials; this hook stores only correlation IDs and expiry. */
export function useChatGithubConnect(options: Options) {
  const scope = React.useRef(options)
  scope.current = options
  const pending = React.useRef(new Map<string, Live>())
  const seen = React.useRef(new Set<string>())
  const reserved = React.useRef<{ userId: string; chatId: string | null; popup: Window; timer: ReturnType<typeof setTimeout> } | null>(null)
  const acceptRef = React.useRef<(detail: GithubConnectionDetail) => void>(() => {})
  const pollRef = React.useRef<(row: Live) => Promise<void>>(async () => {})

  const persist = React.useCallback(() => {
    const owner = scope.current.userId
    if (!owner) return
    try {
      const rows = [...pending.current.values()].filter((row) => row.userId === owner)
        .map(({ userId, chatId, handoffId, expiresAt }) => ({ userId, chatId, handoffId, expiresAt }))
      sessionStorage.setItem(storageKey(owner), JSON.stringify(rows))
    } catch { /* Authentication still works when session storage is unavailable. */ }
  }, [])
  const finish = React.useCallback((row: Live) => {
    row.controller.abort()
    clearTimeout(row.timer)
    clearTimeout(row.expiryTimer)
    pending.current.delete(row.handoffId)
    closePopup(row.popup)
    toast.dismiss(`github-${row.handoffId}`)
    try {
      const entries = JSON.parse(sessionStorage.getItem(consumedKey(row.userId)) || "[]")
      const valid = Array.isArray(entries) ? entries.filter((entry: { expiresAt?: number }) => Number(entry?.expiresAt) > Date.now()) : []
      sessionStorage.setItem(consumedKey(row.userId), JSON.stringify([...valid.slice(-31), { handoffId: row.handoffId, expiresAt: row.expiresAt }]))
    } catch { /* In-memory deduplication remains active. */ }
    persist()
  }, [persist])
  const alive = React.useCallback((row: Live) => !row.controller.signal.aborted
    && scope.current.userId === row.userId && pending.current.get(row.handoffId) === row, [])

  const open = React.useCallback(() => {
    const popup = window.open("about:blank", `siragpt-github-${Date.now()}`, "popup,width=720,height=820")
    if (popup) {
      try { popup.document.title = "Conectar GitHub"; popup.document.body.textContent = "Preparando la conexión con GitHub…" } catch { /* Optional blank-tab message. */ }
    }
    return popup
  }, [])

  const waitingToast = React.useCallback((row: Live, opened: boolean) => {
    toast.message(opened ? "Te abrí GitHub. Inicia sesión y autoriza; retomaré este chat al comprobar la conexión."
      : "Hay una conexión con GitHub pendiente. Completa la autorización en su pestaña o cancela para volver a empezar.", {
      id: `github-${row.handoffId}`, duration: Infinity,
      action: { label: "Cancelar", onClick: () => { if (alive(row)) { finish(row); toast.message("Conexión con GitHub cancelada.") } } },
    })
  }, [alive, finish])

  const start = React.useCallback(async (row: Live) => {
    if (!alive(row) || row.busy) return
    row.busy = true
    try {
      const result = await githubService.connectUrl({ chatId: row.chatId, handoffId: row.handoffId, popup: true, signal: row.controller.signal })
      if (!alive(row)) return
      if (result.chatId !== row.chatId || result.handoffId !== row.handoffId || !isGithubAuthorizeUrl(result.url)) throw new Error("invalid_handoff")
      row.authorizeUrl = result.url
      if (!row.popup) {
        row.busy = false
        toast.message("El navegador bloqueó la pestaña. Abre GitHub para autorizar la conexión.", { duration: Infinity, id: `github-${row.handoffId}`, action: { label: "Abrir GitHub", onClick: () => {
          if (!alive(row)) return
          row.popup = open()
          if (row.popup && row.authorizeUrl) {
            row.popup.location.href = row.authorizeUrl
            row.navigated = true
            waitingToast(row, true)
          }
        } }, cancel: { label: "Cancelar", onClick: () => { if (alive(row)) finish(row) } } })
        return
      }
      if (row.popup.closed) { finish(row); return }
      row.popup.location.href = result.url
      row.navigated = true
      waitingToast(row, true)
    } catch {
      if (alive(row)) { finish(row); toast.error("No se pudo abrir la conexión con GitHub. Vuelve a pedir conectar GitHub.") }
    } finally {
      row.busy = false
      if (alive(row)) row.timer = setTimeout(() => void pollRef.current(row), POLL_MS)
    }
  }, [alive, finish, open, waitingToast])

  pollRef.current = async (row) => {
    if (!alive(row) || row.busy) return
    clearTimeout(row.timer)
    if (Date.now() >= row.expiresAt) { finish(row); toast.message("La conexión con GitHub caducó. Puedes volver a pedir conectar GitHub."); return }
    row.busy = true
    try {
      const receipt = await githubService.connectStatus({ chatId: row.chatId, handoffId: row.handoffId, signal: row.controller.signal })
      if (!alive(row) || receipt.chatId !== row.chatId || receipt.handoffId !== row.handoffId) return
      if (receipt.status === "error") {
        finish(row)
        toast.message("La conexión con GitHub no se completó. Puedes volver a intentarlo.", { id: `github-result-${row.handoffId}` })
        return
      }
      if (receipt.status !== "success") return
      const status = await githubService.status({ verify: true, signal: row.controller.signal })
      if (!alive(row)) return
      if (status.reconnectRequired === true) {
        finish(row)
        toast.error("GitHub necesita una nueva autorización. Vuelve a pedir conectar GitHub.", { id: `github-result-${row.handoffId}` })
        return
      }
      const verified = status.connected && status.verified === true && Boolean(receipt.connectionVersion)
        && status.connectionVersion === receipt.connectionVersion
      if (verified && scope.current.chatId === row.chatId && !scope.current.busy && document.visibilityState !== "hidden") {
        // Remove before continuation: repeated callbacks/focus/polls cannot run it twice.
        finish(row)
        toast.success("GitHub conectado. Retomando la tarea pendiente.", { id: `github-result-${row.handoffId}` })
        try { await scope.current.onConnected({ userId: row.userId, chatId: row.chatId, handoffId: row.handoffId }) }
        catch { toast.error("GitHub quedó conectado, pero no se pudo retomar la tarea. Escribe continuar en este chat.") }
      }
    } catch { /* A transient status error is not proof of a connection. */ }
    finally {
      row.busy = false
      if (alive(row)) row.timer = setTimeout(() => void pollRef.current(row), POLL_MS)
    }
  }

  acceptRef.current = (detail) => {
    if (!parseGithubConnectionPayload(detail) || !detail || detail.userId !== scope.current.userId || seen.current.has(detail.handoffId)) return
    seen.current.add(detail.handoffId)
    // Only one pending authorization per chat; another chat never inherits its popup.
    for (const row of pending.current.values()) if (row.chatId === detail.chatId) finish(row)
    const reservation = reserved.current
    let popup: Window | null = null
    if (reservation && reservation.userId === detail.userId && (reservation.chatId === detail.chatId || !reservation.chatId)) {
      clearTimeout(reservation.timer); popup = reservation.popup; reserved.current = null
    } else if (scope.current.chatId === detail.chatId) popup = open()
    const row: Live = { ...detail, expiresAt: Date.now() + MAX_WAIT_MS, popup, controller: new AbortController(), busy: false, navigated: false }
    row.expiryTimer = setTimeout(() => { if (alive(row)) { finish(row); toast.message("La conexión con GitHub caducó. Puedes volver a pedir conectar GitHub.") } }, MAX_WAIT_MS)
    pending.current.set(detail.handoffId, row); persist()
    void start(row)
  }

  React.useEffect(() => {
    const owner = options.userId
    if (!owner) return
    const ownerPending = pending.current
    seen.current.clear()
    try {
      const consumed = JSON.parse(sessionStorage.getItem(consumedKey(owner)) || "[]")
      if (Array.isArray(consumed)) for (const row of consumed) if (row?.expiresAt > Date.now() && typeof row.handoffId === "string") seen.current.add(row.handoffId)
    } catch { /* Invalid storage is ignored. */ }
    for (const saved of readPending(owner)) {
      seen.current.add(saved.handoffId)
      const row: Live = { ...saved, popup: null, controller: new AbortController(), busy: false, navigated: true }
      row.expiryTimer = setTimeout(() => { if (alive(row)) finish(row) }, Math.max(1, row.expiresAt - Date.now()))
      pending.current.set(row.handoffId, row)
      waitingToast(row, false)
      void pollRef.current(row)
    }
    const required = (event: Event) => acceptRef.current((event as CustomEvent<GithubConnectionDetail>).detail)
    const wake = () => { for (const row of pending.current.values()) if (row.navigated) void pollRef.current(row) }
    const cancel = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; chatId?: string }>).detail
      if (detail?.userId !== owner) return
      for (const row of pending.current.values()) if (row.chatId === detail.chatId) finish(row)
      if (reserved.current?.userId === owner && reserved.current.chatId === detail.chatId) {
        clearTimeout(reserved.current.timer); closePopup(reserved.current.popup); reserved.current = null
      }
    }
    const settled = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; chatId: string }>).detail
      const reservation = reserved.current
      if (reservation && detail?.userId === reservation.userId && detail.chatId === reservation.chatId) {
        clearTimeout(reservation.timer); closePopup(reservation.popup); reserved.current = null
      }
    }
    const message = (event: MessageEvent) => {
      let apiOrigin = ""
      try { apiOrigin = new URL(getSameOriginApiBaseUrl(), window.location.origin).origin } catch { return }
      if (event.origin !== apiOrigin) return
      const data = event.data
      if (data?.type !== "github_oauth_result" || data.service !== "github") return
      const row = pending.current.get(data.handoffId)
      if (!row || data.chatId !== row.chatId || event.source !== row.popup || !row.popup) return
      if (data.status === "error" || data.status === "success") void pollRef.current(row)
    }
    window.addEventListener(GITHUB_CONNECTION_REQUIRED_EVENT, required)
    window.addEventListener(GITHUB_CONNECTION_CANCEL_EVENT, cancel)
    window.addEventListener(GITHUB_CONNECTION_TURN_SETTLED_EVENT, settled)
    window.addEventListener("message", message)
    window.addEventListener("focus", wake)
    document.addEventListener("visibilitychange", wake)
    return () => {
      window.removeEventListener(GITHUB_CONNECTION_REQUIRED_EVENT, required)
      window.removeEventListener(GITHUB_CONNECTION_CANCEL_EVENT, cancel)
      window.removeEventListener(GITHUB_CONNECTION_TURN_SETTLED_EVENT, settled)
      window.removeEventListener("message", message)
      window.removeEventListener("focus", wake)
      document.removeEventListener("visibilitychange", wake)
      for (const row of ownerPending.values()) {
        row.controller.abort(); clearTimeout(row.timer); clearTimeout(row.expiryTimer); toast.dismiss(`github-${row.handoffId}`)
        if (scope.current.userId !== owner) closePopup(row.popup)
      }
      ownerPending.clear()
      if (reserved.current) { clearTimeout(reserved.current.timer); closePopup(reserved.current.popup); reserved.current = null }
    }
  }, [options.userId, alive, finish, waitingToast])

  React.useEffect(() => {
    for (const row of pending.current.values()) if (row.navigated && row.chatId === options.chatId) void pollRef.current(row)
  }, [options.chatId, options.busy])

  const reserve = React.useCallback((text: string) => {
    const current = scope.current
    if (/\b(?:cancela|cancelar|deten|para|anula)\b.*\b(?:conexion|conectar|github)\b/i.test(text) && /github/i.test(text)) {
      window.dispatchEvent(new CustomEvent(GITHUB_CONNECTION_CANCEL_EVENT, { detail: { userId: current.userId, chatId: current.chatId } }))
      return
    }
    if (!current.userId || !current.chatId || current.chatId.startsWith("temp-chat-") || current.busy || !isExplicitGithubConnectRequest(text) || reserved.current) return
    const popup = open()
    if (!popup) return
    const reservation = { userId: current.userId, chatId: current.chatId || null, popup, timer: setTimeout(() => {
      if (reserved.current?.popup === popup) { closePopup(popup); reserved.current = null }
    }, 120_000) }
    reserved.current = reservation
  }, [open])
  const cancel = React.useCallback(() => {
    window.dispatchEvent(new CustomEvent(GITHUB_CONNECTION_CANCEL_EVENT, { detail: { userId: scope.current.userId, chatId: scope.current.chatId } }))
  }, [])
  return { reserve, cancel }
}
