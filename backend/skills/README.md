# `backend/skills/`

Plugin-style skills loaded at runtime by `backend/src/skills/registry.ts`.

This is **separate** from `backend/src/skills/` (the legacy JS skill set used
by `backend/src/services/skills/registry.js`). The two systems coexist; new
skills should land here.

## Layout

```
backend/skills/
  <skill_name>/
    skill.json   # manifest validated by SkillManifestSchema
    index.ts     # default-exports a SkillModule
```

`<skill_name>` must match `manifest.name` (lowercase, snake/kebab).

## CLI

```
npm run skill:list                    # list every skill the registry sees
npm run skill:validate -- <path>      # validate one folder or skill.json
```

The CLI is implemented in `backend/src/skills/cli.ts` and runs through
`tsx` so `index.ts` can be imported without a build step.
