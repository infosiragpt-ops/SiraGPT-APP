import type { SkillContext, SkillLogger, SkillManifest } from './types.ts';

const SCOPE_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function buildLogger(skillName: string, sink: SkillLogger | undefined): SkillLogger {
  const target =
    sink ??
    ({
      debug: (...a: unknown[]) => console.debug('[skill]', skillName, ...a),
      info: (...a: unknown[]) => console.info('[skill]', skillName, ...a),
      warn: (...a: unknown[]) => console.warn('[skill]', skillName, ...a),
      error: (...a: unknown[]) => console.error('[skill]', skillName, ...a),
    } as SkillLogger);

  return {
    debug: (msg, meta) => target.debug(msg, meta),
    info: (msg, meta) => target.info(msg, meta),
    warn: (msg, meta) => target.warn(msg, meta),
    error: (msg, meta) => target.error(msg, meta),
  };
}

/**
 * Filter env vars exposed to a skill. We expose only vars whose key matches
 * a "scope" of the form `env:VAR_NAME` declared in its manifest. This keeps
 * skills from quietly reading unrelated secrets via process.env.
 */
function buildEnv(scopes: ReadonlySet<string>): Readonly<Record<string, string | undefined>> {
  const allowed: Record<string, string | undefined> = {};
  for (const scope of scopes) {
    if (!scope.startsWith('env:')) continue;
    const key = scope.slice('env:'.length);
    if (!SCOPE_ENV_PATTERN.test(key)) continue;
    allowed[key] = process.env[key];
  }
  return Object.freeze(allowed);
}

export interface BuildContextOptions {
  logger?: SkillLogger;
  fetchImpl?: typeof fetch;
  extraGrants?: Iterable<string>;
}

export function buildSkillContext(
  manifest: SkillManifest,
  options: BuildContextOptions = {},
): SkillContext {
  const grants = new Set<string>(manifest.scopes);
  if (options.extraGrants) {
    for (const g of options.extraGrants) grants.add(g);
  }
  const env = buildEnv(grants);
  const logger = buildLogger(manifest.name, options.logger);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const guardedFetch: typeof fetch = (input, init) => {
    if (!grants.has('net:outbound')) {
      return Promise.reject(
        new Error(
          `skill "${manifest.name}" attempted fetch without "net:outbound" scope`,
        ),
      );
    }
    return fetchImpl(input, init);
  };

  return Object.freeze({
    skillName: manifest.name,
    version: manifest.version,
    logger,
    fetch: guardedFetch,
    env,
    grants,
    hasScope: (scope: string) => grants.has(scope),
  });
}
