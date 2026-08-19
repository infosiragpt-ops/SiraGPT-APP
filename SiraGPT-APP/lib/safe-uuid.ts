export function safeUUID(): string {
  try {
    const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined

    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return cryptoObj.randomUUID()
    }

    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
      const bytes = cryptoObj.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80

      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
      return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
    }
  } catch {
    // Fall through to the non-crypto fallback below.
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    const value = char === "x" ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}
