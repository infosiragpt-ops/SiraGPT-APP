'use strict';

/**
 * x-search-metrics — tiny in-memory counters for the X (Twitter) Live
 * Search tool, mirroring the `free-ia-metrics` pattern (flat module-level
 * state, O(1) increments, no per-call allocation). Exposed via the
 * `/api/x-search/metrics` + `/metrics.prom` routes for ops dashboards.
 */

const state = {
  searches: 0, // successful configured searches
  posts: 0, // total citations (X posts) returned
  errors: 0, // failed searches (after retries)
  unconfigured: 0, // calls that hit the no-key path
  errorCodes: Object.create(null),
  lastEventAt: null,
};

function stamp() {
  state.lastEventAt = new Date().toISOString();
}

function recordSearch({ resultCount = 0 } = {}) {
  state.searches += 1;
  state.posts += Math.max(0, Number(resultCount) || 0);
  stamp();
  return state.searches;
}

function recordError({ code = 'unknown' } = {}) {
  state.errors += 1;
  const key = String(code || 'unknown').slice(0, 40);
  state.errorCodes[key] = (state.errorCodes[key] || 0) + 1;
  stamp();
  return state.errors;
}

function recordUnconfigured() {
  state.unconfigured += 1;
  stamp();
  return state.unconfigured;
}

function topErrorCodes(limit = 5) {
  return Object.entries(state.errorCodes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit))
    .map(([code, count]) => ({ code, count }));
}

function snapshot() {
  const total = state.searches + state.errors;
  const successRate = total > 0 ? Math.round((state.searches / total) * 1e4) / 1e4 : null;
  return {
    searches: state.searches,
    posts: state.posts,
    errors: state.errors,
    unconfigured: state.unconfigured,
    successRate,
    topErrorCodes: topErrorCodes(5),
    lastEventAt: state.lastEventAt,
  };
}

function toPrometheusText() {
  const esc = (k) => String(k).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [];
  lines.push('# HELP sira_x_search_total Successful X (Twitter) live searches.');
  lines.push('# TYPE sira_x_search_total counter');
  lines.push(`sira_x_search_total ${state.searches}`);
  lines.push('# HELP sira_x_search_posts_total Total X posts (citations) returned.');
  lines.push('# TYPE sira_x_search_posts_total counter');
  lines.push(`sira_x_search_posts_total ${state.posts}`);
  lines.push('# HELP sira_x_search_errors_total Failed X searches after retries.');
  lines.push('# TYPE sira_x_search_errors_total counter');
  lines.push(`sira_x_search_errors_total ${state.errors}`);
  lines.push('# HELP sira_x_search_unconfigured_total Calls that hit the no-key path.');
  lines.push('# TYPE sira_x_search_unconfigured_total counter');
  lines.push(`sira_x_search_unconfigured_total ${state.unconfigured}`);
  for (const { code, count } of topErrorCodes(20)) {
    lines.push(`sira_x_search_error_code_total{code="${esc(code)}"} ${count}`);
  }
  return `${lines.join('\n')}\n`;
}

function reset() {
  state.searches = 0;
  state.posts = 0;
  state.errors = 0;
  state.unconfigured = 0;
  state.errorCodes = Object.create(null);
  state.lastEventAt = null;
}

module.exports = {
  recordSearch,
  recordError,
  recordUnconfigured,
  topErrorCodes,
  snapshot,
  toPrometheusText,
  reset,
};
