/**
 * registration-errors — the register form's rules and the mapping from the
 * backend's 400 payload to inline field messages.
 *
 * Prod 2026-09-27 19:58: three registration attempts in a row answered 400
 * («Validation failed») and the page only said «No se pudo crear la cuenta.
 * Inténtalo de nuevo.» — the client accepted 6-character passwords while the
 * server requires 8 with a letter and a number, and the server's field
 * details (`validation: [{ field, code }]`) were thrown away. This module is
 * the single source for both: the client rules mirror
 * backend/src/schemas/auth.js (RegisterRequestSchema) and every server code
 * resolves to an i18n key of the `auth` namespace.
 */

export type RegistrationField = 'name' | 'email' | 'password'
export type RegistrationFieldErrors = Partial<Record<RegistrationField, string>>

export interface RegistrationValidationDetail {
  field?: string
  code?: string
  message?: string
}

export interface RegistrationErrorData {
  error?: string
  code?: string
  message?: string
  validation?: RegistrationValidationDetail[]
}

export const NAME_MIN_LENGTH = 2
export const NAME_MAX_LENGTH = 100
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Translate = (key: string) => string

const CODE_TO_FIELD_KEY: Record<string, { field: RegistrationField; key: string }> = {
  'auth.name.too_short': { field: 'name', key: 'nameTooShort' },
  'auth.name.too_long': { field: 'name', key: 'nameTooLong' },
  'auth.name.invalid': { field: 'name', key: 'nameTooShort' },
  'auth.email.invalid': { field: 'email', key: 'emailInvalid' },
  'auth.email.too_short': { field: 'email', key: 'emailInvalid' },
  'auth.email.too_long': { field: 'email', key: 'emailInvalid' },
  'auth.email.in_use': { field: 'email', key: 'emailInUse' },
  'auth.password.too_short': { field: 'password', key: 'passwordTooShort' },
  'auth.password.too_long': { field: 'password', key: 'passwordTooLong' },
  'auth.password.needs_letter': { field: 'password', key: 'passwordNeedsLetter' },
  'auth.password.needs_number': { field: 'password', key: 'passwordNeedsNumber' },
  'auth.password.invalid': { field: 'password', key: 'passwordTooShort' },
}

/** First failing rule for the name, as an `auth` i18n key, or null. */
export function nameRuleKey(name: string): string | null {
  const value = String(name ?? '').trim()
  if (!value) return 'nameRequired'
  if (value.length < NAME_MIN_LENGTH) return 'nameTooShort'
  if (value.length > NAME_MAX_LENGTH) return 'nameTooLong'
  return null
}

export function emailRuleKey(email: string): string | null {
  const value = String(email ?? '').trim()
  return EMAIL_RE.test(value) && value.length <= 254 ? null : 'emailInvalid'
}

/** Mirrors StrongPasswordSchema: 8–128 characters, at least one letter and one number. */
export function passwordRuleKey(password: string): string | null {
  const value = String(password ?? '')
  if (value.length < PASSWORD_MIN_LENGTH) return 'passwordTooShort'
  if (value.length > PASSWORD_MAX_LENGTH) return 'passwordTooLong'
  if (!/[A-Za-z]/.test(value)) return 'passwordNeedsLetter'
  if (!/[0-9]/.test(value)) return 'passwordNeedsNumber'
  return null
}

function fieldOf(detail: RegistrationValidationDetail): RegistrationField | null {
  const raw = String(detail.field || '').replace(/^body\./, '')
  return raw === 'name' || raw === 'email' || raw === 'password' ? raw : null
}

/**
 * Server 400 → inline messages. Returns the per-field errors it could map
 * and, when nothing maps to a field, a human message for a toast.
 */
export function mapRegistrationErrorData(
  data: RegistrationErrorData | null | undefined,
  t: Translate,
): { fieldErrors: RegistrationFieldErrors; message: string | null } {
  const fieldErrors: RegistrationFieldErrors = {}
  if (!data || typeof data !== 'object') return { fieldErrors, message: null }

  const inUse = data.code === 'auth.email.in_use' || /already exists/i.test(String(data.error || ''))
  if (inUse) fieldErrors.email = t('emailInUse')

  for (const detail of Array.isArray(data.validation) ? data.validation : []) {
    if (!detail || typeof detail !== 'object') continue
    const known = CODE_TO_FIELD_KEY[String(detail.code || '')]
    const field = known ? known.field : fieldOf(detail)
    if (!field || fieldErrors[field]) continue
    if (known) {
      fieldErrors[field] = t(known.key)
    } else if (detail.message && !/^validation failed$/i.test(detail.message)) {
      fieldErrors[field] = detail.message
    } else {
      fieldErrors[field] = t(field === 'name' ? 'nameTooShort' : field === 'email' ? 'emailInvalid' : 'passwordTooShort')
    }
  }

  const hasFieldErrors = Object.keys(fieldErrors).length > 0
  const raw = String(data.message || data.error || '').trim()
  const message = hasFieldErrors || !raw || /^validation failed$/i.test(raw) ? null : raw
  return { fieldErrors, message }
}
