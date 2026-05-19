'use strict';

/**
 * Zod schemas for the auth endpoints.
 *
 * These are the canonical request/response contracts for /api/auth/* and are
 * consumed by:
 *   - `middleware/validate.js` for runtime validation at the route boundary
 *   - `scripts/generate-api-types.js` to emit frontend TypeScript types
 *
 * Keep them aligned with `backend/src/routes/auth.js`. When a schema changes
 * here, re-run `npm run generate:api-types` from the backend.
 */

const { z } = require('zod');

// Email — RFC max length 254. We don't normalize here; express normalizeEmail
// stage still runs upstream. zod just enforces shape.
const EmailSchema = z
  .string()
  .trim()
  .min(3, { message: 'auth.email.too_short' })
  .max(254, { message: 'auth.email.too_long' })
  .email({ message: 'auth.email.invalid' });

// Password — strong rules mirror routes/auth.js register: 8..128, must contain
// a letter and a number. Login uses LoosePassword (1..256) because legacy
// accounts may have weaker passwords from before tightening landed.
const StrongPasswordSchema = z
  .string()
  .min(8, { message: 'auth.password.too_short' })
  .max(128, { message: 'auth.password.too_long' })
  .regex(/[A-Za-z]/, { message: 'auth.password.needs_letter' })
  .regex(/[0-9]/, { message: 'auth.password.needs_number' });

const LoosePasswordSchema = z
  .string()
  .min(1, { message: 'auth.password.required' })
  .max(256, { message: 'auth.password.too_long' });

const RegisterRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, { message: 'auth.name.too_short' })
      .max(100, { message: 'auth.name.too_long' }),
    email: EmailSchema,
    password: StrongPasswordSchema,
  })
  .strict();

const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    password: LoosePasswordSchema,
  })
  .strict();

// Mirrors the user shape returned by /auth/{login,register,me} after we strip
// `password`. Kept loose (passthrough) because Prisma may add fields we don't
// want this contract to gatekeep — we only assert the keys the FE relies on.
const AuthUserSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    email: z.string().email(),
    name: z.string().nullable().optional(),
    plan: z.string().optional(),
    isAdmin: z.boolean().optional(),
    isSuperAdmin: z.boolean().optional(),
    apiUsage: z.number().optional(),
    monthlyCallLimit: z.number().nullable().optional(),
    monthlyLimit: z.number().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough();

const AuthResponseSchema = z
  .object({
    user: AuthUserSchema,
    token: z.string().min(8),
  })
  .passthrough();

module.exports = {
  EmailSchema,
  StrongPasswordSchema,
  LoosePasswordSchema,
  RegisterRequestSchema,
  LoginRequestSchema,
  AuthUserSchema,
  AuthResponseSchema,
};
