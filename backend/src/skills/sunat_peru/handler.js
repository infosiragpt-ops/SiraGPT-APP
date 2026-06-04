/**
 * sunat_peru — consulta de datos oficiales peruanos (SUNAT / RENIEC / tipo
 * de cambio) expuesta como skill del agente.
 *
 * Por qué un proveedor de terceros y no la API "oficial" de SUNAT: la API
 * pública de SUNAT solo valida comprobantes electrónicos (CPE) y SIRE; NO
 * expone el padrón RUC (razón social, estado, dirección) ni RENIEC. El
 * estándar de facto en Perú es consumir un proveedor que reexpone el
 * padrón vía REST con Bearer token. Usamos decolecta / apis.net.pe por
 * defecto, pero la base y el header de auth son configurables por env para
 * poder cambiar de proveedor sin tocar código.
 *
 * Configuración (env):
 *   DECOLECTA_API_KEY   — token Bearer del proveedor (requerido).
 *                         También se aceptan SUNAT_API_KEY y APIS_NET_PE_TOKEN
 *                         como alias por compatibilidad.
 *   DECOLECTA_BASE_URL  — base del API. Default https://api.decolecta.com/v1
 *
 * Diseño defensivo: validamos el número antes de salir a la red, ponemos un
 * timeout duro con AbortController (además del timeoutMs del policy layer),
 * y traducimos los códigos de error del proveedor a mensajes accionables
 * para que el agente sepa si reintentar, corregir el número, o avisar al
 * usuario de que falta configurar el token.
 */

const DEFAULT_BASE_URL = "https://api.decolecta.com/v1";
const HARD_TIMEOUT_MS = 12_000;

// Hosts the bearer token may ever be sent to. DECOLECTA_BASE_URL is operator
// configurable, but we fail closed to the default if the override is not https
// or points at an unrecognised host — otherwise a misconfigured/compromised env
// var could leak the API token to an internal or attacker-controlled endpoint.
const ALLOWED_HOSTS = new Set(["api.decolecta.com", "api.apis.net.pe"]);

function resolveToken() {
  return (
    process.env.DECOLECTA_API_KEY ||
    process.env.SUNAT_API_KEY ||
    process.env.APIS_NET_PE_TOKEN ||
    ""
  ).trim();
}

function baseUrl() {
  const raw = (process.env.DECOLECTA_BASE_URL || "").trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname)) {
        return raw.replace(/\/+$/, "");
      }
    } catch {
      /* invalid URL — fall through to the safe default */
    }
  }
  return DEFAULT_BASE_URL;
}

function onlyDigits(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

async function callApi(pathAndQuery, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${pathAndQuery}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });

    let body = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (!res.ok) {
      const map = {
        401: "Token inválido o ausente. Configura DECOLECTA_API_KEY con un token válido del proveedor.",
        403: "Token sin permisos o plan agotado para esta consulta.",
        404: "No se encontraron datos para el número consultado (verifica que sea correcto).",
        422: "Número con formato inválido para esta consulta.",
        429: "Límite de consultas del proveedor alcanzado; reintenta más tarde.",
      };
      return {
        ok: false,
        status: res.status,
        error:
          map[res.status] ||
          (body && (body.message || body.error)) ||
          `El proveedor respondió con HTTP ${res.status}.`,
      };
    }

    return { ok: true, status: res.status, data: body };
  } catch (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, status: 0, error: "La consulta al proveedor superó el tiempo de espera." };
    }
    return { ok: false, status: 0, error: `Error de red al consultar el proveedor: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function execute(args) {
  const tipo = (args && args.tipo ? String(args.tipo) : "").toLowerCase();
  const token = resolveToken();

  if (!token) {
    return {
      ok: false,
      error:
        "Falta el token del proveedor. Pide al administrador configurar el secreto DECOLECTA_API_KEY (obtenible registrándose en decolecta.com o apis.net.pe).",
    };
  }

  if (tipo === "tipo_cambio") {
    const r = await callApi("/tipo-cambio/sbs/average", token);
    if (!r.ok) return r;
    return { ok: true, tipo: "tipo_cambio", fuente: "SUNAT/SBS (decolecta)", resultado: r.data };
  }

  if (tipo === "ruc") {
    const numero = onlyDigits(args && args.numero);
    if (numero.length !== 11) {
      return { ok: false, error: "El RUC debe tener exactamente 11 dígitos." };
    }
    const r = await callApi(`/sunat/ruc?numero=${encodeURIComponent(numero)}`, token);
    if (!r.ok) return r;
    return { ok: true, tipo: "ruc", numero, fuente: "SUNAT (decolecta)", resultado: r.data };
  }

  if (tipo === "dni") {
    const numero = onlyDigits(args && args.numero);
    if (numero.length !== 8) {
      return { ok: false, error: "El DNI debe tener exactamente 8 dígitos." };
    }
    const r = await callApi(`/reniec/dni?numero=${encodeURIComponent(numero)}`, token);
    if (!r.ok) return r;
    return { ok: true, tipo: "dni", numero, fuente: "RENIEC (decolecta)", resultado: r.data };
  }

  return { ok: false, error: `Tipo de consulta no soportado: "${tipo}". Usa 'ruc', 'dni' o 'tipo_cambio'.` };
}

module.exports = { execute };
