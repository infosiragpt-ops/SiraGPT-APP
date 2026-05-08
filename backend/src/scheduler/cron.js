/**
 * cron.js — minimal 5-field cron and "every Ns" parser.
 *
 * Fields (in order):  minute hour day-of-month month day-of-week
 *   minute     0-59
 *   hour       0-23
 *   dom        1-31
 *   month      1-12
 *   dow        0-6   (0=Sunday, 7 also accepted)
 *
 * Supported syntax per field:
 *   *         → all values
 *   a         → exact value
 *   a-b       → inclusive range
 *   a,b,c     → list
 *   *\/n      → every n starting at field min
 *   a-b/n     → every n in range
 *
 * Interval syntax:
 *   "every 30s" | "every 5m" | "every 2h" | "every 1d"
 *
 * Exposes:
 *   parseSchedule(expr) -> { kind, ... }
 *   nextAfter(parsed, fromDate) -> Date
 */

'use strict';

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour',   min: 0, max: 23 },
  { name: 'dom',    min: 1, max: 31 },
  { name: 'month',  min: 1, max: 12 },
  { name: 'dow',    min: 0, max: 6  },
];

class CronParseError extends Error {
  constructor(message) { super(message); this.name = 'CronParseError'; }
}

function parseField(raw, idx) {
  const { name, min, max } = FIELD_RANGES[idx];
  const out = new Set();
  const tokens = String(raw).split(',');
  for (const tok of tokens) {
    const t = tok.trim();
    if (!t) throw new CronParseError(`empty token in ${name}`);
    let stepPart = '1';
    let rangePart = t;
    const slash = t.indexOf('/');
    if (slash >= 0) {
      rangePart = t.slice(0, slash);
      stepPart = t.slice(slash + 1);
    }
    const step = Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new CronParseError(`invalid step "${stepPart}" in ${name}`);
    }
    let lo, hi;
    if (rangePart === '*') {
      lo = min; hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a); hi = Number(b);
    } else {
      lo = Number(rangePart); hi = lo;
    }
    if (name === 'dow' && lo === 7) lo = 0;
    if (name === 'dow' && hi === 7) hi = 0;
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new CronParseError(`invalid range "${rangePart}" in ${name}`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronParseError(`out-of-range "${rangePart}" in ${name}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(`cron must have 5 fields, got ${parts.length}: "${expr}"`);
  }
  return {
    kind: 'cron',
    expr,
    minute: parseField(parts[0], 0),
    hour:   parseField(parts[1], 1),
    dom:    parseField(parts[2], 2),
    month:  parseField(parts[3], 3),
    dow:    parseField(parts[4], 4),
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

function parseInterval(expr) {
  const m = /^every\s+(\d+)\s*(s|m|h|d)$/i.exec(String(expr).trim());
  if (!m) throw new CronParseError(`invalid interval "${expr}"`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = n * multipliers[unit];
  if (ms <= 0) throw new CronParseError(`interval must be > 0`);
  return { kind: 'interval', expr, intervalMs: ms };
}

function parseSchedule(expr) {
  const s = String(expr).trim();
  if (/^every\s+/i.test(s)) return parseInterval(s);
  return parseCron(s);
}

function nextAfterCron(parsed, from) {
  // Search minute-by-minute up to 4 years ahead (bounded).
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = 366 * 24 * 60 * 4; // 4 years of minutes
  const d = start;
  for (let i = 0; i < limit; i += 1) {
    const minute = d.getMinutes();
    const hour = d.getHours();
    const dom = d.getDate();
    const month = d.getMonth() + 1;
    const dow = d.getDay();

    if (!parsed.month.has(month)) {
      // jump to first day of next month
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    let dayOk;
    if (parsed.domRestricted && parsed.dowRestricted) {
      dayOk = parsed.dom.has(dom) || parsed.dow.has(dow);
    } else if (parsed.domRestricted) {
      dayOk = parsed.dom.has(dom);
    } else if (parsed.dowRestricted) {
      dayOk = parsed.dow.has(dow);
    } else {
      dayOk = true;
    }
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hour.has(hour)) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minute.has(minute)) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(d.getTime());
  }
  throw new CronParseError(`no match within search horizon for "${parsed.expr}"`);
}

function nextAfter(parsed, fromDate) {
  const from = fromDate instanceof Date ? fromDate : new Date(fromDate);
  if (parsed.kind === 'interval') {
    return new Date(from.getTime() + parsed.intervalMs);
  }
  if (parsed.kind === 'cron') return nextAfterCron(parsed, from);
  throw new CronParseError(`unknown schedule kind "${parsed.kind}"`);
}

module.exports = {
  parseSchedule,
  parseCron,
  parseInterval,
  nextAfter,
  CronParseError,
};
