'use strict';

const MODES = new Set(['off', 'review', 'auto']);

const AUTONOMY_FIELD_BY_KIND = Object.freeze({
  email_reply: 'emailReplies',
  lead_outreach: 'leadOutreach',
  social_reply: 'socialReplies',
});

function modeForAction(companyContext, kind) {
  const field = AUTONOMY_FIELD_BY_KIND[kind];
  const raw = field ? companyContext?.profile?.autonomy?.[field] : 'off';
  return MODES.has(raw) ? raw : 'review';
}

function dailyLimit(kind, env = process.env) {
  const key = kind === 'lead_outreach'
    ? 'CODEX_LEAD_OUTREACH_DAILY_LIMIT'
    : kind === 'email_reply'
      ? 'CODEX_EMAIL_REPLY_DAILY_LIMIT'
      : 'CODEX_SOCIAL_REPLY_DAILY_LIMIT';
  const fallback = kind === 'lead_outreach' ? 10 : 20;
  const parsed = Number.parseInt(env[key] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 1000) : fallback;
}

function decideExternalAction({ companyContext, kind, connected = true, sentToday = 0, env = process.env }) {
  const mode = modeForAction(companyContext, kind);
  if (mode === 'off') return { allowed: false, mode, action: 'off', reason: 'policy_off' };
  if (!connected) return { allowed: false, mode, action: 'blocked', reason: 'provider_not_connected' };
  const limit = dailyLimit(kind, env);
  if (sentToday >= limit) return { allowed: false, mode, action: 'blocked', reason: 'daily_limit_reached', limit };
  return {
    allowed: true,
    mode,
    action: mode === 'auto' ? 'execute' : 'review',
    reason: mode === 'auto' ? 'explicit_auto_policy' : 'human_review_required',
    limit,
  };
}

module.exports = {
  AUTONOMY_FIELD_BY_KIND,
  dailyLimit,
  decideExternalAction,
  modeForAction,
};
