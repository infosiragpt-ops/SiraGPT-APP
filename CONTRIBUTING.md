# Contributing to siraGPT

¡Gracias por tu interés en contribuir! Este documento te guiará a través del proceso de desarrollo.

## 🚀 Primeros pasos

```bash
# Clonar
git clone <repo-url>
cd siraGPT

# Instalar dependencias
npm install
cd backend && npm install && cd ..

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus claves

# Iniciar servicios (PostgreSQL, Redis) con Docker
docker compose up -d

# Inicializar base de datos
cd backend && npx prisma migrate dev && cd ..

# Iniciar desarrollo
npm run dev
```

## 📁 Estructura del proyecto

```
siraGPT/
├── app/                  # Next.js App Router (páginas)
├── backend/              # Servidor Express + Prisma
│   ├── src/
│   │   ├── routes/       # Rutas Express
│   │   ├── middleware/    # Middleware (auth, rate-limit, etc.)
│   │   ├── services/     # Lógica de negocio
│   │   └── config/       # Configuración (DB, Redis, etc.)
│   └── prisma/           # Schema + migraciones
├── components/           # Componentes React reutilizables
├── lib/                  # Utilidades del frontend
├── tests/                # Tests del frontend (Vitest)
│   ├── components/
│   └── lib/
├── scripts/              # Scripts de utilidad
└── docs/                 # Documentación
```

## 🧪 Tests

```bash
# Tests de backend (Node.js test runner)
npm test

# Tests de frontend (Vitest)
npm run test:unit

# Todos los tests
npm run test:all
```

### Escribir tests

Coloca tests de frontend en:
- `tests/components/*.test.tsx` — tests de componentes
- `tests/lib/*.test.tsx` — tests de utilidades

Usa Vitest + Testing Library:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MyComponent } from '@/components/my-component'

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent />)
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })
})
```

## 🔧 Desarrollo

### Frontend (Next.js 14)
- Puerto: 3000
- `npm run dev` — hot-reload
- App Router con layouts anidados
- Componentes en `/components`

### Backend (Express)
- Puerto: 5000
- Express + Prisma + PostgreSQL
- Redis para colas y rate-limiting
- `cd backend && npm run dev`

### Docker
```bash
# Desarrollo (hot-reload)
docker compose up

# Producción
docker compose -f docker-compose.prod.yml up
```

## ✅ Antes de hacer commit

1. `npm test` — tests de backend pasan
2. `npm run test:unit` — tests de frontend pasan
3. `npm run build` — build de Next.js compila
4. No commits con `.env` o claves reales

## 📋 Convenciones

- **Commits**: Usa [Conventional Commits](https://www.conventionalcommits.org/)
- **ES/JS**: Backend usa CommonJS (`require`), frontend usa ESM (`import`)
- **Estilo**: Prettier + ESLint configurados
- **Errores**: Siempre usa `ErrorBoundary` para componentes React

## 🧱 Patrones establecidos (cycles 1-40)

Estos patrones están consolidados — úsalos al añadir código nuevo en backend.

### AsyncGuard para timeouts y cleanup

`backend/src/utils/async-guard.js` envuelve cualquier promesa con timeout +
`AbortSignal` + `FinalizationRegistry` (red de seguridad contra leaks).

```js
const { AsyncGuard, GuardError } = require('./utils/async-guard');
const guard = new AsyncGuard({ label: 'my-route' });

// Wrapping a promise
const result = await guard.run(externalCall(), { timeoutMs: 5000 });

// Express middleware
app.get('/x', guard.route(async (req, res) => { /* ... */ }, { timeoutMs: 30000 }));
```

Cuando expira lanza `GuardError` con `guardId` y `guardElapsedMs`. Tests:
`backend/tests/async-guard.test.js` (42).

### CircuitBreaker para dependencias externas

`backend/src/utils/circuit-breaker.js` — máquina de estados CLOSED/OPEN/HALF_OPEN
con rolling window. Úsalo para todo lo que toque red (OpenAI, Anthropic,
Stripe, Slack, Postgres remoto, S3…).

```js
const { CircuitBreaker } = require('./utils/circuit-breaker');
const breaker = new CircuitBreaker({ threshold: 5, windowMs: 60000, timeoutMs: 8000 });
const data = await breaker.call(() => fetch(url).then(r => r.json()));
```

Lanza `CircuitOpenError` cuando está OPEN, `CircuitTimeoutError` en timeout.
`toJSON()` para snapshot en `/metrics`. Tests: `circuit-breaker.test.js` (33).

### writeAuditLog para operaciones sensibles

Toda operación de seguridad (login, password change, GDPR export, delete,
admin override, payment, webhook test) debe escribir un audit log estructurado.
El servicio está en `backend/src/services/audit-log.js`.

```js
await writeAuditLog({
  userId, action: 'gdpr.export.requested', target: userId,
  ip: req.ip, ua: req.get('user-agent'), meta: { format: 'json' },
});
```

### Error envelope shape

Todas las respuestas de error de API siguen el sobre clasificado (cycle 4 +
cycle 7). Nunca devuelvas un string crudo o un stack trace al cliente.

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Has excedido el límite. Intenta de nuevo en 30 s.",
    "category": "client",
    "retryable": true,
    "requestId": "req_abc123"
  }
}
```

Categorías: `client` (4xx), `server` (5xx), `provider` (modelo externo),
`network`, `timeout`. Helper en `backend/src/utils/error-envelope.js`.
Sanitiza errores de provider con `sanitizeProviderError` antes de exponer.

### Convenciones de tests

| Tipo | Path | Runner | Cuándo |
|---|---|---|---|
| Unit backend | `backend/tests/*.test.js` | `node --test` | default — toda función pura/módulo |
| Unit frontend | `tests/**/*.test.{ts,tsx}` | Vitest | componentes + utils |
| Property | `tests/**/*.property.test.ts` | `fast-check` | invariantes (idempotencia, monotonicidad, round-trip) |
| Chaos | `tests/chaos/*.test.js` | Node --test | fallo aleatorio en deps externas |
| Integration | `tests/integration/*.test.js` | Node --test | journeys multi-route (cycle 34) |
| Snapshot | `tests/components/__snapshots__/` | Vitest | UI estable (LongOpIndicator, modals) |
| E2E | `e2e/*.spec.ts` | Playwright | happy-path smoke con `page.route` mock |

Reglas:
- Cada bug fix añade un test que falla sin el fix.
- Si introduces una dep externa, añade un test de chaos que simule su caída.
- Mantén tests deterministas — usa fake timers/clock antes de `Math.random`.

## 🐛 Reportar bugs

Usa GitHub Issues con:
1. Pasos para reproducir
2. Comportamiento esperado vs actual
3. Logs de consola/servidor
4. Versión del software (commit hash)
