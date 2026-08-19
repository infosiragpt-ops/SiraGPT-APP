"use client"

import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"

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
  const sizeClasses = {
    sm: "h-4 w-4 border-2",
    md: "h-6 w-6 border-[2.5px]",
    lg: "h-10 w-10 border-[3px]",
  }

  return (
    <div
      className={cn(
        "inline-block animate-spin rounded-full border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]",
        sizeClasses[size],
        className
      )}
      role="status"
    >
      <span className="!absolute !-m-px !h-px !w-px !overflow-hidden !whitespace-nowrap !border-0 !p-0 ![clip:rect(0,0,0,0)]">
        Loading...
      </span>
    </div>
  )
}
