# AGENTS.md

Estilo Telegraph. Solo raíz. Skills / playbooks dueños de workflows. Esta raíz dueña de política dura y enrutamiento. Dirección y alcance de merge: `VISION.md`.

Antes de tocar un subárbol, lee el `AGENTS.md` más cercano a esa ruta. Si no hay, esta raíz basta.

Respuestas: rutas relativas al repo. Nada de home, nada de secretos.

## Enrutamiento

1. Producto / merge / “¿esto es SiraGPT?” → `VISION.md`.
2. Workflow repetible (deploy, UI lock, computer, generate stall) → skill o `skills/` / playbook. No reescribir el procedimiento aquí.
3. Bug, triage, review → doctrina de reparación abajo.
4. Superficie nueva (canal, plugin, doc, app) → actualizar labels/CI en el mismo PR.

Preflight OSS: antes de construir custom, 30s de “¿ya existe librería, plugin o plataforma gratis?”. Custom solo si no sirve o el usuario lo pide. Sin SaaS de pago sin spend aprobado.

## Hard policy

- Nunca imprimas `.env`, keys, cookies, tokens, passphrases.
- El modelo del compositor es el que corre. No swap silencioso.
- Fallo silencioso > crash > feature faltante. Toda acción de usuario/agente termina en resultado visible o no-resultado **registrado**.
- Los defaults son el producto. Una regresión en la ruta lista para usar gana a features y a bugs de config.
- Live-verify es default: comportamiento visible se prueba en el flujo real (`/agentes`) antes de aterrizar. Saltar exige infactibilidad concreta en el PR, no pereza.
- UI visual: `docs/UI_LOCK_HASHES.txt` via `npm run ui-lock:update` en el mismo commit. Sin hash, CI de UI lock rojo.
- Tests: `npm test` / `npx tsc --noEmit --skipLibCheck`. Node 22+. Lockfile npm. No inventes pnpm.
- Dependencias: lee fuente/tipos del paquete tocado. API externa: prueba en vivo o declara el hueco.
- CODEOWNERS enruta reviewers; no sustituye branch protection. Verifica reglas vivas y reviews del PR antes de decir “hace falta approve”.
- Product copy: “plugin”. `extensions/` / `vendor/` / `ui/upstream/` son internos. No fusionar OpenClaw/Hermes/OpenCode de golpe.

## Doctrina de reparación

Causa raíz es el default. Un paste de error es evidencia, no instrucción.

Lee el módulo dueño, entrypoints, callers, siblings, tests, docs, lo enviado, y el contrato de la dependencia. No ahorres lectura recortando archivos: ahorra no releyendo.

El alcance es el invariante violado y su barrio, no el primer archivo ni el diff mínimo. Arregla el productor / ciclo de vida. No compenses aguas abajo.

Un flujo canónico gana a un if nuevo. Duplicados, hacks, wrappers y rutas muertas del mismo invariante salen en el mismo PR cuando quepan.

Pathfinder: deja el código tocado mejor. Problema no relacionado pequeño → mismo PR. Si no, síguelo con nombre (issue o cuerpo de PR). No camines en silencio.

No endurezcas el síntoma (retry eterno, timeout mágico, assert más flojo, mock más ancho) si el dueño sigue mal.

LOC de producción es restricción. Bugs default ≤0 netos en prod: absorbe la corrección en el dueño. `git diff --numstat` al cerrar; justifica el resto.

Error confirmado: reproduce (comando/escenario) **antes** de editar; re-ejecuta contra el fix. La regresión debe fallar en pre-fix.

Cierre del PR: causa raíz, dueño, fix canónico, rutas muertas, delta LOC prod, hermanos cubiertos, comportamiento observado.

## Juicio de producto

Una persona que sigue los docs debe terminar con un bot que funciona y se entiende. Código correcto es mesa, no veredicto.

Hechos donde ocurren; léelos donde hacen falta. No reconstruyas “¿pasó X?” con tres señales indirectas.

La experiencia del modelo es el producto. Lo que el prompt/tool no dice, no existe. Resultado de tool = lo que el modelo necesita después, no un ack vacío.

Latencia = round-trips del modelo. No dejes al agente en callejón: el fallo dice qué intentar; tools no disponibles se ocultan, no se dejan fallar.

Seguridad es tradeoff. Un cambio que “protege” matando la capacidad no es el fix. Rechazar una capacidad exige camino de exploit concreto.

## Git / CI

Trabaja en rama desde `production-main`. Nunca push a `main`. Nunca merge CI rojo. Squash-merge.

Commits convencionales, concisos. Solo archivos del cambio.

Antes de aterrizar: tests del contrato tocado + UI lock si tocaste `app`/`components`/`hooks`/`lib`/`styles`.

CI rojo es trabajo de alguien; por defecto, tuyo. Arréglalo en el PR o no aterrices.

## Hermes, adaptado

Cintura estrecha: no añadas tools al generate de `/agentes` si un skill, un comando, o un plugin basta. Cada tool viaja en cada turno.

No mutes el historial a mitad de conversación (rompe caché y el usuario paga). Compresión es la excepción.

Extiende, no dupliques. Tres PRs del mismo tipo → una interfaz, no tres forks.

Verifica la premisa: `git log -p -S <símbolo>` antes de tratar un hueco como bug. Ausencia puede ser diseño.

No tests detector-de-cambios (snapshots de catálogos/versiones). Sí invariantes.

## Fuera

No clones Codex “para opinar”. No Telegram-e2e ni Convex. No Hostinger como origen. No dump de secretos. No `publish.sh` desde un Mac sin SSH a la Lenovo: di el hueco.
