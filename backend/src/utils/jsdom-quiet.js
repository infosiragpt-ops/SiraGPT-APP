'use strict';

/**
 * jsdom-quiet — a VirtualConsole that swallows jsdom's OWN errors.
 *
 * jsdom's default virtual console forwards `jsdomError` events (a `<style>`
 * it cannot parse — «Error: Could not parse CSS stylesheet» —, subresources
 * it cannot load, script exceptions) to `console.error`. Third-party pages
 * ship broken CSS all the time, and every one of them landed in Admin → Logs
 * → Errores del sistema as a backend error (prod 2026-09-27, /api/ai/generate
 * reading a page for the user). Our readers only extract text: styles are
 * irrelevant, scripts never run, so jsdom's diagnostics carry no signal.
 */
function quietVirtualConsole() {
  const { VirtualConsole } = require('jsdom');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => { /* intentionally silent */ });
  return virtualConsole;
}

module.exports = { quietVirtualConsole };
