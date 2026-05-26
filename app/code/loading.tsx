/**
 * /code loading — IDE shell skeleton. Three columns mirror the live
 * workspace layout (file tree, AI chat, editor) so the route paints
 * a useful frame while client chunks hydrate.
 */
export default function Loading() {
  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <div className="h-6 w-32 rounded bg-muted/50 animate-pulse" />
        <div className="ml-auto h-7 w-40 rounded-full bg-muted/40 animate-pulse" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[220px_360px_1fr]">
        <div className="border-r border-border/60 p-3 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-5 w-full rounded bg-muted/40 animate-pulse" />
          ))}
        </div>
        <div className="border-r border-border/60 p-3 space-y-3">
          <div className="h-7 w-32 rounded-full bg-muted/40 animate-pulse" />
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/30 animate-pulse" />
          ))}
          <div className="h-10 rounded-md bg-muted/40 animate-pulse" />
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex h-9 items-center gap-2 border-b border-border/60 px-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-6 w-28 rounded-md bg-muted/40 animate-pulse" />
            ))}
          </div>
          <div className="flex-1 p-3 space-y-2">
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} className="h-3 rounded bg-muted/30 animate-pulse" style={{ width: `${30 + ((i * 7) % 60)}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
