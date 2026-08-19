---
name: Next.js dynamic ssr:false in Server Components
description: Why { ssr: false } must live in a "use client" file, and how missing this caused Replit crash detection to fire.
---

## The rule
`next/dynamic(..., { ssr: false })` is forbidden inside Server Components (any file in `app/` without a `"use client"` directive). Next.js 15 throws a build/runtime error if you try.

## Why it matters for Replit
When a Server Component used `nextDynamic(..., { ssr: true })` (the default) on a "use client" tree full of browser-only hooks, Next.js attempted SSR, failed, and printed to stderr on **every request**:

```
⨯ Error: Bail out to client-side rendering: next/dynamic
```

Replit's crash detector reads stderr output and flags the workflow as "crashed with a runtime error" even when every HTTP response is 200 OK.

## The fix pattern
Move `dynamic()` into a "use client" wrapper file:

```tsx
// components/root-providers-dynamic.tsx
"use client"
import dynamic from "next/dynamic"

const RootProvidersDynamic = dynamic(
  () => import("./root-providers").then(m => m.RootProviders),
  { ssr: false }
)
export { RootProvidersDynamic as RootProviders }
```

Then import that wrapper in the Server Component with a plain static import:

```tsx
// app/layout.tsx  (Server Component)
import { RootProviders } from "@/components/root-providers-dynamic"
```

## How to apply
Any time a Server Component needs `dynamic(..., { ssr: false })`: create a small `"use client"` wrapper file that does the `dynamic()` call, then import that wrapper from the Server Component with a plain import.

**Why:** Next.js 15 enforces that `ssr: false` can only appear in Client Component files. Putting it in a Server Component is a compile/runtime error. The wrapper pattern satisfies the constraint while preserving the chunk split and lazy-loading benefits.
