/**
 * /auth/reset loading — chrome skeleton (not the generic app spinner).
 */
export default function Loading() {
  return (
    <div
      className="flex min-h-[50vh] w-full flex-col items-center justify-center bg-background p-6"
      role="status"
      aria-live="polite"
      aria-label="Cargando el restablecimiento"
    >
      <div className="w-full max-w-md space-y-4">
        <div className="h-7 w-40 rounded bg-muted/50 animate-pulse" />
        <div className="h-4 w-64 rounded bg-muted/40 animate-pulse" />
        <div className="space-y-3 rounded-xl border border-border/50 bg-card p-5">
          <div className="h-10 rounded-md bg-muted/40 animate-pulse" />
          <div className="h-10 rounded-md bg-muted/35 animate-pulse" />
          <div className="h-10 w-28 rounded-md bg-muted/50 animate-pulse" />
        </div>
      </div>
    </div>
  )
}
