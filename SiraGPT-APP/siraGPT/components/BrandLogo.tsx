"use client"

import { motion } from "framer-motion"

export function BrandLogo() {
  return (
    <>
      <motion.div
        className="flex items-center gap-3 cursor-pointer select-none"
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
      >
        <motion.img
          src="/sira-gpt.png"
          alt="Sira GPT"
          className="h-10 w-10 rounded-lg object-contain will-change-transform"
          whileHover={{
            rotate: 360,
            scale: 1.08,
            filter:
              "drop-shadow(0 0 12px rgba(99,102,241,0.55)) drop-shadow(0 0 2px rgba(139,92,246,0.35))",
          }}
          transition={{
            rotate: { duration: 0.9, ease: [0.22, 1, 0.36, 1] },
            scale: { duration: 0.35, ease: "easeOut" },
            filter: { duration: 0.3 },
          }}
        />

        {/* Wordmark with shimmer wave */}
        <span className="relative text-xl font-bold leading-none">
          {/* Light mode */}
          <span
            aria-hidden
            className="dark:hidden bg-clip-text text-transparent"
            style={{
              backgroundImage:
                "linear-gradient(90deg, #0f172a 0%, #0f172a 40%, rgba(255,255,255,0.95) 49%, rgba(255,255,255,1) 51%, #0f172a 60%, #0f172a 100%)",
              backgroundSize: "220% 100%",
              animation: "brand-wave 4s ease-in-out infinite",
            }}
          >
            Sira GPT
          </span>
          {/* Dark mode */}
          <span
            aria-hidden
            className="hidden dark:inline-block bg-clip-text text-transparent"
            style={{
              backgroundImage:
                "linear-gradient(90deg, #ffffff 0%, #ffffff 38%, #a5b4fc 48%, #c4b5fd 52%, #ffffff 62%, #ffffff 100%)",
              backgroundSize: "220% 100%",
              animation: "brand-wave 4s ease-in-out infinite",
            }}
          >
            Sira GPT
          </span>
          {/* Accessible copy for screen readers */}
          <span className="sr-only">Sira GPT</span>
        </span>
      </motion.div>

      <style jsx global>{`
        @keyframes brand-wave {
          0% {
            background-position: 180% 0;
          }
          100% {
            background-position: -40% 0;
          }
        }
      `}</style>
    </>
  )
}
