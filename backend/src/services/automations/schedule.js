'use strict';

/**
 * Natural-language schedules for the chat agent's automations (OpenClaw
 * «Automations» parity, rewritten natively — no upstream code).
 *
 * `parseNaturalSchedule(text, { now, tz })` turns what the user said into one
 * of three schedule kinds, all expressible with the existing
 * `ScheduledAgentTask` columns (`cronExpr` + `tz`, no migration):
 *
 *   at    — one shot: «en 20 minutos», «mañana a las 9», «el viernes a las
 *           10:30», «hoy a las 18», «el 15 de octubre a las 10», ISO dates.
 *           cronExpr is the minute of that instant (the worker deletes the
 *           job after it fires, so the yearly cron repeat never happens).
 *   every — «cada 15 minutos», «cada 2 horas», «cada día», «10m», «2h»
 *           (/loop style). Intervals the cron grammar cannot express (every
 *           7 min, every 5 h) snap to the nearest divisor and say so.
 *   cron  — «cada lunes a las 9», «todos los días a las 8», «lunes a viernes
 *           a las 9», «cada mes el día 1», «cada semana», a raw 5-field cron.
 *
 * Times are interpreted in the user's IANA time zone (`tz`); the result keeps
 * `tz` so `cron-parser` fires at the right wall-clock hour across DST.
 * Bilingual ES/EN, accent-insensitive. Pure: no I/O, injectable `now`.
 */

const cronParser = require('cron-parser');
const nodeCron = require('node-cron');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Longest a one-shot may be scheduled ahead (a typo like «en 2000 días»). */
const MAX_AT_AHEAD_MS = 366 * DAY_MS;
/** A one-shot must be at least this far ahead (the worker ticks once a minute). */
const MIN_AT_AHEAD_MS = 30_000;

const DAY_INDEX = {
  domingo: 0, dom: 0, sunday: 0, sun: 0,
  lunes: 1, lun: 1, monday: 1, mon: 1,
  martes: 2, mar: 2, tuesday: 2, tue: 2, tues: 2,
  miercoles: 3, mie: 3, wednesday: 3, wed: 3,
  jueves: 4, jue: 4, thursday: 4, thu: 4, thur: 4, thurs: 4,
  viernes: 5, vie: 5, friday: 5, fri: 5,
  sabado: 6, sab: 6, saturday: 6, sat: 6,
};
const DAY_WORDS = Object.keys(DAY_INDEX).sort((a, b) => b.length - a.length);
const DAY_RE_SRC = `(?:${DAY_WORDS.join('|')})`;
const DAY_LABEL_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTH_INDEX = {
  enero: 1, january: 1, jan: 1, ene: 1,
  febrero: 2, february: 2, feb: 2,
  marzo: 3, march: 3, mar: 3,
  abril: 4, april: 4, apr: 4, abr: 4,
  mayo: 5, may: 5,
  junio: 6, june: 6, jun: 6,
  julio: 7, july: 7, jul: 7,
  agosto: 8, august: 8, aug: 8, ago: 8,
  septiembre: 9, setiembre: 9, september: 9, sep: 9, sept: 9, set: 9,
  octubre: 10, october: 10, oct: 10,
  noviembre: 11, november: 11, nov: 11,
  diciembre: 12, december: 12, dec: 12, dic: 12,
};
const MONTH_RE_SRC = `(?:${Object.keys(MONTH_INDEX).sort((a, b) => b.length - a.length).join('|')})`;
const MONTH_LABEL_ES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const UNIT_MS = {
  s: 1000, seg: 1000, segundo: 1000, segundos: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MINUTE_MS, min: MINUTE_MS, mins: MINUTE_MS, minuto: MINUTE_MS, minutos: MINUTE_MS, minute: MINUTE_MS, minutes: MINUTE_MS,
  h: HOUR_MS, hr: HOUR_MS, hrs: HOUR_MS, hora: HOUR_MS, horas: HOUR_MS, hour: HOUR_MS, hours: HOUR_MS,
  d: DAY_MS, dia: DAY_MS, dias: DAY_MS, day: DAY_MS, days: DAY_MS,
  w: WEEK_MS, sem: WEEK_MS, semana: WEEK_MS, semanas: WEEK_MS, week: WEEK_MS, weeks: WEEK_MS,
};
const UNIT_RE_SRC = `(?:${Object.keys(UNIT_MS).sort((a, b) => b.length - a.length).join('|')})`;
const NUMBER_WORDS = {
  un: 1, una: 1, uno: 1, one: 1, a: 1, an: 1,
  dos: 2, two: 2, tres: 3, three: 3, cuatro: 4, four: 4, cinco: 5, five: 5,
  seis: 6, six: 6, siete: 7, seven: 7, ocho: 8, eight: 8, nueve: 9, nine: 9,
  diez: 10, ten: 10, quince: 15, fifteen: 15, veinte: 20, twenty: 20, treinta: 30, thirty: 30,
  media: 0.5, half: 0.5,
};
const NUMBER_RE_SRC = `(?:\\d+(?:[.,]\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;

// «a las 9», «a las 9:30», «at 9pm», «a las 18h», «9 y media», «a las 9 de la noche»
const TIME_RE_SRC = '(?:a\\s+las?\\s+|at\\s+|@\\s*)?(\\d{1,2})(?::(\\d{2}))?\\s*(?:h(?:rs|s)?\\b)?\\s*(y\\s+media|y\\s+cuarto|am|pm|a\\.m\\.|p\\.m\\.|de\\s+la\\s+(?:manana|madrugada)|de\\s+la\\s+tarde|de\\s+la\\s+noche|in\\s+the\\s+(?:morning|afternoon|evening))?';

function stripAccents(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeText(value) {
  return stripAccents(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function toNumber(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, text)) return NUMBER_WORDS[text];
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** Valid IANA zone or the fallback (never throws). */
function normalizeTimeZone(tz, fallback = 'UTC') {
  const candidate = String(tz || '').trim();
  if (!candidate || candidate.length > 64) return fallback;
  try {
    // Intl canonicalises casing ("america/lima" → "America/Lima").
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return fallback;
  }
}

/** Wall-clock parts of `date` in `tz`. */
function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  const hour = Number(out.hour) % 24; // Intl may print "24" at midnight in some engines
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour, minute: Number(out.minute), second: Number(out.second),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday),
  };
}

/** Offset (ms) of `tz` relative to UTC at the given instant. */
function tzOffsetMs(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant for a wall-clock {year, month, day, hour, minute} in `tz` (DST-safe). */
function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = guess - tzOffsetMs(new Date(guess), tz);
  // Second pass fixes a guess that landed on the other side of a DST shift.
  utc = guess - tzOffsetMs(new Date(utc), tz);
  return new Date(utc);
}

function parseTimeMatch(hRaw, mRaw, suffixRaw) {
  let hour = Number(hRaw);
  let minute = mRaw == null ? 0 : Number(mRaw);
  const suffix = normalizeText(suffixRaw || '');
  if (/y media/.test(suffix)) minute = 30;
  if (/y cuarto/.test(suffix)) minute = 15;
  const pm = /^(pm|p\.m\.)$/.test(suffix) || /tarde|noche|afternoon|evening/.test(suffix);
  const am = /^(am|a\.m\.)$/.test(suffix) || /manana|madrugada|morning/.test(suffix);
  if (pm && hour < 12) hour += 12;
  if (am && hour === 12) hour = 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

const TIME_SUFFIX_SRC = '(y\\s+media|y\\s+cuarto|am|pm|a\\.m\\.|p\\.m\\.|de\\s+la\\s+(?:manana|madrugada)|de\\s+la\\s+tarde|de\\s+la\\s+noche|in\\s+the\\s+(?:morning|afternoon|evening))';
// Three shapes count as a time of day: «a las 9[:30]» / «at 9», «9:30», «9pm» / «9 de la noche».
const TIME_FORMS = [
  new RegExp(`(?:^|\\s)(?:a\\s+las?\\s+|at\\s+|@\\s*)(\\d{1,2})(?::(\\d{2}))?\\s*(?:h(?:rs|s)?(?=\\s|$))?(?:\\s*${TIME_SUFFIX_SRC})?(?=\\s|$)`),
  new RegExp(`(?:^|\\s)(\\d{1,2}):(\\d{2})(?:\\s*${TIME_SUFFIX_SRC})?(?=\\s|$)`),
  new RegExp(`(?:^|\\s)(\\d{1,2})()\\s*${TIME_SUFFIX_SRC}(?=\\s|$)`),
];

/** Extract «a las HH[:MM] [am|pm|…]» / «HH:MM» / «9pm» anywhere in the text; null when absent. */
function extractTime(text) {
  if (/\\bmediodia\\b|\\bnoon\\b/.test(text)) return { hour: 12, minute: 0, matched: true };
  if (/\\bmedianoche\\b|\\bmidnight\\b/.test(text)) return { hour: 0, minute: 0, matched: true };
  for (const re of TIME_FORMS) {
    const m = re.exec(text);
    if (!m) continue;
    const parsed = parseTimeMatch(m[1], m[2] || null, m[3]);
    if (parsed) return { ...parsed, matched: true };
  }
  return null;
}

/** The text without its time-of-day phrase (so a day number is never read as an hour). */
function stripTime(text) {
  let out = text;
  for (const re of TIME_FORMS) out = out.replace(re, ' ');
  return out.replace(/\\s+/g, ' ').trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function cronForAt(date, tz) {
  const p = localParts(date, tz);
  return `${p.minute} ${p.hour} ${p.day} ${p.month} *`;
}

const MINUTE_DIVISORS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const HOUR_DIVISORS = [1, 2, 3, 4, 6, 8, 12];

function nearest(list, value) {
  return list.reduce((best, n) => (Math.abs(n - value) < Math.abs(best - value) ? n : best), list[0]);
}

/**
 * Cron expression for a fixed interval. `anchor` (local parts) gives the
 * minute/hour used by daily and weekly intervals. Returns { cronExpr,
 * everyMs, adjusted } — `adjusted` names the snap when the interval was not
 * expressible as-is.
 */
function cronForEvery(everyMs, { anchor = null } = {}) {
  const ms = Number(everyMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minute = anchor ? anchor.minute : 0;
  const hour = anchor ? anchor.hour : 9;
  if (ms < HOUR_MS) {
    const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
    const snapped = MINUTE_DIVISORS.includes(minutes) ? minutes : nearest(MINUTE_DIVISORS, minutes);
    return {
      cronExpr: snapped === 1 ? '* * * * *' : `*/${snapped} * * * *`,
      everyMs: snapped * MINUTE_MS,
      adjusted: snapped === minutes ? null : `cada ${snapped} min (cada ${minutes} min no es expresable)`,
    };
  }
  if (ms < DAY_MS) {
    const hours = Math.max(1, Math.round(ms / HOUR_MS));
    const snapped = HOUR_DIVISORS.includes(hours) ? hours : nearest(HOUR_DIVISORS, hours);
    return {
      cronExpr: snapped === 1 ? `${minute} * * * *` : `${minute} */${snapped} * * *`,
      everyMs: snapped * HOUR_MS,
      adjusted: snapped === hours ? null : `cada ${snapped} h (cada ${hours} h no es expresable)`,
    };
  }
  if (ms < WEEK_MS) {
    const days = Math.max(1, Math.round(ms / DAY_MS));
    if (days === 1) return { cronExpr: `${minute} ${hour} * * *`, everyMs: DAY_MS, adjusted: null };
    return { cronExpr: `${minute} ${hour} */${Math.min(days, 28)} * *`, everyMs: days * DAY_MS, adjusted: null };
  }
  const weeks = Math.max(1, Math.round(ms / WEEK_MS));
  const weekday = anchor ? anchor.weekday : 1;
  return {
    cronExpr: `${minute} ${hour} * * ${weekday}`,
    everyMs: WEEK_MS,
    adjusted: weeks === 1 ? null : 'cada semana (cron no expresa «cada N semanas»)',
  };
}

function parseDays(text) {
  const found = [];
  const re = new RegExp(`\\b${DAY_RE_SRC}\\b`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = DAY_INDEX[m[0]];
    if (idx !== undefined && !found.includes(idx)) found.push(idx);
  }
  return found;
}

function isValidCron(expr) {
  const text = String(expr || '').trim();
  if (!/^\S+(\s+\S+){4}$/.test(text)) return false;
  try {
    if (!nodeCron.validate(text)) return false;
    cronParser.parseExpression(text, { currentDate: new Date(0) });
    return true;
  } catch {
    return false;
  }
}

function nextCronDate(cronExpr, tz, from) {
  return cronParser.parseExpression(cronExpr, { currentDate: from, tz }).next().toDate();
}

function nextOccurrenceOnWeekday({ now, tz, weekday, hour, minute, strictlyAfter = true }) {
  const today = localParts(now, tz);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidateDay = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const cp = localParts(candidateDay, 'UTC');
    if (weekday !== null && candidateDay.getUTCDay() !== weekday) continue;
    const at = zonedTimeToUtc({ year: cp.year, month: cp.month, day: cp.day, hour, minute }, tz);
    if (!strictlyAfter || at.getTime() - now.getTime() >= MIN_AT_AHEAD_MS) return at;
  }
  return null;
}

function describeAt(at, tz, now) {
  const p = localParts(at, tz);
  const n = localParts(now, tz);
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  const sameDay = p.year === n.year && p.month === n.month && p.day === n.day;
  const tomorrow = localParts(new Date(now.getTime() + DAY_MS), tz);
  const isTomorrow = p.year === tomorrow.year && p.month === tomorrow.month && p.day === tomorrow.day;
  if (sameDay) return `hoy a las ${time}`;
  if (isTomorrow) return `mañana a las ${time}`;
  return `el ${DAY_LABEL_ES[p.weekday]} ${p.day} de ${MONTH_LABEL_ES[p.month]}${p.year !== n.year ? ` de ${p.year}` : ''} a las ${time}`;
}

function listDaysEs(days) {
  const names = [...days].sort((a, b) => a - b).map((d) => DAY_LABEL_ES[d]);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

function describeCron(cronExpr) {
  const [minute, hour, dom, month, dow] = cronExpr.split(/\s+/);
  const time = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${pad2(hour)}:${pad2(minute)}` : null;
  if (dow !== '*' && dom === '*' && month === '*') {
    if (dow === '1-5') return `de lunes a viernes a las ${time}`;
    if (dow === '0,6' || dow === '6,0') return `los fines de semana a las ${time}`;
    const days = dow.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    if (days.length && time) return `cada ${listDaysEs(days)} a las ${time}`;
  }
  if (dom !== '*' && month === '*' && dow === '*' && time) {
    if (dom.startsWith('*/')) return `cada ${dom.slice(2)} días a las ${time}`;
    return `cada mes el día ${dom} a las ${time}`;
  }
  if (dom !== '*' && month !== '*' && dow === '*' && time) {
    return `el ${dom} de ${MONTH_LABEL_ES[Number(month)] || month} a las ${time}`;
  }
  if (dom === '*' && month === '*' && dow === '*') {
    if (time) return `todos los días a las ${time}`;
    if (minute.startsWith('*/') && hour === '*') return `cada ${minute.slice(2)} minutos`;
    if (minute === '*' && hour === '*') return 'cada minuto';
    if (/^\d+$/.test(minute) && hour === '*') return 'cada hora';
    if (/^\d+$/.test(minute) && hour.startsWith('*/')) return `cada ${hour.slice(2)} horas`;
    if (/^\d+$/.test(minute) && /^\d+-\d+$/.test(hour)) return `cada hora de ${pad2(hour.split('-')[0])}:${pad2(minute)} a ${pad2(hour.split('-')[1])}:${pad2(minute)}`;
    if (minute.startsWith('*/') && /^\d+-\d+$/.test(hour)) return `cada ${minute.slice(2)} minutos entre las ${pad2(hour.split('-')[0])}:00 y las ${pad2(hour.split('-')[1])}:59`;
  }
  return `según el cron «${cronExpr}»`;
}

/** Human description (Spanish) of a parsed schedule. */
function describeSchedule(schedule, { now = new Date() } = {}) {
  if (!schedule) return '';
  const tz = schedule.tz || 'UTC';
  if (schedule.kind === 'at' && schedule.at) {
    return `una vez, ${describeAt(new Date(schedule.at), tz, now)} (${tz})`;
  }
  const base = describeCron(schedule.cronExpr);
  return `${base} (${tz})`;
}

/**
 * Parse a schedule written in the user's words.
 * @returns {null | { kind:'at'|'every'|'cron', cronExpr:string, tz:string, at:string|null, everyMs:number|null, description:string, adjusted:string|null, source:string }}
 */
function parseNaturalSchedule(input, { now = new Date(), tz = 'UTC' } = {}) {
  const zone = normalizeTimeZone(tz, 'UTC');
  const raw = String(input || '').trim();
  if (!raw) return null;
  let text = normalizeText(raw)
    .replace(/^(?:programa(?:lo|me|r)?|recuerdame|recordame|avisame|remind me|schedule(?: it)?)\s+/, '')
    .replace(/\s*[.!]+$/, '')
    .replace(/\bal\s+medio\s*dia\b/, 'a las 12:00')
    .replace(/\ba\s+medianoche\b/, 'a las 0:00')
    .trim();
  if (!text) return null;

  const finish = (kind, cronExpr, extra = {}) => {
    const schedule = { kind, cronExpr, tz: zone, at: null, everyMs: null, adjusted: null, source: raw, ...extra };
    schedule.description = describeSchedule(schedule, { now });
    return schedule;
  };
  const finishAt = (at) => {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null;
    const ahead = at.getTime() - now.getTime();
    if (ahead < MIN_AT_AHEAD_MS) return { error: 'schedule_in_past', at: at.toISOString() };
    if (ahead > MAX_AT_AHEAD_MS) return { error: 'schedule_too_far', at: at.toISOString() };
    return finish('at', cronForAt(at, zone), { at: at.toISOString() });
  };

  // 1. Raw cron.
  if (isValidCron(raw)) return finish('cron', raw.trim().replace(/\s+/g, ' '));

  // 2. ISO instant / date-time.
  if (/^\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?$/i.test(text)) {
    const hasZone = /z$|[+-]\d{2}:?\d{2}$/i.test(text);
    if (hasZone || !/[t ]/.test(text)) {
      const d = new Date(/[t ]/.test(text) ? raw : `${raw}T09:00:00`);
      if (!/[t ]/.test(text)) {
        const [y, mo, da] = text.split('-').map(Number);
        return finishAt(zonedTimeToUtc({ year: y, month: mo, day: da, hour: 9, minute: 0 }, zone));
      }
      return finishAt(d);
    }
    const [datePart, timePart] = text.split(/[t ]/);
    const [y, mo, da] = datePart.split('-').map(Number);
    const [hh, mm] = timePart.split(':').map(Number);
    return finishAt(zonedTimeToUtc({ year: y, month: mo, day: da, hour: hh, minute: mm }, zone));
  }

  // 3. Relative one-shot: «en 20 minutos», «dentro de 2 horas», «in 3 days», «en media hora».
  let m = new RegExp(`^(?:en|dentro de|in)\\s+(${NUMBER_RE_SRC})\\s*(${UNIT_RE_SRC})$`).exec(text);
  if (m) {
    const n = toNumber(m[1]);
    const unit = UNIT_MS[m[2]];
    if (!Number.isFinite(n) || n <= 0 || !unit) return null;
    return finishAt(new Date(now.getTime() + Math.round(n * unit)));
  }

  // 4. Fixed interval: «cada 15 minutos», «every 2 hours», «cada hora», «10m», «2h», «30 min».
  m = new RegExp(`^(?:cada|every|each|todos los|todas las)\\s+(?:(${NUMBER_RE_SRC})\\s*)?(${UNIT_RE_SRC})(?:\\s+${TIME_RE_SRC})?$`).exec(text)
    || new RegExp(`^(${NUMBER_RE_SRC})\\s*(${UNIT_RE_SRC})$`).exec(text);
  if (m) {
    const n = m[1] == null ? 1 : toNumber(m[1]);
    const unit = UNIT_MS[m[2]];
    if (!Number.isFinite(n) || n <= 0 || !unit) return null;
    const everyMs = Math.round(n * unit);
    if (everyMs < MINUTE_MS) return { error: 'schedule_too_frequent' };
    const timeInText = m[3] != null ? parseTimeMatch(m[3], m[4], m[5]) : null;
    const anchor = timeInText ? { ...localParts(now, zone), ...timeInText } : localParts(now, zone);
    const built = cronForEvery(everyMs, { anchor });
    if (!built) return null;
    // Sub-day intervals are true «every» schedules; a daily/weekly cadence is
    // a clock-time cron (same shape as «todos los días a las 8»).
    if (built.everyMs >= DAY_MS) return finish('cron', built.cronExpr, { adjusted: built.adjusted });
    return finish('every', built.cronExpr, { everyMs: built.everyMs, adjusted: built.adjusted });
  }

  const time = extractTime(text);
  const timeOrDefault = time || { hour: 9, minute: 0 };

  // 5. Daily: «todos los días a las 8», «cada día», «diario», «daily at 8am».
  if (/\b(cada dia|todos los dias|a diario|diario|diariamente|every day|everyday|daily)\b/.test(text)) {
    return finish('cron', `${timeOrDefault.minute} ${timeOrDefault.hour} * * *`);
  }

  // 6. Weekdays / weekends.
  if (/\b(de lunes a viernes|lunes a viernes|dias de semana|entre semana|weekdays|every weekday|monday to friday)\b/.test(text)) {
    return finish('cron', `${timeOrDefault.minute} ${timeOrDefault.hour} * * 1-5`);
  }
  if (/\b(fin(?:es)? de semana|weekends?)\b/.test(text) && /\b(cada|todos|every|los)\b/.test(text)) {
    return finish('cron', `${timeOrDefault.minute} ${timeOrDefault.hour} * * 0,6`);
  }

  // 7. Monthly: «cada mes el día 1 a las 9», «mensual», «monthly on the 15th».
  if (/\b(cada mes|mensual|mensualmente|monthly|every month)\b/.test(text)) {
    const dm = /\b(?:el\s+)?(?:dia\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/.exec(stripTime(text));
    const day = dm ? Math.min(Math.max(Number(dm[1]), 1), 28) : 1;
    return finish('cron', `${timeOrDefault.minute} ${timeOrDefault.hour} ${day} * *`);
  }

  // 8. Weekly on named days: «cada lunes a las 9», «los martes y jueves», «every monday».
  const days = parseDays(text);
  const recurringCue = /\b(cada|todos los|todas las|every|each)\b/.test(text)
    || new RegExp(`\\b(?:los|las)\\s+${DAY_RE_SRC}\\b`).test(text);
  if (days.length && recurringCue) {
    return finish('cron', `${timeOrDefault.minute} ${timeOrDefault.hour} * * ${[...days].sort().join(',')}`);
  }
  if (/\b(cada semana|semanal|semanalmente|weekly|every week)\b/.test(text)) {
    const weekday = days.length ? days[0] : localParts(now, zone).weekday;
    return finish('cron', `${timeOrDefault.minute} ${timeOrDefault.hour} * * ${weekday}`);
  }

  // 9. One-shot on a date: «el 15 de octubre a las 10», «el 15/10 a las 10», «15 de octubre».
  m = new RegExp(`\\b(?:el\\s+)?(\\d{1,2})\\s+de\\s+(${MONTH_RE_SRC})(?:\\s+(?:de\\s+)?(\\d{4}))?`).exec(text);
  if (m) {
    const nowP = localParts(now, zone);
    const month = MONTH_INDEX[m[2]];
    let year = m[3] ? Number(m[3]) : nowP.year;
    let at = zonedTimeToUtc({ year, month, day: Number(m[1]), ...timeOrDefault }, zone);
    if (!m[3] && at.getTime() <= now.getTime()) at = zonedTimeToUtc({ year: year + 1, month, day: Number(m[1]), ...timeOrDefault }, zone);
    return finishAt(at);
  }
  m = /\b(?:el\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(stripTime(text));
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const nowP = localParts(now, zone);
    let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : nowP.year;
    let at = zonedTimeToUtc({ year, month: Number(m[2]), day: Number(m[1]), ...timeOrDefault }, zone);
    if (!m[3] && at.getTime() <= now.getTime()) at = zonedTimeToUtc({ year: year + 1, month: Number(m[2]), day: Number(m[1]), ...timeOrDefault }, zone);
    return finishAt(at);
  }

  // 10. One-shot relative days: «hoy a las 18», «mañana a las 9», «pasado mañana», «el viernes a las 10», «tomorrow 9am».
  const nowP = localParts(now, zone);
  const dayAt = (offsetDays, t) => {
    const base = new Date(Date.UTC(nowP.year, nowP.month - 1, nowP.day + offsetDays));
    return zonedTimeToUtc({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), ...t }, zone);
  };
  if (/\b(pasado manana|day after tomorrow)\b/.test(text)) return finishAt(dayAt(2, timeOrDefault));
  if (/\b(manana|tomorrow)\b/.test(text) && !/\bde la manana\b/.test(text.replace(/\bmanana\b/, ''))) return finishAt(dayAt(1, timeOrDefault));
  if (/\bmanana\b/.test(text) && time) {
    // «mañana a las 9 de la mañana»: the first mañana is the day.
    return finishAt(dayAt(1, time));
  }
  if (days.length === 1 && time) {
    return finishAt(nextOccurrenceOnWeekday({ now, tz: zone, weekday: days[0], ...time }));
  }
  if (days.length === 1 && /\b(el|este|proximo|next|this)\b/.test(text)) {
    return finishAt(nextOccurrenceOnWeekday({ now, tz: zone, weekday: days[0], hour: 9, minute: 0 }));
  }
  if (time && (/\b(hoy|today)\b/.test(text) || /^(?:a\s+las?\s+|at\s+)/.test(text) || new RegExp(`^${TIME_RE_SRC}$`).test(text))) {
    // Bare time: today if still ahead, otherwise tomorrow.
    const today = dayAt(0, time);
    if (today.getTime() - now.getTime() >= MIN_AT_AHEAD_MS) return finishAt(today);
    if (/\b(hoy|today)\b/.test(text)) return { error: 'schedule_in_past', at: today.toISOString() };
    return finishAt(dayAt(1, time));
  }

  return null;
}

/** Next fire instant for a parsed schedule (or a task row with cronExpr/tz). */
function nextRunFor(schedule, { now = new Date() } = {}) {
  if (!schedule) return null;
  if (schedule.kind === 'at' && schedule.at) {
    const at = new Date(schedule.at);
    return at.getTime() > now.getTime() ? at : null;
  }
  try {
    return nextCronDate(schedule.cronExpr, normalizeTimeZone(schedule.tz, 'UTC'), now);
  } catch {
    return null;
  }
}

/** «jueves 9 de octubre, 15:30 (America/Lima)» for the user. */
function formatLocal(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const p = localParts(d, normalizeTimeZone(tz, 'UTC'));
  return `${DAY_LABEL_ES[p.weekday]} ${p.day} de ${MONTH_LABEL_ES[p.month]} de ${p.year}, ${pad2(p.hour)}:${pad2(p.minute)} (${normalizeTimeZone(tz, 'UTC')})`;
}

module.exports = {
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  WEEK_MS,
  MIN_AT_AHEAD_MS,
  MAX_AT_AHEAD_MS,
  normalizeTimeZone,
  localParts,
  zonedTimeToUtc,
  parseNaturalSchedule,
  cronForAt,
  cronForEvery,
  describeSchedule,
  describeCron,
  nextRunFor,
  isValidCron,
  formatLocal,
  extractTime,
};
