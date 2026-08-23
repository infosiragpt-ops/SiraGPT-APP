# Phone + desktop web responsive shells

SiraGPT is a single web app. Phones (`<768px`) and compact tablets (`≤879px`)
use overlay / stacked shells. Desktop layouts stay the existing split.

## Breakpoints

| Token | Width | Used for |
| --- | --- | --- |
| `MOBILE_BREAKPOINT` | `768` | Sidebar drawer, `/code` phone stack, header hamburger |
| `DOCUMENT_PREVIEW_OVERLAY_MAX_PX` / `CHAT_PANEL_OVERLAY_MAX_PX` | `879` | Chat right-pane overlay (docs, Word/Excel, search, sources, artifact, audio, cowork) |

The chat split mins are `420px` (transcript) + `460px` (preview). Below `880px`
that split clips the transcript, so every right-pane tenant becomes a
full-screen overlay (`data-testid="chat-right-panel"` +
`data-presentation="mobile-overlay"`).

## `/chat`

Phone chrome (light, no redesign):

- Top: hamburger (`md:hidden`) · briefcase · share. WhatsApp / “Subir de plan”
  hide below `768`.
- Transcript: bubbles + DOCX thumbs + Validado artifact cards (history / eye).
- Bottom composer stays sticky above the iOS home bar (`safe-area-inset-bottom`,
  keyboard-open `position: fixed`): `+` · «Pregúntale a Sira GPT» · DeepSeek
  pill · mic · send.

Document / attachment previews on compact viewports use
`UnifiedDocumentViewer variant="modal"` (full-screen, not a flex sibling).

The generation picker lists DeepSeek V4 Flash / Pro only. OpenRouter rows are
filtered in the UI (`listDeepSeekCatalogModels`) and fail-closed on send.

## `/code`

Desktop lock is unchanged: APPS company rail | CEO Office | Preview. Do **not**
reintroduce Panel / Controlar / Archivos / Recursos or a green Ejecutar FAB in
the workspace center.

On phones:

- `WorkspaceTopBar` (including header Ejecutar) does not mount.
- Company home hides the four desktop tool rows (`data-company-desktop-tools`).
- Empresa / Preview stack with a bottom tab bar that clears the home indicator.
- Publishing logs scroll inside the pane instead of forcing `960px` page overflow.

PR 334 (Grok Bot phone chrome) can replace the Empresa/Preview tabs; these
shells stay compatible.

## Tests

- `tests/responsive-phone-web-source.test.ts` — breakpoint + overlay + lock contracts
- `tests/chat-catalog-model.test.ts` — DeepSeek-only picker list
- `tests/code-agent-model-policy.test.ts` — DeepSeek-only `/code` catalog
- `tests/components/artifact-panel-adaptive.test.tsx` — drawer at `767`
- `e2e/chat-mobile-responsive.spec.ts` — 375px overflow / composer bounds
