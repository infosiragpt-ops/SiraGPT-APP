import { Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"

function PulseBlock({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-muted/70", className)} />
}

export default function ParafraseoLoading() {
  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border bg-card shadow-sm">
            <Sparkles className="h-4 w-4 text-teal-500" />
          </div>
          <div>
            <PulseBlock className="h-4 w-28" />
            <PulseBlock className="mt-2 h-3 w-44" />
          </div>
        </div>
        <PulseBlock className="h-9 w-36 rounded-full" />
      </header>

      <div className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-5">
        {Array.from({ length: 8 }).map((_, index) => (
          <PulseBlock key={index} className="h-7 w-20 shrink-0 rounded-full" />
        ))}
      </div>

      <section className="grid min-h-0 flex-1 grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="space-y-4 p-6">
          <PulseBlock className="h-5 w-48" />
          <PulseBlock className="h-64 w-full" />
        </div>
        <div className="space-y-4 p-6">
          <PulseBlock className="h-5 w-56" />
          <PulseBlock className="h-64 w-full" />
        </div>
      </section>
    </main>
  )
}
