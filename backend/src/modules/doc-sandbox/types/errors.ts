export type DocErrorCode = 'E_PARAMS' | 'E_PROVIDER' | 'E_QUOTA' | 'E_TIMEOUT' |
  'E_CANCELLED' | 'E_VALIDATION' | 'E_NOT_FOUND' | 'E_FORBIDDEN' | 'E_CONFLICT' | 'E_NOT_READY' | 'E_NOT_POSSIBLE' | 'E_PLAN_GATE';

const publicMessages: Record<DocErrorCode, string> = {
  E_PARAMS: 'Los datos o el formato del documento no son válidos.',
  E_PROVIDER: 'El servicio de edición no pudo completar la solicitud. No se cambió de proveedor.',
  E_QUOTA: 'El trabajo alcanzó el presupuesto autorizado.',
  E_TIMEOUT: 'El trabajo alcanzó su límite de tiempo.',
  E_CANCELLED: 'El trabajo fue cancelado.',
  E_VALIDATION: 'No se pudo verificar que el archivo conserve únicamente los cambios solicitados.',
  E_NOT_FOUND: 'El trabajo o archivo no existe.',
  E_FORBIDDEN: 'No tienes acceso a este trabajo.',
  E_CONFLICT: 'El estado del trabajo cambió. Actualiza antes de continuar.',
  E_NOT_READY: 'La edición segura de documentos todavía no está disponible en este entorno.',
  E_NOT_POSSIBLE: 'No se puede aplicar esta solicitud conservando el documento. El original permanece intacto; no se realizó la edición.',
  E_PLAN_GATE: 'Los permisos de esta conversación no permiten editar documentos.',
};
export class DocSandboxError extends Error {
  constructor(readonly code: DocErrorCode, readonly status = 400, options?: ErrorOptions) {
    super(publicMessages[code], options);
    this.name = 'DocSandboxError';
  }
}
export function publicError(error: unknown): { code: DocErrorCode; message: string; status: number } {
  if (error instanceof DocSandboxError) return { code: error.code, message: error.message, status: error.status };
  return { code: 'E_PROVIDER', message: publicMessages.E_PROVIDER, status: 500 };
}
