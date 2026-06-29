"use client"

/**
 * LogsTab - publishing-style deployment log table.
 *
 * Data flow stays the same:
 * - initial fill from deploymentsApi.logs(id).entries
 * - live SSE tail from deploymentsApi.logsStreamUrl(id)
 *
 * The UI intentionally mirrors the richer publishing sample:
 * search, error-only toggle, date sorting, compact rows, optional wrapping,
 * colorized error rows, copy action, and a live status footer.
 */

import * as React from "react"
import { Check, ChevronDown, Copy, Info, Palette, Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { deploymentsApi, type LogEntry } from "@/lib/deployments/deployments-api"

type Connection = "connecting" | "live" | "closed"

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number, size = 2) => String(n).padStart(size, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}.${pad(Math.floor(d.getMilliseconds() / 10))}`
}

function shortDeployment(value: string | null): string {
  if (!value) return "-"
  return value.length > 12 ? value.slice(0, 12) : value
}

function normalizeLogEntry(payload: Partial<LogEntry>): LogEntry | null {
  if (!payload || typeof payload.message !== "string") return null
  const source =
    payload.source === "User" || payload.source === "System" || payload.source === "Runtime"
      ? payload.source
      : "System"
  const level =
    payload.level === "error" || payload.level === "warn" || payload.level === "info"
      ? payload.level
      : "info"
  return {
    id: typeof payload.id === "string" ? payload.id : undefined,
    ts: typeof payload.ts === "string" ? payload.ts : new Date().toISOString(),
    source,
    level,
    message: payload.message,
    deployment: typeof payload.deployment === "string" ? payload.deployment : null,
    index: typeof payload.index === "number" ? payload.index : undefined,
  }
}

function logEntryKey(entry: LogEntry): string {
  return entry.id || `${entry.ts}|${entry.source}|${entry.level}|${entry.deployment || ""}|${entry.message}`
}

function mergeLogEntries(current: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const merged = new Map<string, LogEntry>()
  for (const entry of current) merged.set(logEntryKey(entry), entry)
  for (const entry of incoming) merged.set(logEntryKey(entry), entry)
  return Array.from(merged.values()).sort((a, b) => {
    const at = new Date(a.ts).getTime()
    const bt = new Date(b.ts).getTime()
    const byTime = (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0)
    if (byTime !== 0) return byTime
    return (a.index ?? 0) - (b.index ?? 0)
  })
}

export function LogsTab({ deploymentId }: { deploymentId: string }) {
  const [entries, setEntries] = React.useState<LogEntry[]>([])
  const [connection, setConnection] = React.useState<Connection>("connecting")
  const [query, setQuery] = React.useState("")
  const [errorsOnly, setErrorsOnly] = React.useState(false)
  const [wrap, setWrap] = React.useState(false)
  const [colors, setColors] = React.useState(true)
  const [collapsed, setCollapsed] = React.useState(false)
  const [ascending, setAscending] = React.useState(true)
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null)

  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    setEntries([])
    setConnection("connecting")
  }, [deploymentId])

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await deploymentsApi.logs(deploymentId)
        if (cancelled) return
        const normalized = result.entries
          .map((entry) => normalizeLogEntry(entry))
          .filter((entry): entry is LogEntry => entry !== null)
        setEntries((prev) => mergeLogEntries(prev, normalized))
        setConnection("live")
      } catch {
        // SSE can still hydrate the table after the initial request fails.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [deploymentId])

  React.useEffect(() => {
    const url = deploymentsApi.logsStreamUrl(deploymentId)
    let source: EventSource | null = null

    try {
      source = new EventSource(url, { withCredentials: true })
    } catch {
      setConnection("closed")
      return
    }

    const onOpen = () => setConnection("live")
    const onLog = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as Partial<LogEntry>
        const entry = normalizeLogEntry(payload)
        if (entry) setEntries((prev) => mergeLogEntries(prev, [entry]))
      } catch {
        if (typeof event.data === "string") {
          setEntries((prev) =>
            mergeLogEntries(prev, [
              {
                ts: new Date().toISOString(),
                source: "System",
                level: "info",
                message: event.data,
                deployment: null,
              },
            ]),
          )
        }
      }
    }
    const onError = () => setConnection("closed")

    source.addEventListener("open", onOpen)
    source.addEventListener("log", onLog as EventListener)
    source.onerror = onError

    return () => {
      source?.removeEventListener("open", onOpen)
      source?.removeEventListener("log", onLog as EventListener)
      source?.close()
    }
  }, [deploymentId])

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = entries.filter((entry) => {
      if (errorsOnly && entry.level !== "error") return false
      if (!needle) return true
      return `${formatTime(entry.ts)} ${entry.deployment || ""} ${entry.source} ${entry.message}`
        .toLowerCase()
        .includes(needle)
    })
    return ascending ? rows : [...rows].reverse()
  }, [ascending, entries, errorsOnly, query])

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [filtered.length])

  const copyRow = React.useCallback((entry: LogEntry) => {
    const key = logEntryKey(entry)
    void navigator.clipboard
      ?.writeText(`${formatTime(entry.ts)}\t${shortDeployment(entry.deployment)}\t${entry.source}\t${entry.message}`)
      .then(() => {
        setCopiedKey(key)
        window.setTimeout(() => {
          setCopiedKey((prev) => (prev === key ? null : prev))
        }, 1500)
      })
  }, [])

  return (
    <section className="flex h-full min-h-[520px] flex-col bg-[#1f1f1f] text-[#f5f5f5]">
      <div className="flex h-[49px] shrink-0 items-center gap-3 border-b border-[#353535] bg-[#232323] px-[10px]">
        <div className="relative min-w-0 flex-1">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="h-8 w-full rounded-[6px] border border-[#3b3b3b] bg-[#2a2a2a] pl-3 pr-9 text-[13px] text-[#f3f3f3] outline-none placeholder:text-[#8d8d8d] focus:border-[#5c5c5c]"
          />
          <Search className="pointer-events-none absolute right-2 top-2 h-4 w-4 text-[#c8c8c8]" strokeWidth={1.7} />
        </div>

        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-[6px] border border-[#333] bg-[#2a2a2a] px-3 text-[13px] text-[#f1f1f1] transition-colors hover:bg-[#303030]"
          onClick={() => setErrorsOnly((value) => !value)}
          aria-pressed={errorsOnly}
        >
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-[6px] border border-[#5a5a5a] text-[11px]",
              errorsOnly ? "border-[#efefef] bg-[#efefef] text-[#111]" : "bg-transparent text-transparent",
            )}
          >
            <Check className="h-3.5 w-3.5" />
          </span>
          Errors only
        </button>

        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-[6px] border border-[#333] bg-[#2a2a2a] px-3 text-[13px] text-[#f1f1f1] transition-colors hover:bg-[#303030]"
          onClick={() => setAscending((value) => !value)}
        >
          Date
          <ChevronDown className={cn("h-4 w-4 transition-transform", !ascending && "rotate-180")} strokeWidth={1.5} />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-[#1f1f1f]">
        <div className="min-w-[1120px]">
          <div className="grid h-[30px] grid-cols-[34px_174px_104px_72px_minmax(760px,1fr)] items-center border-b border-[#353535] bg-[#262626] px-0 text-[12px] text-[#e7e7e7]">
            <div className="pl-[6px]">
              <span className="block h-5 w-5 rounded-[5px] border border-[#4c4c4c] bg-[#2f2f2f]" />
            </div>
            <div className="flex items-center gap-1">
              Time <Info className="h-3 w-3 text-[#8e8e8e]" />
            </div>
            <div>Deployment</div>
            <div>Source</div>
            <div>Log</div>
          </div>

          {collapsed ? null : filtered.map((entry, index) => {
            const key = logEntryKey(entry)
            const error = colors && entry.level === "error"
            return (
              <div
                key={`${key}-${index}`}
                className={cn(
                  "group grid min-h-[27px] grid-cols-[34px_174px_104px_72px_minmax(760px,1fr)] items-start border-b border-[#2f2f2f] font-mono text-[12px] text-[#ebebeb]",
                  error ? "bg-[#742523] text-[#fff5f5]" : "bg-[#1f1f1f]",
                )}
              >
                <div />
                <div className={cn("px-1 py-1.5", collapsed && "py-0.5", !error && "text-[#b8b8b8]")}>{formatTime(entry.ts)}</div>
                <div className={cn("px-1 py-1.5", collapsed && "py-0.5", !error && "text-[#b8b8b8]")}>{shortDeployment(entry.deployment)}</div>
                <div className={cn("px-1 py-1.5", collapsed && "py-0.5", !error && "text-[#b8b8b8]")}>{entry.source}</div>
                <div className="flex items-start gap-2 px-1 py-1.5">
                  <span className={cn("min-w-0 flex-1 leading-5", wrap ? "whitespace-pre-wrap break-words" : "truncate whitespace-nowrap")}>
                    {entry.message}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyRow(entry)}
                    className="shrink-0 text-[#b8b8b8] opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
                    aria-label="Copy line"
                  >
                    {copiedKey === key ? <Check className="h-3.5 w-3.5 text-[#a7f3b0]" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            )
          })}

          {filtered.length === 0 || collapsed ? (
            <div className="flex h-32 items-center justify-center border-b border-[#353535] font-mono text-[12px] text-[#8c8c8c]">
              {collapsed ? "Logs collapsed" : entries.length === 0 ? "Waiting for logs..." : `No logs for ${deploymentId}`}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between border-t border-[#353535] bg-[#232323] px-2 text-[12px] text-[#c6c6c6]">
        <div className="flex items-center gap-3">
          <BarToggle active={collapsed} onClick={() => setCollapsed((value) => !value)}>
            Collapse
          </BarToggle>
          <BarToggle active={wrap} onClick={() => setWrap((value) => !value)}>
            Wrap
          </BarToggle>
          <BarToggle active={colors} onClick={() => setColors((value) => !value)}>
            <Palette className="h-3.5 w-3.5" />
            Colors
          </BarToggle>
          <span className="tabular-nums text-[11px] text-[#9c9c9c]">
            {filtered.length === entries.length ? `${entries.length} lines` : `${filtered.length} / ${entries.length} lines`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              connection === "live"
                ? "bg-[#37c96b]"
                : connection === "connecting"
                  ? "bg-[#d6a944]"
                  : "bg-[#6b6b6b]",
            )}
          />
          <span className={connection === "live" ? "text-[#9df0b6]" : "text-[#a6a6a6]"}>
            {connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Offline"}
          </span>
        </div>
      </div>
    </section>
  )
}

function BarToggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-white",
        active ? "font-medium text-white" : "text-[#bdbdbd]",
      )}
    >
      {children}
    </button>
  )
}
