---
name: Authoritative current datetime block
description: Why SiraGPT injects a current date/time block into the system prompt and how it relates to web search.
---

# Authoritative current datetime

The model has no reliable sense of "today" and was confidently hallucinating wrong
dates (e.g. answering with a date a year off). Fix: `buildCurrentDateTimeBlock(lang)`
in master-prompt.js injects a bilingual block ("## FECHA Y HORA ACTUAL (AUTORIDAD)" /
"## CURRENT DATE & TIME (AUTHORITATIVE)") with a human-readable UTC datetime plus
ISO-8601, wired into systemBlocks as `{kind:'current-datetime', cacheable:false}`.

**Why cacheable:false matters:** the block changes every request, so it must be
excluded from the prompt cache or stale dates get served.

**How to apply:** treat the injected block as authority for "today"; for any other
volatile fact (prices, news, scores, current officials) instruct the model to use
web search instead of memory. The realtime web-search trigger lives in
`FRESH_WEB_CONTEXT_RE` (web-search-tools.js) — broaden it cautiously and avoid
ambiguous bare tokens (e.g. English "live" matches "I live in…"); add negative
cases like "vivo en Lima" must NOT trigger.
