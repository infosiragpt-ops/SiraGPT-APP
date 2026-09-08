"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface AccessibleIconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name and default native tooltip for the icon-only action. */
  label: string
}

/**
 * Shared icon-only control for chat surfaces.
 *
 * Mobile gets a 44×44px target; pointer-oriented desktop layouts keep the
 * compact 32×32px rhythm. Consumers can add positioning/color classes while
 * preserving keyboard focus and a programmatic accessible name.
 */
export const AccessibleIconButton = React.forwardRef<
  HTMLButtonElement,
  AccessibleIconButtonProps
>(function AccessibleIconButton(
  { label, title, type = "button", className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cn(
        "inline-grid h-11 w-11 shrink-0 place-items-center rounded-full",
        "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2",
        "disabled:pointer-events-none disabled:opacity-50 sm:h-8 sm:w-8",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
})
