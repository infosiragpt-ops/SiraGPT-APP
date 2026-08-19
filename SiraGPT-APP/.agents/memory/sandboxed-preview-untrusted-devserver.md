---
name: Sandboxed single-origin preview of an untrusted dev server
description: How to iframe an untrusted (generated) Vite dev server on your own origin safely AND have its assets actually load — cookie gate fails, path token works.
---

# Previewing an untrusted dev server in a same-origin iframe

Context: SiraGPT /code "Ejecutar" runs a generated Vite project as a real dev
server on a private 127.0.0.1 port and reverse-proxies it under
`/api/code-runner/<id>/<token>/app/` so the browser can iframe it (no Docker).

## The two hard constraints pull against each other

1. **Security** — the generated code is UNTRUSTED. The iframe MUST be
   `sandbox` WITHOUT `allow-same-origin`, giving it an **opaque ("null")
   origin**. Without that, the untrusted app runs with the real app's origin and
   can read its cookies/localStorage/same-origin APIs.
2. **It has to actually load** — an opaque-origin iframe makes every
   asset/ES-module/dynamic-import fetch a **cross-origin** request.

## Why a cookie gate silently fails (the trap)

A run-scoped httpOnly cookie seems like the obvious gate for the proxy. It does
NOT work for the live preview:
- Vite serves the app via `<script type="module">`. Module scripts use
  **credentials mode `same-origin`** by default. From the opaque iframe origin to
  the real origin the request is cross-origin → the browser **omits the cookie**.
- The proxy gate then 403s every module/asset *before CORS even matters*.
- `SameSite=None;Secure` does not save you — that controls cross-*site* sending,
  not the module-script credentials-mode decision.
- Adding `crossorigin="use-credentials"` would force credentials, but you'd have
  to rewrite the proxied HTML AND hope dynamic imports inherit it — fragile and
  hard to verify without an in-browser session.

## The fix that works deterministically: token in the URL PATH

Put the unguessable run token **in the proxy path** (`.../<id>/<token>/app/`) and
launch Vite with `--base` set to that full path. Then:
- Every asset/module/dynamic-import URL Vite emits already contains the token, so
  it is carried automatically **regardless of credentials mode or CORS**.
- The proxy reads the token from `req.params`, not a cookie. **No credentials
  needed**, so CORS is just `Access-Control-Allow-Origin: <echoed origin>` (which
  covers `"null"`) **without** `Allow-Credentials`. A credential-less cross-origin
  GET passes that check.

**Why:** the credentials-mode behavior of module scripts is the root cause; a
path token sidesteps the entire cookie/SameSite/credentials/CORS-credentials
chain.

**How to apply / guardrails:**
- Still strip incoming `cookie`/`authorization` before forwarding to the
  untrusted server, and strip upstream `set-cookie` + `access-control-*` +
  hop-by-hop on the way back.
- Token-in-URL leak: set `Referrer-Policy: no-referrer` on proxied responses so
  the app can't leak the token to third parties via `Referer`. Token is 192-bit
  random, run-scoped, idle-reaped (~30 min) — acceptable for a single-owner
  ephemeral preview.
- Never open the live run in a top-level tab (no sandbox there → real-origin
  execution). Keep "open in new tab" disabled while a live run is showing.
- Known edge case (acceptable for MVP): a generated app using **root-absolute**
  URLs (`/foo.png`, `fetch('/data')`) bypasses `--base` and won't carry the
  token — that's an app-authoring anti-pattern that also breaks a real `--base`
  deploy.
- Heaviest fully-robust alternative (future): serve the preview from a
  **separate origin/subdomain** so it's naturally isolated and same-origin to
  itself; then you don't need the sandbox-opaque-origin CORS dance at all.
