'use strict';

/**
 * Spanish error catalog for the AGENTES_CODING_V2 session adapter.
 * Codes stay stable for SSE/logs (AGENTS.md §16). Messages are user-facing.
 */

const CATALOG = Object.freeze({
  E_FLAG_OFF: {
    status: 404,
    message: 'Coding Agents está desactivado. Activa AGENTES_CODING_V2 solo en DEV.',
  },
  E_PARAMS: {
    status: 400,
    message: 'Parámetros de sandbox inválidos.',
  },
  E_SESSION_NOT_FOUND: {
    status: 404,
    message: 'La sesión de sandbox no existe.',
  },
  E_SESSION_EXPIRED: {
    status: 410,
    message: 'La sesión de sandbox caducó.',
  },
  E_SESSION_DESTROYED: {
    status: 410,
    message: 'La sesión de sandbox ya fue destruida.',
  },
  E_PATH_ESCAPE: {
    status: 400,
    message: 'La ruta sale del workspace de la sesión.',
  },
  E_NETWORK_DENIED: {
    status: 403,
    message: 'Red denegada: el sandbox no tiene salida salvo allowlist.',
  },
  E_PORT_DENIED: {
    status: 403,
    message: 'Exponer puertos requiere allowlist y el flag activo.',
  },
  E_PREVIEW_EXPIRED: {
    status: 410,
    message: 'La vista previa caducó. Vuelve a exponer el puerto.',
  },
  E_PREVIEW_FAILED: {
    status: 500,
    message: 'No se pudo publicar la vista previa del sandbox.',
  },
  E_TIMEOUT: {
    status: 504,
    message: 'La operación superó el tiempo máximo.',
  },
  E_QUOTA: {
    status: 429,
    message: 'Tope de sesiones o tamaño de archivo alcanzado.',
  },
  E_PROVIDER: {
    status: 503,
    message: 'El proveedor no está disponible.',
  },
  E_CAPACITY: {
    status: 429,
    message: 'No hay capacidad de contenedores de sandbox.',
  },
  E_CANCELLED: {
    status: 499,
    message: 'Operación de sandbox cancelada.',
  },
  E_CONTENT: {
    status: 400,
    message: 'El contenido del archivo no es válido para el sandbox.',
  },
  E_MAP_FAILED: {
    status: 500,
    message: 'No se pudo construir el mapa del repositorio.',
  },
  E_STRUCT_EDIT_FAILED: {
    status: 500,
    message: 'No se pudo aplicar la edición estructural.',
  },
  E_TERMINAL_FAILED: {
    status: 500,
    message: 'No se pudo abrir el canal de terminal.',
  },
  E_GIT_FAILED: {
    status: 500,
    message: 'No se pudo ejecutar git en el repositorio de la sesión.',
  },
  E_CHECKPOINT_NOT_FOUND: {
    status: 404,
    message: 'El punto de control no existe.',
  },
  E_EXPORT_FAILED: {
    status: 500,
    message: 'No se pudo exportar el workspace de la sesión.',
  },
  E_EXPORT_NOT_FOUND: {
    status: 404,
    message: 'El artefacto de exportación no existe.',
  },
  E_DEPLOY_DENIED: {
    status: 403,
    message: 'Despliegue denegado: falta allowlist de URL o cliente inyectable.',
  },
  E_DEPLOY_FAILED: {
    status: 502,
    message: 'El proveedor de despliegue no aceptó la solicitud.',
  },
  E_DEPLOY_NOT_FOUND: {
    status: 404,
    message: 'La intención de despliegue no existe.',
  },
  E_HARNESS_FAILED: {
    status: 500,
    message: 'No se pudo completar el turno del harness.',
  },
  E_HARNESS_NOT_FOUND: {
    status: 404,
    message: 'La ejecución del harness no existe.',
  },
  E_PERMISSION_DENIED: {
    status: 403,
    message: 'Permiso denegado: la acción privilegiada no se ejecutó.',
  },
  E_PERMISSION_NOT_FOUND: {
    status: 404,
    message: 'La solicitud de permiso no existe.',
  },
  E_HARNESS_QUEUE: {
    status: 503,
    message: 'No se pudo encolar el turno del harness.',
  },
});

class CodingSandboxError extends Error {
  constructor(code, detail, opts = {}) {
    const entry = CATALOG[code] || CATALOG.E_PARAMS;
    const message = opts.replace && detail
      ? String(detail)
      : (detail ? `${entry.message} ${detail}`.trim() : entry.message);
    super(message);
    this.name = 'CodingSandboxError';
    this.code = CATALOG[code] ? code : 'E_PARAMS';
    this.status = entry.status;
  }

  toJSON() {
    return { error: this.code, message: this.message };
  }
}

function fail(code, detail, opts) {
  throw new CodingSandboxError(code, detail, opts);
}

module.exports = {
  CATALOG,
  CodingSandboxError,
  fail,
};
