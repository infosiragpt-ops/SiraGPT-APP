"use client"

/**
 * Dithered pixel-dissolve fill for the effort slider.
 *
 * Pure SVG — no raster asset. A cloud of small square "pixels" sits centred
 * on the rail and dissolves symmetrically toward both pale ends: density AND
 * opacity peak in the middle and fall off left and right, with a few isolated
 * pixels that read as particles near the edges and white sparkles glinting
 * in the dense core.
 *
 * How it is built (all responsive — nothing depends on the rendered width):
 *   • `<pattern patternUnits="userSpaceOnUse">` tiles keep every pixel a true
 *     square whatever the track width is (no viewBox stretching).
 *   • Six pattern layers hold disjoint subsets of an 8×4 cell tile. Layer 0
 *     is the sparse "particles" layer; each next layer adds more cells so the
 *     cumulative density climbs to a full grid.
 *   • Each layer is masked by a symmetric "tent" luminance gradient (flat
 *     opaque plateau around the centre, fading to 0 at the window edges).
 *     Narrower windows per layer make both the density (which layers are
 *     visible yet) and the opacity (how far into its ramp a layer is) grow
 *     toward the middle.
 *   • A soft violet core glows under the densest region, and a white sparkle
 *     layer glints only in the tight centre.
 *
 * The cell ordering is a seeded shuffle so SSR and client markup are byte
 * identical and the "particles" never move between renders.
 */

import * as React from "react"

const CELL = 4 // px — one grid cell (pixel + gap)
const PIXEL = 3 // px — the visible square inside a cell
const TILE_COLS = 8
const TILE_ROWS = 4
const TILE_W = TILE_COLS * CELL
const TILE_H = TILE_ROWS * CELL

/** Cells per layer — sums to TILE_COLS × TILE_ROWS (32). */
const LAYER_SIZES = [2, 4, 6, 6, 6, 8] as const

/**
 * Layers whose pixels shimmer. Only the sparse, outer layers twinkle — the
 * dense core, the glow and the sparkles stay rock-stable so the bar keeps
 * reading as a solid control, not a loading spinner.
 */
const TWINKLE_LAYERS = 3

/**
 * Heartbeat period (s): one lub-dub + rest. Per-pixel delays spread over the
 * full period so the thump travels along the bar instead of beating in sync.
 */
const TWINKLE_PERIOD_S = 2.4

/**
 * Deterministic shimmer delay for a cell: grows with the column (plus a
 * small row offset so neighbours never pulse in lockstep), wrapped into one
 * period. Because the delay is a function of position, the twinkle reads as
 * a wave travelling left → right across the bar.
 */
function twinkleDelayS(col: number, row: number): number {
  return (col * 0.35 + row * 0.13) % TWINKLE_PERIOD_S
}

/** Symmetric tent half-widths (fractions of the fill width) per layer. */
const LAYER_HALF_WIDTHS: ReadonlyArray<number> = [
  0.42, // particles: isolated pixels dissolving before the pale end caps
  0.36,
  0.29,
  0.22,
  0.15,
  0.1, // densest grid: tight core only
]

/** Soft violet core glowing under the densest region. */
const CORE_HALF_WIDTH = 0.15

/** White sparkles glinting in the tight centre. */
const SPARKLE_SIZE = 10
const SPARKLE_HALF_WIDTH = 0.12

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
  // pixels instead of a pair — pin them to opposite sides of the tile.
  const particles: Cell[] = [[1, 1], [6, 2]]
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
/** Sparkle cells ride on the dense core layers — deterministic, centre-masked. */
const SPARKLE_CELLS = [...LAYERS[LAYERS.length - 1], ...LAYERS[LAYERS.length - 2]].slice(0, SPARKLE_SIZE)
const INSET = (CELL - PIXEL) / 2

/**
 * Symmetric "tent" mask stops for a half-width w: flat opaque plateau
 * around the centre, fading to transparent at the window edges.
 */
function tentStops(w: number): Array<readonly [number, number]> {
  const inner = w * 0.35
  return [
    [0.5 - w, 0],
    [0.5 - inner, 1],
    [0.5 + inner, 1],
    [0.5 + w, 0],
  ]
}

function TentGradient({ id: gid, halfWidth }: { id: string; halfWidth: number }) {
  return (
    <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
      {tentStops(halfWidth).map(([offset, opacity]) => (
        <stop key={offset} offset={offset} stopColor="#fff" stopOpacity={opacity} />
      ))}
    </linearGradient>
  )
}

function PixelCells({ cells, twinkle }: { cells: Cell[]; twinkle: boolean }) {
  return (
    <>
      {cells.map(([col, row]) => (
        <rect
          key={`${col}-${row}`}
          className={twinkle ? "effort-dither-px effort-dither-twinkle" : "effort-dither-px"}
          style={twinkle ? { animationDelay: `${twinkleDelayS(col, row).toFixed(2)}s` } : undefined}
          x={col * CELL + INSET}
          y={row * CELL + INSET}
          width={PIXEL}
          height={PIXEL}
        />
      ))}
    </>
  )
}

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
            <PixelCells cells={cells} twinkle={index < TWINKLE_LAYERS} />
          </pattern>
        ))}
        <pattern
          id={id("psparkle")}
          width={TILE_W}
          height={TILE_H}
          patternUnits="userSpaceOnUse"
        >
          {SPARKLE_CELLS.map(([col, row]) => (
            <rect
              key={`${col}-${row}`}
              className="effort-dither-spark"
              x={col * CELL + INSET}
              y={row * CELL + INSET}
              width={PIXEL}
              height={PIXEL}
            />
          ))}
        </pattern>
        {LAYER_HALF_WIDTHS.map((halfWidth, index) => (
          <TentGradient key={`g${index}`} id={id(`g${index}`)} halfWidth={halfWidth} />
        ))}
        <TentGradient id={id("gcore")} halfWidth={CORE_HALF_WIDTH} />
        <TentGradient id={id("gsparkle")} halfWidth={SPARKLE_HALF_WIDTH} />
        {LAYER_HALF_WIDTHS.map((_, index) => (
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
        <mask id={id("mcore")} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <rect width="100%" height="100%" fill={`url(#${id("gcore")})`} />
        </mask>
        <mask id={id("msparkle")} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <rect width="100%" height="100%" fill={`url(#${id("gsparkle")})`} />
        </mask>
      </defs>

      {/* Pale rail shows through at both ends. */}
      <rect className="effort-dither-base" width="100%" height="100%" />
      {/* Soft violet core glowing under the densest region. */}
      <rect className="effort-dither-core" width="100%" height="100%" mask={`url(#${id("mcore")})`} />
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
      {/* White sparkles glinting in the tight centre. */}
      <rect
        className="effort-dither-sparkle-layer"
        width="100%"
        height="100%"
        fill={`url(#${id("psparkle")})`}
        mask={`url(#${id("msparkle")})`}
      />
    </svg>
  )
}

/** Exposed for unit tests: geometry + layer contract of the dither grid. */
export const EFFORT_DITHER_SPEC = Object.freeze({
  cell: CELL,
  pixel: PIXEL,
  tile: Object.freeze({ cols: TILE_COLS, rows: TILE_ROWS, width: TILE_W, height: TILE_H }),
  layerSizes: LAYER_SIZES,
  layerHalfWidths: LAYER_HALF_WIDTHS,
  coreHalfWidth: CORE_HALF_WIDTH,
  sparkleSize: SPARKLE_SIZE,
  sparkleHalfWidth: SPARKLE_HALF_WIDTH,
  layers: LAYERS,
  sparkleCells: SPARKLE_CELLS,
  tentStops,
  twinkleLayers: TWINKLE_LAYERS,
  twinklePeriodS: TWINKLE_PERIOD_S,
  twinkleDelayS,
})
