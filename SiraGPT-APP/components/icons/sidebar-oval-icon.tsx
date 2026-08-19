"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type SidebarOvalIconProps = React.SVGProps<SVGSVGElement>

export function SidebarOvalIcon({ className, ...props }: SidebarOvalIconProps) {
  // Panel-left glyph (the Notion/Linear-style sidebar toggle): a crisp
  // rounded frame, a divider at the 1/3 mark, and a soft fill on the
  // sidebar pane so the icon reads "this side collapses" at a glance.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
      {...props}
    >
      <path
        d="M3.75 7.5a3 3 0 0 1 3-3H9.4v15H6.75a3 3 0 0 1-3-3v-9z"
        fill="currentColor"
        opacity="0.16"
      />
      <rect
        x="3.75"
        y="4.5"
        width="16.5"
        height="15"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M9.4 4.5v15"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  )
}

export default SidebarOvalIcon
