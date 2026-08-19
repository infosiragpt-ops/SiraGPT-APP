"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type SidebarOvalIconProps = React.SVGProps<SVGSVGElement>

export function SidebarOvalIcon({ className, ...props }: SidebarOvalIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
      {...props}
    >
      <rect
        x="4.25"
        y="3.25"
        width="15.5"
        height="17.5"
        rx="5.25"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <path
        d="M10.2 4.35V19.65"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default SidebarOvalIcon
