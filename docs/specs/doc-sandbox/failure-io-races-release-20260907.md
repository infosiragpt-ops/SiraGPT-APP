# F1 — cancelación y deadline durante una escritura aceptada

2026-09-07 UTC. **PR #561 en borrador, no desplegada; F1 no está cerrada.**
Base probada: `67ded1f0e1abab02bc7f21dc7f2e0ef1b2cd4afd`.
Este lote añade pruebas, no cambia runtime, esquema, UI ni política.

## Ensayo y resultado

La suite de retención pasa de siete a diez casos. Un proxy HTTP local retiene
únicamente la respuesta de un PUT realmente aceptado por MinIO. Antes de
revocar el trabajo, cada caso confirma la reserva PostgreSQL y recupera el
objeto mediante GET/GCM. No fabrica respuestas, modifica bytes ni sustituye
SDK, almacenamiento, repositorio o validador. Los originales no usan el proxy.

- Cancelar y borrar durante el PUT producen `DOC_STALE_LEASE`, sin informe,
  output, metadatos ni reintento tardíos. La compensación recibe DELETE 204
  real. El diario conserva la obligación de limpieza: la gracia de 15 minutos
  impide certificarla inmediatamente, aunque el objeto ya no esté en MinIO.
- Al retener la respuesta hasta vencer el plazo real de 15 segundos, el
  handler aborta sin conceder otra ventana de compensación. El objeto sigue
  cifrado, reservado y sin acuse de purga; estado, lease y eventos no cambian.
  `cleanupPending` sigue falso antes de la recuperación. Después se borra
  explícitamente sólo ese job sintético, se vence su gracia en la fixture y
  se ejecuta el reconciliador real: prefijo vacío y purga confirmada.
- Originales y objeto vecino se comparan byte a byte. Se esperan worker y
  transportes antes de eliminar la fixture. Cero construcciones del motor
  y cero llamadas o gasto del proveedor.

Candidata privada:
`/home/user/deployments/doc-sandbox-phase1-tests/candidate-races-20260907-XXPoOmCa`.
Fuente de prueba idéntica en Mac/Lenovo, SHA-256:
`47fa8b40024634be22451dc4c45636c46db689710c57d39ed39850cb77b695f0`.
Se reutilizó el bundle Python positivo/negativo de D31, no se contó como una
nueva ejecución Python. SHA externo:
`676c7bd19ed0e634be40c85df09a7d661898e6333fcde32832cb9c44bb94f6cd`.
Sus tres fuentes protegidas por hash permanecieron intactas.

```text
bash infra/doc-validation/run-isolated-failure-retention.sh <candidata> <bundle> <SHA256>
tests 10; pass 10; fail 0; cancelled 0; skipped 0; todo 0
duration_ms 25696.095189; exit 0
caso deadline: duration_ms 15824.671052
```

Log local: `output/phase1-failure-races-integration.log`. Runner Node 22.23.2
con imagen fijada, no root, readonly, 1 CPU/1 GiB y red interna sin puertos;
misma infraestructura de test y script revisado de D31. Al terminar se
verificaron PostgreSQL, Redis y MinIO detenidos, etiqueta de ámbito correcta,
cero puertos y ningún contenedor de prueba activo. Typecheck estricto del
spec y `git diff --check`: exit 0. Revisión independiente sin bloqueantes.

## CI y límites

El CI de la base `67ded1f0…`, run `34070058593`, terminó en fallo de cobertura
y agregador; los demás jobs aprobaron. Retención **7/7**, storage **34/34**
(10003 objetos purgados en una pasada), unitarias estrictas **368/368**,
cobertura **72,20% (2741/3796)**: no alcanza el 80%. Estas integraciones no se
mezclan en cobertura. La suite ampliada necesita su CI después del push.
No se repitieron las 79 integraciones ni los 12472 casos generales de D31:
el runtime no cambió y este lote ejecutó las diez pruebas focales completas.

Se acredita el tramo privado `handleFailure`, no `process()` completo, el
scheduler, expiración durante INSERT, tres intentos completos, 10010 PUT en
15 segundos, Anthropic remoto, gVisor, render Office ni edición en el chat.
La recuperación explícita de una fixture no demuestra recuperación autónoma.
No cambia la aceptación pendiente de F1 ni las restricciones de D31.

Checkout Lenovo limpio y API pública coinciden en `100d29bc2e…` (#571), con
readiness saludable a **2026-09-07T00:50:57.458Z**. No contienen #561.
No se revalidaron los bloqueos de infraestructura en este lote. Sin cambios
productivos, reinicios, DNS, excepciones de CI o gasto del proveedor.

Guías aplicadas: `release-orchestrator`, `agent-validation`, `quality-gates`,
`secret-safety` y `technical-docs` de `.agents/skills`.
