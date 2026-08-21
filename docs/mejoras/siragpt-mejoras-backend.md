# Catálogo de mejoras backend — SiraGPT (árbol vivo)

Fuente: inspección SSH de `/opt/siragpt/backend` en el VPS vivo (root@62.72.11.231), 15 ago 2026 (hora Lima).
2037 módulos en `backend/src`, 115 rutas, AgentRunner F0–F5, gateway F11, R2 en `orchestration/r2-storage.js`, sandbox gVisor en `doc-agent/sandbox.js`.

**Reglas**
- Generate = `native-llm.js` → DeepSeek V4 Flash/Pro. OpenRouter se rechaza (`model_forbidden` / `clientLooksLikeOpenRouter`).
- F5 está COMPLETED pendiente de merge/gVisor en el daemon; no proponer `compose down`.
- F6+ está stubbeado en `agent-runner/browser`, `multimodal`, `mcp`, `memory` — se lista como oleada, no se adelanta el gate.
- `.bak` y `.env.bak-*` del VPS son ítems reales de higiene/seguridad (secretos históricos en disco).

Estructura = AgentRunner/chat/doc, Word/PPT/R2, /code/codex, Gateway/skills/MCP, auth/orgs/billing, gVisor, observabilidad, candado DeepSeek, F6–F12, higiene, tests.


## AgentRunner /chat /doc — loop, tools, traces F0–F4, candado DeepSeek

1. Partir backend/src/routes/ai.js (11380 líneas, 112 console.log, 49 menciones OpenRouter) en generate, stop-stream, models y media; el generate debe importar solo native-llm.
2. Eliminar o gatear las 49 menciones a OpenRouter en backend/src/routes/ai.js: el path de generación es api.deepseek.com (NOTICE-F11 / native-llm.js).
3. Reducir los 112 console.log de backend/src/routes/ai.js a eventos estructurados (ya hay telemetry.js / metrics.js) sin prompts ni OOXML.
4. Cerrar los 5 TODO/FIXME reales de backend/src/routes/ai.js que no sean el scanner de TODOs del usuario.
5. En backend/src/services/agentic-chat-stream.js (2385 líneas) forzar resolveAgentLlmClient() igual que agent-runner/index.js; hoy aún menciona OpenRouter 6 veces.
6. En agentic-chat-stream.js mapear budget_exceeded y plan_failed de F4 a copy en español (AGENT_RUNNER_FAILURE_COPY) y nunca a advanced-document-pipeline.
7. En agentic-chat-stream.js no caer al loop LLM genérico cuando shouldRunAgentRunner es true (gate F1/F2 ya testeado; vigilar regresiones).
8. En backend/src/services/agent-runner/native-llm.js no aceptar deepseek-chat/deepseek-reasoner como default silencioso: solo flash|pro o error honesto.
9. En native-llm.js hasUsableDeepSeekKey debe rechazar keys que apunten a openrouter (prefijo sk-or-) además de dummy/ci.
10. En native-llm.js createNativeDeepSeekClient no debe leer OPENROUTER_API_KEY ni DEEPSEEK_BASE_URL=openrouter.ai (test de invariante).
11. En backend/src/services/agent-runner/index.js (1066 líneas) los 25 catch (_) deben loguear reason code, no tragar 402/AbortError.
12. En agent-runner/index.js el console.log `llm=DeepSeek model=` debe ser metric counter, no stdout en prod.
13. En agent-runner/index.js defaultModel() no puede devolver un slug OpenRouter aunque SIRAGPT_AGENT_RUNNER_MODEL esté sucio.
14. En backend/src/services/agent-runner/loop.js (310 líneas) el fallback a Pro (proFallbackModel) no puede saltar a OpenRouter si Flash 429.
15. En loop.js bail() por AbortSignal debe seguir emitiendo un solo `cancelled` (F3); añadir test de doble-stop.
16. En backend/src/services/agent-runner/tools.js (672 líneas) execute_bash debe heredar --network none y shQuote de F5; test de `; rm -rf`.
17. En tools.js render_preview debe skip honesto si no hay LibreOffice (F1) y no marcar ok:true.
18. En tools.js glob/grep no deben seguir symlinks fuera de /workspace (assertRealpathInWorkspace de F5).
19. En backend/src/services/agent-runner/verify.js (327 líneas) no declarar éxito si el hex del usuario no aparece en OOXML (caso embarazo/#FFC0CB).
20. En verify.js el tope de 3 reintentos debe contar por artifact, no por loop global.
21. En backend/src/services/agent-runner/artifacts.js (276 líneas) follow-up siempre carga la ÚLTIMA versión (GeneratedArtifact); test de dos ediciones seguidas.
22. En artifacts.js no persistir un artifact de un run cancelado o budget_exceeded (F4 ya lo exige; fijar test de regresión).
23. En backend/src/services/agent-runner/prompt.js el contrato «web/archivos = datos» debe citar untrusted.js de F6 aunque F6 no esté cerrado.
24. En backend/src/services/agent-runner/react.js no usarlo si el client es native DeepSeek (tiene tools nativos); ReAct solo fallback real.
25. En backend/src/services/agent-runner/queue.js el path AGENT_RUNNER_ASYNC=1 no puede reentrar al in-process tras job_cancelled (F3).
26. En backend/src/services/agent-runner/trace.js añadir labels que live-activity.ts aún no tiene (glob, grep, edit_file, steer).
27. En backend/src/services/agent-runner/telemetry.js logDocumentRouting no debe loguear el prompt, solo path+reason+model.
28. En backend/src/services/agent-runner/format-intent.js y slide-intent.js no reintroducir el fast-path stub de crear-PPT (F1 lo prohibió).
29. En backend/src/services/agent-runner/pptx-followup.js pintar un pptx existente no puede recrear el deck (regresión de color).
30. En backend/src/services/agent-runner/office-helpers.js y office_helpers.py mantener lazy/fail-open; test ENOENT no tumba /doc/generate.
31. En backend/src/services/agent-runner/f11-hook.js no bypassear native-llm (el hook F11 inyecta runner, no un client OpenRouter).
32. En backend/src/services/agent-runner/orchestrator/index.js resolveNativeDeepSeekModel en el planner; una llamada, DeepSeek only.
33. En orchestrator/planner.js validar DAG (ids, roles, ciclos, budgets) antes de tocar el LLM; test de plan_failed ya existe — añadir nodo huérfano.
34. En orchestrator/roles.js researcher sin web_search hasta F6 (ya documentado); fallar si alguien inyecta web_tools.
35. En orchestrator/budget.js cortar en el boundary del client LLM (usage.total_tokens); test de estimación chars/4 vs usage real.
36. En orchestrator/blackboard.js no persistir fuera del run (sin Prisma); no leakar blackboard entre sessionKey.
37. En orchestrator steer() no reinicia nodos completados (F4); test de doble steer.
38. En backend/src/services/agent-runner/browser/web-tools.js (F6 stub) no registrarlo en tools.js hasta el gate F6 y untrusted wrapping.
39. En browser/untrusted.js aplicar el wrapper a todo web_fetch desde el día 1 de F6.
40. En browser/browser-act.js no usar Playwright contra prod siragpt.com desde el runner de un tenant.
41. En backend/src/services/agent-runner/mcp/index.js (F8 stub) no ejecutar tools MCP sin permission-manager del harness.
42. En backend/src/services/agent-runner/memory/index.js y search.js: no vender recall cross-sesión hasta GraphRAG F8; test de no-persist.
43. En backend/src/services/agent-runner/skills/index.js y manage.js: skills builtin se cargan on-demand, no todas en cada turno.
44. En backend/src/services/agent-runner/skills/builtin/* cada skill debe declarar allow/deny de red (F5 network none).
45. En backend/src/services/agent-runner/multimodal/vision.js (F7) no mandar screenshots a OpenRouter vision.
46. En multimodal/voice.js no transcribir con un vendor que re-genere el texto (candado).
47. En multimodal/computer.js no arrancar VM si resolveSandboxRuntime lanza SandboxRuntimeError.
48. En multimodal/flags.js default off en prod hasta F7.
49. En backend/src/services/agent-runner/evals/ el harness F9 debe grabar model=flash|pro y fallar si el trace tiene openrouter.
50. Borrar los directorios backend/src/services/agent-runner/.bak-* (coloradd, countfix, livefail, prod×2) del árbol vivo — 30+ copias de index.js.
51. Borrar los *.bak-deeplock/pptfix/wordppt/finish/slide7/eq6/f11 de agent-runner/*.js (lista en higiene).

## Documentos Word/PPT, pipeline, R2, verify

52. En backend/src/routes/doc.js (589 líneas) runner-first: si shouldRunAgentRunner y no hay archivo, error honesto, nunca advanced-document-pipeline (F1/F2).
53. Borrar backend/src/routes/doc.js.bak-wordfix-20260814T190611Z.
54. En backend/src/routes/generate-document.js alinear con runAgentRunnerForDocRoute (mismos stages F3).
55. En backend/src/services/document-pipeline/advanced-document-pipeline.js (3791 líneas) no invocarlo desde chat/doc/agent-task cuando el runner reclamó el turno.
56. En document-pipeline/pptx-design-system.js el hex del usuario sigue ganando al tema boardroom (parche F0); test de #FFC0CB.
57. En backend/src/services/source-preserving-document-edit.js (8612 líneas) partir por mime (docx/xlsx/pptx/pdf) y no usarlo para crear-doc (solo edición quirúrgica F2).
58. En backend/src/services/document-professional-analyzer.js (8278 líneas) no bloquear el worker de Express; cola BullMQ.
59. En backend/src/services/document-editing/user-intent-parser.js no reintroducir clasificador que salte el runner (F2 lo retiró).
60. En backend/src/services/agents/document-delivery-policy.js no entregar un stub rosado (F1).
61. En backend/src/services/agents/pptx-package-validator.js validar slide count vs slide-intent (regresión eq6).
62. En backend/src/services/vector-ppt-service.js no es el path de generate; no llamarlo desde /api/ai/generate.
63. En backend/src/services/docx-table-insert.js no corromper relaciones OOXML; test de tabla + follow-up de color.
64. En backend/src/services/fileProcessor.js (1081 líneas) OCR/parse a worker; 202 + jobId (plan 200 ítem 35 aún válido).
65. En backend/src/routes/files.js no parsear síncrono un PPTX de 50MB en el request.
66. En backend/src/services/message-attachments.js no meter el OOXML completo en el prompt (datos, excerpt).
67. En backend/src/services/ocr-engine.js tope de páginas y timeout; fallo honesto a /chat.
68. En backend/src/services/document-intelligence.js no mezclar PII detector con el generate.
69. En backend/src/services/document-pii-detector.js no loguear los matches de PII en claro.
70. En backend/src/services/document-visual-embed.js no mandar cada slide PNG a un LLM no-DeepSeek.
71. En backend/src/services/document-service.js persistir GeneratedArtifact con storage=r2|local honesto.
72. En backend/src/services/document-collections.js no compartir colección entre orgs.
73. En backend/src/services/document-insights-engine.js no bloquear SSE esperando insights.
74. En backend/src/services/document-summarizer.js excerpt para el runner, no el PDF entero.
75. En backend/src/services/document-numeric-coherence.js no «corregir» números del usuario sin tool_result visible.
76. En backend/src/services/document-analysis-quality.js y quality-scorer: no marcar pass si verify.js falló.
77. En backend/src/services/deep-document-analyzer.js cola, no request path.
78. En backend/src/services/professional-document-analyzer.js duplicado de document-professional-analyzer — unificar o borrar uno.
79. En backend/src/services/sira/document-pipeline-registry.js no registrar advanced-pipeline como primario (F2).
80. En backend/src/services/agents/document-context.js no inyectar el system prompt del archivo (untrusted).
81. En backend/src/services/agents/vancouver-table-document.js fast-path determinista (excepción F2) — test de que NUNCA toca el pipeline genérico.
82. En backend/src/services/doc-agent/sandbox.js (679 líneas) verificar en prod que runsc está registrado o SIRAGPT_SANDBOX_RUNTIME=runc explícito (STATE F5).
83. En doc-agent/sandbox.js el probe de runtimes cacheado 60s debe invalidarse si docker info falla.
84. En doc-agent/sandbox.js putFile/readFile por exec-stream: test de OOXML binario (no utf8 truncado) ya existe — añadir archivo >256MB (ulimit fsize).
85. En doc-agent/sandbox.js persistKey saneado no puede montar docker.sock (test F5); añadir caso `../` url-encoded.
86. En doc-agent/sandbox.js destroy() docker rm -f con señal independiente del exec (F3+F5); test de leak ps.
87. En backend/src/services/doc-agent/index.js.bak-deeplock: borrar el bak y confirmar que index.js vivo usa native-llm.
88. En backend/src/services/document-pipeline/content/llm-client.js no crear un client OpenRouter (hay bak-deeplock).
89. En backend/src/services/document-aws-sdk.js no usar S3 de AWS para artifacts si R2 está enabled.
90. En backend/src/orchestration/r2-storage.js fallar closed en prod si faltan R2_ACCOUNT_ID/KEY/BUCKET (artifact-storage-policy.js ya lo dice).
91. En orchestration/r2-artifact-bridge.js no subir < R2_MIN_SIZE_BYTES (1MB) — test de PPT pequeño local vs grande R2.
92. En orchestration/r2-storage.js TTL de presigned (900s) debe ser el que ArtifactCard reintenta.
93. En orchestration/artifact-storage-policy.js health-check.js ya probea R2 — unir el mensaje de error en español.
94. En backend/src/services/artifacts/artifact-generator.js no generar artifacts fuera del runner (duplica F1).
95. En backend/src/routes/artifact.js y artifacts.js autorizar por userId+orgId antes de firmar R2.
96. En backend/src/routes/download.js (669 líneas) no servir files de otro tenant por ID enumerable.

## Codex /code, departamentos, host-runner, git

97. En backend/src/routes/codex.js (2609 líneas) el loop de runs debe usar DeepSeek nativo (mismo native-llm) y rechazar OpenRouter.
98. Borrar backend/src/routes/codex.js.bak-dept-computer-20260814-213120.
99. En backend/src/services/codex/agent-loop.js (3799 líneas) partir planner/tools/verify y no reimplementar AgentRunner.
100. En backend/src/services/codex/swarm-orchestrator.js (1787 líneas) respetar presupuestos F4 (max nodes/tokens) y el candado Flash/Pro.
101. En backend/src/services/codex/company-autopilot-planner.js no activar flota PROACTIVO sin flag y budget.
102. En backend/src/services/codex/fleet-quality-reviewer.js no «arreglar» con un modelo no-DeepSeek.
103. En backend/src/services/codex/proactive-engine.js cortar con budget_exceeded y emitir stage F4.
104. En backend/src/services/codex/mission-evidence-ledger.js no persistir secretos de .env del repo del usuario.
105. En backend/src/services/codex/business-channels.js no publicar a redes sin HITL (P14).
106. En backend/src/services/codex/run-processor.js y swarm-runner.js: cancel F3 mata toda la familia (cancel-run-family FE).
107. En backend/src/services/codex/build-tools.js no ejecutar build con network del host (F5 none).
108. En backend/src/services/codex/company-mission-orchestrator.js delegar en agent-runner/orchestrator, no un DAG paralelo.
109. En backend/src/services/codex/company-operations/external-actions.js deny-by-default (email/slack/github write).
110. En backend/src/services/codex/progress-ledger.js emitir stages compatibles con trace.js.
111. En backend/src/services/codex/checkpoint-service.js no restaurar checkpoint cross-user.
112. En backend/src/services/codex/run-service.js 402 DeepSeek → no reencolar.
113. En backend/src/services/codex/company-operating-profile.js no sobreescribir el model a OpenRouter.
114. En backend/src/services/codex/session-service.js sessionKey serial lane (gateway F11).
115. En backend/src/services/codex/git-workflow.js no force-push ni push a main desde el runner.
116. En backend/src/services/codex/company-association-service.js scope por org (lib/company-association-scope.ts).
117. En backend/src/services/codex/company-departments.js (hay bak-dept-computer) no recrear el PC; exponer computerId estable.
118. En backend/src/services/codex/background-tasks.js AbortSignal por task.
119. En backend/src/services/codex/verify-loop.js no declarar éxito sin tests/quality-gate.
120. En backend/src/services/codex/starter-files.ts/js no meter API keys.
121. En backend/src/services/codex/project-budget.js alinear env con SIRAGPT_ORCHESTRATOR_MAX_*.
122. En backend/src/services/codex/agent-sdk/index.js no wrappear OpenRouter.
123. En backend/src/services/codex/fleet-orchestrator.js tope de depts concurrentes.
124. En backend/src/services/codex/self-hosting.js no exponer docker.sock al tenant.
125. En backend/src/services/codex/runtime-canary.js no canary-ear un modelo no-DeepSeek.
126. En backend/src/services/code/host-runner.js (931 líneas) mismos límites F5 (cpus/mem/pids/network none).
127. En backend/src/services/code/preview-proxy.js strip cookies y no proxyar a metadata cloud.
128. En backend/src/services/code/verify-agent.js correr en sandbox, no en el host del API.
129. En backend/src/routes/code-runner.js authz projectId y rate-limit por org.
130. En backend/src/services/github/workspace-runner.service.js no clonar repos privados en un volumen compartido.
131. En backend/src/services/github-codex-connector.js (1479 líneas) filtrar .gitignore (phase-9b) y no indexar secrets.
132. En backend/src/routes/github.js y github-codex.js: OAuth token nunca al prompt.
133. En backend/src/services/opencode/* no bypassear native-llm.
134. En backend/src/routes/se-agents.js (1735 líneas) no es el path de /code vivo; no enrutar generate ahí.
135. En backend/src/services/software-engineering/* alinear con AgentRunner o deprecar.
136. En backend/src/routes/deployments.js y hosting/deploy.service.js: no deploy automático sin quality-gate.
137. En backend/src/services/builder/codegen.js generate con DeepSeek, no LiteLLM/OpenRouter.
138. En backend/src/services/builder/live-app.js sandbox igual que preview-pane.
139. En backend/src/services/builder/brief-from-prompt.js no clasificar a un pipeline de docs (F2).

## Gateway F11 / skills / MCP / memoria

140. En backend/src/services/agent-gateway/index.js resolveModel ya tira OpenRouter; añadir test HTTP de model_forbidden.
141. En agent-gateway/index.js SURFACES solo chat|code; rechazar telegram/whatsapp (NOTICE-F11).
142. En agent-gateway/http.js no bufferar SSE (X-Accel-Buffering: no) y heartbeat (F3).
143. En agent-gateway/protocol.js validar first-frame connect y seq; test de frame malicioso.
144. En agent-gateway/queue.js serial lane por sessionKey; test de dos chat.turn concurrentes.
145. En backend/src/routes/gateway.js (254 líneas) authn + org + DeepSeek model; 6 menciones DeepSeek / 1 OpenRouter — la de OpenRouter debe ser solo el reject.
146. En backend/src/orchestration/gateway-adapter.js no adaptar a un mesh de nodos (NOTICE: HTTP+SSE only).
147. En backend/src/services/agent-harness/mcp-client.js (1040 líneas) OAuth por usuario (F8/F16), tokens fuera del prompt.
148. En agent-harness/mcp-policy.js deny-by-default de tools con egress.
149. En agent-harness/permission-manager.js HITL para write/send.
150. En agent-harness/event-stream.js shape `stage` F3.
151. En agent-harness/tools/cowork-tools.js no compartir workspace entre users.
152. En agent-harness/tools/document-edit-tool.js reenviar a source-preserving, no al pipeline genérico.
153. En backend/src/services/connectors/mcp-tool-registry.js no registrar tools de generate.
154. En backend/src/services/google-mcp.js tokens en credentials service, no en logs.
155. En backend/src/services/skills-registry.js y ai-product-os/skill-system.js: no duplicar agent-runner/skills.
156. En backend/src/skills/registry.ts y skills/*/handler.js: cada handler timeout + no-network default.
157. En backend/src/skills/web_search/ no habilitar hasta F6.
158. En backend/src/skills/read_url/handler.js (525 líneas) untrusted wrap.
159. En backend/src/skills/read_file/ path confinement F5.
160. En backend/src/skills/session_* no spawn sesiones sin authz.
161. En backend/src/skills/webhook_create/ HITL.
162. En backend/src/skills/cron_* alinear con gateway cron (aprendizaje) y no con system-cron.js de infra.
163. En backend/src/services/long-term-memory.js y active-memory.js: no inyectar memoria de otro userId.
164. En backend/src/services/user-memory-vector.ts no llamar a un embedder OpenRouter como generate.
165. En backend/src/orchestration/memory-adapter.js fail-open honesto si pgvector no está (F8 no cerrado).
166. En backend/src/routes/memory.js authz + no devolver embeddings crudos a un user no-owner.
167. En backend/src/services/agent-cron/* y hermes-cron-scanner.js: no ejecutar un cron que llame OpenRouter.
168. En backend/src/jobs/system-cron.js (1117 líneas) no mezclar cron de producto (gateway) con cron de ops.

## Auth, billing, orgs, invitaciones, créditos

169. Implementar refresh-token rotation en backend/src/routes/auth.js (TODO líneas 160 y 949): hoy se re-firma un JWT sin rotar.
170. En auth.js (2292 líneas, 22 process.env) partir login/oauth/reset/mfa y no console.log de bodies.
171. En backend/src/services/auth/session-token-persistence.js no persistir refresh en localStorage-compatible cookies sin Secure/HttpOnly/SameSite.
172. En backend/src/services/auth/oauth-state-store.js TTL corto y single-use.
173. En backend/src/services/auth/impersonation-rate-limiter.js audit log obligatorio (actor, motivo, target).
174. En backend/src/middleware/auth.js (618 líneas) no aceptar un JWT con model claim OpenRouter como bypass.
175. En backend/src/services/webauthn/* ceremony timeout y origin allowlist siragpt.com.
176. En backend/src/routes/webauthn.js no loguear attestation cruda.
177. En backend/src/services/SsoCallbackService.js (514 líneas) no crear user en la org equivocada (tenant hint).
178. En backend/src/services/saml-request-store.js TTL + one-time.
179. En backend/src/routes/orgs.js (5491 líneas) partir invites/members/rbac/billing y no hacer N+1 de members.
180. En orgs.js invites: token unuseable tras accept; rate-limit por email.
181. En orgs.js no listar members de otra org por ID enumerable.
182. En backend/src/routes/rbac.js y rbac-bootstrap.js / rbac-assignment-sync.js: no auto-admin al primer user de prod.
183. En backend/src/routes/users.js (2387 líneas) no devolver phone/tokens en listados admin sin proyección.
184. En backend/src/routes/payments.js (2974 líneas, 12 console.log) no loguear Stripe payloads con PII; idempotency-key en todos los charges.
185. En backend/src/services/stripe.js y stripe-webhook-recovery.js: no re-entregar un credit dos veces (credit-ledger.js).
186. En backend/src/services/credit-ledger.js (1589 líneas) transacción por generate; un 402 DeepSeek no debe descontar dos veces.
187. En backend/src/middleware/charge-credits.js (642 líneas) no cobrar si el runner ni siquiera llamó al LLM (cancel inmediato).
188. En backend/src/routes/credits.js no permitir topup negativo ni cross-org.
189. En backend/src/routes/plans.js y plan.js: copy Flash/Pro, no «todos los modelos».
190. En backend/src/routes/enterprise.js (1360 líneas) SSO/SCIM es F11 — no exponer endpoints a medias sin flag.
191. En backend/src/routes/legal.js no servir PII en exports sin authz.
192. En backend/src/services/email.js (1213 líneas) no mandar el token de reset en query a un referrer tercero.
193. En backend/src/services/subscription-analytics.js no mezclar costo OpenRouter viejo con DeepSeek sin etiqueta.

## Sandbox gVisor F5

194. Verificar en el VPS que docker info lista runsc o que SIRAGPT_SANDBOX_RUNTIME=runc está explícito (STATE F5, fail-closed).
195. En backend/src/services/sandbox/local-sandbox.js no presentarse como gVisor (runtime:'none').
196. En backend/src/services/sandbox/e2b-sandbox.js no usarlo en prod si F5 eligió gVisor (o documentar deprecación).
197. En backend/src/services/sandbox/remote-driver.js no docker.sock.
198. En backend/src/services/sandbox/router.js no downgrade silencioso a local en NODE_ENV=production.
199. En backend/src/services/sandbox/session-manager.js un contenedor por tarea, nunca compartido (F5).
200. En backend/src/services/agents/code-sandbox.js alinear límites con doc-agent/sandbox.js (una sola fuente de sandboxLimitsFromEnv).
201. En backend/src/services/agents/host-bash-tool.js shQuote + realpath (F5).
202. En backend/src/routes/sandbox.js no exponer exec a un user sin project role.
203. En backend/src/services/code/host-runner.js --cap-drop ALL y no-new-privileges (copiar args F5).
204. No reintroducir docker cp en ningún driver (FAQ gVisor; F5 lo eliminó).
205. Allowlist de egress solo en F6; hoy --network none SIEMPRE — test de que no hay opt-in escondido en env.
206. En backend/src/utils/startup-validator.js fallar boot de prod si REQUIRE_GVISOR=1 y no hay runsc.
207. En health-check.js probe de runsc + R2 + DEEPSEEK_API_KEY (sin imprimir la key).

## Observabilidad, colas, health, métricas

208. En backend/src/services/observability/health-check.js (1052 líneas) partir probes (db/redis/r2/gvisor/deepseek) y no bloquear /ready >2s.
209. En backend/src/health/probe.js y health/probes/* unificar con health-check.js (hoy hay dos árboles).
210. En backend/src/routes/health-routes.js no filtrar env en el JSON de /ready.
211. En backend/src/routes/metrics.js histograma de generate por model=flash|pro y path=agent_runner|failed.
212. En backend/src/utils/metrics.js (685 líneas) no cardinality por conversationId.
213. En backend/src/utils/fetch-instrument.js redactar Authorization.
214. En backend/src/services/ai/cost-tracker.js (911 líneas) precio DeepSeek nativo, no tarifa OpenRouter.
215. En backend/src/services/feature-cost-estimator.js igual.
216. En backend/src/routes/telemetry.js no aceptar beacons con prompt text.
217. En backend/src/services/admin-stats-aggregator.js (878 líneas) cachear y no full-scan Prisma en cada /admin.
218. En backend/src/jobs/system-cron.js no hacer full table scans a medianoche sin statement_timeout.
219. En backend/src/db/pool-autoscaler.js (498 líneas) exponer utilización en /metrics (plan 200 ítem 33).
220. En backend/src/config/database.js query logger >1s WARN sin params PII.
221. En backend/src/middleware/rate-limit-store.js (679 líneas) no rate-limitar stop-stream igual que generate.
222. En backend/src/middleware/idempotency.js (559 líneas) cubrir payments y generate (clientMessageId).
223. En backend/src/utils/async-guard.js (916 líneas) no tragar AbortError como 500.
224. En backend/src/services/queues/queue-registry.js no registrar una cola de generate que use OpenRouter worker.
225. En backend/src/routes/admin-queues.js authz admin + no retry de jobs 402.
226. En backend/src/services/realtime/socket-server.js NOTICE-F11 es HTTP+SSE: no abrir un socket que bypassee el gateway.
227. En backend/src/chaos/* no encender en prod sin flag.

## Candado DeepSeek — fugas OpenRouter en generate

228. En backend/src/services/ai-service.js (1553 líneas, hay bak-deeplock y bak-deepseek) el client de generate es native-llm, no OpenRouter.
229. Borrar backend/src/services/ai-service.js.bak-deeplock-20260814T193448Z y bak-deepseek-20260814T182533Z.
230. En backend/src/services/ai/provider-inference.js (bak-deeplock) no inferir OpenRouter como provider de chat.
231. En backend/src/services/visible-model-catalog.js (3 baks deeplock/admin-toggles) el catálogo servido a /admin/models y /chat es Flash/Pro.
232. En backend/src/services/model-sync-service.js (1322 líneas) no re-sincronizar un catálogo OpenRouter encima del candado.
233. En backend/src/services/model-catalog-manifest.js no listar slugs openrouter/* como generables.
234. En backend/src/services/ai-product-os/litellm-gateway.js (889 líneas) no usarlo para /api/ai/generate (LiteLLM ≠ DeepSeek nativo).
235. En backend/src/services/ai-product-os/integration-stack.js no registrar OpenRouter como completion provider.
236. En backend/src/services/providers/* cualquier provider de completion debe deny OpenRouter en generate.
237. En backend/src/services/agents/provider-registry.js igual.
238. En backend/src/routes/ai-failover-health.js failover solo Flash→Pro nativo (proFallbackModel), nunca a OpenRouter.
239. En backend/src/services/react-agent.js (1727 líneas) no es el path F1; no enrutar generate ahí.
240. En backend/src/services/agents/agent-core.js / agent-entry.js / agentic-operating-core.js: deprecar o reenviar a AgentRunner.
241. En backend/src/services/agents/semantic-intent-router.js no saltar el runner en docs (F2).
242. En backend/src/services/sira/chat-controller.js (1046 líneas) runner-first.
243. En backend/src/services/sira/cortex-orchestrator.js no competir con F4 orchestrator.
244. En backend/src/services/reasoning-orchestrator.js igual.
245. En backend/src/services/master-prompt.js no pedir al modelo que «use OpenRouter».
246. En backend/src/services/agents/prompting-strategies.js igual.
247. Un test de invariante CI: grep -L native-llm en las 4 entradas (chat, /doc/generate, ai.js gate, /agent/task) + gateway.

## Rutas y servicios vivos restantes

248. En backend/src/routes/chats.js (1832 líneas) cursor pagination (plan 200 ítem 32) y proyección sin tokens.
249. En backend/src/routes/agent-task.js (3407 líneas) preloop runner-first (F2) on en prod, no solo NODE_ENV=test.
250. En backend/src/services/agents/agent-task-runner.js (3863 líneas) create_document prohibido si el runner reclamó.
251. En backend/src/routes/agent.js / agent-runs.js / agent-batch.js / agent-keys.js / agent-harness.js: no generate OpenRouter.
252. En backend/src/routes/computer-use.js (2923 líneas) flag F7 + sandbox F5; no VNC al host.
253. En backend/src/routes/thesis.js (2300 líneas) AgentRunner + DeepSeek, no un pipeline paralelo oscuro.
254. En backend/src/routes/video.js (1498 líneas) FAL es media; el prompt de storyboard sí va a DeepSeek.
255. En backend/src/routes/images.js igual.
256. En backend/src/routes/elevenlabs.js no re-escribir el texto con otro LLM.
257. En backend/src/routes/search.js / search-brain*.js / scientific-search.js: F6 untrusted; no generate OpenRouter.
258. En backend/src/services/searchBrain/* no usar un completion OpenRouter para rerank (o marcar rerank ≠ generate).
259. En backend/src/services/rag-service.js (1206 líneas) y rag/*: retrieval no es generate; el answer sí es DeepSeek.
260. En backend/src/routes/rag.js authz collection.
261. En backend/src/routes/research*.js untrusted + DeepSeek.
262. En backend/src/routes/gmail.js / spotify.js / telegram.js: NOTICE-F11 no Telegram como superficie de generate.
263. En backend/src/routes/social-posts.js HITL antes de publicar.
264. En backend/src/routes/paraphrase.js DeepSeek nativo.
265. En backend/src/routes/marco-teorico.js no inventar citas (crossref skill existe).
266. En backend/src/routes/gpts.js actions no pueden target openrouter.ai.
267. En backend/src/routes/cowork.js / cowork-platform.js / cowork-ai-control.js: session isolation.
268. En backend/src/services/cowork/workspace-store.js y control-plane.js: un workspace ≠ un sandbox compartido.
269. En backend/src/routes/appshots.js no geolocalizar sin consent.
270. En backend/src/routes/public.js no filtrar user emails.
271. En backend/src/routes/webhooks.js firma + idempotency.
272. En backend/src/services/webhook-dispatcher.js no reenviar el prompt.
273. En backend/src/routes/push.js VAPID y no payload con prompt.
274. En backend/src/routes/admin.js (3118 líneas) partir users/stats/impersonate.
275. En backend/src/routes/admin/settings.js no aceptar OPENROUTER_API_KEY como completion.
276. En backend/src/routes/admin/security.js checklist de refresh-token + gVisor + R2.
277. En backend/src/routes/admin/reports.js no CSV con prompts.
278. En backend/src/routes/admin-connections.js last4 only.
279. En backend/src/routes/admin-user-context.js no impersonate sin audit.
280. En backend/src/routes/db-internal.js no montar en prod o mTLS only.
281. En backend/src/routes/scheduler-internal.js igual.
282. En backend/src/routes/document-index-internal.js igual.
283. En backend/src/routes/dev-sentry.js off en prod.
284. En backend/src/routes/free-ia.js no es generate autenticado — no OpenRouter, no secrets.
285. En backend/src/routes/version.js no filtrar SHA internos a anónimos si se usa para fingerprint de ataque.
286. En backend/src/graphql/* si no está en el camino vivo, no exponerlo en nginx.
287. En backend/src/services/fal-video-model-catalog.js no listarlo como LLM.
288. En backend/src/services/media/image-engine.js vendor media ≠ generate.
289. En backend/src/services/agents/visual-media-tools.js (8536 líneas) partir y no llamar completion OpenRouter.
290. En backend/src/services/agents/task-tools.js (2149 líneas) y tool-manifest.js (2112): no registrar web_search hasta F6.
291. En backend/src/services/agents/agent-tools.js (1560 líneas) deprecar duplicados de agent-runner/tools.js.
292. En backend/src/services/agents/universal-task-contract.js no saltar F2.
293. En backend/src/services/agents/enterprise-agentic-runtime.js no es F1 — no enrutar /chat ahí.
294. En backend/src/services/agents/task-store.js no leak cross-org.
295. En backend/src/services/agents/cira-cognitive-task-envelope.js no sustituir task-envelope-builder de sira.
296. En backend/src/services/sira/task-envelope-builder.js (1605) y contextual-understanding.js (1698): runner-first.
297. En backend/src/services/sira/hybrid-retrieval.js untrusted.
298. En backend/src/services/sira/validator-engine.js no «arreglar» un PPT fallido con el pipeline genérico.
299. En backend/src/services/sira/tool-registry.js no duplicar tools.js.
300. En backend/src/services/sira/mythos-preview-eval-suite.js útil para F9 — no llamarlo en request path.
301. En backend/src/services/plan-generator.js DeepSeek + no stub.
302. En backend/src/services/scientific-search.js F6 untrusted.
303. En backend/src/services/github-search.js no indexar secrets.
304. En backend/src/services/gmail.js tokens en credentials store.
305. En backend/src/services/paraphrase-humanizer.js DeepSeek.
306. En backend/src/services/context-attribution-graph.js no en el hot path de SSE.
307. En backend/src/services/context-intelligence-engine.js igual.
308. En backend/src/routes/context-intelligence.js authz.
309. En backend/src/routes/circuit-attribution.js no PII en traces públicos.
310. En backend/src/routes/attribution-*.js igual.
311. En backend/src/services/intent-attribution-graph/* no reintroducir clasificador F2.
312. En backend/src/services/hitl/* cola de confirmación (P14) para external-actions.
313. En backend/src/services/safety/* prompt-injection: archivos/web = datos (ya en prompt.js; test).
314. En backend/src/services/security/* secret rotation (docs/secret-rotation.md) de DEEPSEEK_API_KEY y R2.
315. En backend/src/services/flags/* flag F6/F7/F8 default off.
316. En backend/src/services/scheduler/* no cron generate OpenRouter.
317. En backend/src/workers/* same native-llm que el request path.
318. En backend/src/services/contracts/schema-registry.js validar SSE stage.
319. En backend/src/services/openapi/ no drift vs routes (plan 200 ítem 63).
320. En backend/prisma/schema.prisma GeneratedArtifact.storage = r2|local; no asumir disco.
321. En backend/prisma/seed.js no seedear OPENROUTER_API_KEY ni users con role admin en prod.
322. En backend/src/i18n/* errores del runner en español (ya hay copy); no mezclar EN en 402.
323. En backend/src/rate-limit/* separar generate/stop/files.
324. En backend/src/concurrency/* no dos runner loops por conversationId.
325. En backend/src/cache/* no cachear completions (el candado y el costo se distorsionan).
326. En backend/src/router/* no router aprendido F10 que elija OpenRouter.
327. En backend/src/orchestration/multi-agent/* deprecar vs F4 orchestrator o reenviar.
328. En backend/src/orchestration/parser-adapters/* untrusted.
329. En backend/src/orchestration/multichannel/* NOTICE: no Telegram generate.
330. En backend/src/channels/* igual.
331. En backend/src/services/telegram/* no superficie de generate (NOTICE-F11).
332. En backend/src/services/business-channels/* HITL.
333. En backend/src/services/social-company/* HITL + no LLM OpenRouter.
334. En backend/src/services/accounting/* no generate sin asiento HITL.
335. En backend/src/services/bi/* no prompts en dashboards.
336. En backend/src/services/deployments/deployment-service.js quality-gate.
337. En backend/src/services/hosting/* no root en el container de tenant.
338. En backend/src/services/design-generator.js DeepSeek.
339. En backend/src/services/figma.js tokens fuera del prompt.
340. En backend/src/routes/figma.js authz.
341. En backend/src/routes/math.js no shell-out sin sandbox.
342. En backend/src/routes/compute.js sandbox F5.
343. En backend/src/routes/intent.js no bypassear F2.
344. En backend/src/routes/hooks.js firma.
345. En backend/src/routes/goals.js y goal-boot-recovery.js: no recover un goal que genera con OpenRouter.
346. En backend/src/routes/library.js authz.
347. En backend/src/routes/bookmarks.js authz.
348. En backend/src/routes/link-preview.js SSRF allowlist (F6).
349. En backend/src/routes/answer.js DeepSeek.
350. En backend/src/routes/apps-ai.js / apps-kv.js: no secrets en kv.
351. En backend/src/routes/platform-improvements.js no es un backdoor de generate.
352. En backend/src/routes/hermes.js cron learning = DeepSeek, no OpenRouter.
353. En backend/src/routes/doc-agent.js sandbox F5.
354. En backend/src/routes/research-agent.js F6 untrusted.
355. En backend/src/routes/search-agentic.js igual.
356. En backend/src/routes/x-search.js igual.
357. En backend/src/routes/scientific-search.js igual.
358. En backend/src/routes/video-provider-status.js no LLM.
359. En backend/src/routes/voice-grok.js no generate texto.
360. En backend/src/routes/viz.js sandbox de plot.
361. En backend/src/routes/publishing.js HITL.
362. En backend/src/routes/project-documents.js authz + última versión.
363. En backend/src/routes/document-collections.js org scope.
364. En backend/src/routes/api-docs.js no exponer internal routes.
365. En backend/src/routes/api.js barrel — no registrar free-ia en prod sin flag.
366. Tests: ampliar agent-runner-f5-sandbox.test.js con el caso REQUIRE_GVISOR + runc opt-in (matriz ya existe; añadir env sucio).
367. Tests: invariante native-llm en CI (ya hay native-llm.test.js) + grep de baseURL openrouter en generate path.
368. Tests: F3 cancel no-leak (ya 14 tests) + un caso orchestrator+sandbox juntos.
369. Tests: F2 routing (10) + agent-task preloop ON fuera de NODE_ENV=test (hoy opt-in).
370. Tests: orgs invites accept/reject/expire.
371. Tests: payments idempotency + credit-ledger 402.
372. Tests: r2-storage presign expire.
373. Tests: gateway protocol first-frame.
374. Tests: visible-model-catalog solo flash/pro.
375. No commitear .env.bak-* (10 archivos en /opt/siragpt) — mover a vault; contienen secretos históricos.

## Higiene del árbol vivo — .bak, AppleDouble y .env.bak (BE/ops)

376. Borrar .deploy-prev-sha.bak-autorestore-20260801T044004Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
377. Borrar .deploy-prev-sha.bak-manual del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
378. Sacar .env.bak-20260703045449 de /opt/siragpt a un vault y borrar la copia del disco: es un .env histórico con secretos.
379. Sacar .env.bak-autoheal-20260801035711 de /opt/siragpt a un vault y borrar la copia del disco: es un .env histórico con secretos.
380. Sacar .env.bak-deepseek-20260814T182533Z de /opt/siragpt a un vault y borrar la copia del disco: es un .env histórico con secretos.
381. Sacar .env.bak-pairing-20260729T184745Z de /opt/siragpt a un vault y borrar la copia del disco: es un .env histórico con secretos.
382. Sacar .env.bak-preview-20260801T005219Z de /opt/siragpt a un vault y borrar la copia del disco: es un .env histórico con secretos.
383. Sacar .env.bak-r2-20260814 de /opt/siragpt a un vault y borrar la copia del disco: es un .env histórico con secretos.
384. Sacar .env.bak-stripefix-20260703210334 de /opt/siragpt a un vault y borrar la copia del disco: es un .env histórico con secretos.
385. Sacar .env.bak-verifyrt-20260703114637 de /opt/siragpt a un vault y borrar la copia del disco: es un .env histórico con secretos.
386. Sacar .env.bak.20260814T221212Z de /opt/siragpt a un vault y borrar la copia del disco: es un .env histórico con secretos.
387. Borrar backend/index.js.bak-f11-20260814T205145Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
388. Borrar backend/src/routes/codex.js.bak-dept-computer-20260814-213120 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
389. Borrar backend/src/routes/doc.js.bak-wordfix-20260814T190611Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
390. Borrar backend/src/services/agent-runner/.bak-coloradd-20260814T191830Z/artifacts.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
391. Borrar backend/src/services/agent-runner/.bak-coloradd-20260814T191830Z/index.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
392. Borrar backend/src/services/agent-runner/.bak-coloradd-20260814T191830Z/office-helpers.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
393. Borrar backend/src/services/agent-runner/.bak-coloradd-20260814T191830Z/pptx-followup.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
394. Borrar backend/src/services/agent-runner/.bak-coloradd-20260814T191830Z/verify.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
395. Borrar backend/src/services/agent-runner/.bak-countfix-20260814T194606Z/index.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
396. Borrar backend/src/services/agent-runner/.bak-countfix-20260814T194606Z/slide-intent.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
397. Borrar backend/src/services/agent-runner/.bak-countfix-20260814T194606Z/verify.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
398. Borrar backend/src/services/agent-runner/.bak-livefail-20260814T191950Z/artifacts.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
399. Borrar backend/src/services/agent-runner/.bak-livefail-20260814T191950Z/format-intent.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
400. Borrar backend/src/services/agent-runner/.bak-livefail-20260814T191950Z/index.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
401. Borrar backend/src/services/agent-runner/.bak-livefail-20260814T191950Z/office-helpers.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
402. Borrar backend/src/services/agent-runner/.bak-livefail-20260814T191950Z/pptx-followup.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
403. Borrar backend/src/services/agent-runner/.bak-livefail-20260814T191950Z/verify.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
404. Borrar backend/src/services/agent-runner/.bak-prod-20260814T190220Z/doc.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
405. Borrar backend/src/services/agent-runner/.bak-prod-20260814T190220Z/docker-compose.production.override.yml del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
406. Borrar backend/src/services/agent-runner/.bak-prod-20260814T190220Z/index.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
407. Borrar backend/src/services/agent-runner/.bak-prod-20260814T190220Z/office-helpers.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
408. Borrar backend/src/services/agent-runner/.bak-prod-20260814T190220Z/slide-intent.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
409. Borrar backend/src/services/agent-runner/.bak-prod-20260814T190220Z/verify.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
410. Borrar backend/src/services/agent-runner/.bak-prod-20260814T192043Z/artifacts.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
411. Borrar backend/src/services/agent-runner/.bak-prod-20260814T192043Z/format-intent.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
412. Borrar backend/src/services/agent-runner/.bak-prod-20260814T192043Z/index.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
413. Borrar backend/src/services/agent-runner/.bak-prod-20260814T192043Z/office-helpers.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
414. Borrar backend/src/services/agent-runner/.bak-prod-20260814T192043Z/pptx-followup.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
415. Borrar backend/src/services/agent-runner/.bak-prod-20260814T192043Z/verify.js del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
416. Borrar backend/src/services/agent-runner/artifacts.js.bak-eq6-20260814T195105Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
417. Borrar backend/src/services/agent-runner/artifacts.js.bak-pptfix-20260814T185521Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
418. Borrar backend/src/services/agent-runner/artifacts.js.bak-slide7-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
419. Borrar backend/src/services/agent-runner/index.js.bak-broken-20260814T1906 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
420. Borrar backend/src/services/agent-runner/index.js.bak-deeplock-20260814T193349Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
421. Borrar backend/src/services/agent-runner/index.js.bak-escribe-20260814T190857Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
422. Borrar backend/src/services/agent-runner/index.js.bak-escribe-20260814T190930Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
423. Borrar backend/src/services/agent-runner/index.js.bak-f11-20260814T205145Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
424. Borrar backend/src/services/agent-runner/index.js.bak-finish-20260814T1942Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
425. Borrar backend/src/services/agent-runner/index.js.bak-pptfix-20260814T185521Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
426. Borrar backend/src/services/agent-runner/index.js.bak-slide7-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
427. Borrar backend/src/services/agent-runner/index.js.bak-wordfix-20260814T190611Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
428. Borrar backend/src/services/agent-runner/index.js.bak-wordppt-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
429. Borrar backend/src/services/agent-runner/loop.js.bak-deeplock-20260814T193349Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
430. Borrar backend/src/services/agent-runner/loop.js.bak-finish-20260814T1942Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
431. Borrar backend/src/services/agent-runner/native-llm.js.bak-finish-20260814T1942Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
432. Borrar backend/src/services/agent-runner/office-helpers.js.bak-finish-20260814T1942Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
433. Borrar backend/src/services/agent-runner/office-helpers.js.bak-slide7-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
434. Borrar backend/src/services/agent-runner/office-helpers.js.bak-wordppt-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
435. Borrar backend/src/services/agent-runner/orchestrator/index.js.bak-deeplock-20260814T193349Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
436. Borrar backend/src/services/agent-runner/prompt.js.bak-pptfix-20260814T185521Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
437. Borrar backend/src/services/agent-runner/prompt.js.bak-slide7-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
438. Borrar backend/src/services/agent-runner/react.js.bak-slide7-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
439. Borrar backend/src/services/agent-runner/slide-intent.js.bak-wordppt-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
440. Borrar backend/src/services/agent-runner/tools.js.bak-finish-20260814T1942Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
441. Borrar backend/src/services/agent-runner/tools.js.bak-pptfix-20260814T185521Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
442. Borrar backend/src/services/agent-runner/tools.js.bak-slide7-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
443. Borrar backend/src/services/agent-runner/verify.js.bak-eq6-20260814T195105Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
444. Borrar backend/src/services/agent-runner/verify.js.bak-finish-20260814T1942Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
445. Borrar backend/src/services/agent-runner/verify.js.bak-pptfix-20260814T185521Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
446. Borrar backend/src/services/agent-runner/verify.js.bak-slide7-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
447. Borrar backend/src/services/agent-runner/verify.js.bak-wordppt-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
448. Borrar backend/src/services/agents/document-delivery-policy.js.bak-wordfix-20260814T190611Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
449. Borrar backend/src/services/agents/pptx-package-validator.js.bak-eq6-20260814T195105Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
450. Borrar backend/src/services/ai-service.js.bak-deeplock-20260814T193448Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
451. Borrar backend/src/services/ai-service.js.bak-deepseek-20260814T182533Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
452. Borrar backend/src/services/ai/provider-inference.js.bak-deeplock-20260814T193425Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
453. Borrar backend/src/services/codex/company-departments.js.bak-dept-computer-20260814-213120 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
454. Borrar backend/src/services/doc-agent/index.js.bak-deeplock-20260814T193425Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
455. Borrar backend/src/services/document-editing/user-intent-parser.js.bak-pptfix-20260814T185521Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
456. Borrar backend/src/services/document-pipeline/advanced-document-pipeline.js.bak-wordfix-20260814T190611Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
457. Borrar backend/src/services/document-pipeline/content/llm-client.js.bak-deeplock-20260814T193425Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
458. Borrar backend/src/services/visible-model-catalog.js.bak-admin-toggles-20260815 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
459. Borrar backend/src/services/visible-model-catalog.js.bak-deeplock-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
460. Borrar backend/src/services/visible-model-catalog.js.bak-deeplock-20260814T193425Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
461. Borrar backend/tests/agent-runner-f2-routing.test.js.bak-wordfix-20260814T190611Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
462. Borrar deploy/Caddyfile.bak-20260813-p280 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
463. Borrar docker-compose.prod.yml.bak-deepseek-20260814T182533Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
464. Borrar docker-compose.production.override.yml.bak-aimount-20260814T183244Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
465. Borrar docker-compose.production.override.yml.bak-deeplock-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
466. Borrar docker-compose.production.override.yml.bak-deeplock-20260814T193505Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
467. Borrar docker-compose.production.override.yml.bak-deepseek-20260814T182533Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
468. Borrar docker-compose.production.override.yml.bak-dept-computer-20260814-213120 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
469. Borrar docker-compose.production.override.yml.bak-docsandbox-20260814T160815Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
470. Borrar docker-compose.production.override.yml.bak-eq6-20260814T195105Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
471. Borrar docker-compose.production.override.yml.bak-f11-20260814T205145Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
472. Borrar docker-compose.production.override.yml.bak-pptfix-20260814T185521Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
473. Borrar docker-compose.production.override.yml.bak-r2-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
474. Borrar docker-compose.production.override.yml.bak-slide7-20260814 del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
475. Borrar docker-compose.production.override.yml.bak-wordfix-20260814T190619Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
476. Borrar scripts/auto-heal.sh.bak-20260801T054213Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
477. Borrar scripts/auto-heal.sh.bak-20260813T1635Z del árbol vivo /opt/siragpt (backup de hotpatch; no debe resolverse por require/glob).
478. Borrar AppleDouble backend/src/routes/._doc.js en backend (rompe listados y puede colarse en empaquetados).
479. Borrar AppleDouble backend/src/routes/._generate-document.js en backend (rompe listados y puede colarse en empaquetados).

## Partir god-files backend (líneas vivas)

480. Partir backend/src/routes/elevenlabs.js (681 líneas vivas) en voz ≠ generate.
481. Partir backend/src/routes/appshots.js (821 líneas vivas) en consent.
482. Partir backend/src/routes/auth.js (2293 líneas vivas) en login / oauth / reset / mfa.
483. Partir backend/src/routes/orgs.js (5492 líneas vivas) en invites / members / rbac / billing.
484. Partir backend/src/routes/payments.js (2975 líneas vivas) en checkout / webhook / portal.
485. Partir backend/src/routes/codex.js (2610 líneas vivas) en projects / runs / company.
486. Partir backend/src/routes/chats.js (1833 líneas vivas) en crud / cursor / share.
487. Partir backend/src/routes/files.js (1704 líneas vivas) en upload / worker / status.
488. Partir backend/src/routes/research-library.js (828 líneas vivas) en untrusted.
489. Partir backend/src/routes/agent-task.js (3408 líneas vivas) en http / preloop / stream.
490. Partir backend/src/routes/video.js (1499 líneas vivas) en media ≠ LLM.
491. Partir backend/src/routes/thesis.js (2301 líneas vivas) en sections / runner / files.
492. Partir backend/src/routes/admin.js (3119 líneas vivas) en users / stats / impersonate.
493. Partir backend/src/routes/paraphrase.js (807 líneas vivas) en DeepSeek.
494. Partir backend/src/routes/images.js (791 líneas vivas) en media.
495. Partir backend/src/routes/projects.js (650 líneas vivas) en org scope.
496. Partir backend/src/routes/search.js (829 líneas vivas) en F6 untrusted.
497. Partir backend/src/routes/users.js (2388 líneas vivas) en profile / admin / projection.
498. Partir backend/src/routes/se-agents.js (1736 líneas vivas) en deprecar o reenviar.
499. Partir backend/src/routes/social-posts.js (927 líneas vivas) en HITL.
500. Partir backend/src/routes/rag.js (877 líneas vivas) en authz.
501. Partir backend/src/routes/gpts.js (1143 líneas vivas) en no OpenRouter actions.
502. Partir backend/src/routes/doc.js (590 líneas vivas) en runner-first.
503. Partir backend/src/routes/ai.js (11381 líneas vivas) en generate / stop-stream / models / media.
504. Partir backend/src/routes/download.js (670 líneas vivas) en tenant.
505. Partir backend/src/routes/computer-use.js (2924 líneas vivas) en session / input / flag F7.
506. Partir backend/src/routes/enterprise.js (1361 líneas vivas) en flag F11.
507. Partir backend/src/routes/cowork.js (715 líneas vivas) en isolation.
508. Partir backend/src/routes/github.js (1096 líneas vivas) en token fuera de prompt.
509. Partir backend/src/jobs/system-cron.js (1118 líneas vivas) en ops vs product cron.
510. Partir backend/src/services/document-service.js (789 líneas vivas) en R2|local.
511. Partir backend/src/services/agentic-chat-stream.js (2385 líneas vivas) en route / runner / sse.
512. Partir backend/src/services/fileProcessor.js (1082 líneas vivas) en worker 202.
513. Partir backend/src/services/document-professional-analyzer.js (8279 líneas vivas) en parse / score / queue.
514. Partir backend/src/services/message-attachments.js (925 líneas vivas) en excerpt no OOXML.
515. Partir backend/src/services/ocr-engine.js (990 líneas vivas) en timeout / pages.
516. Partir backend/src/services/react-agent.js (1728 líneas vivas) en deprecar vs F1.
517. Partir backend/src/services/source-preserving-document-edit.js (8613 líneas vivas) en docx / xlsx / pptx / pdf.
518. Partir backend/src/services/rag-service.js (1207 líneas vivas) en retrieve ≠ generate.
519. Partir backend/src/services/ai-service.js (1554 líneas vivas) en native-llm only.
520. Partir backend/src/services/credit-ledger.js (1590 líneas vivas) en tx generate / 402.
521. Partir backend/src/services/github-codex-connector.js (1480 líneas vivas) en clone / filter / no secrets.
522. Partir backend/src/services/model-sync-service.js (1323 líneas vivas) en no OpenRouter overlay.
523. Partir backend/src/services/agents/task-tools.js (2150 líneas vivas) en manifest vs agent-runner/tools.
524. Partir backend/src/services/agents/tool-manifest.js (2113 líneas vivas) en registry único.
525. Partir backend/src/services/agents/agent-task-runner.js (3864 líneas vivas) en preloop / tools / delivery.
526. Partir backend/src/services/agents/visual-media-tools.js (8537 líneas vivas) en image / video / inspect.
527. Partir backend/src/services/document-pipeline/advanced-document-pipeline.js (3792 líneas vivas) en solo fallback no-reclamado.
528. Partir backend/src/services/sira/task-envelope-builder.js (1606 líneas vivas) en contrato F2.
529. Partir backend/src/services/sira/chat-controller.js (1047 líneas vivas) en runner-first.
530. Partir backend/src/services/sira/contextual-understanding.js (1699 líneas vivas) en untrusted + runner.
531. Partir backend/src/services/ai/cost-tracker.js (912 líneas vivas) en precio DeepSeek.
532. Partir backend/src/services/codex/progress-ledger.js (783 líneas vivas) en stage F3.
533. Partir backend/src/services/codex/swarm-orchestrator.js (1788 líneas vivas) en budget F4.
534. Partir backend/src/services/codex/agent-loop.js (3800 líneas vivas) en plan / tools / verify.
535. Partir backend/src/services/codex/run-processor.js (956 líneas vivas) en cancel family.
536. Partir backend/src/services/agent-harness/mcp-client.js (1041 líneas vivas) en OAuth user.
537. Partir backend/src/services/doc-agent/sandbox.js (680 líneas vivas) en una fuente de límites F5.
538. Partir backend/src/services/deployments/deployment-service.js (767 líneas vivas) en quality-gate.
539. Partir backend/src/services/observability/health-check.js (1053 líneas vivas) en probes por dependencia.
540. Partir backend/src/services/agent-runner/index.js (1066 líneas vivas) en client / turn / persist.
541. Partir backend/src/services/agent-runner/tools.js (672 líneas vivas) en F5 confine.
542. Partir backend/src/middleware/auth.js (619 líneas vivas) en no bypass model claim.
543. Partir backend/src/middleware/charge-credits.js (643 líneas vivas) en no cobro si cancel.
544. Partir backend/src/middleware/rate-limit-store.js (680 líneas vivas) en stop ≠ generate.
545. Partir backend/src/utils/startup-validator.js (616 líneas vivas) en gVisor + DeepSeek key.
546. Partir backend/src/utils/async-guard.js (917 líneas vivas) en AbortError.

## Fugas OpenRouter en backend (generate path)

547. Auditar backend/src/routes/admin.js (2 menciones OpenRouter, 3119 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
548. Auditar backend/src/routes/admin-connections.js (4 menciones OpenRouter, 388 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
549. Auditar backend/src/routes/gpts.js (2 menciones OpenRouter, 1143 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
550. Auditar backend/src/routes/design.js (3 menciones OpenRouter, 299 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
551. Auditar backend/src/routes/generate-document.js (2 menciones OpenRouter, 377 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
552. Auditar backend/src/routes/ai.js (49 menciones OpenRouter, 11381 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
553. Auditar backend/src/health/probes/provider-llm.js (2 menciones OpenRouter, 101 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
554. Auditar backend/src/services/context-window.js (4 menciones OpenRouter, 377 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
555. Auditar backend/src/services/agentic-chat-stream.js (6 menciones OpenRouter, 2385 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
556. Auditar backend/src/services/model-pricing-service.js (30 menciones OpenRouter, 218 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
557. Auditar backend/src/services/model-catalog-manifest.js (57 menciones OpenRouter, 631 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
558. Auditar backend/src/services/visible-model-catalog.js (27 menciones OpenRouter, 401 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
559. Auditar backend/src/services/react-agent.js (2 menciones OpenRouter, 1728 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
560. Auditar backend/src/services/plan-generator.js (4 menciones OpenRouter, 1170 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
561. Auditar backend/src/services/artifact-generator.js (3 menciones OpenRouter, 175 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
562. Auditar backend/src/services/math-solver.js (3 menciones OpenRouter, 275 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
563. Auditar backend/src/services/viz-generator.js (3 menciones OpenRouter, 337 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
564. Auditar backend/src/services/grok-voice-model.js (3 menciones OpenRouter, 176 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
565. Auditar backend/src/services/ai-service.js (19 menciones OpenRouter, 1554 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
566. Auditar backend/src/services/design-generator.js (6 menciones OpenRouter, 484 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
567. Auditar backend/src/services/admin-connections-bridge.js (5 menciones OpenRouter, 278 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
568. Auditar backend/src/services/model-sync-service.js (28 menciones OpenRouter, 1323 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
569. Auditar backend/src/services/media/image-engine.js (22 menciones OpenRouter, 702 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
570. Auditar backend/src/services/agents/provider-registry.js (2 menciones OpenRouter, 478 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
571. Auditar backend/src/services/agents/agent-task-runner.js (16 menciones OpenRouter, 3864 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
572. Auditar backend/src/services/document-pipeline/content/llm-client.js (5 menciones OpenRouter, 163 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
573. Auditar backend/src/services/sira/model-adapter.js (3 menciones OpenRouter, 331 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
574. Auditar backend/src/services/ai/openrouter-afford-guard.js (9 menciones OpenRouter, 74 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
575. Auditar backend/src/services/ai/provider-inference.js (10 menciones OpenRouter, 126 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
576. Auditar backend/src/services/ai/lyria-music.js (10 menciones OpenRouter, 190 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
577. Auditar backend/src/services/ai-product-os/integration-stack.js (3 menciones OpenRouter, 1566 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
578. Auditar backend/src/services/ai-product-os/litellm-gateway.js (32 menciones OpenRouter, 890 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
579. Auditar backend/src/services/ai-product-os/model-router.js (7 menciones OpenRouter, 403 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
580. Auditar backend/src/services/codex/error-patterns.js (7 menciones OpenRouter, 140 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
581. Auditar backend/src/services/codex/llm-provider.js (14 menciones OpenRouter, 412 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
582. Auditar backend/src/services/codex/llm-turn.js (2 menciones OpenRouter, 270 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
583. Auditar backend/src/services/codex/cost-resolver.js (16 menciones OpenRouter, 125 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
584. Auditar backend/src/services/agent-harness/model-capabilities.js (13 menciones OpenRouter, 329 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
585. Auditar backend/src/services/searchBrain/llmClient.js (6 menciones OpenRouter, 84 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
586. Auditar backend/src/services/doc-agent/index.js (4 menciones OpenRouter, 239 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
587. Auditar backend/src/services/providers/anthropic-native.js (2 menciones OpenRouter, 181 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
588. Auditar backend/src/services/observability/llm-cost.js (4 menciones OpenRouter, 203 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
589. Auditar backend/src/services/agent-runner/native-llm.test.js (4 menciones OpenRouter, 42 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
590. Auditar backend/src/services/agent-runner/loop.js (3 menciones OpenRouter, 310 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
591. Auditar backend/src/services/agent-runner/index.js (6 menciones OpenRouter, 1066 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
592. Auditar backend/src/services/agent-runner/native-llm.js (9 menciones OpenRouter, 84 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
593. Auditar backend/src/services/agent-runner/multimodal/vision.js (6 menciones OpenRouter, 235 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
594. Auditar backend/src/services/agent-runner/multimodal/index.js (2 menciones OpenRouter, 146 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
595. Auditar backend/src/services/agent-gateway/index.js (2 menciones OpenRouter, 252 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
596. Auditar backend/src/orchestration/llm-routing.config.js (6 menciones OpenRouter, 121 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.
597. Auditar backend/src/orchestration/llm-gateway.js (2 menciones OpenRouter, 339 líneas): si está en el path de generate, forzar native-llm (api.deepseek.com) y test de rechazo; si es histórico, aislarlo de /api/ai/generate.

## Observabilidad — console.log ruidosos en backend

598. Reemplazar los 18 console.log de backend/src/routes/elevenlabs.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
599. Reemplazar los 12 console.log de backend/src/routes/payments.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
600. Reemplazar los 50 console.log de backend/src/routes/video.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
601. Reemplazar los 82 console.log de backend/src/routes/thesis.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
602. Reemplazar los 112 console.log de backend/src/routes/ai.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
603. Reemplazar los 48 console.log de backend/src/routes/computer-use.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
604. Reemplazar los 19 console.log de backend/src/services/fileProcessor.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
605. Reemplazar los 8 console.log de backend/src/services/google-mcp.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
606. Reemplazar los 21 console.log de backend/src/services/email.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
607. Reemplazar los 10 console.log de backend/src/services/model-sync-scheduler.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
608. Reemplazar los 22 console.log de backend/src/services/ai-service.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
609. Reemplazar los 23 console.log de backend/src/services/model-sync-service.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
610. Reemplazar los 9 console.log de backend/src/services/agent-runner/evals/cli.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.
611. Reemplazar los 10 console.log de backend/src/utils/stripe-setup.js por métricas/eventos estructurados sin prompt, cookies ni OOXML.

## TODOs/FIXME reales en backend/src

612. Resolver o convertir en issue los 2 TODO/FIXME de backend/src/routes/auth.js (2293 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
613. Resolver o convertir en issue los 1 TODO/FIXME de backend/src/routes/search.js (829 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
614. Resolver o convertir en issue los 1 TODO/FIXME de backend/src/routes/users.js (2388 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
615. Resolver o convertir en issue los 1 TODO/FIXME de backend/src/routes/hooks.js (79 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
616. Resolver o convertir en issue los 2 TODO/FIXME de backend/src/routes/ai.js (11381 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
617. Resolver o convertir en issue los 1 TODO/FIXME de backend/src/services/agentic-chat-stream.js (2385 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
618. Resolver o convertir en issue los 2 TODO/FIXME de backend/src/services/document-pm-tickets.js (171 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
619. Resolver o convertir en issue los 4 TODO/FIXME de backend/src/services/document-professional-analyzer.js (8279 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
620. Resolver o convertir en issue los 9 TODO/FIXME de backend/src/services/document-todos.js (166 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
621. Resolver o convertir en issue los 1 TODO/FIXME de backend/src/services/master-prompt.js (751 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
622. Resolver o convertir en issue los 1 TODO/FIXME de backend/src/services/cowork-session-tools.js (325 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
623. Resolver o convertir en issue los 3 TODO/FIXME de backend/src/services/agents/static-check-agent.js (141 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
624. Resolver o convertir en issue los 6 TODO/FIXME de backend/src/services/agents/qa-board.js (392 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
625. Resolver o convertir en issue los 4 TODO/FIXME de backend/src/services/agents/agent-tools.js (1561 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
626. Resolver o convertir en issue los 3 TODO/FIXME de backend/src/services/sira/answer-validator.js (391 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
627. Resolver o convertir en issue los 4 TODO/FIXME de backend/src/services/sira/validator-engine.js (450 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
628. Resolver o convertir en issue los 6 TODO/FIXME de backend/src/services/software-engineering/code-review.js (308 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
629. Resolver o convertir en issue los 1 TODO/FIXME de backend/src/services/codex/company-soul.js (220 líneas), empezando por seguridad (auth.js refresh-token) si aplica.
630. Resolver o convertir en issue los 1 TODO/FIXME de backend/src/workers/heavy-analysis.worker.js (104 líneas), empezando por seguridad (auth.js refresh-token) si aplica.

## Tests backend — rutas y módulos críticos

631. Añadir o endurecer tests de backend/src/routes/gateway.js cubriendo model_forbidden + first-frame + authn.
632. Añadir o endurecer tests de backend/src/routes/auth.js cubriendo refresh-token rotation y reset token expiry.
633. Añadir o endurecer tests de backend/src/routes/orgs.js cubriendo invite single-use y cross-org deny.
634. Añadir o endurecer tests de backend/src/routes/payments.js cubriendo idempotency-key y no double-credit.
635. Añadir o endurecer tests de backend/src/routes/files.js cubriendo PPTX grande → 202 + jobId.
636. Añadir o endurecer tests de backend/src/routes/download.js cubriendo cross-tenant 403.
637. Añadir o endurecer tests de backend/src/routes/chats.js cubriendo cursor pagination.
638. Añadir o endurecer tests de backend/src/routes/credits.js cubriendo topup negativo deny.
639. Añadir o endurecer tests de backend/src/orchestration/r2-storage.js cubriendo presign TTL y fail-closed prod.
640. Añadir o endurecer tests de backend/src/services/doc-agent/sandbox.js cubriendo REQUIRE_GVISOR + env sucio.
641. Añadir o endurecer tests de backend/src/services/agent-runner/native-llm.js cubriendo sk-or- key reject + baseURL.
642. Añadir o endurecer tests de backend/src/services/visible-model-catalog.js cubriendo solo flash/pro generables.
643. Añadir o endurecer tests de backend/src/services/credit-ledger.js cubriendo 402 no descuenta dos veces.
644. Añadir o endurecer tests de backend/src/middleware/charge-credits.js cubriendo cancel inmediato no cobra.
645. Añadir o endurecer tests de backend/src/services/agent-gateway/protocol.js cubriendo frame malicioso.
646. Añadir o endurecer tests de backend/src/services/agent-runner/artifacts.js cubriendo cancel no persiste.
647. Añadir o endurecer tests de backend/src/services/agent-runner/verify.js cubriendo hex usuario en OOXML.
648. Añadir o endurecer tests de backend/src/services/agent-runner/tools.js cubriendo injection `;` en filename.
649. Añadir o endurecer tests de backend/src/services/agentic-chat-stream.js cubriendo plan_failed no pipeline.
650. Añadir o endurecer tests de backend/src/routes/doc.js cubriendo runner-first no pipeline.
651. Añadir o endurecer tests de backend/src/routes/codex.js cubriendo DeepSeek only + cancel family.
652. Añadir o endurecer tests de backend/src/routes/computer-use.js cubriendo flag F7 off default.
653. Añadir o endurecer tests de backend/src/routes/admin/settings.js cubriendo no guardar OpenRouter como generate.
654. Añadir o endurecer tests de backend/src/services/safety cubriendo archivo = datos no instrucciones.
655. Añadir o endurecer tests de backend/src/routes/webhooks.js cubriendo firma inválida 401.
656. Añadir o endurecer tests de backend/src/routes/link-preview.js cubriendo SSRF deny metadata.
657. Añadir o endurecer tests de backend/src/routes/public.js cubriendo no emails.
658. Añadir o endurecer tests de backend/src/routes/free-ia.js cubriendo off en prod o sin secrets.
659. Añadir o endurecer tests de backend/src/routes/db-internal.js cubriendo no montado en prod.
660. Añadir o endurecer tests de backend/src/health/probe.js cubriendo no env leak.

## Oleadas F6–F12 backend (stubs ya en el árbol vivo)

661. F6: registrar web_search/web_fetch desde backend/src/services/agent-runner/browser/web-tools.js solo tras tests de untrusted.js y allowlist; red sigue none hasta el allowlist explícito.
662. F6: backend/src/services/agent-runner/browser/browser-act.js Playwright a11y tree; no visión como path primario.
663. F6: skills/web_search y skills/read_url/handler.js envueltos untrusted; test de prompt-injection desde HTML.
664. F6: link-preview.js y search.js usan la misma allowlist de egress que el sandbox.
665. F6: researcher role (orchestrator/roles.js) gana web_search solo cuando F6 cierre; hasta entonces el test que lo prohíbe se queda.
666. F7: multimodal/vision.js DeepSeek nativo (o skip honesto); nunca OpenRouter vision.
667. F7: multimodal/voice.js STT/TTS no re-generan texto con otro LLM.
668. F7: multimodal/computer.js exige gVisor ok; si SandboxRuntimeError, no VM.
669. F7: routes/computer-use.js flag default off; VNC no en el host API.
670. F8: memory/index.js + search.js + long-term-memory.js + user-memory-vector.ts: recall cross-sesión con tenant isolation y test de no-leak.
671. F8: agent-runner/mcp/index.js + agent-harness/mcp-client.js: OAuth por usuario, revoke, tokens fuera del prompt.
672. F8: skills/manage.js carga on-demand; test de aislamiento entre skills.
673. F8: GraphRAG nocturno (ROADMAP) no arranca si F8 memoria híbrida no pasó recall.
674. F9: evals/ harness sobre traces reales; CI gate si pass-rate de frases (blanco/rosado/hex/gracias/embarazo) baja.
675. F9: prompt optimizer no puede proponer OpenRouter como modelo.
676. F9: dashboard /admin/evals lee counters document_turn_path_total.
677. F10: router aprendido solo elige Flash vs Pro nativos, nunca un vendor tercero.
678. F10: LoRA/vLLM solo si hay GPU; si no, el path se queda en DeepSeek API nativa.
679. F11: SSO/SCIM sobre orgs.js/SsoCallbackService.js; no mezclar con el candado de modelos.
680. F11: marketplace de skills (ROADMAP) instala en skills/manage.js con review HITL.
681. F11: Stripe ya vive en payments.js — no rehacer; sí idempotency y ledger.
682. F12: MinIO no sustituye R2 si R2 ya está wired (orchestration/r2-storage.js); o documentar uno solo.
683. F12: OTel end-to-end generate→runner→sandbox→R2 (phase-6a ya empezó; cerrar huecos).
684. F12: canary + rollback (STATE deploy es Mac de Luis; el VPS no pushea) — documentar el procedimiento en docs/deployment.md.
685. F12: i18n de AGENT_RUNNER_FAILURE_COPY es+en.
686. F12: Prisma→Drizzle solo cuando F1–F11 estables (STATE: ORM hoy Prisma).
687. P14 HITL: external-actions.js + social-posts + webhooks no salen sin confirmación y audit log.
688. P14: segundo modelo de alto riesgo, si existe, también DeepSeek Pro nativo, no OpenRouter.
689. Secret rotation: DEEPSEEK_API_KEY, R2_*, JWT, Stripe — docs/secret-rotation.md operativo, no teórico.
690. No docker compose down -v (regla viva); los ítems de sandbox se verifican con docker info / tests, no derribando prod.

## Módulos backend grandes aún no partidos (ítem por archivo vivo)

691. Auditar el servicio backend/src/services/searchBrain/agenticBatch.js (1075 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
692. Auditar el servicio backend/src/services/agents/agentic-operating-core.js (1063 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
693. Auditar el servicio backend/src/services/agents/agent-collaboration.js (1000 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
694. Auditar el servicio backend/src/services/codex/swarm-runner.js (955 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
695. Auditar el servicio backend/src/services/codex/starter-files.js (819 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
696. Auditar el servicio backend/src/services/rbac-bootstrap.js (809 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
697. Auditar el servicio backend/src/services/agents/ai-product-os.js (767 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
698. Auditar el servicio backend/src/services/agents/plugin-registry.js (757 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
699. Auditar el servicio backend/src/services/searchBrain/providers.js (752 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
700. Auditar el servicio backend/src/services/rbac-assignment-sync.js (747 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
701. Auditar el servicio backend/src/services/agents/openclaw-source-inventory.js (719 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
702. Auditar el servicio backend/src/services/agent-harness/tools/cowork-tools.js (708 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
703. Auditar el servicio backend/src/services/rag/operational-runtime.js (694 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
704. Auditar el servicio backend/src/services/cowork/control-plane.js (688 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
705. Auditar el servicio backend/src/services/agent-harness/tools/document-edit-tool.js (671 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
706. Auditar el servicio backend/src/services/rag/self-rag-engine.js (667 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
707. Auditar el servicio backend/src/services/rag/map-reduce.js (649 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
708. Auditar el servicio backend/src/services/searchBrain/universal/providers/catalog.js (649 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
709. Auditar el servicio backend/src/services/rag/hierarchical-chunker.js (637 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
710. Auditar el servicio backend/src/services/ai-product-os/skill-system.js (619 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
711. Auditar el servicio backend/src/services/active-memory.js (606 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
712. Auditar el servicio backend/src/services/social-company/conversations.js (583 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
713. Auditar el servicio backend/src/services/social-company/worker.js (581 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
714. Auditar el servicio backend/src/services/agents/constrained-decoder.js (579 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
715. Auditar el servicio backend/src/services/agents/universal-agent-fabric.js (574 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
716. Auditar el servicio backend/src/services/code-chunker.js (568 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
717. Auditar el servicio backend/src/services/sira/task-envelope-schema.js (567 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
718. Auditar el servicio backend/src/services/agent-harness/mcp-policy.js (555 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
719. Auditar el servicio backend/src/services/agents/media-intent.js (539 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
720. Auditar el servicio backend/src/services/research-agent.js (534 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
721. Auditar el ruta backend/src/routes/cowork-platform.js (532 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
722. Auditar el servicio backend/src/services/document-analysis-quality-scorer.js (531 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
723. Auditar el servicio backend/src/services/agent-harness/event-stream.js (530 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
724. Auditar el servicio backend/src/services/agents/task-flow-store.js (516 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
725. Auditar el servicio backend/src/services/trigger-registry.js (514 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
726. Auditar el servicio backend/src/services/providers/anthropic-citations.js (513 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
727. Auditar el servicio backend/src/services/ai-product-os/tool-registry.js (509 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
728. Auditar el servicio backend/src/services/agents/open-source-agent-radar.js (507 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
729. Auditar el servicio backend/src/services/agents/openclaw-playbook-bridge.js (506 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
730. Auditar el servicio backend/src/services/agents/sub-agent-orchestrator.js (506 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
731. Auditar el servicio backend/src/services/agent-harness/permission-manager.js (505 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
732. Auditar el servicio backend/src/services/rag/index-store.js (502 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
733. Auditar el servicio backend/src/services/agent-runner/skills/manage.js (501 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
734. Auditar el servicio backend/src/services/agents/skill-runner.js (500 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
735. Auditar el servicio backend/src/services/ai-product-os/semantic-intent-router.js (496 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
736. Auditar el servicio backend/src/services/stripe-webhook-recovery.js (491 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
737. Auditar el servicio backend/src/services/thesis/section-specs.js (490 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
738. Auditar el servicio backend/src/services/agents/request-token-intelligence.js (485 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
739. Auditar el servicio backend/src/services/research/literature-review-engine.js (484 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
740. Auditar el servicio backend/src/services/research/systematic-review-protocol.js (484 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
741. Auditar el servicio backend/src/services/goal-boot-recovery.js (481 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
742. Auditar el servicio backend/src/services/social-company/publisher.js (481 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
743. Auditar el servicio backend/src/services/agents/professional-document-cycle.js (479 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
744. Auditar el servicio backend/src/services/document-pipeline/pptx-prompt-contract.js (478 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
745. Auditar el servicio backend/src/services/agents/agent-entry.js (476 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
746. Auditar el servicio backend/src/services/agents/web-search/index.js (475 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
747. Auditar el servicio backend/src/services/agents/media-inspection-runtime.js (474 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
748. Auditar el servicio backend/src/services/agents/speculative-executor.js (465 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
749. Auditar el servicio backend/src/services/agent-runtime/middleware.js (459 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
750. Auditar el servicio backend/src/services/concept-extractor.js (458 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
751. Auditar el servicio backend/src/services/hosting/deploy.service.js (456 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
752. Auditar el servicio backend/src/services/gpts/gpt-actions.js (455 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
753. Auditar el servicio backend/src/services/agents/component-registry.js (451 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
754. Auditar el ruta backend/src/routes/agent-batch.js (448 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
755. Auditar el servicio backend/src/services/agents/task-contract-schema.js (447 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
756. Auditar el servicio backend/src/services/sira/plan-critic.js (446 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
757. Auditar el servicio backend/src/utils/circuit-breaker.js (445 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
758. Auditar el servicio backend/src/services/codex/business-analyzer.js (442 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
759. Auditar el servicio backend/src/services/plan-quota.js (440 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
760. Auditar el servicio backend/src/services/social-company/autopilot.js (439 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
761. Auditar el servicio backend/src/services/cowork/scheduler.js (438 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
762. Auditar el servicio backend/src/services/agents/coref-resolver.js (438 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
763. Auditar el servicio backend/src/services/agents/tree-of-thought.js (437 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
764. Auditar el servicio backend/src/services/audit-query.js (436 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
765. Auditar el servicio backend/src/flags/index.js (433 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
766. Auditar el servicio backend/src/services/agents/audio-media-tools.js (431 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
767. Auditar el servicio backend/src/services/proration.js (429 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
768. Auditar el servicio backend/src/services/codex/skills.js (426 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
769. Auditar el servicio backend/src/services/document/hierarchical-document-chunker.js (425 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
770. Auditar el servicio backend/src/services/document-intent-analyzer.js (424 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
771. Auditar el servicio backend/src/services/chat-turn-idempotency.js (424 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
772. Auditar el servicio backend/src/services/agents/user-intent-attribution-graph.js (423 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
773. Auditar el servicio backend/src/services/github/git.service.js (423 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
774. Auditar el servicio backend/src/middleware/compression.js (423 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
775. Auditar el servicio backend/src/utils/oauth-callback-boot-validator.js (423 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
776. Auditar el servicio backend/src/services/document-temporal-timeline.js (422 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
777. Auditar el servicio backend/src/services/free-ia-metrics.js (419 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
778. Auditar el servicio backend/src/services/ai/cost-alert.js (419 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
779. Auditar el servicio backend/src/services/user-notifications.js (417 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
780. Auditar el servicio backend/src/services/intent-attribution-graph/feature-extractor.js (416 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
781. Auditar el servicio backend/src/services/agents/cognitive-improvements.js (414 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
782. Auditar el servicio backend/src/services/agents/agent-task-persistence.js (411 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
783. Auditar el servicio backend/src/services/write-behind-cache.js (409 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
784. Auditar el servicio backend/src/services/agents/artifact-reviewer.js (409 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
785. Auditar el servicio backend/src/services/scheduler/scheduler.js (409 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
786. Auditar el servicio backend/src/services/agents/se-orchestrator.js (407 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
787. Auditar el servicio backend/src/services/openclaw-execution-dossier.js (406 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
788. Auditar el servicio backend/src/services/agents/agent-autonomy-progress-ledger.js (406 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
789. Auditar el servicio backend/src/services/rbac-permission-cache.js (405 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
790. Auditar el servicio backend/src/services/ai/stream-resume.js (405 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
791. Auditar el ruta backend/src/routes/hosting.js (404 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
792. Auditar el servicio backend/src/services/connectors/web-fetch.js (404 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
793. Auditar el servicio backend/src/services/agents/task-contract-resolver.js (404 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
794. Auditar el servicio backend/src/services/codex/company-operations/company-resource-access.js (404 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
795. Auditar el servicio backend/src/services/saml-handler.js (403 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
796. Auditar el servicio backend/src/services/document-pipeline/pptx-content-planner.js (403 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
797. Auditar el servicio backend/src/services/openai-computer-use-engine.js (402 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
798. Auditar el servicio backend/src/services/upload-security-policy.js (401 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
799. Auditar el servicio backend/src/services/openapi/route-scanner.js (401 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
800. Auditar el servicio backend/src/services/agents/bulkhead.js (400 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
801. Auditar el servicio backend/src/rate-limit/token-bucket.js (400 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
802. Auditar el servicio backend/src/services/sira/code-interpreter-sandbox.js (399 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
803. Auditar el servicio backend/src/services/agents/performance-tracer.js (396 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
804. Auditar el servicio backend/src/services/agent-runner/evals/fixtures.js (396 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
805. Auditar el servicio backend/src/services/sira/memory-promotion-lifecycle.js (394 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
806. Auditar el servicio backend/src/services/document-editing/docx-image-adapter.js (394 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
807. Auditar el servicio backend/src/services/agents/response-calibrator.js (391 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
808. Auditar el servicio backend/src/services/webauthn.js (389 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
809. Auditar el servicio backend/src/services/openclaw-capability-kernel.js (389 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
810. Auditar el servicio backend/src/services/agents/enterprise-tool-gateway.js (389 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
811. Auditar el servicio backend/src/services/document-editing/pptx-adapter.js (389 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
812. Auditar el servicio backend/src/services/document-deep-analyzer.js (388 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
813. Auditar el servicio backend/src/services/agents/prompt-optimizer.js (388 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
814. Auditar el servicio backend/src/config/oauth-url-policy.js (386 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
815. Auditar el servicio backend/src/services/LoginService.js (386 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
816. Auditar el servicio backend/src/services/sira/eval-harness.js (386 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
817. Auditar el servicio backend/src/middleware/csrf.js (386 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
818. Auditar el servicio backend/src/services/two-fa-sms.js (385 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
819. Auditar el servicio backend/src/services/triple-graph.js (383 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
820. Auditar el servicio backend/src/middleware/error-handler.js (382 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
821. Auditar el servicio backend/src/services/document-consistency-checker.js (381 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
822. Auditar el servicio backend/src/services/scheduled-agent-tasks.js (381 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
823. Auditar el servicio backend/src/services/rag/nli-faithfulness.js (381 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
824. Auditar el servicio backend/src/services/research/research-quality-agents.js (381 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
825. Auditar el servicio backend/src/services/codex/publication-service.js (379 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
826. Auditar el servicio backend/src/jobs/archive-audit-logs.js (377 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
827. Auditar el servicio backend/src/services/agents/web-search/relevance.js (377 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
828. Auditar el servicio backend/src/services/codex/mcp-tools.js (375 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
829. Auditar el servicio backend/src/services/document/streaming-pdf.js (374 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
830. Auditar el servicio backend/src/services/codex/enterprise-command-center-service.js (374 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
831. Auditar el servicio backend/src/services/codex/company-operations/sales-pipeline.js (374 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
832. Auditar el servicio backend/src/services/deployments/pipeline.js (373 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
833. Auditar el servicio backend/src/services/sira/runtime.js (372 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
834. Auditar el servicio backend/src/services/codex/company-resources.js (372 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
835. Auditar el servicio backend/src/concurrency/redlock.js (372 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
836. Auditar el servicio backend/src/services/agents/clarification-options-builder.js (371 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
837. Auditar el servicio backend/src/services/ai-product-os/agentic-kernel.js (371 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
838. Auditar el servicio backend/src/services/sira/generators/text-writers.js (370 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
839. Auditar el servicio backend/src/services/agents/agent-task-plan.js (369 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
840. Auditar el servicio backend/src/services/sira/research-engine.js (368 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
841. Auditar el servicio backend/src/services/business-analyzer.js (367 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
842. Auditar el servicio backend/src/services/sira/speculative-router.js (367 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
843. Auditar el servicio backend/src/services/document-editing/xlsx-adapter.js (365 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
844. Auditar el servicio backend/src/db/pool-instrumentation.js (365 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
845. Auditar el servicio backend/src/services/user-attribution-profile.js (364 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
846. Auditar el servicio backend/src/services/rag/vision-doc-parser.js (362 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
847. Auditar el servicio backend/src/services/codex/office-state.js (361 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
848. Auditar el servicio backend/src/utils/config-validator.js (361 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
849. Auditar el servicio backend/src/services/zip-parser.js (358 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
850. Auditar el servicio backend/src/services/multi-hop-intent-reasoner.js (358 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
851. Auditar el servicio backend/src/services/faithfulness-scorer.js (357 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
852. Auditar el servicio backend/src/services/deployments/connectors/node-container-executor.js (356 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
853. Auditar el servicio backend/src/cache/semantic.js (356 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
854. Auditar el servicio backend/src/services/ai-product-os/planner-agent.js (355 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
855. Auditar el servicio backend/src/services/rag/advanced-patterns.js (355 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
856. Auditar el servicio backend/src/jobs/sweep-stale-system-settings.js (354 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
857. Auditar el servicio backend/src/services/session-manager.js (354 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
858. Auditar el servicio backend/src/services/searchBrain/universal/orchestrator.js (354 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
859. Auditar el servicio backend/src/services/document-comparison-engine.js (352 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
860. Auditar el servicio backend/src/services/agents/understanding-eval-harness.js (352 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
861. Auditar el servicio backend/src/services/document-readability-analyzer.js (350 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
862. Auditar el servicio backend/src/utils/pii-mask.js (350 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
863. Auditar el servicio backend/src/services/personal-lexicon.js (348 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
864. Auditar el servicio backend/src/services/thesis/thesis-engine.js (347 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
865. Auditar el servicio backend/src/services/memory-document.js (346 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
866. Auditar el servicio backend/src/services/agents/agentic-qa-board.js (346 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
867. Auditar el ruta backend/src/routes/research.js (344 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
868. Auditar el servicio backend/src/utils/otel-spans.js (344 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
869. Auditar el servicio backend/src/services/cross-turn-entity-tracker.js (343 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
870. Auditar el servicio backend/src/services/agents/benchmarks/real-toxicity.js (343 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
871. Auditar el servicio backend/src/services/ai/token-budget.js (343 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
872. Auditar el servicio backend/src/services/sira/artifact-engine.js (341 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
873. Auditar el servicio backend/src/services/model-quota-router.js (340 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
874. Auditar el servicio backend/src/services/document-pipeline/pptx-design-system.js (340 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
875. Auditar el servicio backend/src/services/agent-harness/tools/web-fetch-tool.js (340 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
876. Auditar el servicio backend/src/router/ProviderRouter.ts (340 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
877. Auditar el servicio backend/src/services/document-response-fidelity.js (338 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
878. Auditar el servicio backend/src/services/document-audience-tone.js (337 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
879. Auditar el servicio backend/src/services/sira/confidence-calibrator.js (337 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
880. Auditar el servicio backend/src/services/rag/colbert-retrieval.js (337 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
881. Auditar el servicio backend/src/services/agent-audit-log.js (336 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
882. Auditar el servicio backend/src/services/context-attribution-engine.js (335 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
883. Auditar el servicio backend/src/services/docintel/pdf-structure.js (335 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
884. Auditar el servicio backend/src/middleware/enforce-api-key-rate-limit.js (335 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
885. Auditar el servicio backend/src/services/sira/hallucination-scanner.js (333 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
886. Auditar el servicio backend/src/services/software-engineering/wcag-checker.js (333 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
887. Auditar el servicio backend/src/services/sira/tool-error-classifier.js (331 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
888. Auditar el servicio backend/src/services/x-search.js (329 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
889. Auditar el servicio backend/src/services/agents/user-intent-alignment.js (329 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
890. Auditar el servicio backend/src/services/agents/benchmarks/alignment-tax.js (329 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
891. Auditar el servicio backend/src/services/ai/cost-forecast.js (329 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
892. Auditar el servicio backend/src/orchestration/langgraph-engine.js (329 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
893. Auditar el servicio backend/src/services/agents/agent-telemetry.js (328 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
894. Auditar el servicio backend/src/services/observability/otel.js (328 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
895. Auditar el servicio backend/src/services/research/research-query-intelligence.js (327 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
896. Auditar el servicio backend/src/services/document-parsers/index.js (326 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
897. Auditar el servicio backend/src/services/auth/user-session-revocation-events.js (326 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
898. Auditar el servicio backend/src/services/agents/execution-graph.js (326 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
899. Auditar el servicio backend/src/services/agents/benchmarks/truthful-qa.js (326 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
900. Auditar el servicio backend/src/services/sira/agent-skill-registry.js (326 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
901. Auditar el servicio backend/src/services/codex/browser-check.js (326 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
902. Auditar el ruta backend/src/routes/search-brain.js (325 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
903. Auditar el servicio backend/src/middleware/response-cache.js (325 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
904. Auditar el servicio backend/src/utils/error-telemetry.js (325 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
905. Auditar el servicio backend/src/services/usage-monitor.js (324 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
906. Auditar el servicio backend/src/services/agents/benchmarks/bias-eval.js (323 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
907. Auditar el servicio backend/src/services/github/workspace-files.service.js (323 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
908. Auditar el servicio backend/src/services/sira/goal-decomposer.js (322 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
909. Auditar el servicio backend/src/services/codex/company-operations/social-triage.js (322 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
910. Auditar el ruta backend/src/routes/agent-harness.js (321 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
911. Auditar el servicio backend/src/services/goal-worker.js (321 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
912. Auditar el servicio backend/src/services/document-semantic-graph.js (321 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
913. Auditar el servicio backend/src/services/sira/prompt-injection-defenses-v2.js (321 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
914. Auditar el servicio backend/src/rate-limit/dynamic-cost.js (321 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
915. Auditar el servicio backend/src/services/sira/token-ledger.js (320 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
916. Auditar el servicio backend/src/services/csv-dialect-detector.js (319 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
917. Auditar el servicio backend/src/services/sira/context-compactor.js (319 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
918. Auditar el servicio backend/src/services/agents/saga-coordinator.js (317 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
919. Auditar el servicio backend/src/services/providers/anthropic-openai-adapter.js (317 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
920. Auditar el servicio backend/src/services/constraint-adherence.js (316 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
921. Auditar el servicio backend/src/services/sira/parallel-fanout.js (316 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
922. Auditar el servicio backend/src/cache/llm-cache.js (316 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
923. Auditar el servicio backend/src/middleware/upload-static-access.js (316 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
924. Auditar el servicio backend/src/services/chat-attachment-recovery.js (315 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
925. Auditar el servicio backend/src/services/rag/rag-quality.js (315 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
926. Auditar el servicio backend/src/services/codex/anthropic-turn.js (315 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
927. Auditar el servicio backend/src/services/agents/host-code-search-tool.js (314 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
928. Auditar el servicio backend/src/services/user-profile-inference.js (313 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
929. Auditar el servicio backend/src/services/cowork-engine.js (311 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
930. Auditar el servicio backend/src/services/agent-runner/multimodal/computer.js (311 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
931. Auditar el servicio backend/src/health/probe-scheduler.js (310 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
932. Auditar el servicio backend/src/services/sira/llm-instrumentation.js (310 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
933. Auditar el servicio backend/src/services/admin-route-policy.js (309 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
934. Auditar el servicio backend/src/services/memory-consolidation-job.ts (309 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
935. Auditar el servicio backend/src/services/sira/pipeline-errors.js (309 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
936. Auditar el ruta backend/src/routes/attribution-toolkit.js (308 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
937. Auditar el servicio backend/src/services/active-session-validator.js (308 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
938. Auditar el servicio backend/src/services/gear-agent.js (308 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
939. Auditar el servicio backend/src/services/agents/structured-logger.js (308 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
940. Auditar el servicio backend/src/services/sira/llm-observability.js (308 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
941. Auditar el ruta backend/src/routes/accounting.js (307 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
942. Auditar el servicio backend/src/services/agents/agent-plugin-lifecycle.js (306 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
943. Auditar el servicio backend/src/services/sira/memory-store-adapters.js (305 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
944. Auditar el servicio backend/src/services/sira/cortex-pipeline-orchestrator.js (305 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
945. Auditar el servicio backend/src/services/db/sql-safety.js (305 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
946. Auditar el servicio backend/src/services/cross-turn-attribution-chain.js (304 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
947. Auditar el servicio backend/src/services/sira/semantic-tool-cache.js (304 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
948. Auditar el servicio backend/src/services/rag/raptor-tree.js (304 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
949. Auditar el servicio backend/src/services/agents/misunderstanding-signals.js (303 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
950. Auditar el servicio backend/src/services/agents/execution-graph-runner.js (302 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
951. Auditar el servicio backend/src/services/agent-access/keys.js (302 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
952. Auditar el servicio backend/src/services/alerting.js (301 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
953. Auditar el servicio backend/src/services/knowledge-boundary-detector.js (301 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
954. Auditar el servicio backend/src/services/agents/intent-triage-judge.js (300 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
955. Auditar el servicio backend/src/utils/retry-with-backoff.js (300 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
956. Auditar el servicio backend/src/services/security/database-secret-vault.js (299 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
957. Auditar el servicio backend/src/services/agents/metrics.js (299 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
958. Auditar el servicio backend/src/jobs/backfill-appshots-geo-hint.js (298 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
959. Auditar el servicio backend/src/services/agents/durable-execution-store.js (298 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
960. Auditar el servicio backend/src/services/rag/self-rag-critic.js (298 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
961. Auditar el servicio backend/src/services/progress-stream.js (297 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
962. Auditar el servicio backend/src/services/agents/budget.js (297 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
963. Auditar el servicio backend/src/services/db/database-guard.js (297 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
964. Auditar el servicio backend/src/services/agents/eval-harness.js (296 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
965. Auditar el servicio backend/src/services/agents/prompted-tool-calling.js (296 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
966. Auditar el servicio backend/src/services/codex/event-store.js (296 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
967. Auditar el servicio backend/src/services/codex/file-state.js (296 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
968. Auditar el servicio backend/src/utils/secret-redactor.js (296 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
969. Auditar el servicio backend/src/services/reasoning-faithfulness-check.js (295 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
970. Auditar el servicio backend/src/services/self-consistency-checker.js (295 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
971. Auditar el servicio backend/src/services/sira/storage-schema.js (295 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
972. Auditar el servicio backend/src/services/invoice-sync.js (294 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
973. Auditar el servicio backend/src/services/social-company/oauth.js (294 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
974. Auditar el servicio backend/src/services/skills/policy.js (294 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
975. Auditar el servicio backend/src/services/sira/generators/csv-to-xlsx.js (294 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
976. Auditar el servicio backend/src/services/agent-runner/evals/harness.js (293 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
977. Auditar el servicio backend/src/services/file-integrity-validator.js (292 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
978. Auditar el servicio backend/src/services/agents/agentic-execution-profile.js (291 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
979. Auditar el servicio backend/src/services/research/research-discipline-router.js (291 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
980. Auditar el servicio backend/src/services/agents/clone-project-tool.js (290 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
981. Auditar el servicio backend/src/services/sira/cross-signal-coherence.js (290 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
982. Auditar el servicio backend/src/services/agents/admin-scope-enforcer.js (289 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
983. Auditar el servicio backend/src/services/xlsx-safe-workbook.js (288 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
984. Auditar el servicio backend/src/middleware/require-permission.js (287 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
985. Auditar el servicio backend/src/utils/delivery-failure-policy.js (287 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
986. Auditar el servicio backend/src/services/org-activity-feed.js (286 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
987. Auditar el servicio backend/src/services/agents/tool-call-replay-log.js (286 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
988. Auditar el servicio backend/src/services/agents/temporal/temporal-client.js (286 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
989. Auditar el servicio backend/src/auth/hooks.js (286 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
990. Auditar el servicio backend/src/services/agents/intent-triage.js (284 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
991. Auditar el servicio backend/src/health/slo-aggregator.js (283 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
992. Auditar el servicio backend/src/services/auto-file-bridge.js (282 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
993. Auditar el servicio backend/src/services/ai-product-os/durable-workflow.js (282 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
994. Auditar el servicio backend/src/services/bi/semantic-model.js (282 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
995. Auditar el servicio backend/src/services/document-discourse-mapper.js (281 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
996. Auditar el servicio backend/src/services/observability/metrics-exposition.js (281 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
997. Auditar el ruta backend/src/routes/github-codex.js (280 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
998. Auditar el servicio backend/src/services/attribution-prompt-fuzzer.js (280 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
999. Auditar el servicio backend/src/services/document-outline-generator.js (279 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1000. Auditar el servicio backend/src/config/database-url.js (277 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1001. Auditar el servicio backend/src/services/agents/document-merge.js (277 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1002. Auditar el servicio backend/src/cache/embedding-quantizer.js (277 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1003. Auditar el servicio backend/src/utils/bounded-process-tree.js (277 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1004. Auditar el servicio backend/src/services/rbac-system-assignments.js (276 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1005. Auditar el servicio backend/src/services/intent-card-generator.js (276 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1006. Auditar el servicio backend/src/services/sira/vision-deep-analyzer.js (276 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1007. Auditar el servicio backend/src/services/prompt-provenance-tracker.js (275 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1008. Auditar el servicio backend/src/services/agents/github-actions-tool.js (275 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1009. Auditar el servicio backend/src/services/agents/code-bleu.js (275 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1010. Auditar el servicio backend/src/services/cross-chat-retrieval.js (274 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1011. Auditar el servicio backend/src/services/telegram/telegram-control.js (274 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1012. Auditar el servicio backend/src/services/doc-preview.js (273 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1013. Auditar el servicio backend/src/services/goal-cleanup.js (273 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1014. Auditar el servicio backend/src/services/agents/agent-task-queue.js (272 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1015. Auditar el servicio backend/src/services/deployments/provider-connectors.js (272 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1016. Auditar el servicio backend/src/services/rag-store.js (271 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1017. Auditar el servicio backend/src/services/spotify-mcp.js (271 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1018. Auditar el servicio backend/src/services/document-quote-extractor.js (271 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1019. Auditar el servicio backend/src/services/codex/project-service.js (271 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1020. Auditar el servicio backend/src/services/user-memory-store.js (270 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1021. Auditar el servicio backend/src/services/oidc-handler.js (270 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1022. Auditar el servicio backend/src/services/agent-cron/index.js (270 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1023. Auditar el servicio backend/src/scheduler/scheduler.js (270 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1024. Auditar el servicio backend/src/services/agent-approvals.js (269 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1025. Auditar el servicio backend/src/services/batch-context-store.js (269 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1026. Auditar el servicio backend/src/services/agents/hermes-plugin-bridge.js (268 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1027. Auditar el servicio backend/src/services/agents/agent-coder.js (267 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1028. Auditar el servicio backend/src/services/security/owasp-asvs.js (266 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1029. Auditar el servicio backend/src/services/hosting/build.service.js (266 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1030. Auditar el servicio backend/src/services/language-policy.js (265 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1031. Auditar el servicio backend/src/services/agents/align-wrapper.js (265 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1032. Auditar el servicio backend/src/services/agents/canonical-document-ast.js (265 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1033. Auditar el servicio backend/src/services/cross-modal-attribution.js (264 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1034. Auditar el servicio backend/src/services/ppt-vector-shapes.js (264 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1035. Auditar el servicio backend/src/services/intent-attribution-graph/response-validator.js (264 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1036. Auditar el servicio backend/src/services/document-kpi-extractor.js (262 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1037. Auditar el servicio backend/src/services/software-engineering/cwv-budget.js (262 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1038. Auditar el servicio backend/src/services/cache/llm-response-cache.js (262 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1039. Auditar el servicio backend/src/services/document-quality-grade.js (261 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1040. Auditar el servicio backend/src/services/local-computer-bridge.js (261 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1041. Auditar el servicio backend/src/services/agents/audit-log.js (261 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1042. Auditar el servicio backend/src/services/codex/run-queue.js (261 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1043. Auditar el servicio backend/src/services/document-risk-register.js (260 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1044. Auditar el servicio backend/src/services/skills/registry.js (260 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1045. Auditar el servicio backend/src/services/agents/pipeline-registry.js (260 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1046. Auditar el servicio backend/src/services/research/research-library.js (260 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1047. Auditar el servicio backend/src/services/agent-runner/orchestrator/planner.js (260 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1048. Auditar el servicio backend/src/services/agents/hermes-playbook-bridge.js (259 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1049. Auditar el servicio backend/src/services/agents/benchmarks/mbpp.js (259 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1050. Auditar el servicio backend/src/health/probes/synthetic-ping.js (258 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1051. Auditar el servicio backend/src/services/conversation-summarizer.js (258 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1052. Auditar el servicio backend/src/services/agents/benchmarks/humaneval.js (258 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1053. Auditar el servicio backend/src/services/hidden-goal-extractor.js (257 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1054. Auditar el servicio backend/src/services/documentRenderer.js (257 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1055. Auditar el servicio backend/src/services/phone-verification.js (257 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1056. Auditar el servicio backend/src/services/sira/tool-resilience.js (257 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1057. Auditar el servicio backend/src/services/document-action-dashboard.js (256 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1058. Auditar el servicio backend/src/services/ai/elevenlabs-office-soundscape.js (255 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1059. Auditar el servicio backend/src/services/rag/contextual-chunking.js (255 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1060. Auditar el servicio backend/src/services/failed-email-retry.js (254 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1061. Auditar el servicio backend/src/cache/context-invalidation.js (254 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1062. Auditar el servicio backend/src/services/legacy-format-converter.js (253 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1063. Auditar el ruta backend/src/routes/builder.js (252 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1064. Auditar el servicio backend/src/services/social-company/marketing-bridge.js (252 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1065. Auditar el servicio backend/src/services/ai-product-os/adapters/rag-adapter.js (252 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1066. Auditar el servicio backend/src/services/ai-product-os/adapters/eval-adapter.js (252 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1067. Auditar el servicio backend/src/services/intent-planner.js (251 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1068. Auditar el servicio backend/src/services/multi-hop-reasoner.js (251 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1069. Auditar el servicio backend/src/services/agents/host-file-tool.js (251 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1070. Auditar el servicio backend/src/services/codex/company-operations/inbox-triage.js (251 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1071. Auditar el servicio backend/src/i18n/audit.js (251 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1072. Auditar el servicio backend/src/services/document-section-classifier.js (250 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1073. Auditar el servicio backend/src/services/thesis/citation-verifier.js (250 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1074. Auditar el servicio backend/src/services/software-engineering/seo-validator.js (250 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1075. Auditar el servicio backend/src/services/ai/auth-profile-rotation.js (250 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1076. Auditar el servicio backend/src/services/rag/context-curation.js (250 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1077. Auditar el servicio backend/src/middleware/require-scope.js (250 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1078. Auditar el servicio backend/src/services/text-encoding-detector.js (249 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1079. Auditar el servicio backend/src/services/agents/mime-type-validator.js (249 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1080. Auditar el servicio backend/src/services/sira/chat-modes.js (249 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1081. Auditar el servicio backend/src/services/agent-runner/evals/optimizer.js (249 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1082. Auditar el servicio backend/src/services/desktop-action-policy.js (248 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1083. Auditar el servicio backend/src/services/attribution-stack-runner.js (248 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1084. Auditar el servicio backend/src/services/attribution-explainer.js (248 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1085. Auditar el servicio backend/src/services/agent-runtime/cira-kernel.js (248 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1086. Auditar el servicio backend/src/services/document-pipeline/pptx-deck-designer.js (248 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1087. Auditar el servicio backend/src/services/document-status.js (247 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1088. Auditar el servicio backend/src/services/agents/executor.js (247 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1089. Auditar el servicio backend/src/services/rag/cohere-rerank.js (247 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1090. Auditar el servicio backend/src/services/intent-attribution-graph/attribution-graph.js (246 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1091. Auditar el servicio backend/src/services/software-engineering/sbom.js (246 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1092. Auditar el servicio backend/src/middleware/static-precompressed.js (246 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1093. Auditar el servicio backend/src/services/agents/web-search/providers/brave.js (245 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1094. Auditar el servicio backend/src/services/ai-product-os/memory-layer.js (245 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1095. Auditar el servicio backend/src/services/codex/department-pools.js (245 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1096. Auditar el servicio backend/src/services/deployments/connectors/hostinger-vps-executor.js (245 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1097. Auditar el servicio backend/src/services/token-attribution-tracer.js (244 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1098. Auditar el servicio backend/src/services/agents/agent-system.js (244 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1099. Auditar el servicio backend/src/services/rag/metadata-router.js (244 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1100. Auditar el servicio backend/src/services/domain-calibration.js (243 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.
1101. Auditar el servicio backend/src/services/platform-improvements.js (243 líneas): extraer I/O y reglas, añadir un test de authz/error honesto, y si genera texto asegurar native-llm (Flash/Pro) en vez de un client residual.

— Fin del catálogo: **1101 ítems** honestos citados al árbol vivo `/opt/siragpt` (VPS 62.72.11.231, 2026-08-15).
