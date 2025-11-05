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
      className={`group ${className}`}
    >
        <img src="/icons/whatsapp.png" alt="WhatsApp" className="w-7 h-7" />

      {/* <div className="relative flex items-center justify-center w-10 h-10 rounded-full bg-gradient-to-br from-green-500 to-green-600 text-white shadow-lg transition-transform duration-200 hover:scale-110 active:scale-95">
        <img src="/icons/whatsapp.png" alt="WhatsApp" className="w-6 h-6" />
      </div> */}
    </a>
  )
}

export default WhatsAppButton
