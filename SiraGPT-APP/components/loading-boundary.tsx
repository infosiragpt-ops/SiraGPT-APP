"use client"

import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

interface LoadingBoundaryProps {
  children: React.ReactNode
  isLoading: boolean
  skeleton: React.ReactNode
  minDelay?: number
  className?: string
}

/**
 * LoadingBoundary — prevents UI flash (skeleton → content → skeleton)
 * by enforcing a minimum display time for each state.
 * 
 * Use for any component that fetches data asynchronously.
 */
export function LoadingBoundary({
  children,
  isLoading,
  skeleton,
  minDelay = 400,
  className,
}: LoadingBoundaryProps) {
  const [showSkeleton, setShowSkeleton] = useState(isLoading)
  const [showContent, setShowContent] = useState(!isLoading)

  useEffect(() => {
    if (isLoading) {
      setShowContent(false)
      setShowSkeleton(true)
    } else {
      // Delay showing content to prevent flash
      const timer = setTimeout(() => {
        setShowSkeleton(false)
        setShowContent(true)
      }, minDelay)
      return () => clearTimeout(timer)
    }
  }, [isLoading, minDelay])

  return (
    <div className={cn("relative", className)}>
      {showSkeleton && (
        <div className={cn(showContent ? "absolute inset-0 z-10" : "")}>
          {skeleton}
        </div>
      )}
      {showContent && (
        <div className={cn(showSkeleton ? "opacity-0" : "animate-in fade-in duration-300")}>
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * LoadingSpinner — a minimal spinner for inline usage.
 */
export function LoadingSpinner({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const sizeMap = { sm: "xs", md: "sm", lg: "md" } as const
  return <ThinkingIndicator size={sizeMap[size]} className={cn("inline-flex", className)} />
}
