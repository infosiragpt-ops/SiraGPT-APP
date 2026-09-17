"use client"

import * as React from "react"

import type { AgentOfficeModel, AgentOfficeWorker } from "@/lib/agent-office-model"
import { cn } from "@/lib/utils"

import { AgentOfficeScene } from "./agent-office-scene"

const LIVE_PREVIEW_MARK = "20260815"

type Seat = {
  name: string
  initial: string
  active: boolean
  tone: "idle" | "active" | "ready" | "attention"
  phase: number
}

const TONE_FILL: Record<Seat["tone"], string> = {
  idle: "#94a3b8",
  active: "#38bdf8",
  ready: "#34d399",
  attention: "#f59e0b",
}

function seatsFromModel(model: AgentOfficeModel): Seat[] {
  const workers: AgentOfficeWorker[] = model.workers?.length
    ? model.workers
    : model.departments.flatMap((department) => department.workers)
  const seats: Seat[] = workers.slice(0, 8).map((worker, index) => ({
    name: worker.name || "Agente",
    initial: (worker.name || "A").slice(0, 1).toUpperCase(),
    active: Boolean(worker.active || worker.statusTone === "active"),
    tone: worker.statusTone,
    phase: index * 0.73,
  }))
  const fillers = ["A", "L", "M", "S", "R", "N", "P", "D"]
  while (seats.length < 6) {
    const index = seats.length
    seats.push({
      name: "Agente",
      initial: fillers[index] || "A",
      active: true,
      tone: index % 3 === 0 ? "ready" : "active",
      phase: index * 0.73,
    })
  }
  return seats
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function drawDesk(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  seat: Seat,
  time: number,
  motion: boolean,
) {
  const type = motion ? Math.sin(time * 11 + seat.phase) : 0
  const bob = motion ? Math.sin(time * 2.1 + seat.phase) * 0.7 : 0
  const glow = motion ? (Math.sin(time * 3.4 + seat.phase) + 1) / 2 : 0.55
  const fill = TONE_FILL[seat.active ? (seat.tone === "idle" ? "active" : seat.tone) : seat.tone]

  ctx.save()
  ctx.translate(x, y)

  ctx.fillStyle = "rgba(15, 23, 42, 0.92)"
  roundRect(ctx, -11 * scale, 10 * scale, 22 * scale, 9 * scale, 3 * scale)
  ctx.fill()

  ctx.fillStyle = "#1b2a3d"
  roundRect(ctx, -20 * scale, 4 * scale, 40 * scale, 7 * scale, 2 * scale)
  ctx.fill()
  ctx.fillStyle = "rgba(56, 189, 248, 0.16)"
  roundRect(ctx, -19 * scale, 4.2 * scale, 38 * scale, 1.4 * scale, 1 * scale)
  ctx.fill()

  const screenPulse = 0.35 + glow * 0.55
  for (const offset of [-8.2, 8.2]) {
    ctx.fillStyle = "#0b1220"
    roundRect(ctx, (offset - 7.2) * scale, -14 * scale, 14.4 * scale, 11 * scale, 1.4 * scale)
    ctx.fill()
    ctx.fillStyle = `rgba(56, 189, 248, ${0.18 + screenPulse * 0.42})`
    roundRect(ctx, (offset - 6.2) * scale, -13 * scale, 12.4 * scale, 9 * scale, 1 * scale)
    ctx.fill()
    ctx.fillStyle = `rgba(186, 230, 253, ${0.35 + screenPulse * 0.4})`
    for (let line = 0; line < 4; line += 1) {
      const width = (7 + ((line + Math.floor(time + seat.phase)) % 3) * 1.4) * scale
      ctx.fillRect((offset - 5.2) * scale, (-11.4 + line * 1.8) * scale, width, 0.7 * scale)
    }
  }

  ctx.fillStyle = fill
  ctx.globalAlpha = 0.92
  roundRect(ctx, -5.2 * scale, (-1 + bob) * scale, 10.4 * scale, 10 * scale, 2.4 * scale)
  ctx.fill()
  ctx.globalAlpha = 1

  ctx.beginPath()
  ctx.fillStyle = fill
  ctx.arc(0, (-6.2 + bob) * scale, 4.3 * scale, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = "rgba(8, 15, 24, 0.88)"
  ctx.font = `600 ${Math.max(6, 5.2 * scale)}px ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(seat.initial, 0, (-6.1 + bob) * scale)

  ctx.strokeStyle = fill
  ctx.lineWidth = 1.7 * scale
  ctx.lineCap = "round"
  ctx.beginPath()
  ctx.moveTo(-4.6 * scale, (2 + bob) * scale)
  ctx.lineTo((-9 + type * 1.6) * scale, 6.2 * scale)
  ctx.moveTo(4.6 * scale, (2 + bob) * scale)
  ctx.lineTo((9 - type * 1.6) * scale, 6.2 * scale)
  ctx.stroke()

  ctx.fillStyle = `rgba(125, 211, 252, ${0.12 + glow * 0.22})`
  roundRect(ctx, -8 * scale, 6.4 * scale, 16 * scale, 2.1 * scale, 0.8 * scale)
  ctx.fill()

  ctx.restore()
}

function paintOffice(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  seats: readonly Seat[],
  motion: boolean,
) {
  const swayX = motion ? Math.sin(time * 0.17) * 2.2 : 0
  const swayY = motion ? Math.cos(time * 0.13) * 1.1 : 0

  const sky = ctx.createLinearGradient(0, 0, 0, height)
  sky.addColorStop(0, "#10233a")
  sky.addColorStop(0.38, "#0b1726")
  sky.addColorStop(1, "#05070d")
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.translate(swayX, swayY)

  const windowTop = height * 0.05
  const windowHeight = height * 0.3
  const paneGap = width * 0.018
  const paneWidth = (width - paneGap * 4) / 3
  for (let pane = 0; pane < 3; pane += 1) {
    const x = paneGap + pane * (paneWidth + paneGap)
    const city = ctx.createLinearGradient(0, windowTop, 0, windowTop + windowHeight)
    city.addColorStop(0, "#1d3a58")
    city.addColorStop(1, "#0c1a2b")
    ctx.fillStyle = city
    roundRect(ctx, x, windowTop, paneWidth, windowHeight, 4)
    ctx.fill()
    ctx.fillStyle = "rgba(125, 211, 252, 0.08)"
    ctx.fillRect(x, windowTop, paneWidth, 3)

    for (let building = 0; building < 5; building += 1) {
      const bx = x + 6 + building * (paneWidth / 5.2)
      const bh = windowHeight * (0.28 + ((pane * 3 + building) % 5) * 0.1)
      const by = windowTop + windowHeight - bh - 4
      ctx.fillStyle = "rgba(8, 16, 28, 0.72)"
      ctx.fillRect(bx, by, paneWidth / 6.4, bh)
      for (let wy = 0; wy < 4; wy += 1) {
        const on = motion
          ? (Math.sin(time * 1.3 + pane * 2 + building + wy) + 1) / 2 > 0.35
          : wy % 2 === 0
        if (!on) continue
        ctx.fillStyle = `rgba(253, 230, 138, ${0.35 + ((building + wy) % 3) * 0.15})`
        ctx.fillRect(bx + 2, by + 4 + wy * (bh / 4.6), 3.2, 2.1)
      }
    }
  }

  const floorTop = height * 0.4
  const floor = ctx.createLinearGradient(0, floorTop, 0, height)
  floor.addColorStop(0, "#153047")
  floor.addColorStop(1, "#070b12")
  ctx.fillStyle = floor
  ctx.beginPath()
  ctx.moveTo(width * 0.04, floorTop)
  ctx.lineTo(width * 0.96, floorTop)
  ctx.lineTo(width, height)
  ctx.lineTo(0, height)
  ctx.closePath()
  ctx.fill()

  ctx.strokeStyle = "rgba(56, 189, 248, 0.08)"
  ctx.lineWidth = 1
  for (let i = 0; i < 6; i += 1) {
    const y = floorTop + (height - floorTop) * (0.12 + i * 0.14)
    ctx.beginPath()
    ctx.moveTo(width * (0.06 + i * 0.012), y)
    ctx.lineTo(width * (0.94 - i * 0.012), y)
    ctx.stroke()
  }

  for (const lx of [0.22, 0.5, 0.78]) {
    const pulse = motion ? 0.16 + (Math.sin(time * 1.7 + lx * 8) + 1) * 0.05 : 0.2
    const lamp = ctx.createRadialGradient(width * lx, floorTop + 8, 4, width * lx, floorTop + 18, width * 0.22)
    lamp.addColorStop(0, `rgba(186, 230, 253, ${pulse})`)
    lamp.addColorStop(1, "rgba(186, 230, 253, 0)")
    ctx.fillStyle = lamp
    ctx.fillRect(width * (lx - 0.22), floorTop, width * 0.44, height * 0.55)
  }

  const cols = Math.min(4, Math.max(3, Math.ceil(seats.length / 2)))
  seats.forEach((seat, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const depth = row === 0 ? 0.78 : 1
    const y = floorTop + height * (row === 0 ? 0.14 : 0.36)
    const spread = width * (row === 0 ? 0.78 : 0.86)
    const x0 = (width - spread) / 2
    const x = x0 + (col + 0.5) * (spread / cols)
    drawDesk(ctx, x, y, depth * (height / 148), seat, time, motion)
  })

  ctx.restore()
}

export function OfficeLivePreview({
  model,
  paused = false,
  className,
}: {
  model: AgentOfficeModel
  paused?: boolean
  className?: string
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const seats = React.useMemo(() => seatsFromModel(model), [model])
  const [sceneReady, setSceneReady] = React.useState(false)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let frame = 0
    let running = true
    const started = performance.now()
    const reduceMotion =
      typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

    const draw = (now: number) => {
      if (!running) return
      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const nextWidth = Math.round(width * dpr)
      const nextHeight = Math.round(height * dpr)
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth
        canvas.height = nextHeight
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const motion = !paused && !reduceMotion && document.visibilityState === "visible"
      paintOffice(ctx, width, height, (now - started) / 1000, seats, motion)
      if (motion) frame = window.requestAnimationFrame(draw)
    }

    frame = window.requestAnimationFrame(draw)
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !paused) {
        frame = window.requestAnimationFrame(draw)
      }
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      running = false
      window.cancelAnimationFrame(frame)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [paused, seats])

  return (
    <div
      className={cn("relative h-full w-full overflow-hidden bg-[#05070d]", className)}
      data-office-live-preview={LIVE_PREVIEW_MARK}
      data-testid="agent-office-live-preview"
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        aria-hidden
        data-office-live-preview-canvas={LIVE_PREVIEW_MARK}
      />
      <div
        className={cn(
          "absolute inset-0 transition-opacity duration-500",
          sceneReady ? "opacity-100" : "opacity-0",
        )}
      >
        <AgentOfficeScene
          model={model}
          variant="thumbnail"
          closeUp
          paused={paused}
          className="h-full w-full"
          onReady={() => setSceneReady(true)}
        />
      </div>
      <span
        className="pointer-events-none absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full border border-emerald-300/25 bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-100 shadow-[0_0_12px_rgba(16,185,129,0.28)]"
        data-office-live-badge="1"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />
        En vivo
      </span>
    </div>
  )
}
