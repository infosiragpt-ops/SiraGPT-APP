'use strict';

/**
 * cron-expression — parser + nextRun() for the classic 5-field crontab
 * format: `minute hour day-of-month month day-of-week`. Pairs with
 * the lease-mutex (#26) so a "exactly one worker fires this job"
 * scheduler can compute its next deadline without pulling in a 30k-
 * LOC dependency.
 *
 * Supported per-field syntax:
 *   *           — every value
 *   N           — single value
 *   N,M,...     — list
 *   N-M         — range
 *   N-M/S       — range with step
 *   *\/S        — every S from field minimum
 *
 * Day-of-week: 0 or 7 = Sunday. Month and DOW name aliases are NOT
 * supported (keep it small + deterministic).
 *
 * If both DOM (field 3) and DOW (field 5) are restricted (i.e. not '*'),
 * we honor crontab's "OR" rule: a fire is allowed when EITHER matches.
 *
 * Public API:
 *   parseCron(expr)            → { fields[5] of Set<number> }
 *   matches(parsed, date)      → boolean (does this minute match?)
 *   nextRun(parsed, fromDate)  → Date  (next strictly-greater minute)
 *   isValidExpression(expr)    → boolean
 */

const FIELD_RANGES = [
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day-of-month
  [1, 12],   // month
  [0, 7],    // day-of-week (0 = Sunday; 7 also accepted, normalized to 0)
];
const FIELD_NAMES = ['minute', 'hour', 'dom', 'month', 'dow'];

class CronError extends Error {
  constructor(message) { super(message); this.name = 'CronError'; }
}

function expandField(token, [lo, hi]) {
  const out = new Set();
  for (const part of String(token).split(',')) {
    const slash = part.indexOf('/');
    let head = slash === -1 ? part : part.slice(0, slash);
    const step = slash === -1 ? 1 : Number(part.slice(slash + 1));
    if (!Number.isInteger(step) || step <= 0) throw new CronError(`bad step in "${part}"`);
    let from, to;
    if (head === '*') { from = lo; to = hi; }
    else if (head.includes('-')) {
      const [a, b] = head.split('-');
      from = Number(a); to = Number(b);
    } else {
      // A bare number WITH a step ("5/15") means "from 5 to the max, every 15"
      // — expand to hi. Without a step it's the single value N.
      from = Number(head);
      to = slash === -1 ? Number(head) : hi;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new CronError(`bad range in "${part}"`);
    if (from < lo || to > hi || from > to) throw new CronError(`out-of-range "${part}" for ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr) {
  if (typeof expr !== 'string' || !expr.trim()) throw new CronError('cron: empty expression');
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) throw new CronError(`cron: expected 5 fields, got ${tokens.length}`);
  const fields = tokens.map((t, i) => expandField(t, FIELD_RANGES[i]));
  // Normalize DOW: 7 → 0.
  if (fields[4].has(7)) { fields[4].delete(7); fields[4].add(0); }
  // Track whether DOM and DOW are unrestricted (originally '*').
  const domRestricted = tokens[2] !== '*';
  const dowRestricted = tokens[4] !== '*';
  return { fields, domRestricted, dowRestricted };
}

function matches(parsed, date) {
  const m = date.getMinutes();
  const h = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();
  const [fmin, fhour, fdom, fmon, fdow] = parsed.fields;
  if (!fmin.has(m)) return false;
  if (!fhour.has(h)) return false;
  if (!fmon.has(mon)) return false;
  // crontab OR rule for DOM/DOW when both restricted.
  const domOk = fdom.has(dom);
  const dowOk = fdow.has(dow);
  if (parsed.domRestricted && parsed.dowRestricted) {
    if (!(domOk || dowOk)) return false;
  } else {
    if (!domOk || !dowOk) return false;
  }
  return true;
}

function nextRun(parsed, fromDate) {
  const start = new Date(fromDate);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  // Try minute-by-minute up to ~5 years (lots of headroom; in practice
  // the loop fires immediately for any sensible expression).
  const cap = 5 * 366 * 24 * 60;
  const cur = new Date(start);
  for (let i = 0; i < cap; i++) {
    if (matches(parsed, cur)) return new Date(cur);
    cur.setMinutes(cur.getMinutes() + 1);
  }
  throw new CronError('cron: no match within 5 years');
}

function isValidExpression(expr) {
  try { parseCron(expr); return true; }
  catch { return false; }
}

module.exports = {
  parseCron,
  matches,
  nextRun,
  isValidExpression,
  CronError,
  FIELD_RANGES,
  FIELD_NAMES,
};
