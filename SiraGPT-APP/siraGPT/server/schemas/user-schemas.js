'use strict';
const { z } = require('zod');

const userProfileUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  locale: z.string().regex(/^[a-z]{2,3}$/i).optional(),
  preferredTone: z.enum(['casual', 'formal', 'technical', 'pedagogical']).optional(),
  customInstructions: z.string().max(5000).optional(),
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format').optional(),
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

module.exports = {
  userProfileUpdateSchema,
  passwordChangeSchema,
};
