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
import { motion } from "framer-motion"
import { useState, useEffect, useRef } from "react"
import { ThemeToggle } from "@/components/theme-toggle"
import { LiquidButton } from "@/components/LiquidButton"
import { LoginButton, SignUpButton } from "@/components/AuthNavButtons"
import { BrandLogo } from "@/components/BrandLogo"
import { BrandCycle } from "@/components/BrandCycle"
import { BottomGlowBar } from "@/components/BottomGlowBar"

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
  const handleSplineLoad = (splineApp: Application) => {
    console.log("Spline scene loaded successfully.");
  };

  return (
    <>
      <GlobalStyles />
      <BottomGlowBar />
      <div className="min-h-screen bg-gradient-to-b from-white to-gray-100 dark:from-black dark:to-gray-950 text-gray-900 dark:text-white">

        {/* Header */}
        <header className="fixed top-0 w-full z-50 border-b border-gray-200 dark:border-white/10 bg-white/80 dark:bg-black/50 backdrop-blur-xl">
          <div className="container mx-auto flex items-center justify-between px-6 py-4">
            <BrandLogo />

            <motion.div
              className="flex items-center gap-3 z-[60]"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <ThemeToggle />
              <LoginButton href="/auth/login" />
              <SignUpButton href="/auth/register" />
            </motion.div>
          </div>
        </header>

        {/* Hero Section */}
        <section className="relative min-h-screen flex items-center justify-center pt-40">
          <div className="w-full max-w-[900px] mx-auto px-8">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
              className="relative flex items-center justify-center"
            >
              <BrandCycle />
            </motion.div>
          </div>
        </section>

      </div>
    </>
  )
}