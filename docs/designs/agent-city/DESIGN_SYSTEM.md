# SiraGPT Agent Megaoffice — Design System Inventory

## Accepted visual direction

- Desktop concept: `agent-megaoffice-desktop-concept.jpg`
- Mobile concept: `agent-megaoffice-mobile-concept.jpg`
- The city is environmental context. Departments are zones inside one continuous rooftop office in SIRA HQ; neighboring buildings are never department destinations.
- All operational values come from live product data. Sample numbers and names shown in the concepts are not copied into the UI.

## Information architecture

- Primary title: `Oficina de agentes`
- Primary destinations: `Vista 3D`, `Panel`, `Controlar`, `Archivos`, `Recursos`
- Filters: `Todos`, `Activos`, `Todos los departamentos`
- Camera actions: `Acercar`, `Alejar`, `Restablecer cámara`
- Status metrics: `Puestos ocupados`, `Agentes activos`, `Tareas en cola`, `Aprobaciones`, `Salud del sistema`
- Worker detail: `Agente seleccionado`, `Departamento`, `Estado`, `Trabajo actual`, `Coste`, `Evidencia`, `Última actividad`, `Abrir sesión`, `Abrir departamento`
- Department names, capacity and work summaries are always generated from the real company model.

## Tokens

| Role | Value |
| --- | --- |
| Canvas | `#05070D` |
| Primary surface | `#09111F` |
| Raised surface | `#0F1B2D` |
| Main text | `#EAF2FF` |
| Muted text | `#94A3B8` |
| Primary action | `#2563EB` |
| Spatial accent | `#38BDF8` |
| Ready | `#22C55E` |
| Attention | `#F59E0B` |
| Blocked | `#EF4444` |

- Typography: the application's existing Inter-compatible sans stack. Sizes are 12, 13, 14, 16 and 20 px; monospace is reserved for run identifiers and telemetry.
- Corners: 10–16 px for operational surfaces; circular treatment only for avatars and status indicators.
- Depth: restrained blur, one-pixel cool borders and soft navy shadows. No neon bloom behind body copy.
- Motion: 200–300 ms for interface state changes. `prefers-reduced-motion` disables decorative movement and pulsing.
- Interaction: every control is at least 44 × 44 px and has a visible keyboard focus state.

## Responsive containers

- Desktop: compact top command bar, left navigation rail, unobstructed 3D center, optional 360 px worker drawer, compact bottom telemetry.
- Tablet: horizontal destination strip, full-width 3D, worker drawer overlaid from the right.
- Mobile: the office remains the primary visual; destinations live in a bottom navigation and the selected worker opens in a bottom sheet. Camera controls remain visible above the sheet.
- Accessible parity: every clickable canvas entity must also be reachable through a DOM department/worker roster.

## Intentional deviations from the concepts

- Live SiraGPT names, departments, costs, approvals, blockers and states replace illustrative copy.
- The existing `/code` product shell remains unchanged outside the office dialog.
- The 3D scene is interactive and deterministic, not a static concept image.
- Capacity seats may be visually aggregated for GPU performance, but the exact logical capacity is always exposed in the UI and accessibility tree.
