'use strict';

/**
 * Shared desktop error copy (F7.1).
 *
 * The generic provision string is what the live orch (#484) and the
 * computer pane show when fetch/orchestrator fail. The session manager
 * must NEVER return it when a warm healthy desktop is available.
 */

const GENERIC_PROVISION_ERROR_ES =
  'No se pudo abrir la computadora. El escritorio no está disponible.';

const DESKTOP_DISABLED_ES =
  'El escritorio de SiraComputer está desactivado. '
  + 'Activa SIRAGPT_DESKTOP_ENABLED para usarlo — no se finge un panel negro.';

const E2B_KEY_MISSING_ES =
  'Falta E2B_API_KEY. No se puede crear un escritorio E2B '
  + '(no se finge una sesión).';

const E2B_SDK_MISSING_ES =
  'El SDK de E2B Desktop no está disponible. '
  + 'Instala @e2b/desktop o inyecta un cliente — no se finge un escritorio.';

const PROVIDER_UNCONFIGURED_ES =
  'No hay un proveedor de escritorio configurado. '
  + 'Define DESKTOP_PROVIDER o E2B_API_KEY — no se elige uno en silencio.';

const DESKTOP_NOT_READY_ES =
  'El escritorio no quedó listo a tiempo. Reintenta en unos segundos.';

const PREPARING_DESKTOP_ES = 'Preparando escritorio…';

function isGenericProvisionError(text) {
  return String(text || '').includes('El escritorio no está disponible');
}

module.exports = {
  GENERIC_PROVISION_ERROR_ES,
  DESKTOP_DISABLED_ES,
  E2B_KEY_MISSING_ES,
  E2B_SDK_MISSING_ES,
  PROVIDER_UNCONFIGURED_ES,
  DESKTOP_NOT_READY_ES,
  PREPARING_DESKTOP_ES,
  isGenericProvisionError,
};
