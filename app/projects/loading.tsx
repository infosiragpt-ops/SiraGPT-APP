/**
 * /projects loading — same pattern as /gpts. Thin skeleton that
 * matches the final layout's proportions so the LCP stays stable.
 */
export default function Loading() {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border/50 px-6 py-4">
        <div className="space-y-1.5">
          <div className="h-6 w-32 rounded bg-muted/60 animate-pulse" />
          <div className="h-3.5 w-56 rounded bg-muted/40 animate-pulse" />
        </div>
        <div className="h-9 w-32 rounded-md bg-muted/60 animate-pulse" />
      </div>
      <div className="flex-1 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-border/50 bg-card p-5 space-y-3"
            >
              <div className="flex items-start justify-between">
                <div className="h-9 w-9 rounded-lg bg-muted/60 animate-pulse" />
                <div className="h-5 w-12 rounded-full bg-muted/40 animate-pulse" />
              </div>
              <div className="h-5 w-3/4 rounded bg-muted/60 animate-pulse" />
              <div className="h-3 w-full rounded bg-muted/40 animate-pulse" />
              <div className="h-3 w-4/5 rounded bg-muted/40 animate-pulse" />
              <div className="flex justify-between pt-2">
                <div className="h-3 w-24 rounded bg-muted/30 animate-pulse" />
                <div className="h-3 w-14 rounded bg-muted/30 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
