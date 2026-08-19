"use client"

import { useEffect, useRef } from "react"

/**
 * StarSparkles — capa decorativa de destellos futuristas.
 *
 * Estrellas finas de cuatro puntas que fluyen tras el cursor con una
 * oscilación lateral tipo ola de líquido, y una onda expansiva (ripple)
 * con degradado azul→rojo al tocar la pantalla. Paleta azulina con
 * acentos #FF0000. Sutil a propósito: partículas pequeñas, canvas fijo
 * que no captura eventos y desactivado con `prefers-reduced-motion`.
 */

const PALETTE = ["#2563eb", "#3b82f6", "#60a5fa", "#93c5fd"]
const ACCENT = "#FF0000"
const ACCENT_RATIO = 0.22 // fracción de estrellas rojas
const MAX_STARS = 140
const TRAIL_SPACING = 14 // px de recorrido del puntero entre destellos
const TAP_BURST = 9

type Star = {
  baseX: number
  baseY: number
  vx: number
  vy: number
  drag: number // frenado viscoso (mayor = se detiene antes, sensación líquida)
  perpX: number
  perpY: number
  amp: number // amplitud de la ola lateral
  freq: number // rad/s de la ola
  phase: number
  size: number
  rotation: number
  spin: number
  born: number
  life: number
  color: string
}

type Ripple = {
  x: number
  y: number
  born: number
  delay: number
  life: number
  maxR: number
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
    const ripples: Ripple[] = []
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

    function wake() {
      if (running) return
      running = true
      lastFrame = performance.now()
      raf = requestAnimationFrame(frame)
    }

    function pickColor(): string {
      if (Math.random() < ACCENT_RATIO) return ACCENT
      return PALETTE[Math.floor(Math.random() * PALETTE.length)]
    }

    function spawnStar(x: number, y: number, dirX: number, dirY: number, burst: boolean) {
      if (stars.length >= MAX_STARS) stars.shift()
      const speed = burst ? 40 + Math.random() * 55 : 12 + Math.random() * 14
      stars.push({
        baseX: x + (Math.random() - 0.5) * 8,
        baseY: y + (Math.random() - 0.5) * 8,
        vx: dirX * speed,
        vy: dirY * speed - (burst ? 6 : 10),
        drag: burst ? 3.2 : 0.7,
        perpX: -dirY,
        perpY: dirX,
        amp: burst ? 4 + Math.random() * 5 : 6 + Math.random() * 9,
        freq: 4 + Math.random() * 3.5,
        phase: Math.random() * Math.PI * 2,
        size: burst ? 3.5 + Math.random() * 4 : 2.5 + Math.random() * 3.5,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 2,
        born: performance.now(),
        life: 700 + Math.random() * 500,
        color: pickColor(),
      })
      wake()
    }

    function spawnRipples(x: number, y: number) {
      if (ripples.length > 6) ripples.splice(0, ripples.length - 6)
      const now = performance.now()
      ripples.push({ x, y, born: now, delay: 0, life: 650, maxR: 64 })
      ripples.push({ x, y, born: now, delay: 130, life: 700, maxR: 42 })
      wake()
    }

    function drawStar(s: Star, now: number): boolean {
      if (!ctx) return false
      const p = (now - s.born) / s.life
      if (p >= 1) return false
      const appear = Math.min(1, p / 0.15)
      const easeIn = 1 - Math.pow(1 - appear, 3)
      const alpha = easeIn * (1 - Math.pow(p, 1.6)) * 0.8
      const scale = easeIn * (1 - 0.35 * p)
      // Ola lateral: emerge suave, ondula y se amortigua al morir (líquido).
      const waveScale = Math.min(1, p * 4) * (1 - p)
      const wave = Math.sin(s.phase + ((now - s.born) / 1000) * s.freq) * s.amp * waveScale
      const x = s.baseX + s.perpX * wave
      const y = s.baseY + s.perpY * wave
      const r = s.size
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(s.rotation + s.spin * p)
      ctx.scale(scale, scale)
      ctx.globalAlpha = alpha
      ctx.fillStyle = s.color
      ctx.shadowColor = s.color
      ctx.shadowBlur = 10
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

    function drawRipple(rp: Ripple, now: number): boolean {
      if (!ctx) return false
      const t = now - rp.born - rp.delay
      if (t < 0) return true // aún no emerge (segunda onda retardada)
      const p = t / rp.life
      if (p >= 1) return false
      const eased = 1 - Math.pow(1 - p, 3)
      const radius = Math.max(eased * rp.maxR, 0.5)
      const alpha = (1 - p) * 0.45
      const grad = ctx.createLinearGradient(rp.x - radius, rp.y, rp.x + radius, rp.y)
      grad.addColorStop(0, PALETTE[1])
      grad.addColorStop(1, ACCENT)
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = grad
      ctx.lineWidth = 0.6 + 1.4 * (1 - p)
      ctx.beginPath()
      ctx.arc(rp.x, rp.y, radius, 0, Math.PI * 2)
      ctx.stroke()
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
        const damp = Math.exp(-s.drag * dt)
        s.vx *= damp
        s.vy *= damp
        s.baseX += s.vx * dt
        s.baseY += s.vy * dt
        if (!drawStar(s, now)) stars.splice(i, 1)
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        if (!drawRipple(ripples[i], now)) ripples.splice(i, 1)
      }
      if (stars.length > 0 || ripples.length > 0) {
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
      const dist2 = dx * dx + dy * dy
      if (dist2 < TRAIL_SPACING * TRAIL_SPACING) return
      const dist = Math.sqrt(dist2)
      const dirX = dx / dist
      const dirY = dy / dist
      lastSpawnX = e.clientX
      lastSpawnY = e.clientY
      spawnStar(e.clientX, e.clientY, dirX, dirY, false)
      if (Math.random() < 0.45) {
        spawnStar(
          e.clientX - dirX * 8 + (Math.random() - 0.5) * 12,
          e.clientY - dirY * 8 + (Math.random() - 0.5) * 12,
          dirX,
          dirY,
          false,
        )
      }
    }

    function onPointerDown(e: PointerEvent) {
      hasLastSpawn = true
      lastSpawnX = e.clientX
      lastSpawnY = e.clientY
      spawnRipples(e.clientX, e.clientY)
      for (let i = 0; i < TAP_BURST; i++) {
        const angle = (i / TAP_BURST) * Math.PI * 2 + Math.random() * 0.6
        spawnStar(e.clientX, e.clientY, Math.cos(angle), Math.sin(angle), true)
      }
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
