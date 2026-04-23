export default function Loading() {
  return (
    <div className="flex h-[calc(100vh-0px)] w-full flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-muted/60 animate-pulse" />
          <div className="space-y-1.5">
            <div className="h-3 w-52 rounded bg-muted/40 animate-pulse" />
            <div className="h-4 w-72 rounded bg-muted/60 animate-pulse" />
          </div>
        </div>
        <div className="h-5 w-44 rounded-full bg-muted/40 animate-pulse" />
      </header>
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[360px_1fr_420px]">
        <aside className="border-r border-border/60 bg-card p-4 space-y-4">
          <div className="h-3 w-20 rounded bg-muted/40 animate-pulse" />
          <div className="h-28 rounded-md bg-muted/40 animate-pulse" />
          <div className="h-3 w-16 rounded bg-muted/40 animate-pulse" />
          <div className="grid grid-cols-6 gap-1.5">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-7 rounded-md bg-muted/40 animate-pulse" />
            ))}
          </div>
          <div className="h-9 rounded-md bg-muted/60 animate-pulse" />
        </aside>
        <main className="p-6 space-y-5">
          <div className="h-24 rounded-md bg-muted/30 animate-pulse" />
          <div className="grid grid-cols-5 gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />
            ))}
          </div>
          <div className="h-10 rounded-md bg-muted/60 animate-pulse" />
        </main>
        <aside className="border-l border-border/60 bg-muted/10 p-4">
          <div className="h-3 w-24 rounded bg-muted/40 animate-pulse mb-3" />
          <div className="rounded-xl border border-border/60 bg-background p-3 space-y-3">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-full bg-muted/60 animate-pulse" />
              <div className="flex-1 space-y-1">
                <div className="h-3 w-24 rounded bg-muted/40 animate-pulse" />
                <div className="h-2 w-16 rounded bg-muted/30 animate-pulse" />
              </div>
            </div>
            <div className="aspect-square rounded-md bg-muted/40 animate-pulse" />
          </div>
        </aside>
      </div>
    </div>
  )
}
