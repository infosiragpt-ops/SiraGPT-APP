---
name: secret-safety
description: "Scan and harden changes so API keys, OAuth tokens, cookies, private URLs, and user data do not leak through code, logs, commits, or chat replies."
---

# Secret Safety

Use this skill before commits that touch environment loading, provider integrations, logs, deploy scripts, GitHub Actions, auth, webhooks, or external messaging.

## Contract

- Never print secret values in terminal summaries, chat messages, logs, tests, or memory files.
- Refer to key names only, for example `FAL_API_KEY`, not the value.
- Redact logs before sharing with users or issue/PR bodies.
- Treat screenshots, env files, cookies, OAuth redirects, and local session logs as private.
- If a secret may have been exposed, stop and rotate it before continuing.

## Local Checks

```bash
bash scripts/check-secrets.sh
git diff --check
git grep -nE 'sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]+|xox[baprs]-|BEGIN (RSA|OPENSSH|PRIVATE) KEY' -- ':!node_modules' ':!.next'
```

## Review Targets

- `.env*`, deploy scripts, GitHub workflow YAML.
- Provider clients and health probes.
- Logging/telemetry helpers.
- Error responses returned to browser.
- Memory updates and Telegram/Discord/Slack messages.

## Safe Reporting

Good: `Producción tiene FAL_API_KEY configurada.`

Bad: `La key es ...`

When proof requires checking a key, verify presence or provider health only. Do not echo the key.

