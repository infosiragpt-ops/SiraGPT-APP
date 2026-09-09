"use client"

import * as React from "react"

import { MASCOT_GRID, getChatMascot, mascotRects } from "@/lib/chat-mascot"
import { cn } from "@/lib/utils"

type ChatMascotProps = {
  seed: string
  size?: number
  className?: string
  title?: string
}

function ChatMascotView({ seed, size = 16, className, title }: ChatMascotProps) {
  const spec = getChatMascot(seed)
  const rects = mascotRects(spec)

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${MASCOT_GRID} ${MASCOT_GRID}`}
      className={cn("shrink-0", className)}
      shapeRendering="crispEdges"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      data-testid="chat-mascot"
      data-mascot-species={spec.species}
      data-mascot-palette={spec.palette.name}
    >
      {title ? <title>{title}</title> : null}
      {rects.map((rect, index) => (
        <rect
          key={`${rect.x}-${rect.y}-${index}`}
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          fill={rect.color}
        />
      ))}
    </svg>
  )
}

export const ChatMascot = React.memo(ChatMascotView)
