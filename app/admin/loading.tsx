/**
 * /admin loading — chrome skeleton (not the generic app spinner).
 */
export default function Loading() {
  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-hidden bg-zinc-50/80 text-foreground"
      role="status"
      aria-live="polite"
      aria-label="Cargando el panel de administración"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <div className="h-6 w-32 rounded bg-muted/50 animate-pulse" />
        <div className="ml-auto h-7 w-24 rounded-full bg-muted/40 animate-pulse" />
      </div>
      <div className="space-y-3 p-4">
        <div className="h-24 rounded-xl bg-muted/30 animate-pulse" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 rounded-xl bg-muted/25 animate-pulse" />
        ))}
      </div>
    </div>
  )
}
