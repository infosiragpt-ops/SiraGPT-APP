"use client"

import React from "react"
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon"
import { cn } from "@/lib/utils"

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

  // Matches the sizing + hover/focus/active vocabulary used by neighboring
  // icon buttons (ThemeToggle, upgrade, etc.) so the header reads as a
  // single system. Icon inherits `currentColor` from the anchor's text
  // color, so no dark-mode invert hacks needed.
  return (
    <a
      href={webUrl}
      onClick={handleClick}
      aria-label="Chat en WhatsApp"
      title="Chat en WhatsApp"
      role="button"
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full",
        "text-muted-foreground transition-all duration-200",
        "hover:bg-foreground/[0.06] hover:text-foreground",
        "active:scale-[0.96]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
    >
      <WhatsAppIcon className="h-[18px] w-[18px]" />
    </a>
  )
}

export default WhatsAppButton
