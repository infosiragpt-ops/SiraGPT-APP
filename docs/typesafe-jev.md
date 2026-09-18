# TypeSafe Jev en SiraGPT

Jev es el modelo *System One* de TypeSafe AI: no redacta texto, **decide**.
Recibe un `state` (texto o JSON) y un mapa de preguntas tipadas y devuelve
probabilidades calibradas (entrenado con RLCD). Un solo endpoint:
`POST https://api.typesafe.ai/v1/systemone`, clave `TYPESAFE_API_KEY`,
64k tokens por petición (32k para el `state`), 0,042 $/Mtok de entrada,
salida gratis. Alias `jev-latest` → `jev-1.13.0`.

| Tipo | Pregunta | Respuesta |
|---|---|---|
| `noul` | sí/no | `noul` ∈ [0,1] (probabilidad de sí) |
| `choice` | elegir entre `criteria {opcion: descripcion}` | `choice`, `probabilities`, `confidence` |
| `score` | posición en `criteria [nivel0, nivel1, …]` | `score` (puede caer entre niveles), `legend`, `probabilities`, `confidence` |

## Dónde aparece en el producto

1. **Selector de modelos** (`/agentes`): `typesafe/jev-latest` («TypeSafe Jev») y
   `typesafe/jev-1.13` («TypeSafe Jev 1.13», versión fijada). Las filas del
   catálogo se crean desde código (`services/typesafe-catalog.js`) la primera
   vez que se lista el picker con la clave configurada; no hay migración.
   Al elegir Jev, cada turno pasa por `services/typesafe-decision-chat.js`:
   el mensaje se convierte en preguntas tipadas, se evalúa y se responde con
   una **tarjeta de decisión** determinista (elección, distribución, confianza
   y recomendación actuar / confirmar / no automatizar). Formatos aceptados:
   * sí/no: «¿Debo desplegar el viernes?» → `noul`
   * opciones: «¿A, B o C?», `opciones: a, b, c`, o lista `a) … b) …` → `choice`
     (se añade siempre «ninguna de las anteriores»)
   * escala: «puntúa del 1 al 5 …» → `score`
   * modo pro: JSON con `state`, `questions` (y `model`) en el mensaje → se envía tal cual
   * cualquier otra cosa: `noul` genérico (¿es cierto/válido/recomendable?) +
     `score` de claridad, con una pista de cómo preguntar.
   El historial reciente y los documentos adjuntos viajan en el `state`.
   Jev no ejecuta herramientas ni el bucle agéntico (la ruta lo excluye).
2. **Herramienta de agente `decide_with_jev`** (siempre disponible en el bucle
   agéntico): cualquier turno puede pedir a Jev que clasifique, priorice o
   puntúe con probabilidades honestas en lugar de adivinar con el modelo de chat.
3. **RLCD – intención de medios** (`services/rlcd/jev-decider.js`): cuando la
   heurística de `decideMediaIntent` no es concluyente (todo lo que no sea un
   `force` con raw ≥ 0,85 sin reparación) y el mensaje tiene vocabulario de
   medios, `refineMediaIntentWithJev` pregunta a Jev (Choice
   generate_image / edit_image / generate_video / generate_music /
   generate_speech / chat_only + Noul «¿quiere un archivo ahora?»). La
   probabilidad de Jev sustituye al raw heurístico, el ledger la calibra y se
   aplican los mismos umbrales (`SIRAGPT_RLCD_MEDIA_FORCE_THRESHOLD` /
   `_ASK_THRESHOLD`). Jev puede vetar un `force` heurístico cuando está seguro
   de que el usuario solo conversa. Cada refinamiento se registra como decisión
   propia (`meta.source = 'jev'`, `meta.supersedes = id heurístico`) para que
   la heurística y Jev se puntúen contra el mismo resultado. Fail-open, ≤1,5 s.
4. **Admin → Conexiones → TypeSafe**: la clave se guarda cifrada y
   `admin-connections-bridge` la publica como `TYPESAFE_API_KEY`; la sonda usa
   `GET /v1/models`. `/api/health` expone `model_providers.typesafe`.

## Variables

| Variable | Por defecto | Uso |
|---|---|---|
| `TYPESAFE_API_KEY` | – | clave (Admin → Conexiones o `.env`) |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | host alternativo |
| `TYPESAFE_TIMEOUT_MS` | 15000 | timeout por petición |
| `TYPESAFE_RETRIES` | 2 | reintentos con backoff en 429/529/5xx/red |
| `SIRAGPT_RLCD_JEV` | on si hay clave | `0` desactiva el refinamiento RLCD |
| `SIRAGPT_RLCD_JEV_TIMEOUT_MS` | 1500 | presupuesto del refinamiento por turno |
| `SIRAGPT_RLCD_JEV_MODEL` | `jev-latest` | `jev-1.13` para fijar versión |

## Código

* `backend/src/services/providers/typesafe.js` — cliente HTTP, validación local
  del esquema, reintentos, `summarizeAnswer`, `confidenceBand`, mapa de ids.
* `backend/src/services/typesafe-decision-chat.js` — parser mensaje → preguntas
  y render de la tarjeta; `aiService.streamTypeSafeDecision` lo emite como
  `text_delta`.
* `backend/src/services/typesafe-catalog.js` — filas del catálogo.
* `backend/src/services/agents/typesafe-decision-tool.js` — `decide_with_jev`.
* `backend/src/services/rlcd/jev-decider.js` + `rlcd/index.js`
  `refineMediaIntentWithJev`.
* Tests: `backend/tests/typesafe-provider.test.js`,
  `backend/tests/typesafe-integration.test.js`,
  `tests/admin-connections-typesafe-source.test.ts`.

## Verificación en producción

1. Admin → Conexiones → TypeSafe → pegar la clave → la sonda debe marcar OK.
2. `GET /api/health` → `model_providers.typesafe: true`.
3. `GET /api/ai/models?type=TEXT` lista `typesafe/jev-latest` y `typesafe/jev-1.13`.
4. En `/agentes` con «TypeSafe Jev»: «¿Debo lanzar la campaña en marzo, abril o mayo?»
   → tarjeta con la distribución.
5. `GET /api/rlcd/stats` → `media_intent` empieza a recibir decisiones con
   `source: jev` cuando se escriben frases de imagen ambiguas.
