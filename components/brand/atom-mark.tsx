import type { SVGProps } from "react"

/**
 * SiraGPT brand mark: an atom — three elliptical orbits (rotated −90°, 30°
 * and 150°) with one electron on each, around a solid nucleus. Luis supplied
 * the artwork on 2026-10-02 («logo de Sira de átomo»); the mark is pure
 * vector geometry drawn in `currentColor` («tinta»), so callers pick the ink
 * with a text class (`text-[color:var(--brand)]`, `text-white`, …).
 *
 * Each orbit ring carries a gap centred on its electron (stroke-dasharray /
 * dashoffset), exactly as in the source artwork. Same geometry as
 * `public/brand/atom.svg`. Below 32 px the strokes and dots get an optical
 * size bump so the mark stays legible in the sidebar rail and auth cards.
 */

const VIEW = 400
const CENTRE = 200
const ORBIT_RX = 170
const ORBIT_RY = 62
/** Ramanujan approximation of the orbit ellipse perimeter (matches the artwork's 716.9 + 52). */
const ORBIT_LENGTH = 768.9
const ORBIT_ANGLES = [-90, 30, 150] as const

const ORBIT_PATH = `M${CENTRE + ORBIT_RX} ${CENTRE}A${ORBIT_RX} ${ORBIT_RY} 0 1 1 ${CENTRE - ORBIT_RX} ${CENTRE}A${ORBIT_RX} ${ORBIT_RY} 0 1 1 ${CENTRE + ORBIT_RX} ${CENTRE}`

type AtomWeights = { stroke: number; electron: number; nucleus: number }

/** Artwork proportions (360 px and up). */
const WEIGHT_DISPLAY: AtomWeights = { stroke: 9, electron: 13, nucleus: 24 }
/** Optical size for ≤ 32 px renders (sidebar 20–22 px, auth 28 px). */
const WEIGHT_SMALL: AtomWeights = { stroke: 16, electron: 19, nucleus: 32 }

export type AtomMarkProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  /** Rendered width/height in px (the mark is square). */
  size?: number | string
  /** Accessible name. When omitted the mark is decorative (`aria-hidden`). */
  title?: string
  /** Force the artwork proportions regardless of size. */
  weight?: "auto" | "display" | "small"
}

export function AtomMark({ size = 24, className, title, weight = "auto", ...rest }: AtomMarkProps) {
  const labelled = typeof title === "string" && title.length > 0
  const small = weight === "small" || (weight === "auto" && typeof size === "number" && size <= 32)
  const w = small ? WEIGHT_SMALL : WEIGHT_DISPLAY
  const gap = w.electron * 4
  const dashArray = `${(ORBIT_LENGTH - gap).toFixed(1)} ${gap}`
  const dashOffset = (ORBIT_LENGTH - gap / 2).toFixed(1)
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      width={size}
      height={size}
      className={className}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      data-brand="atom"
      fill="none"
      {...rest}
    >
      {labelled ? <title>{title}</title> : null}
      {ORBIT_ANGLES.map((angle) => (
        <g key={angle} transform={`rotate(${angle} ${CENTRE} ${CENTRE})`}>
          <path
            d={ORBIT_PATH}
            stroke="currentColor"
            strokeWidth={w.stroke}
            strokeLinecap="round"
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset}
          />
          <circle cx={CENTRE + ORBIT_RX} cy={CENTRE} r={w.electron} fill="currentColor" />
        </g>
      ))}
      <circle cx={CENTRE} cy={CENTRE} r={w.nucleus} fill="currentColor" />
    </svg>
  )
}

export default AtomMark
