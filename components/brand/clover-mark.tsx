import type { CSSProperties, SVGProps } from "react"

/**
 * SiraGPT brand mark: a four-leaf clover.
 *
 * The leaves take `currentColor`, so callers pick the colour with a text
 * class (`text-[color:var(--brand)]`, `text-white`, ...). The veins use
 * `--clover-vein` (white in both themes) so they stay visible on the green.
 * Same geometry as `public/brand/clover.svg`.
 */

const LEAF_PATH =
  "M0 0 C -16 -30, -62 -44, -76 -84 C -90 -124, -56 -154, -28 -136 C -12 -126, -5 -112, 0 -100 C 5 -112, 12 -126, 28 -136 C 56 -154, 90 -124, 76 -84 C 62 -44, 16 -30, 0 0 Z"

const STEM_PATH =
  "M -6 12 C -2 70, 4 120, 22 170 C 34 202, 62 216, 82 200 C 92 192, 86 178, 74 182 C 54 190, 44 178, 36 156 C 22 118, 16 70, 12 12 Z"

const ROTATIONS = [0, 90, 180, 270] as const

export type CloverMarkProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  /** Rendered width/height in px (the mark is square). */
  size?: number | string
  /** Accessible name. When omitted the mark is decorative (`aria-hidden`). */
  title?: string
}

export function CloverMark({ size = 24, className, title, style, ...rest }: CloverMarkProps) {
  const labelled = typeof title === "string" && title.length > 0
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className}
      style={style}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      data-brand="clover"
      {...rest}
    >
      {labelled ? <title>{title}</title> : null}
      <g fill="currentColor" transform="translate(256 244)">
        {ROTATIONS.map((deg) => (
          <path key={deg} d={LEAF_PATH} transform={`rotate(${deg})`} />
        ))}
        <path d={STEM_PATH} />
      </g>
      <g
        stroke="var(--clover-vein, #fff)"
        strokeWidth={6}
        strokeLinecap="round"
        fill="none"
        opacity={0.8}
        transform="translate(256 244)"
      >
        {ROTATIONS.map((deg) => (
          <path key={deg} d="M0 -34 L 0 -96" transform={`rotate(${deg})`} />
        ))}
      </g>
    </svg>
  )
}

export type CloverBadgeProps = {
  /** Outer square size in px. */
  size?: number
  className?: string
  title?: string
  style?: CSSProperties
}

/**
 * Clover on a rounded brand-green square (white leaves). Use where the old
 * PNG sat on a coloured background: launcher-style tiles, avatars, badges.
 */
export function CloverBadge({ size = 40, className, title = "SiraGPT", style }: CloverBadgeProps) {
  const radius = Math.round(size * 0.22)
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: radius,
        background: "var(--brand, #2E7D32)",
        color: "#ffffff",
        flexShrink: 0,
        ...style,
      }}
    >
      <CloverMark size={Math.round(size * 0.72)} title={title} style={{ ["--clover-vein" as string]: "var(--brand, #2E7D32)" }} />
    </span>
  )
}
