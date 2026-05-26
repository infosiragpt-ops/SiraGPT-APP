/**
 * Open-Meteo — free, no-key weather API (CC-BY 4.0).
 *
 *   Docs:        https://open-meteo.com/en/docs
 *   Geocoding:   https://open-meteo.com/en/docs/geocoding-api
 *
 * Open-Meteo expects lat/lon inputs, so this provider runs two API
 * calls per search: geocoding → forecast. Users can also pass
 * { lat, lon } directly via opts.raw to skip geocoding.
 *
 * We return ONE UnifiedResult per query (the top geocoded location)
 * summarising the current conditions + a 3-day forecast, so that the
 * chat LLM can cite it verbatim without needing to parse a blob.
 */

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const USER_AGENT = "siraGPT/1.0 (+https://siragpt.com)";

async function fetchJson(url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`open-meteo ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildSnippet(current, daily) {
  const parts = [];
  if (current) {
    if (typeof current.temperature_2m === "number") {
      parts.push(`${current.temperature_2m}°C`);
    }
    if (typeof current.relative_humidity_2m === "number") {
      parts.push(`humedad ${current.relative_humidity_2m}%`);
    }
    if (typeof current.wind_speed_10m === "number") {
      parts.push(`viento ${current.wind_speed_10m} km/h`);
    }
  }
  if (daily && Array.isArray(daily.time)) {
    const days = daily.time.slice(0, 3).map((d, i) => {
      const tmax = daily.temperature_2m_max?.[i];
      const tmin = daily.temperature_2m_min?.[i];
      return `${d}: ${tmin}°/${tmax}°C`;
    });
    if (days.length > 0) parts.push(`Pronóstico: ${days.join(" · ")}`);
  }
  return parts.join(" · ");
}

/** @type {import("../../types").SearchProvider} */
const openMeteoProvider = {
  id: "openmeteo",
  name: "Open-Meteo",
  region: "global",
  category: "weather",
  license: "open",
  rateLimit: "10 000 req/día (sin clave)",
  requiresKey: false,

  async search(query, opts = {}) {
    const timeoutMs = opts.timeoutMs || 8000;
    const raw = opts.raw || {};

    let lat = typeof raw.lat === "number" ? raw.lat : null;
    let lon = typeof raw.lon === "number" ? raw.lon : null;
    let locationName = typeof raw.location === "string" ? raw.location : query;
    let country = typeof raw.country === "string" ? raw.country : "";

    if (lat === null || lon === null) {
      const geocodeParams = new URLSearchParams({
        name: query,
        count: "1",
        language: opts.language || "es",
        format: "json",
      });
      const geo = await fetchJson(`${GEOCODE_URL}?${geocodeParams}`, { timeoutMs });
      const hit = Array.isArray(geo.results) ? geo.results[0] : null;
      if (!hit) return [];
      lat = hit.latitude;
      lon = hit.longitude;
      locationName = hit.name;
      country = hit.country || "";
    }

    const forecastParams = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum",
      timezone: "auto",
      forecast_days: "3",
    });
    const fx = await fetchJson(`${FORECAST_URL}?${forecastParams}`, { timeoutMs });

    const today = fx.daily?.time?.[0] || new Date().toISOString().slice(0, 10);
    const locLabel = country ? `${locationName}, ${country}` : locationName;

    return [
      {
        id: `openmeteo:${locationName.toLowerCase().replace(/\s+/g, "-")}-${today}`,
        sourceProvider: "openmeteo",
        category: "weather",
        title: `Clima en ${locLabel}`,
        snippet: buildSnippet(fx.current, fx.daily),
        url: `https://open-meteo.com/en/docs?latitude=${lat}&longitude=${lon}`,
        location: locLabel,
        datePublished: new Date().toISOString(),
        metadata: {
          lat,
          lon,
          timezone: fx.timezone,
          current: fx.current,
          daily: fx.daily,
        },
      },
    ];
  },
};

module.exports = { openMeteoProvider };
