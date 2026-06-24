"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Wifi, WifiOff, RefreshCw } from "lucide-react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { cn } from "@/lib/utils"

export type ConnectionState = "online" | "offline" | "checking"

interface ConnectionStatusProps {
  /** Optional: custom check URL. Defaults to /api/health */
  checkUrl?: string
  /** Check interval in ms. Defaults to 30s when connected, 5s when disconnected */
  checkInterval?: number
  /** Show as a floating badge instead of inline */
  floating?: boolean
  className?: string
}

export function ConnectionStatus({
  checkUrl = "/api/health",
  checkInterval,
  floating = true,
  className,
}: ConnectionStatusProps) {
  const [state, setState] = useState<ConnectionState>("checking")
  const [latency, setLatency] = useState<number | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  const checkConnection = useCallback(async () => {
    try {
      const start = performance.now()
      const res = await fetch(checkUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      })
      if (!mountedRef.current) return
      setLatency(Math.round(performance.now() - start))
      setState(res.ok ? "online" : "offline")
    } catch {
      if (mountedRef.current) {
        setState("offline")
        setLatency(null)
      }
    }
  }, [checkUrl])

  useEffect(() => {
    mountedRef.current = true
    checkConnection()

    const interval = setInterval(
      checkConnection,
      checkInterval ?? (state === "offline" ? 5_000 : 30_000)
    )
    intervalRef.current = interval

    // Also re-check on 'online' event (browser network recovery)
    const onOnline = () => checkConnection()
    window.addEventListener("online", onOnline)

    return () => {
      mountedRef.current = false
      clearInterval(interval)
      window.removeEventListener("online", onOnline)
    }
  }, [checkConnection, checkInterval, state])

  // Dynamic interval: check more often when offline
  useEffect(() => {
    if (!intervalRef.current) return
    clearInterval(intervalRef.current)
    intervalRef.current = setInterval(
      checkConnection,
      checkInterval ?? (state === "offline" ? 5_000 : 30_000)
    )
  }, [state, checkInterval, checkConnection])

  const isOffline = state === "offline"

  const baseClass = cn(
    "flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full transition-all duration-300",
    floating && "fixed bottom-4 right-4 z-50 shadow-lg",
    state === "online" && "bg-green-50 text-green-700 border border-green-200",
    state === "checking" && "bg-yellow-50 text-yellow-700 border border-yellow-200",
    isOffline && "bg-red-50 text-red-700 border border-red-200 animate-pulse",
    className
  )

  if (state === "online" && floating) {
    // When floating and online, show a minimal dot
    return (
      <button
        onClick={checkConnection}
        className={cn(
          "fixed bottom-4 right-4 z-50 flex items-center gap-1.5 rounded-full bg-green-50 border border-green-200 px-2.5 py-1 shadow-lg transition-all hover:bg-green-100",
          className
        )}
        title={`Conectado · ${latency ?? "?"}ms`}
      >
        <Wifi className="h-3 w-3 text-green-600" />
        <span className="text-xs text-green-700 font-medium">{latency}ms</span>
      </button>
    )
  }

  if (!isOffline && state === "checking" && floating) return null

  return (
    <button onClick={checkConnection} className={baseClass} title="Tocar para verificar">
      {isOffline ? (
        <>
          <WifiOff className="h-3.5 w-3.5" />
          <span>Sin conexión al servidor</span>
          <RefreshCw className="h-3 w-3 ml-1 opacity-70" />
        </>
      ) : state === "checking" ? (
        <>
          <ThinkingIndicator size="xs" />
          <span>Verificando...</span>
        </>
      ) : (
        <>
          <Wifi className="h-3 w-3" />
          <span>{latency}ms</span>
        </>
      )}
    </button>
  )
}
