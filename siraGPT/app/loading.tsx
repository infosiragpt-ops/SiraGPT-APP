// ──────────────────────────────────────────────────────────────
// siraGPT — Loading State (Suspense Fallback)
// ──────────────────────────────────────────────────────────────
// Next.js wraps page content in React Suspense automatically
// when this file exists. Shown during streaming SSR or when
// async server components are resolving.
//
// The layout mirrors the chat shell (sidebar rail + canvas) so
// the transition into the real UI feels instantaneous instead of
// "spinner → content jolt". Skeleton lines pulse on the premium
// shimmer curve defined in globals.css and respect
// prefers-reduced-motion.
// ──────────────────────────────────────────────────────────────

export default function Loading() {
  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Sidebar ghost — hidden on small viewports, matches the real
          sidebar's 264px width on md+ */}
      <aside
        aria-hidden
        className="hidden md:flex w-[260px] shrink-0 flex-col gap-3 border-r border-border/40 bg-sidebar/40 p-3"
      >
        <div className="h-9 w-full premium-shimmer rounded-lg" />
        <div className="mt-2 space-y-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-7 w-full premium-shimmer rounded-md"
              style={{ animationDelay: `${i * 0.06}s`, opacity: 1 - i * 0.1 }}
            />
          ))}
        </div>
      </aside>

      {/* Main canvas ghost */}
      <main className="flex flex-1 flex-col">
        {/* Top bar ghost */}
        <div className="flex h-14 items-center justify-between border-b border-border/30 px-4">
          <div className="h-8 w-40 premium-shimmer rounded-lg" />
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 premium-shimmer rounded-full" />
            <div className="h-8 w-8 premium-shimmer rounded-full" />
          </div>
        </div>

        {/* Content area — center column, generous breathing */}
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-10">
          <div className="mb-8 flex items-center gap-2 opacity-70">
            <div className="h-7 w-7 rounded-full premium-shimmer" />
            <div className="h-3 w-20 rounded premium-shimmer" />
          </div>
          <div className="h-9 w-72 max-w-full rounded-lg premium-shimmer" />
          <div className="mt-3 h-4 w-60 max-w-full rounded premium-shimmer" />

          <div className="mt-10 grid w-full max-w-2xl grid-cols-2 gap-2 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-12 w-full rounded-2xl premium-shimmer"
                style={{ animationDelay: `${i * 0.05}s` }}
              />
            ))}
          </div>
        </div>

        {/* Composer ghost — pinned at the bottom, matches the real
            composer's pill shape and width */}
        <div className="mx-auto w-full max-w-3xl px-4 pb-6">
          <div className="h-14 w-full rounded-3xl premium-shimmer" />
        </div>
      </main>

      {/* Accessible label for screen readers */}
      <span role="status" aria-live="polite" className="sr-only">
        Cargando…
      </span>
    </div>
  )
}
