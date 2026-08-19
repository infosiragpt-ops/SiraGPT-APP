# TypeScript Strictness — Gradual Adoption Plan

Status as of cycle 42 (2026-05-19).

## Current state

`tsconfig.json` already has `strict: true`. Beyond the core strict family, the
following additional flags are still **off**:

- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `noImplicitOverride`
- `noPropertyAccessFromIndexSignature`
- `noFallthroughCasesInSwitch`

## Audit — `noUncheckedIndexedAccess`

Enabling this flag with the current code base produces **184 errors** across
~30 files. That's above the cycle 42 cutoff (50 errors) for a single-cycle
enable + fix, so we keep the flag **off** for now and document the cleanup plan
here.

### Top offenders (by error count)

| Errors | File |
| ------ | ---- |
| 16 | `lib/long-paste.ts` |
| 15 | `components/document-preview.tsx` |
| 13 | `components/viewers/UnifiedDocumentViewer.tsx` |
| 13 | `components/chat-interface-enhanced.tsx` |
| 12 | `lib/chat-context-integrated.tsx` |
| 11 | `components/presentation-view.tsx` |
|  7 | `app/profile/page.tsx` |
|  5 | `lib/message-preservation.ts` |
|  5 | `lib/database.ts` |
|  5 | `components/text-to-speech-component.tsx` |
|  4 | `lib/download-utils.ts`, `lib/code-detection.ts`, `components/chat/ComposerInlineDisplays.tsx`, `components/chat/ArtifactCard.tsx`, `components/artifact/InteractiveArtifact.tsx` |

Remaining ~50 errors are spread across single-digit hits in `middleware.ts`,
`lib/utils.ts`, `lib/agent-task-service.ts`, and assorted UI components.

### Typical patterns to fix

1. `arr[i]` after `for (let i = 0; i < arr.length; i++)` — assert with
   `arr[i]!` or destructure via `for (const item of arr)`.
2. `groups[0]` from regex match — guard with `if (!match) return` or use
   optional chaining `match?.[0]`.
3. `obj[key]` on `Record<string, T>` look-ups — accept `T | undefined`
   at the call site and add an explicit check.
4. `parts.split(".")[0]` — store in const, narrow with `??` default.

### Suggested rollout

| Phase | Scope | Approx errors fixed | Cycle target |
| ----- | ----- | ------------------- | ------------ |
| 1 | `lib/*` only (long-paste, message-preservation, database, download-utils, code-detection, utils, chat-context-integrated, agent-task-service) | ~55 | next TS cycle |
| 2 | `components/document-preview`, `components/presentation-view`, `components/viewers/UnifiedDocumentViewer`, `components/chat-interface-enhanced` | ~50 | +1 cycle |
| 3 | Remaining components + `app/*` + `middleware.ts` + `hooks/*` | ~80 | +1 cycle |
| 4 | Flip `noUncheckedIndexedAccess: true` in `tsconfig.json`, run `npm run lint && npx tsc --noEmit` to confirm zero new errors | — | flip cycle |

## Other flags (deferred)

- `exactOptionalPropertyTypes` — likely high impact on React props that mix
  `prop?: T` with explicit `undefined`. Skip until phase 4 above lands.
- `noImplicitOverride` — low fix volume (we barely use class inheritance in
  TS), but low payoff too. Can be flipped opportunistically.
- `noPropertyAccessFromIndexSignature` — would force `obj["foo"]` everywhere
  we currently use `obj.foo` on `Record` types. Defer indefinitely; ROI low.

## Reproduction

```bash
# 1. Add the flag
sed -i '' 's/"strict": true,/"strict": true,\n    "noUncheckedIndexedAccess": true,/' tsconfig.json

# 2. Count errors
npx tsc --noEmit --skipLibCheck 2>&1 | grep -c "error TS"

# 3. Group by file
npx tsc --noEmit --skipLibCheck 2>&1 \
  | grep -E "^[^:]+\.[tj]sx?" \
  | cut -d'(' -f1 \
  | sort | uniq -c | sort -rn
```
