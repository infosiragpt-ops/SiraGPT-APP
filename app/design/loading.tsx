/**
 * /design loading — matches the design-studio grid layout
 * (sidebar-less full-width grid of design cards).
 */
export default function Loading() {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="border-b border-border/50 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <div className="h-6 w-28 rounded bg-muted/60 animate-pulse" />
            <div className="h-3.5 w-40 rounded bg-muted/40 animate-pulse" />
          </div>
          <div className="h-9 w-36 rounded-md bg-muted/60 animate-pulse" />
        </div>
      </div>
      <div className="flex-1 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-border/50 bg-card">
              <div className="aspect-video bg-muted/40 animate-pulse" />
              <div className="p-3 space-y-2">
                <div className="h-4 w-3/4 rounded bg-muted/60 animate-pulse" />
                <div className="h-3 w-1/2 rounded bg-muted/40 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
