# Voice creation reference QA — 2026-09-20

Scope: existing `/agentes` voice creation panel and clone workspace, not a redesign of the application navigation, model picker or composer.

## Visual truth and evidence

- Source panel: `/Users/luis/.openclaw/workspace/media/inbound/openclaw-staged-50d42d22-b3f1-4db0-b11b-5fef7442b10a/input-a0644a20-c74d-4959-bc13-a3b3275583db.png` (2452 × 1426).
- Source upload: same directory, `input-45f90edb-7b1c-45e5-a75e-8be9a417da31.png` (2460 × 1426).
- CSS viewport: 1200 × 698, deviceScaleFactor 1. References normalized to that size; source density is approximately 2×. Minor source aspect ratio differences normalized before comparison.
- Stable states: voice mode with compact right panel; instant clone upload with three tips, media dropzone, recording and disabled Next; 390 × 844 mobile upload.
- Browser-rendered implementation: `/tmp/voice-pr-evidence/voice-reference-layout-ref-dc416-se-and-reopen-without-modal-chromium/voice-panel.png` and `voice-upload.png`.
- Full-view paired comparisons: `/tmp/voice-qa/pr-compare-panel.png`, `/tmp/voice-qa/pr-compare-upload.png`.
- Focused paired comparisons: `/tmp/voice-qa/focus-panel.png`, `/tmp/voice-qa/focus-upload.png` (earlier capture before final 12px vertical correction).
- Mobile: `/tmp/voice-verified-e2e/voice-reference-layout-mob-b187c-nd-returns-to-voice-choices-chromium/voice-mobile.png`.

## Findings and comparison history

1. Initial P1: the panel covered the composer's controls. Reserved its 208px desktop column; actual browser bounding-box assertion now checks non-overlap.
2. Initial P2: upload workspace stretched too wide and close action sat far from the form. Constrained the form to 556px, placed close relative to it, and aligned the desktop content to the reference.
3. Initial P2: right cards/list were too tall. Reduced card padding, text line-height and list row density, retaining legible live labels.
4. Post-fix paired review: correct right-side grouping and persistent panel, three-column tips, rounded dotted upload area, recording action and validation footer. Mobile stacks the tips, scrolls within the workspace, has accessible close/Next controls and no horizontal overflow.
5. Final capture waits for the tool menu and tooltip exit animations instead of judging a transient screenshot.

## Required fidelity surfaces

- **Typography:** existing application sans-serif retained; central 12–13px body and medium headings match the reference hierarchy. Small panel labels are slightly larger than the downscaled reference for readability.
- **Spacing/layout:** compact 208px right column, 556px central form, 208px minimum dropzone, thin rounded card borders. Existing composer and navigation intentionally preserved; no modal backdrop in the voice creation flow.
- **Colors/tokens:** white/background surface, neutral text, gray borders, black primary action and gray disabled state. Dark mode uses the existing product tokens.
- **Assets:** existing Lucide icons, no red annotation arrow or fabricated avatars. The voice API has no portrait field, so rows use the product's microphone icon rather than inventing identities. Voice names/counts/availability are live data, not copied claims from the reference.
- **Copy/content:** Spanish reference upload/tip/action copy. Real product constraints remain explicit: instant 10–20 seconds/10 MB, professional minimum 30 minutes/25 MB per file. Professional quota is not fabricated; local clones are labeled Sira Voz and never silently switch the chosen provider.

## Functional verification

- 8 Playwright scenarios: panel/composer and close/reopen, real WAV decode (9s rejected/10s accepted), multipart clone submission with mocked authenticated API, invalid/oversize/overlong media, unavailable engine, microphone rejection with usable upload fallback, professional minimum/other tools, mobile layout, and native MediaRecorder with Chromium's synthetic microphone plus ended-track verification.
- Creation scenario also asserts the chosen ElevenLabs model is unchanged after saving a Sira voice.
- Runtime page errors and console errors checked in the primary scenarios. Notification/approval fixtures return real envelopes.
- Next.js development indicator is not product UI. On mobile it overlaps the plus button, so that test uses the real accessible keyboard activation, not a forced click or hidden application overlay.
- 818 component tests; 12 existing voice wiring/storage tests; TypeScript and UI-lock checks.
- No real voice clone, paid synthesis or identity-verification transaction performed. Production checks are version/readiness only; vendor voice quality is outside this layout QA.

## Follow-up polish

P3: exact voice portraits/flags require catalog data which the current API does not return; no synthetic replacements introduced. Existing composer dimensions and provider/language labels intentionally follow the product, not the pictured account's settings.

## Implementation checklist

- [x] Preserve existing authenticated voice/PVC services and additional studio tools.
- [x] No silent model substitution or invented quota.
- [x] Desktop/mobile browser interactions and paired visual comparison.
- [x] Required E2E gate includes the new voice suite.
- [x] Update UI-lock hashes with intentional visual changes.

final result: passed
