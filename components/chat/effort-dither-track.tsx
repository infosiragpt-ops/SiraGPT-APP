"use client"

/**
 * Dithered pixel-dissolve fill for the effort slider.
 *
 * Pure SVG — no raster asset. A cloud of tiny square "pixels" grows from pale,
 * isolated particles on the left into a dense violet grid toward the right,
 * so the filled part always gets stronger as it approaches the active stop
 * and reads as a full bar at Max.
 *
 * Advanced treatment:
 *   • Finer grid: 2 px pixels on a 3 px cell (10×5 tile) for a delicate,
 *     designed texture instead of coarse noise.
 *   • Ordered dissolve: cells are sorted by a Bayer matrix, so the density
 *     ramps wear the classic halftone pattern professionals use — a regular,
 *     intentional texture rather than random scatter.
 *   • Color depth: three violet tones — light particles in the sparse zone,
 *     the base violet in the body, and a deeper violet in the dense zone —
 *     layered over a gradient under-glow.
 *   • Ten overlapped left→right ramp masks: each layer fades in over its own
 *     window and stays opaque, giving a silky (not bandy) gradient.
 *   • White sparkles glint only in the dense zone.
 *
 * "Muy avanzada": how it looks like a designed professional control.
 *
 * How it is built (all responsive — nothing depends on the rendered width):
 *   • `<pattern patternUnits="userSpaceOnUse">` tiles keep every pixel a true
 *     square whatever the track width is (no viewBox stretching).
 *
 * The cell ordering is deterministic (Bayer value primary, position tie-
 * breaker) so SSR and client markup are byte identical and the "particles"
 * never move between renders.
 */

import * as React from "react"

const CELL = 3 // px — one grid cell (pixel + gap)
const PIXEL = 2 // px — the visible square inside a cell
const TILE_COLS = 10
const TILE_ROWS = 5
const TILE_W = TILE_COLS * CELL
const TILE_H = TILE_ROWS * CELL

/** Cells per layer — one fifth of the tile each (50). */
const LAYER_SIZES = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5] as const

/** Color tiers per layer index: light particles → base violet → deep violet. */
function depthClass(index: number): string {
  if (index < 3) return "effort-dither-px effort-dither-px-light"
  if (index > 6) return "effort-dither-px effort-dither-px-deep"
  return "effort-dither-px"
}

/**
 * Layers whose pixels shimmer. Only the sparse, leftmost layers twinkle — the
 * dense zone, the glow and the sparkles stay rock-stable so the bar keeps
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

/**
 * Left→right ramp windows (fractions of the fill width) per layer: each layer
 * fades in over [from, to] and stays opaque after `to`. Later layers start
 * further right, so density and opacity grow toward the active stop.
 */
const LAYER_RAMPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.18], // particles: isolated pixels from the very start
  [0.06, 0.26],
  [0.11, 0.34],
  [0.16, 0.42],
  [0.21, 0.5],
  [0.26, 0.58],
  [0.31, 0.66],
  [0.36, 0.74],
  [0.41, 0.82],
  [0.46, 0.9], // densest grid: completes before the right end
]

/** Soft violet core glowing under the dense right side. */
const CORE_RAMP: readonly [number, number] = [0.4, 0.95]

/** White sparkles glinting in the dense right zone. */
const SPARKLE_SIZE = 5
const SPARKLE_RAMP: readonly [number, number] = [0.55, 0.9]

/** Bayer matrix disperses cells across the tile in a regular halftone order. */
const BAYER_4x4: readonly number[] = [
  0, 8, 2, 10, 12, 4, 14, 6,
  3, 11, 1, 9, 15, 7, 13, 5,
]
function bayerValue(col: number, row: number): number {
  return BAYER_4x4[(row % 4) * 4 + (col % 4)]
}

type Cell = readonly [col: number, row: number]

function buildLayers(): Cell[][] {
  const cells: Cell[] = []
  for (let row = 0; row < TILE_ROWS; row += 1) {
    for (let col = 0; col < TILE_COLS; col += 1) cells.push([col, row])
  }
  // Ordered dissolve: Bayer value first, position as tie-breaker, so the
  // pattern is the classic halftone designed texture, not random scatter.
  cells.sort((a, b) => {
    const bDiff = bayerValue(a[0], a[1]) - bayerValue(b[0], b[1])
    if (bDiff !== 0) return bDiff
    return a[0] - b[0] || a[1] - b[1]
  })
  const layers: Cell[][] = []
  let cursor = 0
  for (const size of LAYER_SIZES) {
    layers.push(cells.slice(cursor, cursor + size))
    cursor += size
  }
  return layers
}

const LAYERS = buildLayers()
/** Sparkle cells ride on the densest two layers — deterministic, centre-masked. */
const SPARKLE_CELLS = [...LAYERS[LAYERS.length - 1], ...LAYERS[LAYERS.length - 2]].slice(0, SPARKLE_SIZE)
const INSET = (CELL - PIXEL) / 2

/**
 * Left→right ramp mask stops: transparent until `from`, fully opaque from
 * `to` onward (gradients hold their last stop value).
 */
function rampStops(from: number, to: number): Array<readonly [number, number]> {
  return [
    [from, 0],
    [to, 1],
  ]
}

function RampGradient({ id: gid, from, to }: { id: string; from: number; to: number }) {
  return (
    <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
      {rampStops(from, to).map(([offset, opacity]) => (
        <stop key={offset} offset={offset} stopColor="#fff" stopOpacity={opacity} />
      ))}
    </linearGradient>
  )
}

function PixelCells({ cells, layerIndex }: { cells: Cell[]; layerIndex: number }) {
  const cls = depthClass(layerIndex)
  return (
    <>
      {cells.map(([col, row]) => (
        <rect
          key={`${col}-${row}`}
          className={
            layerIndex < TWINKLE_LAYERS
              ? `${cls} effort-dither-twinkle`
              : cls
          }
          style={
            layerIndex < TWINKLE_LAYERS
              ? { animationDelay: `${twinkleDelayS(col, row).toFixed(2)}s` }
              : undefined
          }
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
            <PixelCells cells={cells} layerIndex={index} />
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
        {LAYER_RAMPS.map(([from, to], index) => (
          <RampGradient key={`g${index}`} id={id(`g${index}`)} from={from} to={to} />
        ))}
        <RampGradient id={id("gcore")} from={CORE_RAMP[0]} to={CORE_RAMP[1]} />
        <RampGradient id={id("gsparkle")} from={SPARKLE_RAMP[0]} to={SPARKLE_RAMP[1]} />
        {LAYER_RAMPS.map((_, index) => (
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
      {/* Soft violet core glowing under the dense right side. */}
      <rect className="effort-dither-core" width="100%" height="100%" mask={`url(#${id("mcore")})`} />
      {/* Pixel layers — light particles first, deep violet grid last. */}
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
      {/* White sparkles glinting in the dense right zone. */}
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
  depthClass,
  layerRamps: LAYER_RAMPS,
  coreRamp: CORE_RAMP,
  sparkleSize: SPARKLE_SIZE,
  sparkleRamp: SPARKLE_RAMP,
  layers: LAYERS,
  sparkleCells: SPARKLE_CELLS,
  rampStops,
  bayerValue,
  twinkleLayers: TWINKLE_LAYERS,
  twinklePeriodS: TWINKLE_PERIOD_S,
  twinkleDelayS,
})
