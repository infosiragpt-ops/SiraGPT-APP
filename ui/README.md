# ui — user interface parity

Product UI (protegida por UI-lock — no modificar sin scope explícito):

- `app/` — Next.js 14
- `components/` — shadcn/ui

**Protocolo TUI Hermes (backend, sin terminal Python):**

- `POST /api/hermes/tui/slash` — `/model`, `/compress`, `/skills`, `/new`, `/doctor`
- `GET /api/hermes/tui/commands`

Bridge: `backend/src/services/agents/hermes-tui-bridge.js`
