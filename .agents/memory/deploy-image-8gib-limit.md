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
already near the cap because stray duplicate project copies carried their own
gitignored `node_modules` and `.next` output. Cleanup names are case-sensitive:
audit and prune every exact duplicate name rather than assuming one spelling
covers variants.

**How to apply:** when publish hits the 8 GiB cap, do NOT remove runtime-needed
nix deps (libreoffice + playwright-driver are both used at runtime here —
document rendering and computer-use/screenshots). Instead audit the working dir
for large dirs that survive the build and add them to the `junk` list in
`scripts/postbuild-slim.js`. Both `libreoffice` and `playwright-driver` are
heavy but load-bearing — cutting them breaks features, not the right lever.

**Layering note:** deletion does not reclaim a separate automatic hosting layer.
Here the root dependency tree alone is too large to coexist with the required
Nix and backend runtime layers, so automatic hosting installation must remain
disabled. Install or reuse root build dependencies inside the custom build
layer, then prune them before its final snapshot. Never trust a retained
workspace tree from package presence alone: require the installed Next version
to match the lockfile and a clean top-level `npm ls`; otherwise fall back to a
clean install.
