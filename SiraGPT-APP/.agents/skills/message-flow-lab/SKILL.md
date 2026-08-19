---
name: message-flow-lab
description: "Validate SiraGPT chat/message flows, optimistic updates, streaming lifecycle, background refreshes, and channel delivery behavior."
---

# Message Flow Lab

Use this skill when changing chat behavior, Telegram/OpenClaw delivery, streaming UX, message persistence, file attachments, or model selector behavior.

## Contract

- Preserve current visual design and layout.
- Validate both fast success and slow/partial-stream paths.
- Confirm user messages, attachments, assistant content, and metadata survive refresh.
- Do not send external messages unless the user explicitly asked or the target is a controlled test channel.

## Flows To Check

- Simple text chat: user turn persists, assistant answer streams, final message stores.
- Model switch: selected model remains valid for the active chat type.
- Video chat: `VIDEO` models load from `/api/ai/models?type=VIDEO`.
- File prompt: upload reference stays attached after chat refresh.
- Regenerate/stop: abort does not corrupt the saved assistant turn.
- Telegram delivery: progress update is brief; final answer is complete and not duplicated.

## Focused Probes

```bash
curl -sS 'https://api.siragpt.com/api/ai/models?type=TEXT' >/tmp/text-models.json
curl -sS 'https://api.siragpt.com/api/ai/models?type=VIDEO' >/tmp/video-models.json
npm run type-check
```

When changing frontend state helpers, add or update tests around `lib/message-preservation.ts`, `lib/chat-context-integrated.tsx`, or the relevant API client instead of relying only on manual clicking.

## Failure Heuristics

- Empty assistant after refresh usually means persistence race or orphan-tail merge issue.
- Model visible in admin but missing in chat usually means active/type/cache mismatch.
- Duplicate messages usually mean optimistic ID mismatch or final server refresh appending instead of reconciling.
- Telegram double replies usually mean both normal final and explicit channel send were used.

