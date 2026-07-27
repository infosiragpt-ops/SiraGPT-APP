"use client"

// SearchPanel — full-text search results UI over /api/search.
//
// Per CLAUDE rule #1 we DO NOT auto-mount this anywhere. The
// component is a self-contained panel that any host can drop into a
// dialog / sidebar / command palette when the UI work is approved.
//
// Wiring points exposed:
//   - <SearchPanel onClose={…} /> — render anywhere.
//   - registerCmdK(open) — helper to bind ⌘K/Ctrl+K to a parent's
//     "open panel" handler. The hook is exported so a host component
//     can opt-in without us mounting any global keyboard listener.
//
// Features:
//   - 300ms debounce on the input.
//   - Loading / empty / error states.
//   - Result item: chat title + highlighted snippet + timestamp.
//   - Click → router.push(`/c/${chatId}`).

import * as React from "react"
import { useRouter } from "next/navigation"
import { Search as SearchIcon, AlertCircle, MessageSquare } from "lucide-react"

import { Input } from "@/components/ui/input"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { authenticatedFetch, isTrustedSiraApiUrl } from "@/lib/authenticated-fetch"

export interface SearchHit {
  messageId: string
  chatId: string
  chatTitle: string
  role: "USER" | "ASSISTANT" | string
  snippet: string
  timestamp: string
  rank: number
}

interface SearchPanelProps {
  onClose?: () => void
  initialQuery?: string
  /** Override the fetch URL for tests / SSR. Defaults to /api/search. */
  endpoint?: string
}

type Status = "idle" | "loading" | "ready" | "error" | "empty"

export function SearchPanel({ onClose, initialQuery = "", endpoint = "/api/search" }: SearchPanelProps) {
  const router = useRouter()
  const [query, setQuery] = React.useState(initialQuery)
  const [debounced, setDebounced] = React.useState(initialQuery)
  const [status, setStatus] = React.useState<Status>("idle")
  const [results, setResults] = React.useState<SearchHit[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [retryNonce, setRetryNonce] = React.useState(0)
  const abortRef = React.useRef<AbortController | null>(null)

  // 300ms debounce.
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  React.useEffect(() => {
    if (!debounced) {
      setStatus("idle")
      setResults([])
      setError(null)
      return
    }
    // Cancel any in-flight request so we don't race ourselves.
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setStatus("loading")
    setError(null)

    const url = `${endpoint}?q=${encodeURIComponent(debounced)}&limit=20`
    const request = isTrustedSiraApiUrl(url)
      ? authenticatedFetch(url, { signal: ac.signal })
      : fetch(url, { signal: ac.signal })
    request
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: { results?: SearchHit[] }) => {
        if (ac.signal.aborted) return
        const items = Array.isArray(data.results) ? data.results : []
        setResults(items)
        setStatus(items.length === 0 ? "empty" : "ready")
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        setError(err?.message || "search failed")
        setStatus("error")
      })

    return () => ac.abort()
  }, [debounced, endpoint, retryNonce])

  const handleRetry = React.useCallback(() => {
    // Re-run the effect by bumping a nonce — keeps the last debounced
    // query intact so the user doesn't have to retype.
    setRetryNonce((n) => n + 1)
  }, [])

  const handlePick = React.useCallback(
    (hit: SearchHit) => {
      onClose?.()
      router.push(`/c/${hit.chatId}`)
    },
    [onClose, router],
  )

  return (
    <div className="flex flex-col w-full max-w-2xl mx-auto">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar en tus chats…"
          className="pl-9"
          aria-label="Search chats"
        />
      </div>

      <ScrollArea className="mt-3 max-h-[60vh]">
        {status === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
            <ThinkingIndicator size="sm" /> Buscando…
          </div>
        )}
        {status === "error" && (
          <div className="flex items-start gap-2 text-sm text-destructive p-4">
            <AlertCircle className="h-4 w-4 mt-0.5" />
            <div className="flex flex-col gap-2">
              <span>{error || "Error al buscar"}</span>
              <button
                type="button"
                onClick={handleRetry}
                className="self-start text-xs underline hover:no-underline focus:outline-none"
                aria-label="Retry search"
              >
                Reintentar
              </button>
            </div>
          </div>
        )}
        {status === "empty" && (
          <div className="text-sm text-muted-foreground p-4">
            Sin resultados para <span className="font-medium">&ldquo;{debounced}&rdquo;</span>.
          </div>
        )}
        {status === "idle" && (
          <div className="text-sm text-muted-foreground p-4">
            Escribe para buscar en tu historial de chats.
          </div>
        )}
        {status === "ready" && (
          <ul className="divide-y divide-border">
            {results.map((hit) => (
              <li key={hit.messageId}>
                <button
                  type="button"
                  onClick={() => handlePick(hit)}
                  className="w-full text-left p-3 hover:bg-accent focus:bg-accent focus:outline-none transition"
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate">{hit.chatTitle || "Chat sin título"}</span>
                  </div>
                  <p
                    className="text-xs text-muted-foreground mt-1 line-clamp-2 [&_mark]:bg-yellow-200 [&_mark]:text-foreground [&_mark]:rounded-sm [&_mark]:px-0.5"
                    // Backend returns HTML-escaped output from ts_headline with
                    // <mark>…</mark> wrappers. We render via dangerouslySetInnerHTML
                    // so the highlight survives; ts_headline already escapes the
                    // surrounding text.
                    dangerouslySetInnerHTML={{ __html: hit.snippet || "" }}
                  />
                  <div className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wide">
                    {new Date(hit.timestamp).toLocaleString()} · {hit.role}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

/**
 * Helper hook: bind ⌘K / Ctrl+K to a host-supplied open handler.
 * Not auto-mounted — the host opts in by calling this from a
 * component it controls (e.g. a layout-level wrapper). We deliberately
 * do NOT mount a global listener at module-eval time so the panel can
 * land in the codebase without touching any existing UI.
 *
 * Usage:
 *   const [open, setOpen] = useState(false)
 *   useCmdKToggle(() => setOpen((o) => !o))
 */
export function useCmdKToggle(onToggle: () => void) {
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (isMod && (e.key === "k" || e.key === "K")) {
        e.preventDefault()
        onToggle()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onToggle])
}

export default SearchPanel
