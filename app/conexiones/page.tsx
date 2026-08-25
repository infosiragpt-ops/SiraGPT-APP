"use client"

import { useState } from "react"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { GptsAppsSection } from "@/components/gpts/gpts-apps-section"

export default function ConexionesPage() {
  const [searchQuery, setSearchQuery] = useState("")

  return (
    <main data-testid="connect-apps-page" className="min-h-full bg-white dark:bg-background text-zinc-950 dark:text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-[1220px] flex-col px-6 py-4 sm:px-8 lg:px-12">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[1.25rem] font-medium tracking-[-0.04em] text-zinc-950 dark:text-zinc-50">Apps</h1>
            <p className="mt-0.5 text-[0.88rem] text-zinc-400 dark:text-zinc-500">
              Conecta las aplicaciones que SiraGPT puede usar
            </p>
          </div>
        </header>

        <section className="mx-auto mt-5 w-full max-w-[640px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              data-testid="connect-apps-search"
              placeholder="Buscar apps"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-10 rounded-xl border-zinc-200 bg-white pl-11 text-[0.94rem] text-zinc-900 shadow-none placeholder:text-zinc-400 focus-visible:ring-1 focus-visible:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus-visible:ring-zinc-600"
            />
          </div>
        </section>

        <GptsAppsSection searchQuery={searchQuery} showAll hideHeading />
      </div>
    </main>
  )
}
