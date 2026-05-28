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

Instruction-only skills can also be written as:

```
backend/skills/
  <skill_name>/
    SKILL.md     # frontmatter + operating instructions
```

`<skill_name>` must match `manifest.name` (lowercase, snake/kebab).

`SKILL.md` files are loaded as first-class skills. The registry reads
`name`, `description`, and optional `version` from frontmatter, exposes a
standard `read_instructions` tool, and includes the body in recommendation
search. This lets the backend adopt operational playbooks without shipping
new executable code for every skill.

## CLI

```
npm run skill:list                    # list every skill the registry sees
npm run skill:recommend -- "debug a failing test"
npm run skill:validate -- <path>      # validate one folder or skill.json/SKILL.md
```

The CLI is implemented in `backend/src/skills/cli.ts` and runs through
`tsx` so `index.ts` can be imported without a build step.
