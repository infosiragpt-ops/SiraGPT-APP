"use client"

import * as React from "react"
import {
  Code2,
  FolderKanban,
  Images,
  LayoutGrid,
  Palette,
  Search,
  Sparkles,
} from "lucide-react"

import { useNavigationTransition } from "@/components/navigation-transition-context"
import { cn } from "@/lib/utils"

type RouteMeta = {
  title: string
  subtitle: string
  icon: React.ComponentType<{ className?: string }>
}

const ROUTE_META: Record<string, RouteMeta> = {
  "/library": {
    title: "Biblioteca",
    subtitle: "Preparando tus archivos y recursos",
    icon: Images,
  },
  "/gpts": {
    title: "GPTs",
    subtitle: "Cargando asistentes y modelos personalizados",
    icon: LayoutGrid,
  },
  "/parafraseo": {
    title: "Parafraseo",
    subtitle: "Activando el editor profesional",
    icon: Sparkles,
  },
  "/projects": {
    title: "Empresas",
    subtitle: "Organizando espacios e instrucciones",
    icon: FolderKanban,
  },
  "/design": {
    title: "Diseño",
    subtitle: "Preparando el estudio visual",
    icon: Palette,
  },
  "/code": {
    title: "Código",
    subtitle: "Abriendo el workspace de desarrollo",
    icon: Code2,
  },
}

export function RouteTransitionShell({
  children,
}: {
  children: React.ReactNode
}) {
  const { pendingHref, pendingLabel, isTransitioning } =
    useNavigationTransition()

  if (!isTransitioning || !pendingHref) {
    return <>{children}</>
  }

  const meta = ROUTE_META[pendingHref] ?? {
    title: pendingLabel || "Cargando",
    subtitle: "Preparando la vista",
    icon: Search,
  }

  return (
    <TransitionSkeleton
      route={pendingHref}
      title={pendingLabel || meta.title}
      subtitle={meta.subtitle}
      Icon={meta.icon}
    />
  )
}

function TransitionSkeleton({
  route,
  title,
  subtitle,
  Icon,
}: {
  route: string
  title: string
  subtitle: string
  Icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <main className="min-h-screen w-full overflow-hidden bg-background">
      <div className="mx-auto flex h-full min-h-screen w-full max-w-5xl flex-col px-6 py-7">
        <header className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border bg-card shadow-sm">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-lg font-semibold tracking-tight text-foreground">
              {title}
            </p>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </header>

        <div className="mt-8 flex-1">
          {route === "/parafraseo" ? (
            <ParaphraseSkeleton />
          ) : route === "/code" ? (
            <CodeSkeleton />
          ) : route === "/gpts" ? (
            <GptsSkeleton />
          ) : route === "/projects" ? (
            <ProjectsSkeleton />
          ) : route === "/design" ? (
            <DesignSkeleton />
          ) : (
            <LibrarySkeleton />
          )}
        </div>
      </div>
    </main>
  )
}

function PulseBlock({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-muted/70", className)} />
}

function GptsSkeleton() {
  return (
    <div className="space-y-7">
      <PulseBlock className="h-11 w-full max-w-2xl rounded-2xl" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 5 }).map((_, index) => (
          <PulseBlock key={index} className="h-8 w-28 shrink-0 rounded-full" />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-4 rounded-2xl border bg-card/60 p-4"
          >
            <PulseBlock className="h-14 w-14 rounded-full" />
            <div className="flex-1 space-y-2">
              <PulseBlock className="h-4 w-1/2" />
              <PulseBlock className="h-3 w-4/5" />
              <PulseBlock className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <PulseBlock className="h-5 w-5 rounded-full" />
            <div className="flex-1 space-y-2">
              <PulseBlock className="h-4 w-1/2" />
              <PulseBlock className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ParaphraseSkeleton() {
  return (
    <div className="flex h-[calc(100vh-150px)] flex-col">
      <div className="flex gap-2 border-b pb-3">
        {Array.from({ length: 7 }).map((_, index) => (
          <PulseBlock key={index} className="h-8 w-24 rounded-full" />
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 divide-y border-b md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="space-y-4 p-6">
          <PulseBlock className="h-5 w-48" />
          <PulseBlock className="h-40 w-full" />
        </div>
        <div className="space-y-4 p-6">
          <PulseBlock className="h-5 w-56" />
          <PulseBlock className="h-40 w-full" />
        </div>
      </div>
    </div>
  )
}

function ProjectsSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <PulseBlock className="h-12 w-52" />
        <PulseBlock className="h-11 w-40 rounded-2xl" />
      </div>
      <PulseBlock className="h-12 w-full rounded-2xl" />
      <div className="flex justify-end">
        <PulseBlock className="h-10 w-56 rounded-2xl" />
      </div>
      <div className="flex flex-col items-center justify-center py-24">
        <PulseBlock className="h-16 w-16 rounded-full" />
        <PulseBlock className="mt-6 h-6 w-56" />
        <PulseBlock className="mt-3 h-4 w-80 max-w-full" />
        <PulseBlock className="mt-8 h-12 w-48 rounded-2xl" />
      </div>
    </div>
  )
}

function DesignSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <PulseBlock className="h-56 rounded-2xl" />
        <PulseBlock className="h-56 rounded-2xl" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <PulseBlock key={index} className="h-40 rounded-2xl" />
        ))}
      </div>
    </div>
  )
}

function CodeSkeleton() {
  return (
    <div className="grid h-[calc(100vh-150px)] min-h-[560px] grid-cols-1 overflow-hidden rounded-2xl border lg:grid-cols-[minmax(240px,0.9fr)_240px_minmax(360px,1.1fr)]">
      <div className="flex flex-col border-r p-4">
        <PulseBlock className="h-8 w-36" />
        <div className="mt-auto space-y-3">
          <PulseBlock className="h-28 w-full rounded-2xl" />
          <PulseBlock className="h-10 w-full rounded-full" />
        </div>
      </div>
      <div className="space-y-2 border-r p-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <PulseBlock key={index} className="h-8 w-full rounded-lg" />
        ))}
      </div>
      <div className="space-y-3 p-4">
        <PulseBlock className="h-8 w-48" />
        <PulseBlock className="h-[460px] w-full rounded-xl" />
      </div>
    </div>
  )
}

function LibrarySkeleton() {
  return (
    <div className="space-y-6">
      <PulseBlock className="h-12 w-full rounded-2xl" />
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="rounded-2xl border bg-card/60 p-4">
            <PulseBlock className="h-36 w-full rounded-xl" />
            <PulseBlock className="mt-4 h-4 w-2/3" />
            <PulseBlock className="mt-2 h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  )
}
