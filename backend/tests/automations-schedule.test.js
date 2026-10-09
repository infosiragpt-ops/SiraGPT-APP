'use strict';

/**
 * Natural-language schedules for the chat agent's automations (OpenClaw
 * «Automations» parity): «en 20 minutos», «cada lunes a las 9», «todos los
 * días a las 8», «/loop 10m», raw cron — all expressed with cronExpr + tz so
 * the existing ScheduledAgentTask worker fires them in the user's zone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const schedule = require('../src/services/automations/schedule');

const NOW = new Date('2026-10-09T19:30:00Z'); // viernes 9-oct-2026, 14:30 en Lima
const TZ = 'America/Lima';
const parse = (text) => schedule.parseNaturalSchedule(text, { now: NOW, tz: TZ });

test('normalizeTimeZone canonicalises valid zones and falls back on garbage', () => {
  assert.equal(schedule.normalizeTimeZone('america/lima'), 'America/Lima');
  assert.equal(schedule.normalizeTimeZone('Europe/Madrid'), 'Europe/Madrid');
  assert.equal(schedule.normalizeTimeZone('Mars/Olympus'), 'UTC');
  assert.equal(schedule.normalizeTimeZone('', 'America/Bogota'), 'America/Bogota');
  assert.equal(schedule.normalizeTimeZone(null), 'UTC');
});

test('zonedTimeToUtc is DST-safe (Madrid, the night the clocks go back)', () => {
  // 2026-10-25 03:30 Madrid is after the 03:00→02:00 fall-back: UTC+1 → 02:30Z.
  const at = schedule.zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 3, minute: 30 }, 'Europe/Madrid');
  assert.equal(at.toISOString(), '2026-10-25T02:30:00.000Z');
  // Mid-summer stays UTC+2.
  assert.equal(schedule.zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, 'Europe/Madrid').toISOString(), '2026-07-01T07:00:00.000Z');
});

test('relative one-shots: «en 20 minutos», «dentro de 2 horas», «in 3 days», «en media hora»', () => {
  assert.deepEqual(
    [parse('en 20 minutos'), parse('dentro de 2 horas'), parse('in 3 days'), parse('en media hora'), parse('recuérdame en 45 min')].map((r) => [r.kind, r.at]),
    [
      ['at', '2026-10-09T19:50:00.000Z'],
      ['at', '2026-10-09T21:30:00.000Z'],
      ['at', '2026-10-12T19:30:00.000Z'],
      ['at', '2026-10-09T20:00:00.000Z'],
      ['at', '2026-10-09T20:15:00.000Z'],
    ],
  );
  const r = parse('en 20 minutos');
  assert.equal(r.cronExpr, '50 14 9 10 *', 'the cron is the local minute of the instant');
  assert.equal(r.tz, TZ);
  assert.equal(r.description, 'una vez, hoy a las 14:50 (America/Lima)');
});

test('absolute one-shots resolve in the user zone: hoy / mañana / weekday / date', () => {
  assert.equal(parse('mañana a las 9').at, '2026-10-10T14:00:00.000Z');
  assert.equal(parse('mañana a las 9 de la mañana').at, '2026-10-10T14:00:00.000Z');
  assert.equal(parse('hoy a las 18').at, '2026-10-09T23:00:00.000Z');
  assert.equal(parse('a las 9 de la noche').at, '2026-10-10T02:00:00.000Z');
  assert.equal(parse('a las 9').at, '2026-10-10T14:00:00.000Z', 'a past bare time rolls to tomorrow');
  assert.equal(parse('a las 15:00').at, '2026-10-09T20:00:00.000Z', 'a future bare time is today');
  assert.equal(parse('el viernes a las 10').at, '2026-10-16T15:00:00.000Z', 'today is Friday 14:30, so next Friday');
  assert.equal(parse('el lunes').at, '2026-10-12T14:00:00.000Z', 'a weekday without time defaults to 09:00');
  assert.equal(parse('el 15 de octubre a las 10').at, '2026-10-15T15:00:00.000Z');
  assert.equal(parse('el 15/10 a las 10').at, '2026-10-15T15:00:00.000Z');
  assert.equal(parse('el 1 de noviembre').at, '2026-11-01T14:00:00.000Z');
  assert.equal(parse('pasado mañana').at, '2026-10-11T14:00:00.000Z');
  assert.equal(parse('tomorrow 9am').at, '2026-10-10T14:00:00.000Z');
  assert.equal(parse('2026-12-01T10:00').at, '2026-12-01T15:00:00.000Z', 'ISO without zone is local');
  assert.equal(parse('2026-12-01T10:00:00Z').at, '2026-12-01T10:00:00.000Z', 'ISO with zone is absolute');
  assert.equal(parse('mañana a las 9').description, 'una vez, mañana a las 09:00 (America/Lima)');
});

test('one-shots in the past or absurdly far are reported, not silently scheduled', () => {
  assert.deepEqual(parse('hoy a las 8'), { error: 'schedule_in_past', at: '2026-10-09T13:00:00.000Z' });
  assert.equal(parse('en 10 segundos').error, 'schedule_in_past');
  assert.equal(parse('en 900 días').error, 'schedule_too_far');
});

test('intervals: minutes/hours snap to cron divisors, days and weeks anchor on now', () => {
  assert.deepEqual([parse('cada 15 minutos').cronExpr, parse('cada 15 minutos').kind], ['*/15 * * * *', 'every']);
  assert.equal(parse('10m').cronExpr, '*/10 * * * *', '/loop-style duration');
  assert.equal(parse('2h').cronExpr, '30 */2 * * *');
  assert.equal(parse('cada hora').cronExpr, '30 * * * *');
  assert.equal(parse('every 2 hours').cronExpr, '30 */2 * * *');
  const seven = parse('cada 7 minutos');
  assert.equal(seven.cronExpr, '*/6 * * * *');
  assert.match(seven.adjusted, /cada 6 min/);
  const five = parse('cada 5 horas');
  assert.equal(five.cronExpr, '30 */4 * * *');
  assert.match(five.adjusted, /cada 4 h/);
  assert.equal(parse('todos los dias').cronExpr, '30 14 * * *', 'daily without a time keeps the creation time');
  assert.equal(parse('cada día a las 8').cronExpr, '0 8 * * *');
  assert.equal(parse('cada semana').cronExpr, '30 14 * * 5');
  assert.equal(parse('cada 30 segundos').error, 'schedule_too_frequent');
});

test('recurring cron phrases ES/EN', () => {
  const rows = [
    ['todos los días a las 8:30', '30 8 * * *', 'todos los días a las 08:30 (America/Lima)'],
    ['daily at 7pm', '0 19 * * *', 'todos los días a las 19:00 (America/Lima)'],
    ['lunes a viernes a las 9', '0 9 * * 1-5', 'de lunes a viernes a las 09:00 (America/Lima)'],
    ['cada lunes a las 9', '0 9 * * 1', 'cada lunes a las 09:00 (America/Lima)'],
    ['every monday at 9am', '0 9 * * 1', 'cada lunes a las 09:00 (America/Lima)'],
    ['los martes y jueves a las 18', '0 18 * * 2,4', 'cada martes y jueves a las 18:00 (America/Lima)'],
    ['cada fin de semana a las 10', '0 10 * * 0,6', 'los fines de semana a las 10:00 (America/Lima)'],
    ['cada mes el día 1 a las 9', '0 9 1 * *', 'cada mes el día 1 a las 09:00 (America/Lima)'],
    ['monthly on the 15th at 10am', '0 10 15 * *', 'cada mes el día 15 a las 10:00 (America/Lima)'],
    ['0 9 * * 1', '0 9 * * 1', 'cada lunes a las 09:00 (America/Lima)'],
  ];
  for (const [text, cronExpr, description] of rows) {
    const r = parse(text);
    assert.ok(r && !r.error, `${text} parses`);
    assert.equal(r.cronExpr, cronExpr, text);
    assert.equal(r.description, description, text);
    assert.equal(r.kind, 'cron', text);
  }
});

test('unparseable text returns null (the tool asks the user instead of guessing)', () => {
  for (const text of ['xyz', 'ahora mismo', 'cuando puedas', '', '   ', '99:99']) {
    assert.equal(parse(text), null, JSON.stringify(text));
  }
});

test('nextRunFor honours the zone and never returns a past one-shot', () => {
  const weekly = parse('cada lunes a las 9');
  assert.equal(schedule.nextRunFor(weekly, { now: NOW }).toISOString(), '2026-10-12T14:00:00.000Z');
  const once = parse('en 20 minutos');
  assert.equal(schedule.nextRunFor(once, { now: NOW }).toISOString(), '2026-10-09T19:50:00.000Z');
  assert.equal(schedule.nextRunFor(once, { now: new Date('2026-10-09T20:00:00Z') }), null);
  assert.equal(schedule.nextRunFor({ kind: 'cron', cronExpr: 'bad', tz: TZ }), null);
});

test('describeCron covers the shapes the worker stores; formatLocal is Spanish and zoned', () => {
  assert.equal(schedule.describeCron('*/30 8-21 * * *'), 'cada 30 minutos entre las 08:00 y las 21:59');
  assert.equal(schedule.describeCron('0 8-22 * * *'), 'cada hora de 08:00 a 22:00');
  assert.equal(schedule.describeCron('15 */3 * * *'), 'cada 3 horas');
  assert.equal(schedule.describeCron('0 9 */2 * *'), 'cada 2 días a las 09:00');
  assert.equal(schedule.describeCron('5 4 1 7 *'), 'el 1 de julio a las 04:05');
  assert.equal(schedule.formatLocal('2026-10-09T19:50:00.000Z', TZ), 'viernes 9 de octubre de 2026, 14:50 (America/Lima)');
  assert.equal(schedule.isValidCron('0 9 * * 1'), true);
  assert.equal(schedule.isValidCron('0 9 * *'), false);
});
