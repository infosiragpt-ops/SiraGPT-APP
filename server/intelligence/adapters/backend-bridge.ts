/**
 * server/intelligence/adapters/backend-bridge.ts
 *
 * The single seam between the (TypeScript, ports-and-adapters) intelligence
 * core and the existing (CommonJS) backend services under `backend/src/`.
 *
 * Why this exists:
 * - The backend is plain CommonJS JavaScript. The core is TypeScript.
 * - Adapters need to lazily `require()` backend modules WITHOUT the TypeScript
 *   compiler trying to statically resolve / pull in those `.js` files (which
 *   would happen under the root tsconfig's `allowJs`). We therefore obtain a
 *   `require` via `node:module#createRequire` (whose result is typed `any`),
 *   so module paths stay opaque to the type-checker.
 * - The path must resolve correctly whether the code runs from source
 *   (`server/intelligence/...`) or from the compiled test output
 *   (`.test-dist/server/intelligence/...`). We therefore anchor every backend
 *   import to the discovered repository root, not to `__dirname`.
 *
 * Every load is wrapped so a missing/unbuilt backend module degrades to `null`
 * (fail-open) rather than throwing — adapters then fall back to null-objects.
 */

import { createRequire } from 'node:module';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';

let cachedRoot: string | null = null;

/**
 * Walk up from a starting directory until we find the repo root — identified by
 * the presence of a `backend/package.json`. Falls back to `process.cwd()`.
 */
export function resolveRepoRoot(startDir?: string): string {
  if (cachedRoot) return cachedRoot;
  const candidates: string[] = [];
  if (startDir) candidates.push(startDir);
  candidates.push(process.cwd());

  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 12; i += 1) {
      try {
        const marker = nodePath.join(dir, 'backend', 'package.json');
        if (nodeFs.existsSync(marker)) {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        /* ignore and keep walking */
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}

// A require anchored at the repo root. The referrer file need not exist;
// createRequire only uses its directory to seed module resolution, and we
// always pass absolute paths anyway.
function backendRequire(): (id: string) => unknown {
  const root = resolveRepoRoot();
  const anchor = nodePath.join(root, 'package.json');
  return createRequire(anchor) as (id: string) => unknown;
}

/**
 * Lazily load a backend module by its repo-root-relative path, e.g.
 * `loadBackendModule('backend/src/services/observability/langfuse')`.
 *
 * Returns `null` (never throws) when the module cannot be loaded, so adapters
 * can degrade gracefully.
 */
export function loadBackendModule<T = unknown>(relPath: string): T | null {
  try {
    const root = resolveRepoRoot();
    const abs = nodePath.join(root, relPath);
    const req = backendRequire();
    return req(abs) as T;
  } catch {
    return null;
  }
}

/**
 * Load an npm package resolvable from the backend's `node_modules` (e.g.
 * `openai`), anchoring resolution at `<root>/backend/` so bare specifiers
 * resolve against the backend dependency tree. Returns `null` on failure.
 */
export function loadNodeModule<T = unknown>(name: string): T | null {
  try {
    const root = resolveRepoRoot();
    const anchor = nodePath.join(root, 'backend', 'package.json');
    const req = createRequire(anchor) as (id: string) => unknown;
    return req(name) as T;
  } catch {
    try {
      // Fall back to the repo-root dependency tree.
      const req = backendRequire();
      return req(name) as T;
    } catch {
      return null;
    }
  }
}

/** Reset the cached repo root (test helper). */
export function __resetRepoRootCache(): void {
  cachedRoot = null;
}
