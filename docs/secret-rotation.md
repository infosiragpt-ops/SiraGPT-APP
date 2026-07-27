# Secret Rotation Runbook

Rotación de API keys y secretos sin downtime para SiraGPT (frontend + backend).

> Ámbito: secretos en `.env` (backend y frontend), claves de proveedores
> (OpenAI, Anthropic, Stripe, Langfuse, LangSmith, Sentry, PostHog),
> secretos de aplicación (`JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`),
> y URLs con credenciales (`PRISMA_DATABASE_URL`, `DIRECT_DATABASE_URL`,
> `DATABASE_URL`, `REDIS_URL`).

---

## 0. Cuándo rotar

| Trigger | Plazo | Severidad |
|---|---|---|
| Compromiso confirmado | Inmediato | P0 |
| Sospecha (log leak, repo público) | < 1h | P1 |
| Salida de un colaborador con acceso | < 24h | P1 |
| Rotación calendarizada | Cada 90 días | P3 |
| Cambio de proveedor / plan | Antes del cutover | P2 |

Para P0/P1, **no esperes** la ventana de mantenimiento: ejecuta el flujo
de **rotación dual** descrito en §3.

---

## 1. Inventario de secretos

Fuente de verdad: `backend/.env.example` y `.env.example` (raíz).

Categorías:

- **Proveedor LLM**: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- **Pago / billing**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- **Observabilidad**: `LANGFUSE_SECRET_KEY`, `LANGSMITH_API_KEY`,
  `SENTRY_DSN`, `POSTHOG_API_KEY`
- **Aplicación**: `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`
- **Infra**: `PRISMA_DATABASE_URL`, `DIRECT_DATABASE_URL`, `DATABASE_URL`, `REDIS_URL`

Reglas de validación están en `backend/scripts/verify-secret-rotation.js`
(`KEY_RULES`).

---

## 2. Pre-requisitos

1. Acceso al gestor de secretos (e.g. 1Password, Vault, GitHub Actions
   secrets, panel del proveedor).
2. Permiso para crear nuevas keys en el panel del proveedor.
3. Acceso al deployment (Render / Railway / Docker host) para reiniciar
   procesos.
4. Snapshot del `.env` actual:
   ```bash
   cp backend/.env backend/.env.previous
   chmod 600 backend/.env.previous
   ```
   `.env.previous` se usa **sólo** para el verificador y se borra al
   final del runbook. Nunca commitearlo.

---

## 3. Rotación dual (zero-downtime)

Aplica para secretos que aceptan dos claves activas a la vez (la mayoría
de proveedores SaaS modernos).

### 3.1. Generar la nueva clave

- **OpenAI / Anthropic / Langfuse / LangSmith**: panel del proveedor →
  *Create new key*. Anota el prefijo y los últimos 4 caracteres.
- **Stripe**: Dashboard → Developers → API keys → *Create restricted key*.
- **Aplicación (`JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`)**:
  ```bash
  node -e 'console.log(require("crypto").randomBytes(48).toString("base64"))'
  ```

### 3.2. Publicar la nueva clave junto a la vieja

Donde el código lo soporte (firma JWT con grace period, dos webhook
secrets aceptados), añade la nueva clave como **secundaria** y mantén la
vieja como primaria. Despliega.

Si el código sólo acepta una clave a la vez (la mayoría de los proveedor
keys), pasa directo a §3.3.

### 3.3. Cutover

1. Sustituye en el secret store: `OPENAI_API_KEY` ← nueva.
2. Re-despliega backend (`docker compose up -d --no-deps backend` o
   equivalente). Para procesos PM2: `pm2 reload backend`.
3. Verifica que las primeras requests a ese servicio retornan 200 (ver
   `docs/observability.md`).

### 3.4. Revocar la vieja clave

Tras 5 minutos sin errores 401/403 atribuibles al servicio, **revoca**
la clave anterior en el panel del proveedor. No la dejes inactiva: una
clave válida sin uso es deuda de seguridad.

---

## 4. Rotación de secretos de aplicación

Para `JWT_SECRET` / `SESSION_SECRET`:

1. Genera el nuevo secret (§3.1).
2. Si tu deploy soporta dos secretos válidos durante un grace window
   (`JWT_SECRET` + `JWT_SECRET_PREVIOUS`), publica el nuevo como
   primario y deja el viejo como `_PREVIOUS`. Despliega.
3. Espera el TTL más largo de tus tokens (default JWT: 24h).
4. Borra `JWT_SECRET_PREVIOUS`. Despliega.

Si **no** hay grace window, todos los usuarios serán deslogueados al
rotar — comunícalo y rota fuera de horario pico.

`ENCRYPTION_KEY` requiere re-cifrado de datos en reposo; **no** rotar sin
plan de migración.

---

## 5. Verificación

Tras cada rotación, ejecuta el verificador:

```bash
node backend/scripts/verify-secret-rotation.js \
  --current backend/.env \
  --previous backend/.env.previous \
  --required OPENAI_API_KEY,ANTHROPIC_API_KEY,JWT_SECRET,STRIPE_SECRET_KEY \
  --json
```

Comprobaciones:

- **`missing`**: ninguna key requerida vacía.
- **`rotated`**: cada key requerida cambió respecto a la versión previa.
- **`unchanged`**: lista vacía (warning si una key requerida no rotó).
- **`issues`** con `level: "error"`: cero. Errores comunes:
  - `placeholder` — la clave es literal (`changeme`, `xxx`…).
  - `bad_prefix` — la clave no empieza con el prefijo esperado
    (`sk-`, `sk-ant-`, `whsec_`…).
  - `too_short` — la clave es más corta que el mínimo del proveedor.
  - `low_entropy` — el secreto generado tiene baja entropía (warning).

El script imprime sólo **fingerprints SHA-256 truncados** de cada
secreto: nunca el valor en claro. Es seguro pegar el JSON resultante en
un ticket de incidencia.

Salida esperada (ejemplo abreviado):

```
secret-rotation: checked=4 rotated=4 unchanged=0 missing=0 ok=true
  rotated: OPENAI_API_KEY, ANTHROPIC_API_KEY, JWT_SECRET, STRIPE_SECRET_KEY
```

Exit code: `0` = OK, `1` = al menos un error → **no continuar el cutover**.

### Smoke checks por proveedor

| Servicio | Comando | Espera |
|---|---|---|
| OpenAI | `curl -s -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models \| jq '.data[0].id'` | nombre de modelo |
| Anthropic | `curl -s -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" https://api.anthropic.com/v1/models \| jq '.data[0].id'` | nombre de modelo |
| Stripe | `curl -s -u $STRIPE_SECRET_KEY: https://api.stripe.com/v1/balance \| jq '.object'` | `"balance"` |
| Redis | `redis-cli -u $REDIS_URL ping` | `PONG` |
| DB | `npx prisma db pull --print` | schema sin error |

---

## 6. Limpieza

```bash
shred -u backend/.env.previous 2>/dev/null || rm -P backend/.env.previous
```

Confirma con el equipo en el canal de seguridad: rotación completada,
fingerprints, hora de cutover, hora de revocación de la clave anterior.

Registra en el log de auditoría:

- Quién rotó.
- Qué secretos.
- Motivo (P0/P1/P2/P3).
- Fingerprint de la clave nueva (no el valor).

---

## 7. Recuperación ante fallo

Si tras el cutover el backend devuelve `401`/`403` en > 1% de requests:

1. **Restaura** el `.env.previous` y re-despliega (`pm2 reload`).
2. **No revoques** la clave nueva todavía (puede tener telemetría útil).
3. Investiga (logs, `secret-redactor.js` no debe estar enmascarando un
   error de configuración real).
4. Repite §3.3 con corrección.

Si ya revocaste la clave vieja antes del fallo: emite una nueva en el
panel y reanuda desde §3.1. La rotación dual existe precisamente para
evitar este escenario.

---

## 8. Anexo: integración en CI

Añade un job opcional que ejecute el verificador contra los secrets del
runner (en seco, sin red):

```yaml
- name: Verify required secrets present
  run: |
    node backend/scripts/verify-secret-rotation.js \
      --required OPENAI_API_KEY,ANTHROPIC_API_KEY,JWT_SECRET
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
```

El verificador lee de `process.env` cuando no se le pasa `--current`, por
lo que no es necesario materializar un `.env` en el runner.
