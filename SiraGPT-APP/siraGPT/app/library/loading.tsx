/**
 * /library loading — biblioteca de medios. Square-tile skeleton
 * matching the gallery's masonry feel.
 */
export default function Loading() {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="border-b border-border/50 px-6 py-4">
        <div className="space-y-1.5">
          <div className="h-6 w-32 rounded bg-muted/60 animate-pulse" />
          <div className="h-3.5 w-52 rounded bg-muted/40 animate-pulse" />
        </div>
      </div>
      <div className="flex-1 p-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 15 }).map((_, i) => (
            <div
              key={i}
              className="aspect-square rounded-lg bg-muted/40 animate-pulse"
            />
          ))}
        </div>
      </div>
    </div>
  )
}
