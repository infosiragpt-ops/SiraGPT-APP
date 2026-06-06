---
name: Reserved VM 8 GiB image limit
description: Why publish fails with "image size is over the limit of 8 GiB" and how the slim step controls it.
---

# Deploy fails: "image size is over the limit of 8 GiB"

**Symptom:** Publish build compiles fine (`next build` succeeds, layers start
pushing) then fails at the very end with
`error: image size is over the limit of 8 GiB`. This is a Reserved VM (gce)
image-size cap, NOT a RAM/machine-size issue — bumping the VM does not help.

**Why it happens here:** Deploys **reuse the workspace** (see the comment in
`.replit` `[deployment]`). So whatever sits in the working directory after the
build — including gitignored cruft like root `node_modules` (~5 GB) and any
stray nested `node_modules` — gets baked into the image unless explicitly
deleted. `scripts/postbuild-slim.js` is the gatekeeper: it runs last
(gated on `REPLIT_DEPLOYMENT=1`) and removes those heavy working-dir trees.

**What tipped it over:** Adding `pkgs.libreoffice` to `replit.nix` (~1.6 GB nix
closure, needed at runtime for the document/PDF render pipeline). The image was
already near the cap because a **stray duplicate project copy `siraGPT/`**
(2.2 GB, its own gitignored `node_modules`) was NOT in the slim prune list.
Fix was to add `siraGPT` to the prune list, freeing ~2.2 GB.

**How to apply:** when publish hits the 8 GiB cap, do NOT remove runtime-needed
nix deps (libreoffice + playwright-driver are both used at runtime here —
document rendering and computer-use/screenshots). Instead audit the working dir
for large dirs that survive the build and add them to the `junk` list in
`scripts/postbuild-slim.js`. Both `libreoffice` and `playwright-driver` are
heavy but load-bearing — cutting them breaks features, not the right lever.
