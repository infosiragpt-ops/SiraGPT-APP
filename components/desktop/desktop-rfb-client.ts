"use client"

/**
 * Client-only RFB constructor.
 *
 * @novnc/novnc 1.7 exports only the package root (core/rfb.js).
 * This wrapper is imported from DesktopScreen after next/dynamic ssr:false.
 */
export { default } from "@novnc/novnc"
