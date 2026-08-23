/**
 * Construye la URL pública de un enlace compartido SIEMPRE a partir del
 * origen real del navegador. La versión anterior usaba
 * `process.env.NEXT_PUBLIC_URL || http://localhost:3000`, así que cuando la
 * variable faltaba o apuntaba a otro dominio, quien recibía el enlace caía en
 * localhost (enlace roto para todo el mundo menos quien lo creó).
 *
 * El origen del navegador es la verdad: el enlace se crea desde la página que
 * el creador está viendo, y ese mismo origen es el que debe abrir el receptor.
 * `window.location.origin` es seguro aquí: solo se ejecuta en handlers de
 * eventos del cliente.
 */
export function buildShareUrl(
  shareId: string,
  kind: "chat" | "message" = "chat",
  origin?: string,
): string {
  const base =
    origin ??
    (typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "");
  if (!base) return ""
  const segment = kind === "message" ? "message/" : ""
  return `${base}/share/${segment}${encodeURIComponent(shareId)}`
}
