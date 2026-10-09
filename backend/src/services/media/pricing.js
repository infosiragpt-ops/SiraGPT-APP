'use strict';

function finitePrice(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Only explicit, dimensioned prices are usable. Catalogue qualityRank and
// billing labels are not amounts; a missing tariff must stay unknown.
function quoteMediaCost(pricing, { count = 1, durationSeconds = 0, resolution = '', audio = false } = {}) {
  if (!Number.isFinite(Number(count)) || Number(count) <= 0 || !Number.isFinite(Number(durationSeconds)) || Number(durationSeconds) < 0) return { estimatedCostUSD: null, source: 'unknown', snapshot: pricing || null };
  if (!pricing || typeof pricing !== 'object') return { estimatedCostUSD: null, source: 'unknown', snapshot: null };
  const variant = pricing.variants?.[`${resolution}:${audio ? 'audio' : 'silent'}`]
    || pricing.resolutions?.[resolution] || pricing;
  const currency = variant.currency || pricing.currency || 'USD';
  if (currency !== 'USD') return { estimatedCostUSD: null, source: 'unknown', snapshot: pricing };
  let cost = null;
  const perSecond = finitePrice(variant.per_second ?? variant.perSecond);
  const perImage = finitePrice(variant.per_image ?? variant.perImage ?? variant.image);
  const perGeneration = finitePrice(variant.per_generation ?? variant.perGeneration ?? variant.request);
  if (perSecond != null && durationSeconds > 0) cost = perSecond * durationSeconds * count;
  else if (perImage != null) cost = perImage * count;
  else if (perGeneration != null) cost = perGeneration * count;
  return {
    estimatedCostUSD: cost == null ? null : Math.ceil(cost * 1e8) / 1e8,
    source: cost == null ? 'unknown' : String(pricing.source || 'catalogue_estimate'),
    snapshot: JSON.parse(JSON.stringify(pricing)),
  };
}

module.exports = { finitePrice, quoteMediaCost };
