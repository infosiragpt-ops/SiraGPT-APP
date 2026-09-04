"use client"

/**
 * Dithered pixel-dissolve fill for the effort slider.
 *
 * Pure SVG — no raster asset. The bar starts grey on the left and dissolves
 * into violet toward the right through a grid of small square "pixels" whose
 * density AND opacity increase along the x axis, plus a few isolated pixels
 * that read as particles well before the dense region begins.
 *
 * How it is built (all responsive — nothing depends on the rendered width):
 *   • `<pattern patternUnits="userSpaceOnUse">` tiles keep every pixel a true
 *     square whatever the track width is (no viewBox stretching).
 *   • Six pattern layers hold disjoint subsets of an 8×6 cell tile. Layer 0
 *     is the sparse "particles" layer; each next layer adds more cells so the
 *     cumulative density climbs to a full grid.
 *   • Each layer is masked by a horizontal luminance gradient that fades from
 *     0 → 1 over its own x range. That is what makes both the density (which
 *     layers are visible yet) and the opacity (how far into its ramp a layer
 *     is) grow toward the right.
 *   • A solid violet cap fades in over the last ~15 % so the bar ends fully
 *     saturated right under the thumb.
 *
 * The cell ordering is a seeded shuffle so SSR and client markup are byte
 * identical and the "particles" never move between renders.
 */

import * as React from "react"

const CELL = 4 // px — one grid cell (pixel + gap)
const PIXEL = 3 // px — the visible square inside a cell
const TILE_COLS = 8
const TILE_ROWS = 6
const TILE_W = TILE_COLS * CELL
const TILE_H = TILE_ROWS * CELL

/** Cells per layer — sums to TILE_COLS × TILE_ROWS (48). */
const LAYER_SIZES = [2, 5, 9, 10, 10, 12] as const

/**
 * Layers whose pixels shimmer. Only the sparse, early layers twinkle — the
 * dense grid and the solid cap stay rock-stable so the bar keeps reading as
 * a solid control, not a loading spinner.
 */
const TWINKLE_LAYERS = 3

/** Wave period (s). Per-pixel delays spread over one full period. */
const TWINKLE_PERIOD_S = 3

/**
 * Deterministic shimmer delay for a cell: grows with the column (plus a
 * small row offset so neighbours never pulse in lockstep), wrapped into one
 * period. Because the delay is a function of position, the twinkle reads as
 * a wave travelling left → right across the bar.
 */
function twinkleDelayS(col: number, row: number): number {
  return (col * 0.35 + row * 0.13) % TWINKLE_PERIOD_S
}

/** Horizontal fade-in window (fractions of the fill width) per layer. */
const LAYER_RAMPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.3], // particles: isolated pixels from the very start of the bar
  [0.15, 0.45],
  [0.3, 0.6],
  [0.45, 0.75],
  [0.6, 0.88],
  [0.74, 0.96],
]

/** Solid violet cap so the far right reads as fully saturated. */
const SOLID_RAMP: readonly [number, number] = [0.84, 1]

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Cell = readonly [col: number, row: number]

function buildLayers(): Cell[][] {
  const rand = mulberry32(0x5a1e5)
  const cells: Cell[] = []
  for (let row = 0; row < TILE_ROWS; row += 1) {
    for (let col = 0; col < TILE_COLS; col += 1) cells.push([col, row])
  }
  // Fisher–Yates with the seeded generator: stable across renders/SSR.
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = cells[i]
    cells[i] = cells[j]
    cells[j] = tmp
  }
  // The two "particle" cells must sit far apart so they read as isolated
  // pixels instead of a pair — pin them to opposite corners of the tile.
  const particles: Cell[] = [[1, 1], [6, 4]]
  const rest = cells.filter(([c, r]) => !particles.some(([pc, pr]) => pc === c && pr === r))
  const ordered = [...particles, ...rest]
  const layers: Cell[][] = []
  let cursor = 0
  for (const size of LAYER_SIZES) {
    layers.push(ordered.slice(cursor, cursor + size))
    cursor += size
  }
  return layers
}

const LAYERS = buildLayers()
const INSET = (CELL - PIXEL) / 2

export function EffortDitherTrack({ className }: { className?: string }) {
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, "")
  const id = (suffix: string) => `effort-${uid}-${suffix}`

  return (
    <svg
      className={className}
      width="100%"
      height="100%"
      aria-hidden
      focusable="false"
      data-testid="effort-dither-track"
    >
      <defs>
        {LAYERS.map((cells, index) => (
          <pattern
            key={`p${index}`}
            id={id(`p${index}`)}
            width={TILE_W}
            height={TILE_H}
            patternUnits="userSpaceOnUse"
          >
            {cells.map(([col, row]) => {
              const twinkle = index < TWINKLE_LAYERS
              return (
                <rect
                  key={`${col}-${row}`}
                  className={twinkle ? "effort-dither-px effort-dither-twinkle" : "effort-dither-px"}
                  style={twinkle ? { animationDelay: `${twinkleDelayS(col, row).toFixed(2)}s` } : undefined}
                  x={col * CELL + INSET}
                  y={row * CELL + INSET}
                  width={PIXEL}
                  height={PIXEL}
                />
              )
            })}
          </pattern>
        ))}
        {LAYERS.map((_, index) => {
          const [from, to] = LAYER_RAMPS[index]
          return (
            <linearGradient key={`g${index}`} id={id(`g${index}`)} x1="0" y1="0" x2="1" y2="0">
              <stop offset={from} stopColor="#fff" stopOpacity={0} />
              <stop offset={to} stopColor="#fff" stopOpacity={1} />
            </linearGradient>
          )
        })}
        <linearGradient id={id("gsolid")} x1="0" y1="0" x2="1" y2="0">
          <stop offset={SOLID_RAMP[0]} stopColor="#fff" stopOpacity={0} />
          <stop offset={SOLID_RAMP[1]} stopColor="#fff" stopOpacity={1} />
        </linearGradient>
        {LAYERS.map((_, index) => (
          <mask
            key={`m${index}`}
            id={id(`m${index}`)}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="100%"
            height="100%"
          >
            <rect width="100%" height="100%" fill={`url(#${id(`g${index}`)})`} />
          </mask>
        ))}
        <mask id={id("msolid")} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <rect width="100%" height="100%" fill={`url(#${id("gsolid")})`} />
        </mask>
      </defs>

      {/* Grey start of the bar. */}
      <rect className="effort-dither-base" width="100%" height="100%" />
      {/* Fully saturated violet cap under the thumb. */}
      <rect className="effort-dither-ink" width="100%" height="100%" mask={`url(#${id("msolid")})`} />
      {/* Pixel layers — sparse particles first, full grid last. */}
      {LAYERS.map((_, index) => (
        <rect
          key={`l${index}`}
          className="effort-dither-layer"
          width="100%"
          height="100%"
          fill={`url(#${id(`p${index}`)})`}
          mask={`url(#${id(`m${index}`)})`}
        />
      ))}
    </svg>
  )
}

/** Exposed for unit tests: geometry + layer contract of the dither grid. */
export const EFFORT_DITHER_SPEC = Object.freeze({
  cell: CELL,
  pixel: PIXEL,
  tile: Object.freeze({ cols: TILE_COLS, rows: TILE_ROWS, width: TILE_W, height: TILE_H }),
  layerSizes: LAYER_SIZES,
  layerRamps: LAYER_RAMPS,
  solidRamp: SOLID_RAMP,
  layers: LAYERS,
  twinkleLayers: TWINKLE_LAYERS,
  twinklePeriodS: TWINKLE_PERIOD_S,
  twinkleDelayS,
})
