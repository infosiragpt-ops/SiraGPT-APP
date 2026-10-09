import type { SVGProps } from "react"
import { logoGeometryFor, openFrame, type SiraGeometry } from "@/lib/brand/sira-motion"

/**
 * SiraGPT brand mark (official since 2026-10-09): a solid centre with eight
 * straight arms — north, clockwise every 45° — each ending in a solid dot,
 * all one ink. Pure vector geometry drawn in `currentColor` («tinta»), so
 * callers pick the ink with a text class (`text-foreground`, `text-white`, …).
 *
 * Proportions come from the supplied artwork (`lib/brand/sira-motion.ts`
 * LOGO_GEOMETRY; the eight arms are deliberately equal — see the note there)
 * and are shared with the animated «Pensando» glyph
 * (`components/brand/thinking-core.tsx`), whose resting frame is exactly this
 * mark. Same drawing as `public/brand/sira-mark.svg`. Below 32 px the strokes
 * and dots get an optical size bump so the mark stays legible in the sidebar
 * rail and auth cards.
 */

export type SiraMarkProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  /** Rendered width/height in px (the mark is square). */
  size?: number | string
  /** Accessible name. When omitted the mark is decorative (`aria-hidden`). */
  title?: string
  /** Force the artwork proportions regardless of size. */
  weight?: "auto" | "display" | "small"
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function SiraMark({ size = 24, className, title, weight = "auto", ...rest }: SiraMarkProps) {
  const labelled = typeof title === "string" && title.length > 0
  const geometry: SiraGeometry = logoGeometryFor(size, weight)
  const frame = openFrame(geometry)
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${geometry.size} ${geometry.size}`}
      width={size}
      height={size}
      className={className}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      data-brand="sira"
      fill="none"
      {...rest}
    >
      {labelled ? <title>{title}</title> : null}
      <g stroke="currentColor" strokeWidth={geometry.stroke} strokeLinecap="round">
        {frame.arms.map((arm) => (
          <line key={arm.index} x1={frame.centre} y1={frame.centre} x2={round(arm.x)} y2={round(arm.y)} />
        ))}
      </g>
      <g fill="currentColor">
        {frame.arms.map((arm) => (
          <circle key={arm.index} cx={round(arm.x)} cy={round(arm.y)} r={arm.tipRadius} />
        ))}
        <circle cx={frame.centre} cy={frame.centre} r={frame.centerRadius} />
      </g>
    </svg>
  )
}

export default SiraMark
