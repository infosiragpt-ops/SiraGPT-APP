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

// `.passthrough()` keeps unknown keys (forward-compat). The known keys
// still get validated; the route layer extracts the leftover keys and
// returns them as `warnings` so callers know they're not yet recognised.
const OrgSettingsSchema = z
  .object({
    defaultModel: z.string().trim().min(1).max(120).optional(),
    responseStyle: ResponseStyleSchema.optional(),
    branding: BrandingSchema.optional(),
    features: FeaturesSchema.optional(),
  })
  .passthrough();

// Known top-level keys — the route uses this to compute the warning list.
const ORG_SETTINGS_KNOWN_KEYS = Object.freeze([
  'defaultModel',
  'responseStyle',
  'branding',
  'features',
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
  parseOrgSettingsPatch,
};
