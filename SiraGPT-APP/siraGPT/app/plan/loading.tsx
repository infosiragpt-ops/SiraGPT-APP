export default function Loading() {
  return (
    <div className="flex h-full w-full">
      <aside className="w-[380px] shrink-0 border-r border-border/60 bg-card">
        <div className="border-b border-border/60 px-4 py-3 space-y-1.5">
          <div className="h-3 w-32 rounded bg-muted/40 animate-pulse" />
          <div className="h-5 w-44 rounded bg-muted/60 animate-pulse" />
        </div>
        <div className="p-4 space-y-3">
          <div className="h-24 rounded-md bg-muted/40 animate-pulse" />
          <div className="h-32 rounded-md bg-muted/30 animate-pulse" />
        </div>
      </aside>
      <main className="flex-1 bg-muted/5" />
    </div>
  )
}
