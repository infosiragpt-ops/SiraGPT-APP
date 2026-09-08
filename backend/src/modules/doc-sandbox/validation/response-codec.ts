import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Artifact } from '../types/contracts';
import { DocumentValidationError } from './errors';

const unitSchema = z.object({ part: z.string(), locator: z.string(), text: z.string(), kind: z.string() });
const inventorySchema = z.object({
  id: z.string(), format: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int(),
  name: z.string(), mime: z.string(), parts: z.record(z.string(), z.string()), units: z.array(unitSchema),
  warnings: z.array(z.string()), partOrder: z.array(z.string()).optional(), pages: z.number().int().optional(),
  encoding: z.string().optional(),
});
const reportSchema = z.object({
  schemaVersion: z.literal(1), passed: z.boolean(), originalSha256: z.string(), outputSha256: z.string(),
  levels: z.array(z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    passed: z.boolean(), applicable: z.boolean(), details: z.record(z.string(), z.unknown()), durationMs: z.number().nonnegative() })),
  artifactFiles: z.array(z.string()), artifactData: z.record(z.string(), z.string()), changes: z.array(z.unknown()),
});
const recipeSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive(),
  expandedBytes: z.number().int().nonnegative(), scripts: z.array(z.string()).min(1), parts: z.record(z.string(), z.string()) });
const responseSchema = z.union([
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
  z.object({ ok: z.literal(true), inventories: z.array(inventorySchema) }),
  z.object({ ok: z.literal(true), report: reportSchema }),
  z.object({ ok: z.literal(true), recipe: recipeSchema }),
  z.object({ ok: z.literal(true), preflight: z.object({ schemaVersion: z.literal(1),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/), applications: z.object({
      writer: z.string().regex(/^[a-f0-9]{64}$/), calc: z.string().regex(/^[a-f0-9]{64}$/),
      impress: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict() }).strict() }),
]);

export type ValidatorResponse = z.infer<typeof responseSchema>;
export type DocumentInventory = z.infer<typeof inventorySchema>;
export type RecipeInventory = z.infer<typeof recipeSchema>;
export interface DecodedValidatorResponse { response: ValidatorResponse; artifacts: Artifact[]; }

/** Parse the isolated process protocol and bound inline artifact bytes.
 * This is not document validation or proof that a validator executed: only
 * the real container transport may supply this result to the validation gate.
 */
export function decodeValidatorResponse(raw: unknown): DecodedValidatorResponse {
  const response = responseSchema.parse(raw);
  if (!response.ok) throw new DocumentValidationError(response.error.code, response.error.message);
  const artifacts: Artifact[] = [];
  let totalArtifactBytes = 0;
  const names = 'report' in response ? response.report.artifactFiles : [];
  if (names.length > 1001) throw new DocumentValidationError('ARTIFACT_LIMIT', 'Exceso de artefactos de validación.');
  for (const filename of names) {
    if (!/^(?:(?:before|after)-(?:notes-)?\d+\.png|text-diff\.json)$/.test(filename)) {
      throw new DocumentValidationError('ARTIFACT_PATH', 'Artefacto de validación inesperado.');
    }
    const encoded = 'report' in response ? response.report.artifactData[filename] : undefined;
    if (!encoded || encoded.length > 24 * 1024 * 1024 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new DocumentValidationError('ARTIFACT_UNSAFE', 'Artefacto de validación inválido.');
    }
    const data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded) throw new DocumentValidationError('ARTIFACT_UNSAFE', 'Codificación de artefacto inválida.');
    totalArtifactBytes += data.length;
    if (data.length > 10 * 1024 * 1024 || totalArtifactBytes > 16 * 1024 * 1024) {
      throw new DocumentValidationError('ARTIFACT_LIMIT', 'Artefactos de validación excedieron su presupuesto total.');
    }
    artifacts.push({ name: filename, kind: filename === 'text-diff.json' ? 'text_diff' : filename.startsWith('before') ? 'thumbnail_before' : 'thumbnail_after',
      mime: filename.endsWith('.png') ? 'image/png' : 'application/json', data, sha256: createHash('sha256').update(data).digest('hex') });
  }
  return { response, artifacts };
}
