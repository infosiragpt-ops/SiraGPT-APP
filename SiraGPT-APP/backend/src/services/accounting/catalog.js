'use strict';

const { z } = require('zod');
const { round2 } = require('./money');

/**
 * Catálogo contable: clientes (para comprobantes) y productos/servicios
 * facturables, incluidas las suscripciones del propio SaaS.
 */

// ── Validación de documento de identidad peruano ─────────────────────────────
const DOC_TYPES = ['RUC', 'DNI', 'CE', 'PASAPORTE', 'SIN_DOC'];

/** True si docNumber es válido para el docType. */
function isValidDoc(docType, docNumber) {
  const n = String(docNumber == null ? '' : docNumber).trim();
  switch (docType) {
    case 'RUC':
      return /^(10|15|16|17|20)\d{9}$/.test(n); // 11 dígitos, prefijos SUNAT
    case 'DNI':
      return /^\d{8}$/.test(n);
    case 'CE':
      return /^[A-Za-z0-9]{8,12}$/.test(n);
    case 'PASAPORTE':
      return /^[A-Za-z0-9]{6,12}$/.test(n);
    case 'SIN_DOC':
      return true;
    default:
      return false;
  }
}

function validationError(issues) {
  const err = new Error('Datos de catálogo inválidos');
  err.code = 'VALIDATION_ERROR';
  err.issues = issues;
  return err;
}

function parse(schema, input) {
  const r = schema.safeParse(input);
  if (!r.success) throw validationError(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

// ── Clientes ─────────────────────────────────────────────────────────────────
const customerInputSchema = z.object({
  docType: z.enum(DOC_TYPES).default('SIN_DOC'),
  docNumber: z.string().trim().max(15).default('0'),
  name: z.string().trim().min(1, 'name requerido').max(200),
  email: z.string().trim().email().max(200).optional().or(z.literal('')).transform((v) => v || undefined),
  address: z.string().trim().max(300).optional(),
  isActive: z.boolean().default(true),
}).superRefine((val, ctx) => {
  if (!isValidDoc(val.docType, val.docNumber)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['docNumber'], message: `docNumber inválido para ${val.docType}` });
  }
});

// Partial schema for updates: every field optional with NO defaults (so an
// absent key stays out of the update `data` rather than resetting a column to
// its create-time default), and the doc-consistency check only fires when both
// docType and docNumber are present in the patch. (The previous code did
// `customerInputSchema.partial ? customerInputSchema : customerInputSchema` —
// identical branches, and `.partial` doesn't even exist on a ZodEffects, so
// updates always required the full create payload.)
const customerUpdateSchema = z.object({
  docType: z.enum(DOC_TYPES).optional(),
  docNumber: z.string().trim().max(15).optional(),
  name: z.string().trim().min(1, 'name requerido').max(200).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal('')).transform((v) => v || undefined),
  address: z.string().trim().max(300).optional(),
  isActive: z.boolean().optional(),
}).superRefine((val, ctx) => {
  if (val.docType !== undefined && val.docNumber !== undefined && !isValidDoc(val.docType, val.docNumber)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['docNumber'], message: `docNumber inválido para ${val.docType}` });
  }
});

async function createCustomer({ prisma, input } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const data = parse(customerInputSchema, input);
  return prisma.accountingCustomer.create({ data });
}

async function updateCustomer({ prisma, id, input } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const data = parse(customerUpdateSchema, input);
  return prisma.accountingCustomer.update({ where: { id }, data });
}

async function getCustomer({ prisma, id } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  return prisma.accountingCustomer.findUnique({ where: { id } });
}

async function listCustomers({ prisma, q, skip = 0, take = 50 } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const where = { isActive: true };
  if (q) where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { docNumber: { contains: q } }];
  const [items, total] = await Promise.all([
    prisma.accountingCustomer.findMany({ where, orderBy: { name: 'asc' }, skip, take }),
    prisma.accountingCustomer.count({ where }),
  ]);
  return { items, total, skip, take };
}

// ── Productos / servicios ────────────────────────────────────────────────────
const productInputSchema = z.object({
  code: z.string().trim().min(1, 'code requerido').max(40),
  name: z.string().trim().min(1, 'name requerido').max(200),
  kind: z.enum(['SERVICE', 'GOOD']).default('SERVICE'),
  unitPrice: z.coerce.number().nonnegative().default(0),
  currency: z.enum(['PEN', 'USD']).default('PEN'),
  unit: z.string().trim().max(10).default('NIU'),
  igvAffected: z.boolean().default(true),
  isSubscription: z.boolean().default(false),
  incomeAccount: z.string().trim().max(12).optional(),
  isActive: z.boolean().default(true),
});

// Partial schema for updates — every field optional, NO defaults, so a patch
// touches only the keys it carries (the old code reused productInputSchema,
// forcing the full create payload — code+name required — on every update).
const productUpdateSchema = z.object({
  code: z.string().trim().min(1, 'code requerido').max(40).optional(),
  name: z.string().trim().min(1, 'name requerido').max(200).optional(),
  kind: z.enum(['SERVICE', 'GOOD']).optional(),
  unitPrice: z.coerce.number().nonnegative().optional(),
  currency: z.enum(['PEN', 'USD']).optional(),
  unit: z.string().trim().max(10).optional(),
  igvAffected: z.boolean().optional(),
  isSubscription: z.boolean().optional(),
  incomeAccount: z.string().trim().max(12).optional(),
  isActive: z.boolean().optional(),
});

async function createProduct({ prisma, input } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const data = parse(productInputSchema, input);
  data.unitPrice = round2(data.unitPrice);
  return prisma.accountingProduct.create({ data });
}

async function updateProduct({ prisma, id, input } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const data = parse(productUpdateSchema, input);
  // Only round when the patch actually carries a price (else round2(undefined)).
  if (data.unitPrice !== undefined) data.unitPrice = round2(data.unitPrice);
  return prisma.accountingProduct.update({ where: { id }, data });
}

async function getProduct({ prisma, id } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  return prisma.accountingProduct.findUnique({ where: { id } });
}

async function listProducts({ prisma, kind, isSubscription, skip = 0, take = 100 } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const where = { isActive: true };
  if (kind) where.kind = kind;
  if (typeof isSubscription === 'boolean') where.isSubscription = isSubscription;
  const [items, total] = await Promise.all([
    prisma.accountingProduct.findMany({ where, orderBy: { code: 'asc' }, skip, take }),
    prisma.accountingProduct.count({ where }),
  ]);
  return { items, total, skip, take };
}

module.exports = {
  DOC_TYPES,
  isValidDoc,
  customerInputSchema,
  productInputSchema,
  createCustomer,
  updateCustomer,
  getCustomer,
  listCustomers,
  createProduct,
  updateProduct,
  getProduct,
  listProducts,
};
