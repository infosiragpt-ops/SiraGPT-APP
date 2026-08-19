# extensions — SiraGPT plugins and connectors

| Upstream | SiraGPT |
|---|---|
| `extensions/` | `extension/` (browser), `backend/src/services/agents/plugin-registry.js` |
| Hermes plugins | `backend/src/services/agents/hermes-plugin-bridge.js` |

Registrar plugins: boot vía `hermes-runtime.js` → `hermes-plugin-bridge.bootHermesPlugins()`.
