/**
 * /gpts loading — Next App Router renders this instantly while the
 * real page.tsx mounts and fetches its data. Gives the user a visible
 * layout hint (header + grid of placeholder cards) the frame they
 * click, instead of a blank viewport.
 *
 * Kept deliberately lightweight (no data, no interactive widgets) so
 * parsing + paint cost is near-zero.
 */
export default function Loading() {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Header bar skeleton */}
      <div className="flex items-center justify-between border-b border-border/50 px-6 py-4">
        <div className="space-y-1.5">
          <div className="h-6 w-32 rounded bg-muted/60 animate-pulse" />
          <div className="h-3.5 w-48 rounded bg-muted/40 animate-pulse" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-52 rounded-md bg-muted/40 animate-pulse" />
          <div className="h-9 w-28 rounded-md bg-muted/60 animate-pulse" />
        </div>
      </div>

      {/* Grid skeleton */}
      <div className="flex-1 overflow-hidden p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-border/50 bg-card p-4 space-y-3"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-muted/60 animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-3/4 rounded bg-muted/60 animate-pulse" />
                  <div className="h-3 w-1/2 rounded bg-muted/40 animate-pulse" />
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="h-3 w-full rounded bg-muted/40 animate-pulse" />
                <div className="h-3 w-5/6 rounded bg-muted/40 animate-pulse" />
              </div>
              <div className="flex gap-2 pt-1">
                <div className="h-5 w-14 rounded-full bg-muted/50 animate-pulse" />
                <div className="h-5 w-16 rounded-full bg-muted/50 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
