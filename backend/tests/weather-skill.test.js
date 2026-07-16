'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const weather = require('../src/skills/weather/handler');

function fixture() {
  return {
    current_condition: [{
      weatherDesc: [{ value: 'Partly cloudy' }],
      temp_C: '22', temp_F: '72', FeelsLikeC: '23', FeelsLikeF: '73',
      humidity: '64', precipMM: '0.3', windspeedKmph: '14', windspeedMiles: '9',
      localObsDateTime: '2026-07-16 02:00 PM',
    }],
    nearest_area: [{
      areaName: [{ value: 'Lima' }], region: [{ value: 'Lima' }],
      country: [{ value: 'Peru' }], latitude: '-12.04', longitude: '-77.03',
    }],
    weather: [
      { date: '2026-07-16', mintempC: '17', maxtempC: '23', avgtempC: '20', mintempF: '63', maxtempF: '73', avgtempF: '68', totalSnow_cm: '0', sunHour: '5.5' },
      { date: '2026-07-17', mintempC: '16', maxtempC: '22', avgtempC: '19', mintempF: '61', maxtempF: '72', avgtempF: '66', totalSnow_cm: '0', sunHour: '4.0' },
    ],
  };
}

test('normalizeWeather returns bounded metric forecast data', () => {
  const result = weather.normalizeWeather(fixture(), { location: 'Lima', days: 1, units: 'metric' });
  assert.equal(result.ok, true);
  assert.equal(result.location.name, 'Lima');
  assert.equal(result.current.temperature, 22);
  assert.equal(result.current.windSpeed, 14);
  assert.equal(result.forecast.length, 1);
  assert.equal(result.forecast[0].maxTemperature, 23);
});

test('normalizeWeather supports imperial units', () => {
  const result = weather.normalizeWeather(fixture(), { location: 'LIM', days: 5, units: 'imperial' });
  assert.equal(result.current.temperature, 72);
  assert.equal(result.current.windSpeed, 9);
  assert.equal(result.forecast[0].minTemperature, 63);
});

test('weather execute uses an encoded HTTPS request and structured JSON', async () => {
  let requestedUrl;
  const result = await weather.execute(
    { location: 'New York', days: 2 },
    {
      fetch: async (url, options) => {
        requestedUrl = url;
        assert.equal(options.headers.accept, 'application/json');
        return { ok: true, json: async () => fixture() };
      },
    },
  );
  assert.equal(requestedUrl, 'https://wttr.in/New%20York?format=j2');
  assert.equal(result.forecast.length, 2);
});

test('weather rejects missing location and provider failures', async () => {
  await assert.rejects(() => weather.execute({}), /location is required/);
  await assert.rejects(
    () => weather.execute({ location: 'Lima' }, { fetch: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/,
  );
});
