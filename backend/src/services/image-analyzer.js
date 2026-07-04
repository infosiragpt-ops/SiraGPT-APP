/**
 * Image analysis for the OCR pipeline — type classification + tiling plan.
 *
 * Two jobs:
 *  1. CLASSIFY what kind of image the user attached (document scan,
 *     screenshot, dense text wall, photo, chart/diagram, receipt) from
 *     cheap sharp statistics + OCR signals, so the extraction carries a
 *     professional description instead of a bare text dump.
 *  2. PLAN TILED OCR for oversized dense-text images. Tesseract input is
 *     resized to ~3000px; a 6000px-wide screenshot of small text loses
 *     half its glyph resolution in that downscale and reads garbage.
 *     Splitting into overlapping tiles keeps native resolution per tile.
 *
 * classifyImage / planTiles / shouldTileOcr are PURE (stats in, verdict
 * out) — unit-tested offline. Only computeImageStats touches sharp.
 */

const sharp = require('sharp');

const TYPE_LABELS_ES = {
  document_scan: 'documento escaneado',
  screenshot: 'captura de pantalla',
  text_dense: 'imagen de texto denso',
  photo: 'fotografía',
  chart_diagram: 'gráfico o diagrama',
  receipt: 'ticket o recibo',
  unknown: 'imagen',
};

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function tilingConfig() {
  return {
    enabled: process.env.SIRAGPT_OCR_TILING !== '0',
    // A tile side close to (but under) the 3000px OCR resize cap keeps
    // every tile at native resolution through preprocessing.
    targetTile: intFromEnv('SIRAGPT_OCR_TILE_TARGET', 2200),
    maxTiles: intFromEnv('SIRAGPT_OCR_TILE_MAX', 9),
    // Only images that actually GET downscaled today can benefit.
    triggerSide: intFromEnv('SIRAGPT_OCR_TILE_TRIGGER_SIDE', 3000),
    // Even an "accepted" single pass with this much text on a downscaled
    // image very likely lost content — worth the tiled second opinion.
    triggerChars: intFromEnv('SIRAGPT_OCR_TILE_TRIGGER_CHARS', 1500),
    overlap: 0.06,
  };
}

/**
 * Cheap image statistics via sharp. Returns null on unreadable input —
 * callers treat classification as best-effort.
 */
async function computeImageStats(input) {
  try {
    const img = sharp(input);
    const [meta, stats] = await Promise.all([img.metadata(), img.stats()]);
    const width = meta.width || 0;
    const height = meta.height || 0;
    const channels = stats.channels || [];
    const means = channels.slice(0, 3).map(c => c.mean);
    const luminance = means.length >= 3
      ? 0.299 * means[0] + 0.587 * means[1] + 0.114 * means[2]
      : (means[0] ?? 0);
    // Channel-mean spread as a saturation proxy: greyscale-ish content
    // (documents, most screenshots) has near-identical RGB means.
    const saturationSpread = means.length >= 3
      ? Math.max(...means) - Math.min(...means)
      : 0;
    return {
      width,
      height,
      megapixels: (width * height) / 1e6,
      aspect: height > 0 ? width / height : 1,
      luminance,
      saturationSpread,
      entropy: Number(stats.entropy || 0),
      whiteBackground: luminance >= 190,
      darkBackground: luminance <= 70,
      grayscaleish: saturationSpread <= 12,
    };
  } catch {
    return null;
  }
}

/**
 * Rule-based classification from image stats + OCR signals.
 * `ocrSignals`: { usefulChars, lineCount, confidence } from the final OCR
 * quality; textDensity is derived (chars per megapixel).
 * Returns { type, label, labelEs, confidence, textDensity }.
 */
function classifyImage(stats, ocrSignals = {}) {
  if (!stats) return { type: 'unknown', labelEs: TYPE_LABELS_ES.unknown, confidence: 0.2, textDensity: 0 };
  const usefulChars = Number(ocrSignals.usefulChars || 0);
  const megapixels = Math.max(stats.megapixels || 0, 0.01);
  const textDensity = usefulChars / megapixels;
  const { aspect, whiteBackground, darkBackground, grayscaleish, saturationSpread, entropy } = stats;

  const screenAspect = [16 / 9, 16 / 10, 4 / 3, 21 / 9, 9 / 16, 9 / 19.5, 3 / 4]
    .some(a => Math.abs(aspect - a) < 0.06);

  let type = 'unknown';
  let confidence = 0.4;

  if (aspect > 0 && aspect < 0.45 && whiteBackground && usefulChars > 40) {
    type = 'receipt';
    confidence = 0.75;
  } else if (textDensity >= 900 && (whiteBackground || darkBackground)) {
    // Wall-of-text: system dumps, logs, dense docs rendered as an image.
    type = 'text_dense';
    confidence = 0.85;
  } else if (whiteBackground && textDensity >= 150) {
    type = 'document_scan';
    confidence = 0.8;
  } else if ((grayscaleish || darkBackground) && screenAspect && usefulChars > 30) {
    type = 'screenshot';
    confidence = 0.7;
  } else if (screenAspect && textDensity >= 60) {
    type = 'screenshot';
    confidence = 0.6;
  } else if (!grayscaleish && saturationSpread >= 30 && entropy >= 6 && textDensity < 60) {
    type = 'photo';
    confidence = 0.7;
  } else if (whiteBackground && usefulChars > 0 && textDensity < 150) {
    type = 'chart_diagram';
    confidence = 0.55;
  } else if (usefulChars >= 100) {
    type = 'document_scan';
    confidence = 0.5;
  }

  return { type, labelEs: TYPE_LABELS_ES[type], confidence, textDensity: Math.round(textDensity) };
}

/**
 * Map a vision-model TYPE line (Spanish free text) to our canonical types.
 * The vision model sees the actual pixels, so when it speaks it wins over
 * the statistical guess.
 */
function normalizeVisionType(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (/captura|pantalla|screenshot/.test(s)) return 'screenshot';
  if (/denso|dump|log|c[oó]digo/.test(s)) return 'text_dense';
  if (/escanead|scan|documento/.test(s)) return 'document_scan';
  if (/foto|photo|imagen real/.test(s)) return 'photo';
  if (/gr[aá]fic|diagrama|chart|tabla/.test(s)) return 'chart_diagram';
  if (/ticket|recibo|factura/.test(s)) return 'receipt';
  return null;
}

/**
 * Should we run the tiled second pass? Pure decision from stats + the
 * single-pass quality.
 */
function shouldTileOcr(stats, quality, cfg = tilingConfig()) {
  if (!cfg.enabled || !stats) return false;
  const maxSide = Math.max(stats.width || 0, stats.height || 0);
  if (maxSide <= cfg.triggerSide) return false; // no downscale happened → single pass saw full resolution
  if (!quality) return true;
  if (!quality.accepted) return true; // weak read on a big image → tiles
  // Accepted but text-heavy: the downscale very likely dropped glyphs.
  return Number(quality.usefulChars || 0) >= cfg.triggerChars;
}

/**
 * Row-major tile plan with overlap so no text line is cut at a seam.
 * Returns [{ left, top, width, height, row, col }]. Pure geometry.
 */
function planTiles(width, height, cfg = tilingConfig()) {
  const target = cfg.targetTile;
  const cols = Math.max(1, Math.ceil(width / target));
  const rows = Math.max(1, Math.ceil(height / target));
  // Respect maxTiles by growing tile size instead of dropping regions.
  let effCols = cols;
  let effRows = rows;
  while (effCols * effRows > cfg.maxTiles) {
    if (effCols >= effRows && effCols > 1) effCols -= 1;
    else if (effRows > 1) effRows -= 1;
    else break;
  }
  const baseW = Math.ceil(width / effCols);
  const baseH = Math.ceil(height / effRows);
  const overlapX = Math.round(baseW * cfg.overlap);
  const overlapY = Math.round(baseH * cfg.overlap);
  const tiles = [];
  for (let r = 0; r < effRows; r += 1) {
    for (let c = 0; c < effCols; c += 1) {
      const left = Math.max(0, c * baseW - (c > 0 ? overlapX : 0));
      const top = Math.max(0, r * baseH - (r > 0 ? overlapY : 0));
      tiles.push({
        left,
        top,
        width: Math.min(baseW + (c > 0 ? overlapX : 0), width - left),
        height: Math.min(baseH + (r > 0 ? overlapY : 0), height - top),
        row: r,
        col: c,
      });
    }
  }
  return tiles;
}

module.exports = {
  TYPE_LABELS_ES,
  tilingConfig,
  computeImageStats,
  classifyImage,
  normalizeVisionType,
  shouldTileOcr,
  planTiles,
};
