"use client"

import { cn } from "@/lib/utils"

/**
 * Skeleton pulse — base component for all loading states.
 * Uses CSS-only animation to avoid JS overhead.
 */
export function SkeletonPulse({ 
  className, 
  style 
}: { 
  className?: string 
  style?: React.CSSProperties 
}) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-muted",
        className
      )}
      style={style}
    />
  )
}

/**
 * Chat area skeleton — shown while the initial chat loads.
 */
export function ChatSkeleton() {
  return (
    <div className="flex h-full flex-col">
      {/* Header skeleton */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-3">
          <SkeletonPulse className="h-8 w-8 rounded-full" />
          <div className="space-y-1.5">
            <SkeletonPulse className="h-4 w-32" />
            <SkeletonPulse className="h-3 w-20" />
          </div>
        </div>
        <SkeletonPulse className="h-8 w-8 rounded-md" />
      </div>

      {/* Messages skeleton */}
      <div className="flex-1 space-y-6 p-4">
        {/* Assistant message */}
        <div className="flex gap-3">
          <SkeletonPulse className="mt-1 h-7 w-7 shrink-0 rounded-full" />
          <div className="max-w-[80%] space-y-2.5">
            <SkeletonPulse className="h-4 w-64" />
            <SkeletonPulse className="h-4 w-52" />
            <SkeletonPulse className="h-4 w-72" />
          </div>
        </div>

        {/* User message */}
        <div className="flex justify-end">
          <div className="max-w-[70%] space-y-2.5">
            <SkeletonPulse className="h-4 w-56" />
            <SkeletonPulse className="h-4 w-40" />
          </div>
        </div>

        {/* Assistant message with code */}
        <div className="flex gap-3">
          <SkeletonPulse className="mt-1 h-7 w-7 shrink-0 rounded-full" />
          <div className="max-w-[80%] w-full space-y-2.5">
            <SkeletonPulse className="h-4 w-48" />
            <SkeletonPulse className="h-24 w-full rounded-lg" />
          </div>
        </div>

        {/* User message */}
        <div className="flex justify-end">
          <div className="max-w-[70%] space-y-2.5">
            <SkeletonPulse className="h-4 w-44" />
          </div>
        </div>
      </div>

      {/* Composer skeleton */}
      <div className="border-t border-border/50 p-4">
        <SkeletonPulse className="h-12 w-full rounded-xl" />
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-2">
            <SkeletonPulse className="h-8 w-8 rounded-md" />
            <SkeletonPulse className="h-8 w-8 rounded-md" />
            <SkeletonPulse className="h-8 w-8 rounded-md" />
          </div>
          <SkeletonPulse className="h-8 w-24 rounded-md" />
        </div>
      </div>
    </div>
  )
}

/**
 * Sidebar skeleton — shown while chat list loads.
 */
export function SidebarSkeleton() {
  return (
    <div className="flex h-full flex-col p-3">
      {/* New button */}
      <SkeletonPulse className="h-10 w-full rounded-lg mb-4" />
      
      {/* Section headers + items */}
      {[1, 2, 3].map((group) => (
        <div key={group} className="mb-4 space-y-2">
          <SkeletonPulse className="h-3 w-20" />
          {[1, 2, 3, 4].map((item) => (
            <SkeletonPulse key={item} className="h-8 w-full rounded-md" />
          ))}
        </div>
      ))}

      {/* Footer */}
      <div className="mt-auto pt-4 border-t border-border/50">
        <div className="flex items-center gap-2">
          <SkeletonPulse className="h-8 w-8 rounded-full" />
          <div className="space-y-1.5 flex-1">
            <SkeletonPulse className="h-3 w-24" />
            <SkeletonPulse className="h-2.5 w-16" />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Message streaming skeleton — shown while AI is generating.
 */
export function StreamingMessageSkeleton() {
  return (
    <div className="flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="relative mt-1">
        <div className="h-7 w-7 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500" />
        <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-500" />
        </span>
      </div>
      <div className="max-w-[80%] w-full space-y-2.5 pt-1">
        <SkeletonPulse className="h-3.5 w-3/4" />
        <SkeletonPulse className="h-3.5 w-1/2" />
        <SkeletonPulse className="h-3.5 w-2/3" />
      </div>
    </div>
  )
}

/**
 * Dashboard skeleton for admin pages.
 */
export function DashboardSkeleton() {
  return (
    <div className="space-y-6 p-6">
      {/* Stats row */}
      <div className="grid gap-4 md:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-xl border border-border/50 p-4 space-y-3">
            <SkeletonPulse className="h-4 w-20" />
            <SkeletonPulse className="h-8 w-16" />
            <SkeletonPulse className="h-3 w-28" />
          </div>
        ))}
      </div>

      {/* Charts area */}
      <div className="grid gap-4 lg:grid-cols-3">
        <SkeletonPulse className="lg:col-span-2 h-64 rounded-xl" />
        <SkeletonPulse className="h-64 rounded-xl" />
      </div>

      {/* Table */}
      <SkeletonPulse className="h-80 rounded-xl" />
    </div>
  )
}

/**
 * Page loading skeleton wrapper.
 */
export function PageSkeleton({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex h-full animate-in fade-in duration-300">
      <div className="hidden lg:block w-72 border-r border-border/50">
        <SidebarSkeleton />
      </div>
      <div className="flex-1 min-w-0">
        {children || <ChatSkeleton />}
      </div>
    </div>
  )
}
