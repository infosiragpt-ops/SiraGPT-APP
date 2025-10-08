"use client"

import { motion, useMotionValue, useSpring } from "framer-motion"
import { useRef, useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { useTheme } from "next-themes"
interface Ripple {
  x: number
  y: number
  id: number
}

interface LiquidButtonProps {
  children: React.ReactNode
  className?: string
  onClick?: () => void
  size?: "default" | "sm" | "lg"
  href?: string
  disabled?: boolean
  variant?: "default" | "outline" | "ghost"
}

export const LiquidButton: React.FC<LiquidButtonProps> = ({
  children,
  size = "default",
  variant = "default",
  className = "",
  href,
  disabled = false,
  onClick,
  ...props
}) => {
  const [ripples, setRipples] = useState<Ripple[]>([])
  const [isHovered, setIsHovered] = useState(false)
  const [isPressed, setIsPressed] = useState(false)

  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"
  // useEffect(() => {
  //   const updateTheme = () => {
  //     setIsDark(
  //       document.documentElement.classList.contains('dark') ||
  //       window.matchMedia('(prefers-color-scheme: dark)').matches
  //     )
  //   }

  //   updateTheme()

  //   // Listen for theme changes
  //   const observer = new MutationObserver(updateTheme)
  //   observer.observe(document.documentElement, {
  //     attributes: true,
  //     attributeFilter: ['class']
  //   })

  //   const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  //   mediaQuery.addEventListener('change', updateTheme)

  //   return () => {
  //     observer.disconnect()
  //     mediaQuery.removeEventListener('change', updateTheme)
  //   }
  // }, [])

  const mouseX = useMotionValue(0)
  const mouseY = useMotionValue(0)
  const springConfig = { damping: 25, stiffness: 300, mass: 0.8 }
  const x = useSpring(mouseX, springConfig)
  const y = useSpring(mouseY, springConfig)

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const centerX = rect.width / 2
    const centerY = rect.height / 2
    mouseX.set((e.clientX - rect.left - centerX) * 0.2)
    mouseY.set((e.clientY - rect.top - centerY) * 0.2)
  }

  const handleMouseEnter = () => setIsHovered(true)
  const handleMouseLeave = () => {
    setIsHovered(false)
    mouseX.set(0)
    mouseY.set(0)
  }

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const newRipple = { x, y, id: Date.now() }
    setRipples(prev => [...prev, newRipple])
    setTimeout(() => setRipples(prev => prev.filter(r => r.id !== newRipple.id)), 800)

    if (onClick) onClick()
  }

  const handleMouseDown = () => setIsPressed(true)
  const handleMouseUp = () => setIsPressed(false)

  const getVariantStyles = () => {
    switch (variant) {
      case "outline":
        return {
          background: isDark
            ? "rgba(255, 255, 255, 0.06)"
            : "rgba(0, 0, 0, 0.04)",
          backdropFilter: "blur(20px)",
          border: isDark
            ? "1px solid rgba(255, 255, 255, 0.15)"
            : "1px solid rgba(0, 0, 0, 0.1)",
          boxShadow: isDark
            ? "inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 2px 8px rgba(0, 0, 0, 0.3)"
            : "inset 0 1px 0 rgba(255, 255, 255, 0.8), 0 2px 12px rgba(0, 0, 0, 0.1)",
          color: isDark ? "rgba(255, 255, 255, 0.9)" : "#000000"
        }
      case "ghost":
        return {
          background: isDark
            ? "rgba(255, 255, 255, 0.03)"
            : "rgba(0, 0, 0, 0.02)",
          backdropFilter: "blur(15px)",
          border: isDark
            ? "1px solid rgba(255, 255, 255, 0.08)"
            : "1px solid rgba(0, 0, 0, 0.05)",
          boxShadow: isDark
            ? "0 1px 3px rgba(0, 0, 0, 0.3)"
            : "0 1px 3px rgba(0, 0, 0, 0.08)",
          color: isDark ? "rgba(255, 255, 255, 0.8)" : "rgba(0, 0, 0, 0.7)"
        }
      default:
        return {
          background: isDark
            ? "rgba(255, 255, 255, 0.12)"
            : "rgba(0, 0, 0, 0.08)",
          backdropFilter: "blur(20px)",
          border: isDark
            ? "1px solid rgba(255, 255, 255, 0.2)"
            : "1px solid rgba(0, 0, 0, 0.15)",
          boxShadow: isDark
            ? "inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 4px 20px rgba(0, 0, 0, 0.4)"
            : "inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 4px 25px rgba(0, 0, 0, 0.15)",
          color: isDark ? "rgba(255, 255, 255, 0.95)" : "rgba(0, 0, 0, 0.85)"
        }
    }
  }

  const buttonClasses = cn(
    "relative overflow-hidden font-semibold cursor-pointer select-none transition-all duration-500 ease-in-out",
    "rounded-2xl border-0",
    "hover:scale-[1.02] active:scale-[0.98]",
    size === "lg" ? "px-8 py-4 text-base" : size === "sm" ? "px-4 py-2 text-sm" : "px-6 py-3 text-sm",
    disabled && "opacity-50 cursor-not-allowed hover:scale-100 active:scale-100",
    className
  )

  const content = (
    <motion.button
      ref={buttonRef}
      className={buttonClasses}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      disabled={disabled}
      style={getVariantStyles()}
      animate={{
        scale: isPressed ? 0.96 : isHovered ? 1.02 : 1,
      }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      {...props}
    >
      {/* Liquid glass distortion layer */}
      <motion.div
        className="absolute inset-0 rounded-2xl pointer-events-none"
        style={{
          x,
          y,
          background: isDark
            ? "radial-gradient(circle at 50% 50%, rgba(255,255,255,0.15), transparent 60%)"
            : "radial-gradient(circle at 50% 50%, rgba(255,255,255,0.4), transparent 60%)",
          filter: "blur(12px)",
        }}
        animate={{
          scale: isHovered ? 1.15 : 1,
          opacity: isHovered ? 0.8 : 0.4
        }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      />

      {/* Ripple effect */}
      {ripples.map(ripple => (
        <motion.span
          key={ripple.id}
          className="absolute rounded-full pointer-events-none"
          style={{
            left: ripple.x,
            top: ripple.y,
            transform: "translate(-50%, -50%)",
            background: isDark
              ? "radial-gradient(circle, rgba(255,255,255,0.3), rgba(255,255,255,0.08), transparent)"
              : "radial-gradient(circle, rgba(255,255,255,0.6), rgba(255,255,255,0.2), transparent)",
            filter: "blur(3px)",
          }}
          initial={{ width: 0, height: 0, opacity: 0.6 }}
          animate={{ width: 160, height: 160, opacity: 0 }}
          transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
        />
      ))}

      {/* Subtle glass highlight */}
      <motion.div
        className="absolute inset-x-0 top-0 h-0.5 rounded-t-2xl pointer-events-none"
        style={{
          background: isDark
            ? "linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent)"
            : "linear-gradient(90deg, transparent, rgba(255,255,255,0.9), transparent)",
        }}
        animate={{
          opacity: isHovered ? 1 : 0.7,
          scaleX: isHovered ? 1.2 : 1
        }}
        transition={{ duration: 0.3 }}
      />

      {/* Moving highlight shimmer */}
      <motion.div
        className="absolute inset-0 rounded-2xl opacity-15 pointer-events-none overflow-hidden"
        animate={{
          background: isHovered ? [
            isDark
              ? "linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.05) 45%, rgba(255,255,255,0.2) 50%, rgba(255,255,255,0.05) 55%, transparent 100%)"
              : "linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.3) 45%, rgba(255,255,255,0.6) 50%, rgba(255,255,255,0.3) 55%, transparent 100%)",
            isDark
              ? "linear-gradient(110deg, transparent 40%, rgba(255,255,255,0.05) 85%, rgba(255,255,255,0.2) 90%, rgba(255,255,255,0.05) 95%, transparent 100%)"
              : "linear-gradient(110deg, transparent 40%, rgba(255,255,255,0.3) 85%, rgba(255,255,255,0.6) 90%, rgba(255,255,255,0.3) 95%, transparent 100%)"
          ] : "linear-gradient(110deg, transparent, transparent)"
        }}
        transition={{ duration: 1.5, repeat: isHovered ? Infinity : 0, ease: "easeInOut" }}
      />

      <span className="relative z-10 flex items-center justify-center gap-2">
        {children}
      </span>
    </motion.button>
  )

  return href ? <a href={href}>{content}</a> : content
}
