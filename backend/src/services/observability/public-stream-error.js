'use strict';

const metrics = require('../../utils/metrics');
const { getRequestId } = require('../../middleware/request-id');

metrics.registerCounter('siragpt_stream_failures_total', {
  help: 'Sanitized streaming failures by bounded backend surface and stable public code',
  labels: ['surface', 'code'],
  maxSeries: 64,
});

const RULES = [
  {
    code: 'aborted',
    retryable: true,
    matches: (error, text) => error?.name === 'AbortError' || /\babort(?:ed)?\b/i.test(text),
    message: 'La operación fue cancelada.',
  },
  {
    code: 'timeout',
    retryable: true,
    matches: (error, text) => error?.name === 'TimeoutError' || /timeout|timed out|etimedout/i.test(text),
    message: 'La operación tardó demasiado. Inténtalo nuevamente.',
  },
  {
    code: 'rate_limited',
    retryable: true,
    matches: (error, text) => Number(error?.status) === 429 || /\b429\b|rate.?limit|too many requests/i.test(text),
    message: 'El servicio está procesando muchas solicitudes. Inténtalo en unos segundos.',
  },
  {
    code: 'provider_unavailable',
    retryable: true,
    matches: (error, text) => Number(error?.status) >= 500 || /econnreset|econnrefused|service unavailable|provider unavailable/i.test(text),
    message: 'El proveedor no está disponible temporalmente.',
  },
  {
    code: 'persistence_failed',
    retryable: true,
    matches: (error) => String(error?.code || '').toUpperCase() === 'PERSISTENCE_FAILED',
    message: 'El archivo se generó, pero no pudo guardarse en la conversación. Puedes descargarlo ahora o reintentar.',
  },
  {
    code: 'credits_exhausted',
    retryable: false,
    matches: (error, text) => Number(error?.status) === 402 || /llm_402|credits?_exhausted|insufficient (credits|balance)|quota_exhausted|credit_no_usage|credit_ceiling/i.test(text) || ['llm_402', 'credit_no_usage', 'credit_ceiling', 'credits_exhausted'].includes(String(error?.code || '').toLowerCase()),
    message: 'No quedan creditos suficientes para esta operacion. No cobre el fallo.',
  },
  {
    code: 'no_llm',
    retryable: false,
    matches: (error, text) => /no_llm|DEEPSEEK_API_KEY is not configured|DeepSeek API key is not configured/i.test(text) || String(error?.code || '').toLowerCase() === 'no_llm',
    message: 'El modelo nativo no esta configurado.',
  },
  {
    code: 'model_forbidden',
    retryable: false,
    matches: (error, text) => /model_forbidden|openrouter/i.test(text) || String(error?.code || '').toLowerCase() === 'model_forbidden',
    message: 'Este modelo no esta permitido. Usa DeepSeek V4 Flash o Pro.',
  },
  {
    code: 'validation_failed',
    retryable: false,
    matches: (error) => /validation/i.test(String(error?.code || '')),
    message: 'La solicitud o el resultado no superó la validación.',
  },
  {
    code: 'loop_cut',
    retryable: false,
    matches: (error, text) => String(error?.code || '').toLowerCase() === 'loop_cut' || /infinite.?loop|loop_cut/.test(text),
    message: 'El agente repitió el mismo paso demasiadas veces. Detuve el bucle.',
  },
  {
    code: 'budget_exceeded',
    retryable: false,
    matches: (error, text) => String(error?.code || '').toLowerCase() === 'budget_exceeded' || /budget_exceeded|max_iterations/.test(text),
    message: 'El presupuesto de pasos del agente se agotó.',
  },
  {
    code: 'tool_args_invalid',
    retryable: false,
    matches: (error, text) => String(error?.code || '').toLowerCase() === 'tool_args_invalid' || /tool_args_invalid/.test(text),
    message: 'Los argumentos de la herramienta no eran JSON válido.',
  },
  {
    code: 'syntax_invalid',
    retryable: false,
    matches: (error, text) => String(error?.code || '').toLowerCase() === 'syntax_invalid' || /syntax_invalid/.test(text),
    message: 'El archivo escrito no pasó validación de sintaxis y se revirtió.',
  },
];


const ENGINE_CODE_RULES = [
  { code: 'checkpoint_missing', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'checkpoint_missing' },
  { code: 'tool_timeout', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_timeout' || /tool_timeout/.test(text) },
  { code: 'sandbox_killed', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_killed' },
  { code: 'file_too_large', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'file_too_large' },
  { code: 'checkpoint_expired', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'checkpoint_expired' },
  { code: 'resume_conflict', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'resume_conflict' },
  { code: 'schema_invalid', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'schema_invalid' },
  { code: 'memory_acl_denied', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'memory_acl_denied' },
  { code: 'symlink_rejected', message: 'El enlace simbolico sale del espacio de trabajo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'symlink_rejected' },
  { code: 'coercion_rejected', message: 'Los argumentos superan el límite permitido de la herramienta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'coercion_rejected' },
  { code: 'dlq_exhausted', message: 'La herramienta falló demasiadas veces. La pasé a la cola de errores.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'dlq_exhausted' },
  { code: 'fence_conflict', message: 'Otra instancia del motor ya está ejecutando esta sesión.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'fence_conflict' },
  { code: 'network_denied', message: 'El sandbox no tiene red permitida para ese destino.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'network_denied' },
  { code: 'path_traversal', message: 'La ruta sale del espacio de trabajo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'path_traversal' },
  { code: 'duplicate_event', message: 'Ese evento ya se entregó. Lo descarté.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'duplicate_event' },
  { code: 'fence_expired', message: 'El candado de esta sesión expiró. Puedes reanudar.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'fence_expired' },
  { code: 'dlq_replay', message: 'Reintentaré el paso con espera aleatoria.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'dlq_replay' },
  { code: 'pgvector_failed', message: 'No pude consultar la memoria vectorial. Sigo sin ella.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'pgvector_failed' },
  { code: 'tmpfs_exceeded', message: 'El espacio temporal del sandbox está lleno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tmpfs_exceeded' },
  { code: 'credit_ceiling', message: 'Este turno alcanzó el techo de tokens.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'credit_ceiling' },
  { code: 'credit_mismatch', message: 'El audit de créditos no cuadra con el ledger.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'credit_mismatch' },
  { code: 'stdout_rate', message: 'La salida de la herramienta se recortó por velocidad.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'stdout_rate' },
  { code: 'dlq_poison', message: 'La herramienta falló demasiadas veces. La pasé a la cola de envenenados.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'dlq_poison' },
  { code: 'gzip_version', message: 'El punto de restauración usa una versión de compresión desconocida.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'gzip_version' },
  { code: 'hash_sweep', message: 'Se limpiaron hashes de eventos vencidos.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'hash_sweep' },
  { code: 'retrieve_memory_failed', message: 'No pude consultar la memoria. Sigo sin ella.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'retrieve_memory_failed' },
  { code: 'tmpfs_cleanup', message: 'Limpié el espacio temporal del sandbox al cancelar.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tmpfs_cleanup' },
  { code: 'turn_deadline', message: 'Se agotó el tiempo máximo de este turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'turn_deadline' },
  { code: 'unknown_tool', message: 'Esa herramienta no existe en este motor.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'unknown_tool' },
  { code: 'tool_result_capped', message: 'Recorté el resultado de la herramienta por tamaño.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_result_capped' },
  { code: 'tool_isolated', message: 'Una herramienta falló en paralelo; las demás siguieron.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_isolated' },
  { code: 'ckpt_cas', message: 'El punto de restauración cambió; no pude sobrescribirlo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'ckpt_cas' },
  { code: 'error_budget', message: 'Este turno acumuló demasiados errores. Lo detuve.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'error_budget' },
  { code: 'circuit_open', message: 'Esa herramienta falló demasiado y quedó en circuito abierto.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'circuit_open' },
  { code: 'tool_repair_exhausted', message: 'La herramienta no entregó argumentos válidos tras varios intentos. Detuve el turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_repair_exhausted' },
  { code: 'token_budget', message: 'Este turno alcanzó el presupuesto de tokens.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'token_budget' },
  { code: 'sse_orphan', message: 'Cerré un flujo SSE huérfano.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sse_orphan' },
  { code: 'sse_resume', message: 'Reanudé el flujo desde el último evento.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sse_resume' },
  { code: 'queue_lease', message: 'El trabajo en cola expiró. Encola de nuevo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'queue_lease' },
  { code: 'sse_backpressure', message: 'Descarté eventos viejos para no saturar el flujo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sse_backpressure' },
  { code: 'write_hash', message: 'El archivo escrito no coincide con el hash esperado. Revertí.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'write_hash' },
  { code: 'subagent_budget', message: 'El presupuesto del subagente se agotó.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'subagent_budget' },
  { code: 'subagent_tool_denied', message: 'Ese tipo de subagente no puede usar esa herramienta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'subagent_tool_denied' },
  { code: 'sleep_compact', message: 'Compacté el contexto y guardé la memoria del turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sleep_compact' },
  { code: 'git_apply_dirty', message: 'El archivo tiene cambios sin commit. No apliqué el diff.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'git_apply_dirty' },
  { code: 'git_syntax_revert', message: 'El diff no pasó validación de sintaxis y se revirtió.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'git_syntax_revert' },
  { code: 'idempotency_replay', message: 'Reproduje la respuesta de una operación ya ejecutada.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'idempotency_replay' },
  { code: 'codex_engine_stop', message: 'El bucle Codex alcanzó su condición de parada.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'codex_engine_stop' },
  { code: 'codex_openrouter_denied', message: 'El generate de /code no usa OpenRouter. Usa DeepSeek nativo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'codex_openrouter_denied' },
  { code: 'codex_first_byte', message: 'Registré el primer token del turno Codex.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'codex_first_byte' },
  { code: 'git_hunk_ambiguous', message: 'El diff no coincide de forma única. No apliqué el cambio.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'git_hunk_ambiguous' },
  { code: 'git_binary_rejected', message: 'Rechacé un diff o archivo binario.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'git_binary_rejected' },
  { code: 'sandbox_stream', message: 'La salida del sandbox se recortó al transmitir.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_stream' },
  { code: 'sandbox_reap', message: 'El proceso del sandbox no cerró a tiempo; lo reapé.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_reap' },
  { code: 'sandbox_cleanup', message: 'Forcé la limpieza del sandbox al cancelar o al vencer el plazo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_cleanup' },
  { code: 'sse_drain_timeout', message: 'El flujo SSE no drenó a tiempo; seguí sin bloquear el turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sse_drain_timeout' },
  { code: 'sse_heartbeat', message: 'Mantuve vivo el flujo SSE con un heartbeat.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sse_heartbeat' },
  { code: 'queue_fairness', message: 'Elegí la siguiente sesión en round-robin.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'queue_fairness' },
  { code: 'retrieve_before', message: 'Recuperé memoria antes de generar. Si falló, sigo sin ella.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'retrieve_before' },
  { code: 'pin_dedup', message: 'Quité recuerdos duplicados del contexto.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'pin_dedup' },
  { code: 'credit_cancel', message: 'Al cancelar, asenté el uso real y liberé el resto del hold.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'credit_cancel' },
  { code: 'resume_recreate', message: 'Reanudé la sesión desde el último checkpoint (sobrevive un recreate).', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'resume_recreate' },
  { code: 'write_syntax_revert', message: 'La escritura no pasó validación de sintaxis y restauré el original.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'write_syntax_revert' },
  { code: 'plan_budget', message: 'El presupuesto restante del plan anidado se agotó.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'plan_budget' },
  { code: 'first_byte_real', message: 'Registré el primer byte real del flujo (no un número inventado).', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'first_byte_real' },
  { code: 'tool_storm', message: 'Demasiadas herramientas a la vez. Completé las que cabían y dejé el resto para el siguiente turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_storm' },
  { code: 'dag_blocked', message: 'El plan no puede seguir: hay tareas esperando dependencias que no terminaron.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'dag_blocked' },
  { code: 'dag_wait', message: 'Esperé a que terminaran las dependencias del plan antes de seguir.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'dag_wait' },
  { code: 'compact_fidelity', message: 'Compacté el contexto sin romper pares herramienta/resultado.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'compact_fidelity' },
  { code: 'event_order', message: 'Reordené eventos del gateway para que la secuencia por sesión sea estricta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'event_order' },
  { code: 'concurrent_turn', message: 'Registré la latencia de turnos concurrentes (sin inventar números Flash).', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'concurrent_turn' },
  { code: 'loop_stall', message: 'El bucle se quedó sin tokens ni resultados de herramientas. Lo detuve.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'loop_stall' },
  { code: 'sandbox_timeout', message: 'El sandbox no produjo salida a tiempo y lo detuve.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_timeout' },
  { code: 'tool_id_duplicate', message: 'Había identificadores de herramienta duplicados en el mismo turno. Los reparé.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_id_duplicate' },
  { code: 'tool_name_empty', message: 'Una herramienta llegó sin nombre. No la ejecuté.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_name_empty' },
  { code: 'tool_result_orphan', message: 'Llegó un resultado de herramienta sin llamada coincidente. Lo ignoré.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_result_orphan' },
  { code: 'session_busy', message: 'Hay otro turno de esta sesión en curso. Este espera su turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'session_busy' },
  { code: 'pin_evict', message: 'Quité recuerdos menos importantes del contexto y conservé los anclados.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'pin_evict' },
  { code: 'exactly_once_tool', message: 'Esa herramienta ya produjo un resultado. No la volví a ejecutar.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'exactly_once_tool' },
  { code: 'credit_hold_reuse', message: 'Reusé la reserva de créditos de este turno; no cobré dos veces.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'credit_hold_reuse' },
  { code: 'turn_superseded', message: 'Un mensaje nuevo canceló este turno. El anterior no se filtró.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'turn_superseded' },
  { code: 'tool_unknown', message: 'No reconozco esa herramienta. Te sugerí la más cercana.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_unknown' },
  { code: 'dag_cycle', message: 'El plan tiene una dependencia circular. Lo detuve para que no se cuelgue.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'dag_cycle' },
  { code: 'write_noop', message: 'La escritura no cambió el archivo. No la cuento como éxito.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'write_noop' },
  { code: 'sandbox_spawn', message: 'No pude arrancar el sandbox.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_spawn' },
  { code: 'sse_duplicate', message: 'Ese evento ya se entregó. No lo repetí.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sse_duplicate' },
  { code: 'credit_no_usage', message: 'El proveedor falló sin reportar uso. Liberé la reserva; no cobré tokens.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'credit_no_usage' },
  { code: 'tool_result_dup', message: 'Ese resultado de herramienta ya se entregó. No lo repetí.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_result_dup' },
  { code: 'gateway_busy', message: 'Esta sesión ya tiene un productor activo. Esperé a que termine.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'gateway_busy' },
  { code: 'turn_cancelled', message: 'Cancelé el turno en curso. Liberé la reserva y corté las herramientas.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'turn_cancelled' },
  { code: 'tool_aborted', message: 'Aborté las herramientas que seguían en vuelo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_aborted' },
  { code: 'first_token_stall', message: 'El proveedor no envió el primer token a tiempo. Mandé un latido.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'first_token_stall' },
  { code: 'rate_limited', message: 'El proveedor está saturado. Reintentaré en un momento.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'rate_limited' },
  { code: 'provider_auth', message: 'El proveedor rechazó la autenticación. No se filtró ninguna clave.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'provider_auth' },
  { code: 'provider_unavailable', message: 'El proveedor falló temporalmente. Reintentaré.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'provider_unavailable' },
  { code: 'provider_timeout', message: 'El proveedor tardó demasiado. Corté la espera.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'provider_timeout' },
  { code: 'provider_bad_request', message: 'El proveedor rechazó el pedido. Revisé el formato.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'provider_bad_request' },
  { code: 'empty_response', message: 'El modelo no devolvió texto ni herramientas. Paré el turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'empty_response' },
  { code: 'dangerous_tool', message: 'Bloqueé una herramienta peligrosa en el generate.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'dangerous_tool' },
  { code: 'openrouter_denied', message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'openrouter_denied' },
  { code: 'session_lock_stale', message: 'El candado de sesión expiró. Liberé al worker caído.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'session_lock_stale' },
  { code: 'mcp_connected_only', message: 'MCP deny-all: solo reuso hosts ya conectados en esta sesión.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'mcp_connected_only' },
  { code: 'path_mutation_busy', message: 'Otra escritura va al mismo archivo. Esperé a que termine.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'path_mutation_busy' },
  { code: 'duplicate_turn', message: 'Ese turno ya está en vuelo. No lancé otro generate.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'duplicate_turn' },
  { code: 'network', message: 'Falló la red al llamar la herramienta. Reintentaré.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'network' },
  { code: 'permission', message: 'No hay permiso para esa acción.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'permission' },
  { code: 'not_found', message: 'No encontré ese archivo o recurso.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'not_found' },
  { code: 'invalid_args', message: 'Los argumentos de la herramienta no son válidos.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'invalid_args' },
  { code: 'read_window', message: 'Leí una ventana del archivo con números de línea.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'read_window' },
  { code: 'glob_ignored', message: 'Omití rutas de build/git/node_modules del glob.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'glob_ignored' },
  { code: 'bash_background', message: 'Dejé el comando en segundo plano. Lo siego si cancelas.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'bash_background' },
  { code: 'secret_redact', message: 'Redacté un secreto del resultado de la herramienta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'secret_redact' },
  { code: 'sse_gap', message: 'Faltan eventos SSE. Reenvío desde el anillo acotado.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sse_gap' },
  { code: 'model_forbidden', message: 'Generate solo usa DeepSeek Flash/Pro.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'model_forbidden' },
  { code: 'schema_strip', message: 'Quite propiedades extra que el schema no permite.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'schema_strip' },
  { code: 'token_compact', message: 'Compacte el contexto para caber en el presupuesto restante.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'token_compact' },
  { code: 'symlink_rejected', message: 'El enlace simbolico sale del espacio de trabajo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'symlink_rejected' },
  { code: 'clock_skew', message: 'El reloj del cliente esta desfasado; reintenta con hora sincronizada.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'clock_skew' },
  { code: 'git_hunk_ambiguous', message: 'No pude aplicar el diff unificado: el hunk no coincide.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'git_hunk_ambiguous' },
  { code: 'sandbox_resource_limit', message: 'El sandbox alcanzo el tope de procesos o archivos abiertos.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_resource_limit' },
  { code: 'unknown_tool', message: 'Esa herramienta no existe en el catalogo. No la ejecute.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'unknown_tool' },
  { code: 'network_denied', message: 'El sandbox no tiene red: SANDBOX_NET_ALLOW no esta definido.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'network_denied' },
  { code: 'final_with_tools', message: 'El texto ya era una respuesta final; ignore las herramientas extra.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'final_with_tools' },
  { code: 'memory_fact_empty', message: 'Ignore un hecho de memoria vacio.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'memory_fact_empty' },
  { code: 'credit_ceiling', message: 'DeepSeek sin credito (402). No reintente.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'credit_ceiling' },
  { code: 'credit_no_usage', message: 'No asente el hold: el stream nunca abrio.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'credit_no_usage' },
  { code: 'identical_observation_loop', message: 'El agente repitio el mismo resultado tres veces. Detuve el bucle.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'identical_observation_loop' },
  { code: 'enum_rejected', message: 'Ese valor no esta permitido en el enumerado.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'enum_rejected' },
  { code: 'binary_file', message: 'Ese archivo es binario. No lo edite.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'binary_file' },
  { code: 'sse_buffer_overflow', message: 'El buffer SSE se desbordo. Cerre el flujo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sse_buffer_overflow' },
  { code: 'generate_overloaded', message: 'El generate esta saturado. Reintenta en unos segundos.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'generate_overloaded' },
  { code: 'net_reset', message: 'La conexion se reseto. Reintenta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'net_reset' },
  { code: 'net_timeout', message: 'La red tardo demasiado. Reintenta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'net_timeout' },
  { code: 'net_dns', message: 'No resolvi el nombre de host. Reintenta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'net_dns' },
  { code: 'missing_required', message: 'Faltan argumentos obligatorios de la herramienta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'missing_required' },
  { code: 'bad_tool_result', message: 'El resultado de la herramienta no tiene una forma valida.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'bad_tool_result' },
  { code: 'timeout_budget', message: 'No alcanza el tiempo restante para esa herramienta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'timeout_budget' },
  { code: 'tool_dead_letter', message: 'La misma herramienta fallo tres veces. Detuve el bucle.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_dead_letter' },
  { code: 'write_checksum', message: 'El hash del archivo escrito no coincide. No conserve el cambio.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'write_checksum' },
  { code: 'syntax_invalid', message: 'El archivo escrito no tiene sintaxis valida. Lo reverte.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'syntax_invalid' },
  { code: 'bad_path', message: 'La ruta contiene caracteres de control no permitidos.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'bad_path' },
  { code: 'file_exists', message: 'Ese archivo ya existe. Pasa overwrite para reemplazarlo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'file_exists' },
  { code: 'fs_not_found', message: 'No encontre ese archivo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'fs_not_found' },
  { code: 'fs_denied', message: 'No hay permiso para esa ruta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'fs_denied' },
  { code: 'fs_nospace', message: 'No queda espacio en disco.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'fs_nospace' },
  { code: 'fs_isdir', message: 'Esa ruta es un directorio.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'fs_isdir' },
  { code: 'ckpt_cas', message: 'El checkpoint no coincide con la secuencia esperada.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'ckpt_cas' },
  { code: 'subagent_depth', message: 'El subagente superó la profundidad máxima.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'subagent_depth' },
  { code: 'wall_clock', message: 'Queda menos de 5 segundos. Detuve el turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'wall_clock' },
  { code: 'file_changed', message: 'El archivo cambió desde la última lectura. No apliqué la edición.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'file_changed' },
  { code: 'git_hunk_context', message: 'El contexto del parche no coincide con el archivo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'git_hunk_context' },
  { code: 'json_parse', message: 'No pude interpretar el JSON de la herramienta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'json_parse' },
  { code: 'too_many_tools', message: 'Demasiadas herramientas en un solo paso. Detuve el turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'too_many_tools' },
  { code: 'empty_model', message: 'El modelo devolvió dos respuestas vacías. Detuve el turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'empty_model' },
  { code: 'coercion_rejected', message: 'No pude convertir ese valor a entero.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'coercion_rejected' },
  { code: 'symlink_write', message: 'No escribo a través de un enlace simbólico.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'symlink_write' },
  { code: 'unauthorized', message: 'No autorizado. No se cobró el turno.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'unauthorized' },
  { code: 'glob_cap', message: 'Demasiados resultados de búsqueda. Recorté la lista.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'glob_cap' },
  { code: 'ttfb_watchdog', message: 'El proveedor no envió el primer token a tiempo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'ttfb_watchdog' },
  { code: 'ckpt_prune', message: 'Conservé solo los últimos puntos de restauración.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'ckpt_prune' },
  { code: 'sse_cursor', message: 'Reanudé el flujo SSE desde el último identificador.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sse_cursor' },
  { code: 'max_output_tokens', message: 'Limité los tokens de salida del modelo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'max_output_tokens' },
  { code: 'dup_tool_call', message: 'Omití una llamada de herramienta duplicada consecutiva.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'dup_tool_call' },
  { code: 'http_5xx', message: 'El proveedor falló (5xx). Reintenta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'http_5xx' },
  { code: 'http_4xx', message: 'El proveedor rechazó la solicitud (4xx).', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'http_4xx' },
  { code: 'http_timeout', message: 'El proveedor tardó demasiado. Reintenta.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'http_timeout' },
  { code: 'empty_tool_name', message: 'La herramienta no tiene nombre. No la ejecuté.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'empty_tool_name' },
  { code: 'nul_path', message: 'La ruta contiene un byte nulo. La rechacé.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'nul_path' },
  { code: 'pgvector_timeout', message: 'La búsqueda de memoria superó el tiempo límite.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'pgvector_timeout' },
  { code: 'computer_flag_off', message: 'Las herramientas de computadora están desactivadas.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'computer_flag_off' },
  { code: 'subagent_concurrency', message: 'Demasiados subagentes a la vez. Aplacé el resto.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'subagent_concurrency' },
  { code: 'empty_turn', message: 'Omití un turno del asistente sin texto ni herramientas.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'empty_turn' },
  { code: 'tool_result_truncated', message: 'Recorté el resultado de la herramienta y marqué el recorte.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_result_truncated' },
  { code: 'tool_id_resume_dup', message: 'Había identificadores de herramienta duplicados al reanudar. Los reparé.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_id_resume_dup' },
  { code: 'write_too_large', message: 'El archivo supera 2 MiB. No lo escribí.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'write_too_large' },
  { code: 'identical_prompt_inflight', message: 'Esa misma pregunta ya se está generando en esta sesión.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'identical_prompt_inflight' },
  { code: 'turn_wall', message: 'Este turno superó el tiempo máximo de 120 segundos.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'turn_wall' },
  { code: 'tool_name_whitespace', message: 'El nombre de la herramienta contiene espacios. No la ejecuté.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_name_whitespace' },
  { code: 'symlink_read', message: 'No leo a través de un enlace simbólico.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'symlink_read' },
  { code: 'plan_step_failed', message: 'Ese paso del plan falló dos veces. Lo marqué como fallido.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'plan_step_failed' },
  { code: 'empty_embedding', message: 'Omití un embedding vacío al guardar memoria.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'empty_embedding' },
  { code: 'credit_observation', message: 'No cobré un bucle de solo observación de herramientas.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'credit_observation' },
  { code: 'stderr_cap', message: 'Recorté stderr de la herramienta a 64 KiB.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'stderr_cap' },
  { code: 'enum_invalid', message: 'El valor no coincide con las opciones permitidas.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'enum_invalid' },
];

function classifyPublicStreamError(error) {
  const text0 = String((error && (error.message || error.code)) || '');
  for (const rule of ENGINE_CODE_RULES) {
    try {
      if (rule.matches(error, text0)) {
        return {
          code: rule.code,
          retryable: rule.code === 'tool_timeout' || rule.code === 'sandbox_killed' || rule.code === 'fence_expired' || rule.code === 'dlq_replay' || rule.code === 'pgvector_failed' || rule.code === 'retrieve_memory_failed' || rule.code === 'hash_sweep' || rule.code === 'sse_drain_timeout' || rule.code === 'sandbox_reap' || rule.code === 'net_reset' || rule.code === 'net_timeout' || rule.code === 'net_dns' || rule.code === 'generate_overloaded' || rule.code === 'sse_buffer_overflow',
          message: rule.message || undefined,
        };
      }
    } catch (_) { /* next */ }
  }
  const text = String(error?.message || error || '');
  const rule = RULES.find((candidate) => candidate.matches(error, text));
  return rule || {
    code: 'internal_error',
    retryable: false,
    message: 'La operación no pudo completarse.',
  };
}

function buildPublicStreamError(error, { req = null, surface = 'unknown', traceId = null } = {}) {
  const classification = classifyPublicStreamError(error);
  const requestId = getRequestId(req);
  const payload = {
    code: classification.code,
    message: classification.message,
    error: classification.message,
    retryable: classification.retryable,
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId: String(traceId) } : {}),
  };
  metrics.counter('siragpt_stream_failures_total', {
    surface: String(surface || 'unknown'),
    code: classification.code,
  });
  return payload;
}

function sanitizePublicStoppedReason(reason) {
  const value = String(reason || '').toLowerCase();
  if (/abort|cancel/.test(value)) return 'cancelled';
  if (/timeout|timed.?out|runtime_budget/.test(value)) return 'timeout';
  if (/max_(?:steps|iterations)|limit|budget_exhausted|budget_exceeded|loop_cut/.test(value)) return 'limit_reached';
  if (/tool_unavailable/.test(value)) return 'tool_unavailable';
  if (/error|failed|failure|provider|control_plane/.test(value)) return 'failed';
  return 'completed';
}

function sanitizePublicStreamEvent(value, context = {}, depth = 0) {
  if (depth > 6 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicStreamEvent(item, context, depth + 1));
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'stoppedReason') {
      output[key] = sanitizePublicStoppedReason(entry);
      continue;
    }
    if ((key === 'error' || key === 'lastError') && entry) {
      const source = entry instanceof Error
        ? entry
        : new Error(typeof entry === 'string' ? entry : String(entry?.message || entry?.error || 'stream failure'));
      const publicError = buildPublicStreamError(source, context);
      output[key] = typeof entry === 'object' ? publicError : publicError.message;
      if (typeof entry !== 'object') output[`${key}Code`] = publicError.code;
      continue;
    }
    output[key] = sanitizePublicStreamEvent(entry, context, depth + 1);
  }
  return output;
}

module.exports = {
  buildPublicStreamError,
  classifyPublicStreamError,
  sanitizePublicStoppedReason,
  sanitizePublicStreamEvent,
};
