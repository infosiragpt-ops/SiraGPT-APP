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

## 🐛 Reportar bugs

Usa GitHub Issues con:
1. Pasos para reproducir
2. Comportamiento esperado vs actual
3. Logs de consola/servidor
4. Versión del software (commit hash)
