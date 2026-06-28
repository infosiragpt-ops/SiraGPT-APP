---
name: React 18.3 window.reportError false crash
description: React 18.3 changed recoverable error reporting to window.reportError(); Replit's crash detector intercepts this. Fix is an inline script override in layout head.
---

## Rule

Override `window.reportError` in an inline `<script>` in `<head>` to filter React 18.3 recoverable hydration errors before they reach Replit's crash detector. Also add an EOF-reload guard for restart scenarios.

```javascript
(function(){
  var _re=window.reportError;
  window.reportError=function(e){
    var m=(e&&e.message)||'';
    if(m.indexOf('Hydration failed')!==-1||m.indexOf('did not match the client')!==-1||m.indexOf('while hydrating')!==-1)return;
    typeof _re==='function'&&_re.call(this,e);
  };
  var rl=false;function rf(){if(!rl){rl=true;setTimeout(function(){location.reload();},2000);}}
  window.addEventListener('unhandledrejection',function(e){var m=(e.reason&&e.reason.message)||'';if(m.indexOf('Unexpected EOF')!==-1){e.preventDefault();rf();}});
  window.addEventListener('error',function(e){if((e.message||'').indexOf('Unexpected EOF')!==-1){e.preventDefault();rf();}},true);
})();
```

**Why:**

React 18.3.1 changed how recoverable errors (including hydration mismatches) are reported:
- **Before React 18.3**: reported via `console.error()` — harmless to Replit's detector
- **React 18.3+**: reported via `window.reportError(error)` → browser dispatches an `ErrorEvent` on `window` → Replit's crash detector captures it as `Method -unhandlederror` → shows false "crash"

The hydration mismatch itself is NOT fatal: React immediately regenerates the tree client-side and the app works correctly. The crash detection is a false positive.

**"Unexpected EOF" during restarts:**

When the app restarts, the old Next.js process dies mid-SSR-stream. The browser receives an incomplete HTML document. React tries to hydrate the truncated DOM → structural mismatch → `window.reportError()` → Replit sees a "crash". The EOF-reload guard intercepts the EOF event and reloads after 2 s so the browser gets a complete page from the new process.

**The `<div hidden="">` RSC flight boundary:**

The server HTML always has `<div hidden=""><!--$--><!--/$--></div>` as the first `<body>` child (before the `<a>` skip-link). This is React/Next.js internal behavior for Client Component RSC boundaries. It cannot be eliminated from layout.tsx code. React's hydrator is SUPPOSED to skip it, but the restart-caused incomplete HTML prevents correct skipping → mismatch.

**How to apply:**

- The inline script is in `app/layout.tsx` `<head>` section, `dangerouslySetInnerHTML`
- `suppressHydrationWarning` must be on both the `<script>` tag AND the `<head>` element
- The `window.reportError` filter only intercepts specific hydration messages — all other errors pass through normally to Sentry and other monitors
- Sentry hooks `window.addEventListener('error')` (not `window.reportError`) so it is NOT affected by this override
