import * as React from "react"

/**
 * WhatsApp Business glyph — brand-colored filled SVG.
 *
 * Renders the official WhatsApp Business mark (green bubble + "B"
 * letter) instead of the consumer WhatsApp phone-handset, since the
 * CTA targets a business WhatsApp account. Self-contained (no external
 * image, no `dark:invert` hack).
 */
export function WhatsAppIcon({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {/* Speech bubble outline, solid WhatsApp green. The subtle outer
          ring keeps the icon readable on both light and dark headers
          without needing a separate dark-mode asset. */}
      <path
        d="M16 2.5C8.54 2.5 2.5 8.54 2.5 16c0 2.38.63 4.66 1.82 6.7L2.5 29.5l7-1.8A13.4 13.4 0 0 0 16 29.5C23.46 29.5 29.5 23.46 29.5 16S23.46 2.5 16 2.5Z"
        fill="#25D366"
      />
      {/* Inner white bubble mask gives the "B" letter room to breathe
          and matches the brand asset's rounded proportions. */}
      <path
        d="M16 5.5C10.2 5.5 5.5 10.2 5.5 16c0 2.06.6 4 1.64 5.63L6 26l4.5-1.1A10.46 10.46 0 0 0 16 26.5c5.8 0 10.5-4.7 10.5-10.5S21.8 5.5 16 5.5Z"
        fill="#FFFFFF"
      />
      {/* Letter "B" — rendered as path so it stays crisp at any size
          and doesn't depend on system fonts. */}
      <path
        d="M12 10.5h5.2c2.2 0 3.8 1.1 3.8 3 0 1.15-.65 2.05-1.65 2.4 1.3.35 2.15 1.35 2.15 2.75 0 2.1-1.7 3.35-4.1 3.35H12V10.5Zm2.3 4.35h2.7c1.05 0 1.7-.5 1.7-1.4 0-.85-.65-1.35-1.7-1.35H14.3v2.75Zm0 4.95h3c1.15 0 1.85-.55 1.85-1.5s-.7-1.5-1.85-1.5h-3v3Z"
        fill="#25D366"
      />
    </svg>
  )
}

export default WhatsAppIcon
