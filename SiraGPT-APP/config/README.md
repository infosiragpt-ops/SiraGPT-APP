# SiraGPT agent platform configuration

Paridad con `config/` de repos agente upstream.

| Archivo | Propósito |
|---|---|
| `agent-platform.yaml` | Flags Hermes/OpenClaw runtime, toolsets, gateway |
| `../package.json` | Scripts npm y dependencias root |
| `../backend/package.json` | Backend test/lint scripts |
| `../tsconfig.json` | TypeScript frontend |
| `../.env.example` | Variables de entorno documentadas |

Validar integración: `npm run agent:platform:map -- --strict`
