"use client"

import { Button } from "@/components/ui/button"
import {
  MessageSquare,
  Shield,
  Users,
  Sparkles,
  Zap,
  Globe,
  Moon,
  Sun,
  ArrowRight,
  Code,
  Rocket,
  Star,
  Brain,
  Terminal,
  Cpu,
  CheckCircle,
  Play,
  Mic,
  Image as ImageIcon,
  Video,
  Palette,
  Check,
  X,
  Crown,
} from "lucide-react"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { motion, useScroll, useTransform, useSpring } from "framer-motion"
import { useState, useEffect, useRef } from "react"
import { ThemeToggle } from "@/components/theme-toggle"
import { LiquidButton } from "@/components/LiquidButton"

const GlobalStyles = () => (
  <style jsx global>{`
    /* Hide scrollbar for Chrome, Safari, and Opera */
    ::-webkit-scrollbar {
      display: none;
    }

    /* Hide scrollbar for IE, Edge, and Firefox */
    body {
      -ms-overflow-style: none; /* IE and Edge */
      scrollbar-width: none; /* Firefox */
    }
  `}</style>
)

// 3D Background Canvas Component
const Background3D = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let animationFrameId: number
    let particles: Particle[] = []

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resize()
    window.addEventListener("resize", resize)

    class Particle {
      x: number
      y: number
      z: number
      vx: number
      vy: number
      vz: number

      constructor() {
        this.x = Math.random() * canvas.width
        this.y = Math.random() * canvas.height
        this.z = Math.random() * 1000
        this.vx = (Math.random() - 0.5) * 0.5
        this.vy = (Math.random() - 0.5) * 0.5
        this.vz = Math.random() * 0.5 + 0.5
      }

      update() {
        this.x += this.vx
        this.y += this.vy
        this.z -= this.vz

        if (this.z <= 0) {
          this.z = 1000
          this.x = Math.random() * canvas.width
          this.y = Math.random() * canvas.height
        }

        if (this.x < 0 || this.x > canvas.width) this.vx *= -1
        if (this.y < 0 || this.y > canvas.height) this.vy *= -1
      }

      draw() {
        const scale = 1000 / (1000 + this.z)
        const x = (this.x - canvas.width / 2) * scale + canvas.width / 2
        const y = (this.y - canvas.height / 2) * scale + canvas.height / 2
        const size = scale * 2
        const opacity = ((1000 - this.z) / 1000) * 0.5

        ctx.fillStyle = `rgba(99, 102, 241, ${opacity})`
        ctx.beginPath()
        ctx.arc(x, y, size, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    for (let i = 0; i < 100; i++) {
      particles.push(new Particle())
    }

    const animate = () => {
      ctx.fillStyle = "rgba(0, 0, 0, 0.05)"
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Draw connecting lines
      for (let i = 0; i < particles.length; i++) {
        const p1 = particles[i]
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j]
          const dx = p1.x - p2.x
          const dy = p1.y - p2.y
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < 150) {
            const scale1 = 1000 / (1000 + p1.z)
            const scale2 = 1000 / (1000 + p2.z)
            const x1 = (p1.x - canvas.width / 2) * scale1 + canvas.width / 2
            const y1 = (p1.y - canvas.height / 2) * scale1 + canvas.height / 2
            const x2 = (p2.x - canvas.width / 2) * scale2 + canvas.width / 2
            const y2 = (p2.y - canvas.height / 2) * scale2 + canvas.height / 2

            ctx.strokeStyle = `rgba(99, 102, 241, ${0.2 * (1 - dist / 150)})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.stroke()
          }
        }
      }

      particles.forEach((p) => {
        p.update()
        p.draw()
      })

      animationFrameId = requestAnimationFrame(animate)
    }

    animate()

    return () => {
      window.removeEventListener("resize", resize)
      cancelAnimationFrame(animationFrameId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 -z-10"
      style={{ background: "linear-gradient(to bottom, #000000, #0a0a0f)" }}
    />
  )
}

export default function Home() {
  // Add smooth scroll-based animation for hero section
  const { scrollY } = useScroll()
  const heroY = useTransform(scrollY, [0, 400], [0, -150])
  const heroOpacity = useTransform(scrollY, [0, 400], [1, 0.5])
  const smoothHeroY = useSpring(heroY, { stiffness: 100, damping: 20 })

  return (
    <>
      <GlobalStyles />
      <div className="min-h-screen bg-gradient-to-b from-white to-gray-100 dark:from-black dark:to-gray-950 text-gray-900 dark:text-white overflow-x-hidden transition-all duration-500 ease-in-out">
        <div className="dark:block hidden">
          <Background3D />
        </div>

        {/* Header */}
        <header className="fixed top-0 w-full z-50 border-b border-gray-200 dark:border-white/10 bg-white/80 dark:bg-black/50 backdrop-blur-xl transition-all duration-500 ease-in-out">
          <div className="container mx-auto flex items-center justify-between px-6 py-4 relative">
            <motion.div
              className="flex items-center gap-3"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <img
                src="/sira-gpt.png"
                alt="Sira GPT"
                className="h-10 w-10 dark:brightness-0 dark:invert"
              />
              <span className="text-xl font-bold text-gray-900 dark:text-white">Sira GPT</span>
            </motion.div>

            <motion.div
              className="flex items-center gap-3 relative z-[60]"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <ThemeToggle />
              <LiquidButton variant="ghost" href="/auth/login">
                Login
              </LiquidButton>
              <LiquidButton href="/auth/register">Sign Up</LiquidButton>
            </motion.div>
          </div>
        </header>

        {/* Hero Section */}
      {/* Hero Section */}
<motion.section
  style={{ y: smoothHeroY, opacity: heroOpacity }}
  className="container mx-auto px-6 min-h-screen flex flex-col justify-center items-center text-center relative"
>
  <div className="max-w-5xl mx-auto">
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.2, duration: 0.8 }}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 backdrop-blur-sm text-sm font-medium mb-8"
    >
      <Sparkles className="h-4 w-4 text-indigo-400" />
      <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
        All AI Models in One Platform
      </span>
    </motion.div>

    <motion.h1
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3, duration: 0.8 }}
      className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-6 leading-tight"
    >
      <span className="bg-gradient-to-r from-gray-900 to-gray-700 dark:from-white dark:via-gray-200 dark:to-gray-400 bg-clip-text text-transparent">
        Chat, Create,
      </span>
      <br />
      <span className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 dark:from-indigo-400 dark:via-purple-400 dark:to-pink-400 bg-clip-text text-transparent">
        Generate Anything
      </span>
    </motion.h1>

    <motion.p
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4, duration: 0.8 }}
      className="text-xl md:text-2xl text-gray-600 dark:text-gray-400 mb-12 max-w-3xl mx-auto leading-relaxed"
    >
      Access GPT-4, Claude, image generation, voice synthesis, and video creation. Choose
      your plan, use any AI model.
    </motion.p>

    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.5, duration: 0.8 }}
      className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16"
    >
      <LiquidButton size="lg" href="/auth/register">
        <Rocket className="h-5 w-5" />
        Start Free Trial
      </LiquidButton>
      <LiquidButton variant="outline" size="lg" href="#pricing">
        View Pricing
      </LiquidButton>
    </motion.div>

    <motion.div
  initial={{ opacity: 0 }}
  animate={{ opacity: 1 }}
  transition={{ delay: 0.6 }}
  className="flex flex-wrap justify-center gap-8 text-sm text-gray-700 dark:text-gray-300 mt-8"
>
  <div className="flex items-center gap-2">
    <Cpu className="h-4 w-4 text-indigo-500" />
    <span>Access 20+ AI models instantly</span>
  </div>
  <div className="flex items-center gap-2">
    <Shield className="h-4 w-4 text-indigo-500" />
    <span>Secure & encrypted data</span>
  </div>
  <div className="flex items-center gap-2">
    <Crown className="h-4 w-4 text-indigo-500" />
    <span>Seamless subscription control</span>
  </div>
  <div className="flex items-center gap-2">
    <Users className="h-4 w-4 text-indigo-500" />
    <span>Trusted by 50K+ creators</span>
  </div>
</motion.div>

  </div>
</motion.section>

      </div>
    </>
  )
}
