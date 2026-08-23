# /code desktop UI lock

This is the git-anchored replacement for the historical VPS-only
`docs/code-ui-lock.md` + `scripts/reapply-code-ui-lock.sh` pair.

Frontend ships as a Next.js **standalone image**. Host TSX is **not** read
at runtime. A one-off VPS patch disappears on the next `docker compose
... --force-recreate frontend`. Keep the lock in git.

## Contract

| Surface | Status |
|---|---|
| Company nav **Panel / Controlar / Archivos / Recursos** | Hidden |
| Top-bar green **Ejecutar** | Hidden |
| Top-bar **Publicar** | Hidden |
| **Routines** | Kept (reserved slot; do not delete the keep-list) |
| **Computadora** (noVNC / ACS) | Kept and wired |

Source of truth: `lib/code-chrome-lock.ts`.

## Re-apply / verify

```bash
bash scripts/reapply-code-ui-lock.sh --check
```

`--check` is what CI runs. Without `--check` the script reprints the
contract and exits 0 (it no longer sed-patches production files — that
was the VPS-only failure mode).

## Do not

- Re-introduce those four company-nav labels or the green Ejecutar / Publicar
  buttons without updating `lib/code-chrome-lock.ts` **and** this doc.
- Rebuild the frontend image during an engine-only wave (see
  `docs/continuity-guards.md`).
