# /code desktop UI lock

Git-anchored chrome contract for `https://siragpt.com/code`.

Frontend ships as a Next.js **standalone image**. Host TSX is **not** read
at runtime. A one-off VPS patch disappears on the next `docker compose
... --force-recreate frontend`. Keep the lock in git.

## Golden chrome

| Surface | Status |
|---|---|
| Company nav **Panel / Controlar / Archivos / Recursos** | Removed (must not remount) |
| Top-bar green **Ejecutar / Detener / Arrancando…** (`workspace-header-run-stop`) | Removed (must not remount) |
| Top-bar **Publicar** (`bg-zinc-900`) | Kept |
| **Routines** | Kept (reserved slot; do not delete the keep-list) |
| **Computadora** (noVNC / ACS) | Kept and wired |
| Empty chat starter grid | `EmptyChat` returns `null` |

Source of truth: `lib/code-chrome-lock.ts`.

Do **not** treat «Arrancando…» as a loading label we can bring back. It is
the same emerald header control as Ejecutar / Detener.

## Re-apply / verify

Intentional `/code` chrome edits must re-baseline the visual-surface hashes
in the same commit:

```bash
npm run ui-lock:update
bash scripts/reapply-code-ui-lock.sh --check
node scripts/assert-continuity-guards.js
```

`--check` is what CI runs. The script never treats leftover argv as a
directory (`--check` is a flag, not a path) and never sed-patches
production files.

Without `--check` the script reprints the contract and still verifies.

## Do not

- Re-introduce `workspace-header-run-stop`, `Arrancando`, `Ejecutar`, or
  `Detener` on `components/code/workspace-top-bar.tsx`.
- Re-introduce `label="Panel"`, `label="Controlar"`, `label="Archivos"`,
  or `label="Recursos"` in `components/code/agent-company-panel.tsx`.
- Hide or restyle the black Publicar button.
- Drop the Routines slot or the Computadora / noVNC wiring.
- Flip `CODE_CHROME_LOCK.showForbiddenCompanyNav` or
  `showHeaderRunStopButton` to `true` without updating this doc **and**
  the SSOT.
