# Phase 6A: OpenTelemetry Backend Tracing

Fecha: 2026-05-01

## Objetivo

Agregar trazas distribuidas profesionales al backend sin acoplar SiraGPT a un proveedor especifico. La integracion usa OpenTelemetry oficial y exporta por OTLP HTTP hacia cualquier collector compatible: Grafana Tempo, Jaeger, Honeycomb, Datadog, New Relic, OpenObserve, Phoenix u otro backend.

## Dependencias agregadas

| Paquete | Version | Licencia | URL | Uso |
|---|---:|---|---|---|
| `@opentelemetry/api` | `1.9.1` | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-js | API estable para contexto/trazas |
| `@opentelemetry/sdk-node` | `0.216.0` | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-js | SDK Node para inicializar tracing |
| `@opentelemetry/resources` | `2.7.1` | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-js | Atributos de recurso/service |
| `@opentelemetry/exporter-trace-otlp-http` | `0.216.0` | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-js | Exportador OTLP HTTP |
| `@opentelemetry/auto-instrumentations-node` | `0.74.0` | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-js-contrib | Instrumentacion HTTP/Express/Pino/Redis/Postgres/OpenAI |

Validacion previa:

- Licencia compatible con uso comercial: Apache-2.0.
- Paquetes oficiales del ecosistema OpenTelemetry.
- Versiones publicadas/actualizadas el 2026-04-30 en npm.
- `npm audit --prefix backend --omit=dev --audit-level=critical` pasa. Queda la deuda moderada conocida de `uuid` transitivo documentada en fases anteriores.

## Variables de entorno

```bash
OTEL_ENABLED=true
OTEL_SERVICE_NAME=siragpt-backend
OTEL_SERVICE_NAMESPACE=siragpt
OTEL_DEPLOYMENT_ENVIRONMENT=production
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel-collector.example.com/v1/traces
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <token>"
OTEL_FAIL_FAST=false
```

Tambien se puede usar el endpoint generico:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

El backend deriva `http://localhost:4318/v1/traces`.

## Comportamiento implementado

- `backend/index.js` carga `dotenv`, arranca OpenTelemetry y luego importa Express/HTTP para que la auto-instrumentacion pueda envolver los modulos a tiempo.
- `backend/src/services/observability/otel.js` centraliza configuracion, resource attributes, auto-instrumentations y shutdown limpio.
- `backend/src/middleware/otel-request-context.js` agrega `X-Trace-Id` a respuestas trazadas y adjunta `siragpt.request_id` al span activo.
- `/health` incluye el check informativo `opentelemetry`.
- `/health*` y `/metrics` no generan trazas para reducir ruido operativo.

## Privacidad

No se adjuntan prompts, documentos, payloads de herramientas, tokens, emails ni IDs de usuario a los spans. Solo se emiten:

- nombre del servicio,
- entorno,
- runtime Node,
- estado de autenticacion booleano,
- request id,
- trace id,
- metadatos automaticos de HTTP/Express/Redis/Postgres/OpenAI provistos por los instrumentadores.

## Pruebas locales

Sin collector, la app debe seguir funcionando sin trazas:

```bash
cd backend
npm test -- tests/otel-observability.test.js tests/sira-health-and-metrics.test.js
```

Con collector local OTLP:

```bash
OTEL_ENABLED=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
npm start
```

Validar:

```bash
curl -i http://localhost:5000/health
curl -i http://localhost:5000/api/public/models
```

Resultado esperado:

- `/health` muestra `opentelemetry.status = healthy` si el SDK arranco.
- Las rutas trazadas devuelven `X-Trace-Id`.
- El collector recibe spans HTTP/Express y dependencias instrumentadas.

## Riesgos y mitigaciones

| Riesgo | Mitigacion |
|---|---|
| Sobrecarga por demasiados spans | `/health*`, `/metrics`, `fs` y `dns` quedan ignorados/deshabilitados |
| Falla del collector | El backend no falla por defecto; `OTEL_FAIL_FAST=true` solo para despliegues que quieran bloquear |
| Cardinalidad/PII | No se adjuntan user IDs ni payloads; solo request id y autenticacion booleana |
| Vendor lock-in | OTLP HTTP estandar, sin SDK propietario |
