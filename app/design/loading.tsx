/**
 * /design loading — mirrors the real design studio layout so the
 * route paints a useful shell immediately while client chunks hydrate.
 */
export default function Loading() {
  return (
    <div className="min-h-screen bg-[#FAF7F2] dark:bg-background">
      <div className="mx-auto max-w-[1600px] px-4 sm:px-6 md:px-8 py-6 md:py-8">
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-10">
          <div className="w-full lg:w-80 shrink-0 space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-full bg-muted/50 animate-pulse" />
              <div className="space-y-2">
                <div className="h-5 w-36 rounded bg-muted/60 animate-pulse" />
                <div className="h-3 w-24 rounded bg-muted/40 animate-pulse" />
              </div>
            </div>
            <div className="rounded-xl border border-border/60 bg-card p-4">
              <div className="mb-4 flex gap-4 border-b border-border/60 pb-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
                ))}
              </div>
              <div className="space-y-3">
                <div className="h-4 w-28 rounded bg-muted/60 animate-pulse" />
                <div className="h-9 w-full rounded-md bg-muted/50 animate-pulse" />
                <div className="grid grid-cols-2 gap-2">
                  <div className="h-28 rounded-lg bg-muted/40 animate-pulse" />
                  <div className="h-28 rounded-lg bg-muted/40 animate-pulse" />
                </div>
                <div className="h-10 w-full rounded-md bg-muted/60 animate-pulse" />
              </div>
            </div>
            <div className="h-28 rounded-xl border border-border/60 bg-card animate-pulse" />
          </div>
          <div className="hidden lg:block w-px bg-border/50 self-stretch" />
          <div className="min-w-0 flex-1">
            <div className="mb-5 flex items-center justify-between gap-4 border-b border-border/60 pb-2">
              <div className="flex gap-6">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-5 w-24 rounded bg-muted/50 animate-pulse" />
                ))}
              </div>
              <div className="h-8 w-60 rounded-full bg-muted/50 animate-pulse" />
            </div>
            <div className="mb-4 h-8 w-48 rounded-full bg-muted/50 animate-pulse" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="overflow-hidden rounded-xl border border-border/60 bg-card">
                  <div className="aspect-video bg-muted/40 animate-pulse" />
                  <div className="space-y-2 px-4 py-3">
                    <div className="h-3 w-1/2 rounded bg-muted/50 animate-pulse" />
                    <div className="h-2 w-1/3 rounded bg-muted/40 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
