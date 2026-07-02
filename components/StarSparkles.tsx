"use client"

import { useEffect, useRef } from "react"

/**
 * StarSparkles — capa decorativa de destellos azulinos.
 *
 * Pequeñas estrellas de cuatro puntas que siguen el cursor al moverse
 * (desktop) y estallan al tocar la pantalla (móvil). Sutil a propósito:
 * pocas partículas, tonos azules, canvas fijo que no captura eventos y
 * desactivado cuando el usuario prefiere movimiento reducido.
 */

const PALETTE = ["#2563eb", "#3b82f6", "#60a5fa", "#93c5fd"]
const MAX_STARS = 80
const TRAIL_SPACING = 26 // px de recorrido del puntero entre destellos
const TAP_BURST = 6

type Star = {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  rotation: number
  spin: number
  born: number
  life: number
  color: string
}

export function StarSparkles() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const stars: Star[] = []
    let raf = 0
    let running = false
    let lastFrame = 0
    let lastSpawnX = 0
    let lastSpawnY = 0
    let hasLastSpawn = false

    function resize() {
      if (!canvas || !ctx) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(window.innerWidth * dpr)
      canvas.height = Math.floor(window.innerHeight * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function spawnStar(x: number, y: number, burst: boolean) {
      if (stars.length >= MAX_STARS) stars.shift()
      const angle = Math.random() * Math.PI * 2
      const speed = burst ? 30 + Math.random() * 60 : 6 + Math.random() * 10
      stars.push({
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (burst ? 10 : 14),
        size: burst ? 5 + Math.random() * 6 : 4 + Math.random() * 5,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 2.4,
        born: performance.now(),
        life: 550 + Math.random() * 400,
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      })
      if (!running) {
        running = true
        lastFrame = performance.now()
        raf = requestAnimationFrame(frame)
      }
    }

    function drawStar(s: Star, now: number): boolean {
      if (!ctx) return false
      const p = (now - s.born) / s.life
      if (p >= 1) return false
      const appear = Math.min(1, p / 0.18)
      const easeIn = 1 - Math.pow(1 - appear, 3)
      const alpha = easeIn * (1 - Math.pow(p, 1.8)) * 0.85
      const scale = easeIn * (1 - 0.45 * p)
      const r = s.size
      ctx.save()
      ctx.translate(s.x, s.y)
      ctx.rotate(s.rotation + s.spin * p)
      ctx.scale(scale, scale)
      ctx.globalAlpha = alpha
      ctx.fillStyle = s.color
      ctx.shadowColor = s.color
      ctx.shadowBlur = 8
      ctx.beginPath()
      ctx.moveTo(0, -r)
      ctx.quadraticCurveTo(0, 0, r, 0)
      ctx.quadraticCurveTo(0, 0, 0, r)
      ctx.quadraticCurveTo(0, 0, -r, 0)
      ctx.quadraticCurveTo(0, 0, 0, -r)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
      return true
    }

    function frame(now: number) {
      if (!ctx) return
      const dt = Math.min((now - lastFrame) / 1000, 0.05)
      lastFrame = now
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
      for (let i = stars.length - 1; i >= 0; i--) {
        const s = stars[i]
        s.x += s.vx * dt
        s.y += s.vy * dt
        if (!drawStar(s, now)) stars.splice(i, 1)
      }
      if (stars.length > 0) {
        raf = requestAnimationFrame(frame)
      } else {
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
        running = false
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (!hasLastSpawn) {
        hasLastSpawn = true
        lastSpawnX = e.clientX
        lastSpawnY = e.clientY
        return
      }
      const dx = e.clientX - lastSpawnX
      const dy = e.clientY - lastSpawnY
      if (dx * dx + dy * dy < TRAIL_SPACING * TRAIL_SPACING) return
      lastSpawnX = e.clientX
      lastSpawnY = e.clientY
      spawnStar(e.clientX, e.clientY, false)
    }

    function onPointerDown(e: PointerEvent) {
      hasLastSpawn = true
      lastSpawnX = e.clientX
      lastSpawnY = e.clientY
      for (let i = 0; i < TAP_BURST; i++) spawnStar(e.clientX, e.clientY, true)
    }

    resize()
    window.addEventListener("resize", resize)
    window.addEventListener("pointermove", onPointerMove, { passive: true })
    window.addEventListener("pointerdown", onPointerDown, { passive: true })

    return () => {
      window.removeEventListener("resize", resize)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerdown", onPointerDown)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="sira-star-canvas pointer-events-none fixed inset-0 z-40"
    />
  )
}
