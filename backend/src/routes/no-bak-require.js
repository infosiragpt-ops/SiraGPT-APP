
"use strict";
/** OLA200_WAVE_G BE-099 — never require() a .bak leftover. */
function assertNotBakModule(requestId) {
  const raw = String(requestId || "");
  if (/\.bak($|-)/i.test(raw)) { const e = new Error("bak_module_forbidden"); e.code = "bak_module_forbidden"; throw e; }
  return true;
}
module.exports = { assertNotBakModule };
