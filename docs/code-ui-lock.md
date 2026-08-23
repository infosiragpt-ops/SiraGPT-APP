# Code UI lock — Empresas (`/code`)

Polish lock for the main Empresas company view. This is **not** a redesign:
three columns stay (departamentos · chat · Computadora/Rutinas). Do not
reintroduce a green play / Ejecutar / Arrancando button in the top bar.

## Must stay gone

- The green **Ejecutar** / **Arrancando…** play button in
  `components/code/workspace-top-bar.tsx` must be **absent from the DOM**.
  Do not CSS-hide it. If the run action is needed, keep it only inside the
  overflow **⋯** menu as a text item (`data-testid="workspace-header-overflow"`).
- Never restore `data-testid="workspace-header-run-stop"` or an
  `bg-emerald-600` play control in that header.

## Must stay

- Desktop/monitor icon at the far right of the top bar
  (`data-testid="workspace-header-department-computer"`).
- Right column: remote desktop (Chrome + Terminal dock) + **Rutinas**.
- Left department list + center chat + right Computadora/Rutinas.
- Left nav **Panel / Controlar / Archivos / Recursos** stays unless a later
  brief explicitly removes them. Do not reintroduce Arrancando/Ejecutar.

## Polish invariants

1. Spanish in this view. Heading is **Rutinas** (never "Routines"). Schedule
   strings use locale **es-PE** and a 24-hour clock
   (`lib/format-schedule-es-pe.ts`).
2. Top-bar toolbar icons share equal size/spacing and each has `title` +
   `aria-label`.
3. Department **names** wrap at the default sidebar width — no ellipsis
   truncation on the name (`data-dept-name-wrap="1"`).
4. Center empty state shows the active department name plus actionable
   suggestions (`data-testid="code-chat-empty-state"`).
5. noVNC fills its panel (`data-novnc-fit="cover"`, `resize=remote`) so grey
   letterboxing is not the default.
6. Clickables in this chrome have hover, active, focus-visible, and disabled.

## Re-apply

```bash
bash scripts/reapply-code-ui-lock.sh
```

That script fails if Ejecutar/Arrancando returned to the header, then
refreshes `docs/UI_LOCK_HASHES.txt` for the global UI lock.

## Capture before/after

Parent can capture at:

- Desktop (≥1440px): full three-column Empresas view.
- 1280px: same structure; department names still wrap, no green Ejecutar.
