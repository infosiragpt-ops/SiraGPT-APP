# qa — quality assurance lanes

| Lane | Comando / ruta |
|---|---|
| Backend unit | `npm test` |
| Hermes runtime | `node --test backend/tests/hermes-runtime.test.js` |
| Platform folders | `npm run agent:platform:map -- --strict` |
| OpenClaw map | `npm run agent:openclaw:map` |
| Hermes map | `npm run agent:hermes:map` |
| E2E | `e2e/` |
| Lint | `npm run lint` |
