"use client"

import React from "react"
import { MessageCircle, } from "lucide-react" // WhatsApp-like icon

type Props = {
  number?: string
  message?: string
  className?: string
}

const WhatsAppButton: React.FC<Props> = ({ number, message, className = "" }) => {
  const phone =
    number || (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_WHATSAPP_NUMBER : "") || ""

  if (!phone) return null

  const query = message ? encodeURIComponent(message) : ""
  const webUrl = `https://wa.me/${phone}${query ? `?text=${query}` : ""}`
  const appUrl = `whatsapp://send?phone=${phone}${query ? `&text=${query}` : ""}`

  const isMobileDevice =
    typeof navigator !== "undefined"
      ? (navigator as any).userAgentData?.mobile ||
      /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent)
      : false

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    if (isMobileDevice) {
      window.location.href = appUrl
      setTimeout(() => {
        window.location.href = webUrl
      }, 800)
    } else {
      window.open(webUrl, "_blank", "noopener,noreferrer")
    }
  }

  return (
    <a
      href={webUrl}
      onClick={handleClick}
      aria-label="Chat on WhatsApp"
      title="Chat on WhatsApp"
      role="button"
      className={`fixed right-4 bottom-4 z-50 md:right-6 md:bottom-6 group ${className}`}
    >
      {/* Button with pulse animation */}
      <div className="relative flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-green-500 to-green-600 text-white shadow-lg transition-transform duration-200 hover:scale-110 active:scale-95">
        <MessageCircle className="w-7 h-7" />

        {/* Pulse glow */}
        <span className="absolute inset-0 rounded-full animate-ping bg-green-500 opacity-30"></span>
      </div>

      {/* Tooltip for desktop */}
      <span className="absolute right-20 bottom-5 hidden md:block bg-black text-white text-sm px-2 py-1 rounded-md shadow-md opacity-0 group-hover:opacity-100 transition-opacity">
        Chat on WhatsApp
      </span>
    </a>
  )
}

export default WhatsAppButton
