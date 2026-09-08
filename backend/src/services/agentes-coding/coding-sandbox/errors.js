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
  E_TIMEOUT: {
    status: 504,
    message: 'El comando superó el tiempo máximo del sandbox.',
  },
  E_QUOTA: {
    status: 429,
    message: 'Tope de sesiones o tamaño de archivo alcanzado.',
  },
  E_PROVIDER: {
    status: 503,
    message: 'Docker no está disponible para el driver local de sandbox.',
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
});

class CodingSandboxError extends Error {
  constructor(code, detail) {
    const entry = CATALOG[code] || CATALOG.E_PARAMS;
    const message = detail ? `${entry.message} ${detail}`.trim() : entry.message;
    super(message);
    this.name = 'CodingSandboxError';
    this.code = CATALOG[code] ? code : 'E_PARAMS';
    this.status = entry.status;
  }

  toJSON() {
    return { error: this.code, message: this.message };
  }
}

function fail(code, detail) {
  throw new CodingSandboxError(code, detail);
}

module.exports = {
  CATALOG,
  CodingSandboxError,
  fail,
};
