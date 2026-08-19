---
name: Console.log printf override
description: backend/index.js overrides console.log to join args with spaces, breaking printf-style %s format strings
---

## The bug
`backend/index.js` wraps `console.log` (and by extension all console methods)
to join arguments with a space separator. This breaks printf-style interpolation:

```js
// WRONG — produces: "[module] value=%s 42"
console.log('[module] value=%s', 42);

// CORRECT — produces: "[module] value=42"
console.log(`[module] value=${42}`);
```

**Why:** The custom override does `args.map(_formatLogArg).join(' ')` before
passing to the original console.log. Node's built-in printf substitution
(`util.format`) is bypassed because the override never calls `util.format`.

## How to apply
Always use template literals in any backend logging code (not just log helpers).
This applies to `console.log`, `console.warn`, `console.info`, `console.error`.
Files already fixed: `hermes-runtime.js`, `anomaly-detector.js`.
