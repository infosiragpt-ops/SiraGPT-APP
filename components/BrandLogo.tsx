"use client"

import { motion } from "framer-motion"
import { SiraMark } from "@/components/brand"

export function BrandLogo() {
  return (
    <>
      <motion.div
        className="flex items-center gap-3 cursor-pointer select-none"
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
      >
        <motion.span
          className="flex h-10 w-10 items-center justify-center rounded-lg text-[color:var(--brand)] will-change-transform"
          whileHover={{
            rotate: 360,
            scale: 1.08,
            filter:
              "drop-shadow(0 0 12px rgba(255,255,255,0.28)) drop-shadow(0 0 2px rgba(255,255,255,0.22))",
          }}
          transition={{
            rotate: { duration: 0.9, ease: [0.22, 1, 0.36, 1] },
            scale: { duration: 0.35, ease: "easeOut" },
            filter: { duration: 0.3 },
          }}
        >
          <SiraMark size={36} title="SiraGPT" />
        </motion.span>

        {/* Wordmark with shimmer wave */}
        <span className="relative text-xl font-bold leading-none">
          {/* Light mode */}
          <span
            aria-hidden
            className="dark:hidden bg-clip-text text-transparent"
            style={{
              backgroundImage:
                "linear-gradient(90deg, #171717 0%, #171717 40%, rgba(255,255,255,0.95) 49%, rgba(255,255,255,1) 51%, #171717 60%, #171717 100%)",
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
                "linear-gradient(90deg, #ffffff 0%, #ffffff 38%, #E5E5E5 48%, #D4D4D4 52%, #ffffff 62%, #ffffff 100%)",
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

    </>
  )
}
