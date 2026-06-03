---
name: Filter config override vs module default
description: FILTERS_CONFIG in agents/filters/index.js overrides each filter module's own enabled flag
---

# Filter config override vs module default

`_isEnabled` in `services/agents/filters/index.js` prefers `FILTERS_CONFIG[id].enabled`
over the filter module's own `enabled` property. So a module that sets
`enabled: false` (with a comment explaining why) is still ON at runtime if
FILTERS_CONFIG lists it `true`.

**Why:** the `conversation-memory` filter was authored disabled (its
`[Recent user turns]` extraContext fold leaked into the visible prompt), but the
registry override kept it enabled — the documented "default off" was a no-op.

**How to apply:** when a filter's intended default changes, update BOTH the
module's `enabled` and the FILTERS_CONFIG entry, or they silently disagree.
