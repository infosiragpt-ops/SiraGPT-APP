/**
 * SiraGPT brand motion — the pure model behind the animated mark.
 *
 * The official logo (2026-10-09) is an eight-arm mark: a solid centre, eight
 * straight arms (N, NE, E, SE, S, SW, W, NW) ending in solid dots, one ink.
 * Its animation («Animación en blanco y negro», supplied as a canvas page)
 * opens and closes the arms in a continuous cycle (1.5 s in the product,
 * 2 s in the delivered showcase): the arms grow
 * out of the centre in four staggered ranks (opposite arms always share
 * their motion), the dots bloom once they have cleared the centre, and the
 * centre itself breathes from a seed to its full size. Velocity and
 * acceleration are zero at both ends of every movement (quintic smoothstep),
 * so there are no jumps or bounces.
 *
 * Everything here is pure and unit-testable; the React components
 * (`components/brand/sira-mark.tsx`, `components/brand/thinking-core.tsx`)
 * only draw what `frameAt()` returns. No DOM, no timers.
 */

/** Geometry in a square box of side `size` (centre at size/2). */
export type SiraGeometry = {
  size: number
  /** Distance from the centre to a tip-dot centre when fully open. */
  reach: number
  /** Centre radius when fully open. */
  center: number
  /** Centre radius when fully closed (the resting seed). */
  seed: number
  /** Tip-dot radius when fully open. */
  tip: number
  /** Arm stroke width. */
  stroke: number
}

export type SiraTiming = {
  /** Full open + close cycle, ms. */
  cycle: number
  /** When the opening starts inside the cycle, ms. */
  start: number
  /** Duration of the opening (and of the closing), ms. */
  duration: number
  /** When the closing starts inside the cycle, ms. */
  close: number
  /** Delay between consecutive ranks, ms. */
  stagger: number
}

/** The animation as delivered (720 px canvas): airy, with margin around it. */
export const SHOWCASE_GEOMETRY: SiraGeometry = Object.freeze({ size: 720, reach: 186, center: 40, seed: 32, tip: 29, stroke: 13 })

/**
 * The logo proportions measured on the official artwork, in a 400 box with
 * the fully open mark touching the box (outer radius 200 = reach + tip):
 * centre 0.24, tip 0.185, reach 0.815, stroke 0.085 of the outer radius.
 * `seed` keeps the closed state a visible dot (same ratio as the showcase).
 *
 * DELIBERATE: all eight arms share one `reach`. The supplied static artwork
 * draws its four diagonal arms ≈ 10.6 % longer than the orthogonal ones
 * (same dot size); the supplied animation uses a single reach for all eight,
 * and so does this model — the owner chose the equal arms on 2026-10-09:
 * perfect 8-fold symmetry, and the mark's extent is a circle, which the
 * maskable / adaptive icon safe zones rely on. Do not "fix" this by
 * re-measuring the artwork.
 */
export const LOGO_GEOMETRY: SiraGeometry = Object.freeze({ size: 400, reach: 163, center: 48, seed: 38, tip: 37, stroke: 17 })

/** Optical size for ≤ 32 px renders (sidebar 20–22 px, rails 12–16 px): heavier so nothing turns into hairlines. */
export const LOGO_GEOMETRY_SMALL: SiraGeometry = Object.freeze({ size: 400, reach: 160, center: 52, seed: 42, tip: 40, stroke: 24 })

/** The timing as delivered with the showcase canvas: a two-second cycle. */
export const SHOWCASE_TIMING: SiraTiming = Object.freeze({ cycle: 2000, start: 0, duration: 970, close: 1000, stagger: 10 })

/**
 * The product timing (Jorge, 2026-10-09: the mark must open and close in
 * 1–1.5 s, with a professional feel): a 1.5 s cycle, 0.75 s to open and
 * 0.75 s to close, same stagger. `duration = close - 3 * stagger`, so the
 * last rank finishes opening exactly when the closing starts and the frame
 * at `close` is the fully open logo (the resting frame the markup shows).
 */
export const SIRA_TIMING: SiraTiming = Object.freeze({ cycle: 1500, start: 0, duration: 720, close: 750, stagger: 10 })

/** Rank of each arm, N clockwise: opposite arms share a rank so they move together. */
export const ARM_RANKS: readonly number[] = Object.freeze([0, 2, 1, 3, 0, 2, 1, 3])

/** Unit direction of each arm, starting at north and going clockwise in 45° steps. */
export const ARM_DIRECTIONS: readonly { x: number; y: number; rank: number }[] = Object.freeze(
  ARM_RANKS.map((rank, i) => ({
    rank,
    x: round6(Math.cos(-Math.PI / 2 + (i * Math.PI) / 4)),
    y: round6(Math.sin(-Math.PI / 2 + (i * Math.PI) / 4)),
  })),
)

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Quintic smoothstep: zero velocity and acceleration at both ends. */
export function smooth(value: number): number {
  const t = Math.max(0, Math.min(1, value))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** Openness of one rank in [0, 1] at `localTime` (ms inside the cycle). */
export function progressAt(localTime: number, rank: number, timing: SiraTiming = SIRA_TIMING): number {
  const delay = rank * timing.stagger
  const opening = smooth((localTime - timing.start - delay) / timing.duration)
  const closing = smooth((localTime - timing.close - (3 * timing.stagger - delay)) / timing.duration)
  return opening * (1 - closing)
}

export type SiraArmFrame = {
  /** Arm index 0..7 (north clockwise). */
  index: number
  /** Tip centre, absolute box coordinates. */
  x: number
  y: number
  /** Distance of the tip centre from the box centre (0 = arm hidden). */
  distance: number
  /** Tip-dot radius at this instant (0 = not yet bloomed). */
  tipRadius: number
}

export type SiraFrame = {
  /** Box centre coordinate (size / 2). */
  centre: number
  /** Centre radius at this instant. */
  centerRadius: number
  /** Mean openness of the eight arms in [0, 1]. */
  openness: number
  arms: SiraArmFrame[]
}

/**
 * The whole mark at absolute time `at` (ms). Pass `Infinity`/`null` for the
 * resting open frame (the static logo) — that is what idle and
 * reduced-motion renders draw.
 */
export function frameAt(at: number | null, geometry: SiraGeometry = LOGO_GEOMETRY, timing: SiraTiming = SIRA_TIMING): SiraFrame {
  const centre = geometry.size / 2
  const open = at === null || !Number.isFinite(at)
  const localTime = open ? 0 : ((at % timing.cycle) + timing.cycle) % timing.cycle
  const amounts = ARM_DIRECTIONS.map((d) => (open ? 1 : progressAt(localTime, d.rank, timing)))
  const openness = amounts.reduce((a, b) => a + b, 0) / amounts.length
  const centerRadius = geometry.seed + (geometry.center - geometry.seed) * openness
  const arms = ARM_DIRECTIONS.map((direction, index) => {
    const distance = geometry.reach * amounts[index]
    // Dots bloom only after leaving the centre, so they never pile up on it.
    const reveal = open ? 1 : smooth((distance - centerRadius - geometry.size * (5 / 720)) / (geometry.size * (70 / 720)))
    return {
      index,
      x: centre + direction.x * distance,
      y: centre + direction.y * distance,
      distance,
      tipRadius: geometry.tip * reveal,
    }
  })
  return { centre, centerRadius, openness, arms }
}

/** The fully open frame — identical to the static logo. */
export function openFrame(geometry: SiraGeometry = LOGO_GEOMETRY): SiraFrame {
  return frameAt(null, geometry)
}

/** Picks the logo geometry for a rendered size (optical weight bump ≤ 32 px). */
export function logoGeometryFor(size: number | string | undefined, weight: "auto" | "display" | "small" = "auto"): SiraGeometry {
  if (weight === "small") return LOGO_GEOMETRY_SMALL
  if (weight === "display") return LOGO_GEOMETRY
  return typeof size === "number" && size <= 32 ? LOGO_GEOMETRY_SMALL : LOGO_GEOMETRY
}

/**
 * Static SVG markup of the open mark (one ink, `currentColor` by default).
 * Used for `public/brand/sira-mark.svg`, icon generation and tests.
 */
export function siraMarkSvg({
  geometry = LOGO_GEOMETRY,
  color = "currentColor",
  title = "SiraGPT",
  background = null,
  padding = 0,
}: { geometry?: SiraGeometry; color?: string; title?: string | null; background?: string | null; padding?: number } = {}): string {
  const frame = openFrame(geometry)
  const n = (v: number) => (Math.round(v * 100) / 100).toString()
  const view = geometry.size + padding * 2
  const shift = padding
  const lines = frame.arms
    .map((arm) => `<line x1="${n(frame.centre + shift)}" y1="${n(frame.centre + shift)}" x2="${n(arm.x + shift)}" y2="${n(arm.y + shift)}"/>`)
    .join("")
  const tips = frame.arms.map((arm) => `<circle cx="${n(arm.x + shift)}" cy="${n(arm.y + shift)}" r="${n(arm.tipRadius)}"/>`).join("")
  const label = title ? ` role="img" aria-label="${title}"` : ' aria-hidden="true"'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${view} ${view}"${label}>` +
    (title ? `<title>${title}</title>` : "") +
    (background ? `<rect width="${view}" height="${view}" fill="${background}"/>` : "") +
    `<g stroke="${color}" stroke-width="${n(geometry.stroke)}" stroke-linecap="round">${lines}</g>` +
    `<g fill="${color}">${tips}<circle cx="${n(frame.centre + shift)}" cy="${n(frame.centre + shift)}" r="${n(frame.centerRadius)}"/></g>` +
    `</svg>`
  )
}
