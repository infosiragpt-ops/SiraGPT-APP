'use strict';

/**
 * Zod schemas for /api/payments endpoints.
 *
 * We only enforce shape on user-initiated flows — webhooks from Stripe /
 * PayPal arrive with provider-defined payloads which are validated by the
 * provider SDK and signature checks, not Zod.
 */

const { z } = require('zod');

const PlanSchema = z.enum(['FREE', 'STARTER', 'PRO', 'BUSINESS', 'ENTERPRISE']);
const ProviderSchema = z.enum(['stripe', 'paypal', 'mercadopago']);
const CurrencySchema = z
  .string()
  .trim()
  .length(3, { message: 'payments.currency.invalid' })
  .regex(/^[A-Za-z]{3}$/, { message: 'payments.currency.invalid' })
  .transform((v) => v.toUpperCase());

const CreatePaymentRequestSchema = z
  .object({
    plan: PlanSchema,
    provider: ProviderSchema,
    // Optional — providers like Stripe Checkout don't need an amount in the
    // body (the price is locked to a Price ID server-side), but PayPal /
    // MercadoPago may. We accept either and gatekeep server-side.
    amount: z.number().positive().max(100000).optional(),
    currency: CurrencySchema.optional(),
    interval: z.enum(['month', 'year']).optional(),
    couponCode: z.string().trim().max(80).optional(),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
  })
  .strict();

const PaymentResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    sessionId: z.string().optional(),
    checkoutUrl: z.string().url().optional(),
    redirectUrl: z.string().url().optional(),
    status: z
      .enum(['pending', 'succeeded', 'failed', 'requires_action', 'canceled', 'refunded'])
      .optional(),
    provider: ProviderSchema.optional(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    plan: PlanSchema.optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough();

module.exports = {
  PlanSchema,
  ProviderSchema,
  CurrencySchema,
  CreatePaymentRequestSchema,
  PaymentResponseSchema,
};
