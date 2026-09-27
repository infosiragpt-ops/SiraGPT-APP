// Admin → Conexiones «Probar»: the backend answers 200 `{ ok:false, reason }`
// when the provider rejects the key, has no credits or is unreachable. Show
// that sentence as-is — never a bare «Server error».
export function connectionTestFailureMessage(result: any): string {
  const reason = typeof result?.reason === "string" ? result.reason.trim() : ""
  if (reason) return reason
  const error = typeof result?.error === "string" ? result.error.trim() : ""
  if (error) return `Falló: ${error}`
  return result?.status ? `Falló: HTTP ${result.status}` : "La prueba falló sin detalle del proveedor."
}
