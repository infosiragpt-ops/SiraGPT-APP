'use strict';

function unixSeconds(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime())
    ? seconds
    : null;
}

// Basil/Clover moved billing periods onto subscription items. This app sells
// one recurring item; accept a common period for multiple items, but never
// guess a deadline when their billing periods disagree. Retain legacy payloads.
// https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
function stripeSubscriptionPeriod(subscription) {
  const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];
  const period = {};
  for (const [key, field] of [['start', 'current_period_start'], ['end', 'current_period_end']]) {
    const legacy = unixSeconds(subscription?.[field]);
    const values = items.map(item => unixSeconds(item?.[field]));
    period[key] = legacy ?? (values.length && values.every(value => value !== null && value === values[0]) ? values[0] : null);
  }
  return period;
}

module.exports = { stripeSubscriptionPeriod };
