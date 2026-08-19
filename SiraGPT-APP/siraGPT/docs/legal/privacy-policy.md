<!--
@version: 1.0.0
@lastUpdated: 2026-05-19
-->

# siraGPT — Privacy Policy

**Version:** 1.0.0
**Last updated:** 2026-05-19

This Privacy Policy describes how siraGPT ("we", "us") collects, uses,
and shares personal data when you use our service. By using siraGPT,
you agree to this policy.

## 1. Data we collect

- **Account data** — email, name, password hash, plan, locale.
- **Conversation data** — chat messages and uploaded files you send to
  our models.
- **Usage data** — API call counters, token counts, timestamps.
- **Billing data** — Stripe customer/subscription identifiers; we do
  not store full card numbers.

## 2. How we use it

- Deliver the service (run AI models, store chats, surface analytics).
- Bill subscriptions and prevent abuse.
- Improve the product through aggregated, de-identified metrics.

## 3. Sharing

- **Subprocessors:** OpenAI, Anthropic, Google, Stripe, AWS.
- We do not sell your personal data.

## 4. Retention

- Account + chat data is retained while your account is active.
- Soft-deleted accounts enter a 30-day grace window before hard
  deletion. Around day 27, free-text fields are PII-scrubbed (see
  Right to Erasure below).

## 5. Your rights (GDPR / CCPA)

- **Access / portability:** `GET /api/users/me/export` returns a ZIP
  archive of your data. Add `?redactPII=true` to redact embedded PII.
- **Erasure:** `POST /api/users/me/delete` schedules your account for
  hard deletion after a 30-day grace period.
- **Rectification:** Update your profile from Settings.

## 6. Contact

privacy@siragpt.io
