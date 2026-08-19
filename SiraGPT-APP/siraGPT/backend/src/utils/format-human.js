'use strict';

/**
 * format-human — small set of human-readable formatters used across
 * the audit log (#14), structured logger (#43), and dashboards. No
 * Intl, no locale; the goal is a stable, terse representation
 * regardless of the runtime's i18n config.
 *
 * Public API:
 *   formatBytes(n, { binary = true, decimals = 1 })  — '1.5 MB' / '1.5 MiB'
 *   formatDuration(ms, { compact = false })           — '1m 23s' / '1m23s'
 *   formatNumber(n, { decimals })                     — '1.2k', '3.4M'
 *   parseDuration('2h30m')                            — ms (inverse)
 */

const BIN_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
const DEC_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
const SI_UNITS = ['', 'k', 'M', 'B', 'T'];

function formatBytes(n, { binary = true, decimals = 1 } = {}) {
  const bytes = Number(n);
  if (!Number.isFinite(bytes)) return 'NaN B';
  const abs = Math.abs(bytes);
  if (abs < 1) return `${bytes} B`;
  const base = binary ? 1024 : 1000;
  const units = binary ? BIN_UNITS : DEC_UNITS;
  const i = Math.min(units.length - 1, Math.floor(Math.log(abs) / Math.log(base)));
  const v = bytes / Math.pow(base, i);
  const fixed = i === 0 ? Math.round(v).toString() : v.toFixed(decimals);
  return `${fixed} ${units[i]}`;
}

function formatDuration(ms, { compact = false } = {}) {
  const v = Number(ms);
  if (!Number.isFinite(v)) return 'NaN';
  const sign = v < 0 ? '-' : '';
  let n = Math.abs(v);
  if (n < 1000) return `${sign}${Math.round(n)}ms`;
  const sep = compact ? '' : ' ';
  const sec = Math.floor(n / 1000);
  if (sec < 60) {
    const remMs = Math.round(n - sec * 1000);
    return remMs > 0
      ? `${sign}${sec}s${sep}${remMs}ms`
      : `${sign}${sec}s`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const remSec = sec - min * 60;
    return remSec > 0
      ? `${sign}${min}m${sep}${remSec}s`
      : `${sign}${min}m`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const remMin = min - hr * 60;
    return remMin > 0
      ? `${sign}${hr}h${sep}${remMin}m`
      : `${sign}${hr}h`;
  }
  const day = Math.floor(hr / 24);
  const remHr = hr - day * 24;
  return remHr > 0
    ? `${sign}${day}d${sep}${remHr}h`
    : `${sign}${day}d`;
}

function formatNumber(n, { decimals = 1 } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'NaN';
  const abs = Math.abs(v);
  if (abs < 1000) return v.toString();
  const i = Math.min(SI_UNITS.length - 1, Math.floor(Math.log10(abs) / 3));
  const scaled = v / Math.pow(1000, i);
  return `${scaled.toFixed(decimals)}${SI_UNITS[i]}`;
}

const DURATION_RE = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseDuration(str) {
  if (typeof str !== 'string' || !str) return 0;
  let total = 0;
  let matched = false;
  DURATION_RE.lastIndex = 0;
  let m;
  while ((m = DURATION_RE.exec(str)) != null) {
    matched = true;
    total += Number(m[1]) * UNIT_MS[m[2]];
  }
  if (!matched) {
    const n = Number(str);
    return Number.isFinite(n) ? n : 0;
  }
  return total;
}

module.exports = {
  formatBytes,
  formatDuration,
  formatNumber,
  parseDuration,
  BIN_UNITS,
  DEC_UNITS,
};
