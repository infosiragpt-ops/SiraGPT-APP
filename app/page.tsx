"use client"

import { Button } from "@/components/ui/button"
import Spline from "@splinetool/react-spline"
import { Application } from "@splinetool/runtime"
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
    ::-webkit-scrollbar {
      display: none;
    }
    body {
      -ms-overflow-style: none;
      scrollbar-width: none;
    }
    /* Aggressive Spline watermark removal */
    canvas ~ div,
    canvas + div,
    canvas ~ a,
    canvas + a,
    a[href*="spline"],
    a[href*="spline.design"],
    div[style*="position: absolute"][style*="bottom"],
    div[style*="position: fixed"][style*="bottom"],
    #logo,
    .logo,
    [id*="logo"],
    [class*="logo"],
    [id*="watermark"],
    [class*="watermark"] {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
      width: 0 !important;
      height: 0 !important;
    }
    canvas {
      background: transparent !important;
    }
  `}</style>
)

export default function Home() {
  const { scrollY } = useScroll()
  const heroY = useTransform(scrollY, [0, 400], [0, -150])
  const heroOpacity = useTransform(scrollY, [0, 400], [1, 0.5])
  const smoothHeroY = useSpring(heroY, { stiffness: 100, damping: 20 })

  const handleSplineLoad = (splineApp: Application) => {
    console.log("Spline scene loaded successfully.");
  };

  return (
    <>
      <GlobalStyles />
      <div className="min-h-screen bg-gradient-to-b from-white to-gray-100 dark:from-black dark:to-gray-950 text-gray-900 dark:text-white overflow-hidden">

        {/* Header */}
        <header className="fixed top-0 w-full z-50 border-b border-gray-200 dark:border-white/10 bg-white/80 dark:bg-black/50 backdrop-blur-xl">
          <div className="container mx-auto flex items-center justify-between px-6 py-4">
            <motion.div
              className="flex items-center gap-3"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <img src="/sira-gpt.png" alt="Sira GPT" className="h-10 w-10 dark:brightness-0 dark:invert" />
              <span className="text-xl font-bold">Sira GPT</span>
            </motion.div>

            <motion.div
              className="flex items-center gap-3 z-[60]"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <ThemeToggle />
              <LiquidButton variant="ghost" href="/auth/login">Login</LiquidButton>
              <LiquidButton href="/auth/register">Sign Up</LiquidButton>
            </motion.div>
          </div>
        </header>

        {/* Hero Section */}
        <section className="relative min-h-screen flex items-center pt-40">
          <div className="w-full max-w-[1600px] mx-auto px-8">
            <div className="grid lg:grid-cols-[45%,55%] gap-4 items-start relative">

              {/* Left Content */}
              <motion.div style={{ y: smoothHeroY, opacity: heroOpacity }} className="z-20">
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.2, duration: 0.8 }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-sm font-medium mb-8"
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
                  className="text-5xl md:text-6xl lg:text-7xl font-bold mb-6 leading-tight"
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
                  className="text-lg md:text-xl text-gray-600 dark:text-gray-400 mb-12 leading-relaxed"
                >
                  Access GPT-4, Claude, image generation, voice synthesis, and video creation. Choose your plan, use any AI model.
                </motion.p>

                <motion.div
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5, duration: 0.8 }}
                  className="flex flex-col sm:flex-row gap-4 mb-12"
                >
                  <LiquidButton size="lg" href={`${process.env.NEXT_PUBLIC_API_URL}/auth/google`}>
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
                  className="space-y-4 text-sm text-gray-700 dark:text-gray-300"
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
              </motion.div>

              {/* Right Spline - Adjusted layout */}
              <motion.div
                initial={{ opacity: 0, x: 100 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2, duration: 0.5 }}
                className="relative hidden lg:block"
                style={{
                  width: '1500px',
                  height: '1500px',
                  // margin: '0 auto',
                  transform: 'translateY(-50px)',
                  transformOrigin: 'center center',
                  marginTop: '-400px',
                }}
              >
                <Spline
                  scene="https://prod.spline.design/3Dy49BOwaRHfkjxT/scene.splinecode"
                  onLoad={handleSplineLoad}
                  style={{
                    width: '100%',
                    height: '100%',
                    background: 'transparent',
                    pointerEvents: 'none'
                  }}
                />
              </motion.div>

            </div>
          </div>
        </section>

      </div>
    </>
  )
}