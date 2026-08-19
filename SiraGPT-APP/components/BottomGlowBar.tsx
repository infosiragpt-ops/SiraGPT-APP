"use client"

import { motion } from "framer-motion"

/**
 * Fixed bottom accent bar — a sweeping rose/violet/indigo glow that
 * animates in on page load and cycles colors to match the "Anything"
 * gradient headline. Three layers:
 *   • Large blurred halo (80px)
 *   • Medium glow (24px blur) that hue-shifts every second
 *   • Sharp 2px line with sliding gradient
 *   • White "comet" that sweeps left→right
 */
export function BottomGlowBar() {
  return (
    <>
      <motion.div
        className="pointer-events-none fixed bottom-0 left-0 right-0 z-[45]"
        initial={{ opacity: 0, scaleX: 0.2 }}
        animate={{ opacity: 1, scaleX: 1 }}
        transition={{ duration: 1.4, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
        style={{ transformOrigin: "50% 100%" }}
      >
        {/* Large soft halo — reaches up 80px */}
        <div
          aria-hidden
          className="absolute bottom-0 left-0 right-0 h-20"
          style={{
            background:
              "linear-gradient(180deg, transparent 0%, rgba(236,72,153,0.18) 60%, rgba(168,85,247,0.28) 85%, rgba(99,102,241,0.32) 100%)",
            filter: "blur(22px)",
            animation: "glow-hue 4s linear infinite",
          }}
        />

        {/* Mid glow — 6px tall, heavy blur */}
        <div
          aria-hidden
          className="absolute bottom-0 left-0 right-0 h-[6px]"
          style={{
            background:
              "linear-gradient(90deg, rgba(236,72,153,0.9), rgba(168,85,247,0.95), rgba(99,102,241,0.9), rgba(236,72,153,0.9))",
            backgroundSize: "300% 100%",
            animation:
              "glow-slide 4s linear infinite, glow-hue 4s linear infinite",
            filter: "blur(6px)",
          }}
        />

        {/* Sharp 2px line with rotating gradient */}
        <div
          aria-hidden
          className="absolute bottom-0 left-0 right-0 h-[2px]"
          style={{
            background:
              "linear-gradient(90deg, #ec4899, #d946ef, #a855f7, #8b5cf6, #6366f1, #a855f7, #ec4899)",
            backgroundSize: "300% 100%",
            animation: "glow-slide 3.5s linear infinite",
          }}
        />

        {/* Traveling white comet highlight */}
        <div
          aria-hidden
          className="absolute bottom-0 h-[3px] w-40"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.95), rgba(255,255,255,0.4), transparent)",
            filter: "blur(2px)",
            animation: "comet-sweep 5s linear infinite",
          }}
        />

        {/* Second, softer reverse-direction comet for richness */}
        <div
          aria-hidden
          className="absolute bottom-0 h-[2px] w-28"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(236,72,153,0.9), transparent)",
            filter: "blur(4px)",
            animation: "comet-sweep-rev 6.5s linear infinite",
          }}
        />
      </motion.div>

      {/* keyframes live in app/globals.css — no inline <style> to avoid hydration mismatch */}
    </>
  )
}
