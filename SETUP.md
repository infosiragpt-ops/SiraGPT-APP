# Setup — correr SiraGPT localmente

Objetivo: monorepo funcionando en menos de 15 minutos.

## Prerrequisitos

- Node.js ≥ 20 (`node -v`)
- Docker Desktop o docker CLI corriendo
- Git

## Pasos

```bash
# 1. Clonar
git clone https://github.com/infosiragpt-ops/SiraGPT-APP && cd SiraGPT-APP

# 2. Dependencias (frontend en la raíz, backend en backend/)
npm install
npm install --prefix backend

# 3. Arrancar todo
./scripts/dev-up.sh
```

`dev-up.sh` hace, en orden:

1. **Primer arranque:** genera `.env.local` con valores de desarrollo válidos
   (Postgres en `localhost:5432`, Redis en `localhost:6379`, secrets JWT/SESSION
   aleatorios). dotenv no expande `${VAR}`, así que el archivo usa valores planos.
2. Levanta Postgres + Redis vía `docker compose up -d db redis`.
3. Espera a que Postgres esté healthy y corre `prisma migrate dev`.
4. Seed best-effort.
5. Arranca en paralelo:
   - Frontend Next.js → http://localhost:3000
   - Backend Express → http://localhost:5000

Abre **http://localhost:3000**. Las llamadas `/api/*` del navegador pasan por el
mismo origen de Next y se proxifican al backend (ver
`next.config.mjs` → `rewrites`). El puerto del proxy sigue `BACKEND_PORT`
(default `5000`) o `BACKEND_INTERNAL_URL`.

## Puerto personalizado

```bash
BACKEND_PORT=5050 ./scripts/dev-up.sh
```

## API keys de modelos

El stack funciona sin keys; las llamadas a modelos fallarán hasta que añadas al
menos una. Edita `.env.local`:

```bash
OPENAI_API_KEY=sk-...        # u ANTHROPIC_API_KEY / OPENROUTER_API_KEY / GROQ_API_KEY
```

Reinicia `dev-up.sh` después de editar.

## Alternativa: todo en Docker

```bash
cp .env.example .env    # edita JWT_SECRET, SESSION_SECRET y POSTGRES_PASSWORD
docker compose up -d    # frontend :3000, backend :5000, db, redis
```

## Verificación rápida

```bash
curl -s http://localhost:5000/health | head     # backend directo
curl -s http://localhost:3000/api/health | head # vía proxy de Next (debe responder igual)
```

## Problemas comunes

| Síntoma | Causa probable | Solución |
|---|---|---|
| La web carga pero todas las llamadas `/api` dan 500 | Backend no está en el puerto que el proxy espera | Revisa que `PORT` de `.env.local` coincida con `BACKEND_PORT`; reinicia `dev-up.sh` |
| `P1001: can't reach database` | Postgres no levantó o `.env.local` apunta a otro host | `docker compose ps db`; el `.env.local` generado usa `localhost:5432` |
| `prisma migrate` falla por auth | Password de DB no coincide | Borra `.env.local` y deja que `dev-up.sh` lo regenere |
| Puerto 3000/5000 ocupado | Otro proceso escucha ahí | `lsof -i :3000 -i :5000` y mata el proceso, o usa `BACKEND_PORT=5050` |
| `Module not found` tras pull | node_modules desactualizado | `npm ci && npm ci --prefix backend` |

## Referencias de arquitectura

- Mapa completo del sistema: [docs/architecture.md](docs/architecture.md)
- Diseño del AgentRunner: [ARCHITECTURE.md](ARCHITECTURE.md)
- Deploy a producción (VPS único, Docker + Caddy, GitHub Actions): [docs/deployment.md](docs/deployment.md)
