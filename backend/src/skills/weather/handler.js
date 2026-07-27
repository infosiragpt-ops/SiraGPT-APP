'use strict';

const REQUEST_TIMEOUT_MS = 12000;

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(value) {
  if (Array.isArray(value)) return value[0]?.value || null;
  return value || null;
}

function normalizeWeather(payload, options = {}) {
  const current = payload?.current_condition?.[0];
  const nearest = payload?.nearest_area?.[0];
  if (!current) throw new Error('weather: provider returned no current conditions');
  const units = options.units === 'imperial' ? 'imperial' : 'metric';
  const days = Math.max(1, Math.min(Number(options.days) || 3, 5));

  return {
    ok: true,
    location: {
      name: firstValue(nearest?.areaName) || options.location,
      region: firstValue(nearest?.region),
      country: firstValue(nearest?.country),
      latitude: asNumber(nearest?.latitude),
      longitude: asNumber(nearest?.longitude),
    },
    units,
    current: {
      condition: firstValue(current.weatherDesc),
      temperature: asNumber(units === 'imperial' ? current.temp_F : current.temp_C),
      feelsLike: asNumber(units === 'imperial' ? current.FeelsLikeF : current.FeelsLikeC),
      humidityPercent: asNumber(current.humidity),
      precipitationMm: asNumber(current.precipMM),
      windSpeed: asNumber(units === 'imperial' ? current.windspeedMiles : current.windspeedKmph),
      observationTime: current.localObsDateTime || current.observation_time || null,
    },
    forecast: (payload.weather || []).slice(0, days).map((day) => ({
      date: day.date || null,
      minTemperature: asNumber(units === 'imperial' ? day.mintempF : day.mintempC),
      maxTemperature: asNumber(units === 'imperial' ? day.maxtempF : day.maxtempC),
      averageTemperature: asNumber(units === 'imperial' ? day.avgtempF : day.avgtempC),
      totalSnowCm: asNumber(day.totalSnow_cm),
      sunHours: asNumber(day.sunHour),
    })),
    source: 'wttr.in',
  };
}

async function execute(args = {}, ctx = {}) {
  const location = String(args.location || '').trim();
  if (!location) throw new Error('weather: location is required');
  if (location.length > 160) throw new Error('weather: location is too long');

  const fetchImpl = ctx.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('weather: fetch is unavailable');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j2`;
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'SiraGPTBot/1.0 (+https://siragpt.com)',
      },
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`weather: provider HTTP ${response?.status || 'error'}`);
    const payload = await response.json();
    return normalizeWeather(payload, { ...args, location });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('weather: request timed out or was cancelled');
    throw error;
  } finally {
    clearTimeout(timeout);
    if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { execute, normalizeWeather, asNumber, firstValue, REQUEST_TIMEOUT_MS };
