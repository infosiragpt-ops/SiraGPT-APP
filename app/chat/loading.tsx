/**
 * /chat loading — composer + timeline skeleton (not the generic app spinner).
 */
export default function Loading() {
  return (
    <div
      className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground"
      role="status"
      aria-live="polite"
      aria-label="Cargando el chat"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <div className="h-6 w-28 rounded bg-muted/50 animate-pulse" />
        <div className="ml-auto h-7 w-36 rounded-full bg-muted/40 animate-pulse" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-hidden px-4 py-6 md:px-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={`flex ${i % 2 === 0 ? "justify-start" : "justify-end"}`}
            >
              <div
                className="space-y-2 rounded-2xl bg-muted/30 p-3"
                style={{ width: `${42 + ((i * 11) % 28)}%` }}
              >
                <div className="h-3 rounded bg-muted/50 animate-pulse" />
                <div className="h-3 w-5/6 rounded bg-muted/40 animate-pulse" />
                {i % 3 === 0 ? <div className="h-3 w-2/3 rounded bg-muted/30 animate-pulse" /> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t border-border/60 px-4 py-3 md:px-8">
          <div className="mx-auto max-w-3xl space-y-2">
            <div className="h-24 rounded-2xl border border-border/50 bg-muted/20 animate-pulse" />
            <div className="flex justify-end">
              <div className="h-8 w-20 rounded-full bg-muted/40 animate-pulse" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
