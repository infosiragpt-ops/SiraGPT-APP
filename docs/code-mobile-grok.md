# /code phone chrome — Grok Bot

Phone-only shell for `https://siragpt.com/code`. Desktop `/code` keeps its own lock (Routines + computer preview; no Panel / Controlar / Archivos / Recursos, no green Publicar play). This file only describes the **max-width 767** path.

## When it activates

`useResolvedMobile()` / `width < 768`. The workspace root then sets `data-testid="code-mobile-grok-shell"`. Wider viewports keep `WorkspaceTopBar`, the APPS rail, CEO Office, and Preview split.

## Chrome

- Solid white canvas
- Floating circular controls with a soft shadow
- Top: circular back (`<`) → company / departments; center pill (avatar + agent name + green online dot); circular monitor → department computer / noVNC
- Main: existing department chat transcript / empty state, **flex-1** between header and composer (`CodeMobileGrokShell` children). The phone shell uses `--app-viewport-height` (not raw `100vh`) so the list fills and the composer is not clipped.
- Bottom: sticky circular `+` (attach + tools), wide capsule with placeholder `Ask {agentName}`, mic inside the capsule, send on the same row

## Behaviour

| Control | Action |
|---|---|
| Back | `bardNav.onBackToCompany()` (company + department list) |
| Agent pill | Opens the existing department drawer |
| Computer | `siragpt:open-current-department-computer` → full-screen `DepartmentComputerPane` |
| `+` | Attach files + composer tools |
| Capsule | Same send / paste / drop path as desktop `/code` |
| Mic | Web Speech dictation into the draft |

Models on this path are **DeepSeek V4 Flash / Pro only**. OpenRouter slugs are filtered out of the phone picker.

## Files

- `components/code/code-mobile-grok-chrome.tsx` — `CodeMobileGrokShell` (children fill), header, mic, computer overlay
- `lib/code-mobile-grok.ts` — breakpoint + `Ask {name}` helper
- `components/code/code-workspace.tsx` — phone shell, hide desktop top bar / Empresa–Preview tabs
- `components/code/ai-code-chat-panel.tsx` — phone header + capsule composer
- `app/globals.css` — `.code-mobile-grok-*`

Target branch: `production-main`.
