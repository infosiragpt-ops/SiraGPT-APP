'use strict';

/**
 * Zod schemas for the organisation endpoints.
 *
 * Cycle 78 — the per-org JSON settings bag (`PATCH /api/orgs/:id/settings`)
 * historically accepted arbitrary keys. To prevent typos (`responsestyle`
 * vs `responseStyle`) and bad shapes (`branding: "sira"` where the FE
 * expects `{ primaryColor, logoUrl }`) we now validate the shape of the
 * **known** keys with zod. Unknown keys are preserved for forward
 * compatibility but are surfaced back to the caller as a `warnings` array
 * so we notice when callers drift.
 *
 * The shape mirrors the FE settings page (components/org-settings/*) and
 * the auto-generated lib/api-types.ts contract.
 */

const { z } = require('zod');

// Hex color — `#rgb`, `#rrggbb`, optional alpha (`#rgba`, `#rrggbbaa`).
// Keep tolerant — branding tools paste freely. Validation here is shape
// only, not perceptual contrast.
const HexColorSchema = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
    message: 'org.settings.branding.primaryColor.invalid',
  });

const LogoUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048, { message: 'org.settings.branding.logoUrl.too_long' })
  .refine(
    (v) => /^https?:\/\//i.test(v) || v.startsWith('data:image/'),
    { message: 'org.settings.branding.logoUrl.invalid' },
  );

const BrandingSchema = z
  .object({
    primaryColor: HexColorSchema.optional(),
    logoUrl: LogoUrlSchema.optional(),
  })
  .strict();

const FeaturesSchema = z
  .object({
    betaCowork: z.boolean().optional(),
    betaAgents: z.boolean().optional(),
  })
  .strict();

const ResponseStyleSchema = z.enum(['concise', 'detailed', 'balanced']);

// Allowlist of AI provider names accepted as org-level preference.
// Mirrors the `actualProvider` branch in routes/ai.js. Case-insensitive
// at the route layer, but stored verbatim so the FE round-trips cleanly.
const AI_PROVIDER_ALLOWLIST = Object.freeze([
  'OpenAI',
  'Anthropic',
  'Gemini',
  'OpenRouter',
  'DeepSeek',
]);

const AiProviderSchema = z.enum(AI_PROVIDER_ALLOWLIST);

// Per-org AI preferences (Task 1 + Task 2). All keys optional — the
// route layer treats missing keys as "no override". `maxCostPerRequestUSD`
// is the per-request hard cap surfaced by the token-budget preflight.
const AiSettingsSchema = z
  .object({
    preferredProvider: AiProviderSchema.optional(),
    preferredModel: z.string().trim().min(1).max(120).optional(),
    maxCostPerRequestUSD: z.number().positive().max(1_000).optional(),
  })
  .strict();

// Per-org AuditLog retention override (ratchet 44, task 1).
// `retentionMonths` is the online retention window the
// `archive-audit-logs` cron honours when archiving rows authored by
// members of this organisation. Default fallback (when unset) is 12
// months / 1 year — matching docs/data-retention.md. The hard cap is 60
// months / 5 years so an org can't push the global pruner past the
// archive-sweep horizon (`SIRAGPT_AUDIT_ARCHIVE_RETENTION_MONTHS`,
// 36mo default). Minimum 1 month so compliance still has a grace
// window before rows leave the operational DB.
const AuditSettingsSchema = z
  .object({
    retentionMonths: z.number().int().min(1).max(60).optional(),
  })
  .strict();

// Per-org GDPR export quota override (ratchet 44, task 2). The
// `quarterlyLimit` value overrides the per-user 10-exports/quarter
// default for calls executed in this organisation's context. Range
// [1, 1000] — the upper bound exists so a misconfigured org can't
// disable the cap entirely. Decimals are rejected (integer-only).
const ExportSettingsSchema = z
  .object({
    quarterlyLimit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

// `.passthrough()` keeps unknown keys (forward-compat). The known keys
// still get validated; the route layer extracts the leftover keys and
// returns them as `warnings` so callers know they're not yet recognised.
const OrgSettingsSchema = z
  .object({
    defaultModel: z.string().trim().min(1).max(120).optional(),
    responseStyle: ResponseStyleSchema.optional(),
    branding: BrandingSchema.optional(),
    features: FeaturesSchema.optional(),
    ai: AiSettingsSchema.optional(),
    audit: AuditSettingsSchema.optional(),
    export: ExportSettingsSchema.optional(),
  })
  .passthrough();

// Known top-level keys — the route uses this to compute the warning list.
const ORG_SETTINGS_KNOWN_KEYS = Object.freeze([
  'defaultModel',
  'responseStyle',
  'branding',
  'features',
  'ai',
  'audit',
  'export',
]);

// PATCH-friendly variant: each known key may be explicitly `null` to
// remove it from the stored settings bag (matches `mergeSettings` in
// routes/orgs.js). Unknown keys still pass through.
const OrgSettingsPatchSchema = z
  .object({
    defaultModel: z.union([z.string().trim().min(1).max(120), z.null()]).optional(),
    responseStyle: z.union([ResponseStyleSchema, z.null()]).optional(),
    branding: z.union([BrandingSchema, z.null()]).optional(),
    features: z.union([FeaturesSchema, z.null()]).optional(),
    ai: z.union([AiSettingsSchema, z.null()]).optional(),
    audit: z.union([AuditSettingsSchema, z.null()]).optional(),
    export: z.union([ExportSettingsSchema, z.null()]).optional(),
  })
  .passthrough();

/**
 * Parse an incoming PATCH payload and return `{ value, warnings, error }`.
 * Never throws — callers can shape a 400 response from `error`.
 *
 * - `value` is the validated object (always a plain JSON object on success)
 * - `warnings` is the list of unknown top-level keys
 * - `error` is null on success or a zod-formatted issue list on failure
 */
function parseOrgSettingsPatch(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      value: null,
      warnings: [],
      error: { message: 'settings must be a JSON object' },
    };
  }
  const result = OrgSettingsPatchSchema.safeParse(input);
  if (!result.success) {
    return {
      value: null,
      warnings: [],
      error: {
        message: 'invalid org settings payload',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      },
    };
  }
  const warnings = Object.keys(result.data).filter(
    (k) => !ORG_SETTINGS_KNOWN_KEYS.includes(k),
  );
  return { value: result.data, warnings, error: null };
}

module.exports = {
  OrgSettingsSchema,
  OrgSettingsPatchSchema,
  ORG_SETTINGS_KNOWN_KEYS,
  AI_PROVIDER_ALLOWLIST,
  parseOrgSettingsPatch,
};
