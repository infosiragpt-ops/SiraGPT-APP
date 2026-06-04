---
name: UI lock re-baseline
description: How to refresh docs/UI_LOCK_HASHES.txt after approved frontend changes
---

# Refreshing the UI lock baseline

`scripts/verify-ui-lock.sh` compares a shasum manifest of frontend files against
`docs/UI_LOCK_HASHES.txt` and fails the build on ANY diff. It has **no update
mode** — after an *approved* UI/functional change to frontend files you must
regenerate the baseline manually with the exact same file-set the script scans:

```bash
find app components hooks lib styles tailwind.config.js postcss.config.js postcss.config.mjs next.config.mjs \
  -type f \( -name "*.tsx" -o -name "*.css" -o -name "*.ts" -o -name "*.js" -o -name "*.mjs" \) \
  ! -path "*/node_modules/*" ! -path "*/.next/*" ! -path "*/.turbo/*" ! -path "*/dist/*" \
  | sort | xargs shasum -a 256 | sort > docs/UI_LOCK_HASHES.txt
```

**Why:** the gate is a governance control, not a code change — only re-baseline
for changes the user already approved/merged (e.g. a previously-approved feature
that touched a frontend file). Never re-baseline to mask an unapproved UI edit.

**How to apply:** run the regen, then `bash scripts/verify-ui-lock.sh` must print
"UI lock verified". The manifest covers `app/ components/ hooks/ lib/ styles/`
plus the listed root config files.
