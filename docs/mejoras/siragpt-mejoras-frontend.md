# Catálogo de mejoras frontend — SiraGPT (árbol vivo)

Fuente: inspección SSH de `/opt/siragpt` en el VPS vivo (root@62.72.11.231), 15 ago 2026 (hora Lima).
No es un dump inventado: cada ítem cita un archivo, ruta o superficie que existe hoy (679 módulos FE vivos, 69 `page.tsx`, 170 `.bak`, 10 AppleDouble).

**Reglas que este catálogo respeta**
- Generate = DeepSeek V4 Flash o DeepSeek V4 Pro nativo (`api.deepseek.com`). Nunca proponer OpenRouter como path de generación.
- No reabrir F0–F5 (cerradas en `STATE.md` / `ROADMAP.md`). F6+ se lista como oleada, no como trabajo a mezclar con F5.
- El trabajo de PC real / oficina 3D / composer logos lo lleva otro agente: no es el ítem 1 ni se duplica como «hacer el computador».
- Si un ítem es higiene (`.bak`, `._*`) es porque esos archivos están hoy en el árbol de producción.

Estructura = superficies reales: `/chat`, `/code`, Admin, Gateway/MCP/memoria, Sandbox/R2, Auth/billing/orgs, Mobile, candado DeepSeek, F6–F12 UI, higiene, tests.


## /chat — AgentRunner, SSE, Word/PPT, live activity, multi-chat

1. Partir components/chat-interface-enhanced.tsx (13158 líneas, 194 `: any`) en Composer, Timeline, SSE client, Artifacts y Media, dejando el barrel actual como fachada para /chat.
2. Sustituir los 43 `as any` de components/chat-interface-enhanced.tsx por tipos de lib/api-types.ts y de los eventos `stage` de F3, empezando por el map de adjuntos de imagen (~línea 527).
3. Quitar los 7 `eslint-disable` de components/chat-interface-enhanced.tsx y corregir las reglas reales (hooks deps y any) en vez de silenciarlas.
4. Conectar lib/live-activity.ts con las labels F4 del backend (Planificando, Delegando a sub-agente, Replanificando, Presupuesto agotado) para que no caigan al fallback «Pensando…».
5. Añadir en lib/live-activity.ts entradas para glob, grep, edit_file, list_files, render_preview y set_slide_background que el runner ya emite.
6. Persistir los chips de components/chat/RunningChatsBar.tsx en sessionStorage vía lib/running-chat-jobs.ts para que un refresh no pierda jobs SSE en vuelo.
7. Hacer que RunningChatsBar cancele de verdad con POST /api/ai/stop-stream + AbortSignal, no solo oculte el chip.
8. Añadir aria-live="polite" y atajo Escape en components/chat/RunningChatsBar.tsx para anunciar y cerrar el job activo.
9. Completar lib/sse-reconnect.ts para reanudar /api/ai/generate con Last-Event-ID (contrato F3 ya existe en el backend).
10. Exponer en lib/sse-reconnect.ts un tope de reintentos con backoff y un evento `sse_give_up` que la UI muestre como error honesto, no un spinner eterno.
11. Hacer que ArtifactCard.tsx muestre error y botón Reintentar cuando el presigned R2 expire (hoy el <a> queda muerto).
12. Añadir aria-describedby y atajo de teclado al botón de descarga de components/chat/ArtifactCard.tsx (14 controles, 2 aria).
13. Virtualizar la lista de versiones en components/chat/ArtifactPanel.tsx y no recargar el blob entero al cambiar de versión.
14. Anunciar el progreso de upload a lectores de pantalla en components/chat/ChatComposerSurface.tsx (aria-live + porcentaje).
15. En components/chat/ChatEmptyStateHero.tsx mostrar solo DeepSeek V4 Flash/Pro como modelos de generación, nunca un placeholder OpenRouter.
16. Restaurar chips de components/chat/chat-session-chips.tsx tras F5 usando el mismo store que RunningChatsBar, sin duplicar estado.
17. En components/chat/ComposerInlineDisplays.tsx no montar ExcelRibbon/WordConnector hasta que el usuario abra el adjunto (ahorra ~4k líneas en el primer paint de /chat).
18. Poner timeout visible y cancelable en components/chat/LongOperationIndicator.tsx alineado con el AbortSignal F3.
19. Aislar components/chat/cowork-panel.tsx detrás de un error boundary propio para que un fallo de cowork no tumbe el hilo de chat.
20. En components/chat/grok-voice-panel.tsx dejar claro que la transcripción no cambia el candado DeepSeek del turno de generación.
21. Hacer que components/chat/diff-block.tsx sea navegable con teclado (siguiente/anterior hunk) y anuncie el resumen del diff.
22. Añadir app/chat/error.tsx con reset() que remonte ChatInterfaceEnhanced sin perder conversationId.
23. Añadir app/chat/loading.tsx con skeleton del composer + timeline, no el spinner genérico de app/loading.tsx.
24. Memoizar components/message-component.tsx (3437 líneas) por messageId y extraer bloques de código/tablas a hijos para recortes de teclado.
25. Virtualizar el timeline de /chat cuando haya >80 mensajes (components/virtual-scroll.tsx ya existe y no se usa en el hilo principal).
26. En components/agentic-steps.tsx consumir el shape `type:'stage'` de F3 de forma exhaustiva (cancelled, budget_exceeded, plan_failed) en vez de ignorar steps desconocidos.
27. En components/thinking-trace.tsx mostrar iteration/attempt que el backend ya manda en toStageEvent.
28. En components/agent-trace.tsx no re-parsear el SSE completo en cada chunk; append-only sobre el buffer de lib/stream-buffer.ts.
29. Hacer que components/SourcesChip.tsx abra el panel con foco inicial en el primer source y Escape para cerrar.
30. En components/sources-panel.tsx marcar el HTML de fuentes como untrusted (mismo contrato que F6: datos, no instrucciones) y no ejecutar scripts embebidos.
31. En components/SlashCommandMenu.tsx filtrar comandos que disparen generación para que solo listen DeepSeek Flash/Pro.
32. En components/ChatSearchDialog.tsx (4 controles, 1 aria) añadir role=dialog, focus trap y resultados anunciados.
33. En components/paste-preview-overlay.tsx confirmar con teclado (Enter/Escape) y no solo click.
34. En components/file-upload-progress.tsx exponer estado de error por archivo (no un único toast) cuando /api/files falle.
35. En components/GlobalDropRedirector.tsx no redirigir a /code un drop de .docx/.pptx destinado a /chat.
36. En lib/chat/composer-queue.ts persistir la cola en IndexedDB para sobrevivir un crash del tab a mitad de un lote Word/PPT.
37. En lib/chat/composer-files.ts rechazar adjuntos > límite de lib/document-batch-limits.ts con mensaje en español antes de tocar la red.
38. En lib/chat/turn-cancellation.ts unificar Stop del composer con RunningChatsBar y con POST /api/ai/stop-stream.
39. En lib/chat/catalog-model.ts devolver solo deepseek-v4-flash y deepseek-v4-pro; borrar slugs OpenRouter residuales.
40. En lib/hydrate-streaming-chat.ts no hidratar un turno cancelado como si hubiera terminado (el backend emite `cancelled`, no `final`).
41. En lib/background-streams-context.tsx limitar streams concurrentes y mostrar el tope en RunningChatsBar.
42. En lib/pending-messages.ts reintentar solo idempotente (mismo clientMessageId) y no duplicar el turno al volver de offline.
43. En lib/attachment-ingest.ts calcular hash del archivo y reutilizar el fileId si el usuario re-adjunta el mismo PPT.
44. En lib/long-paste.ts (1109 líneas) extraer el chip de umbral a un módulo y no leer process.env en cada keystroke del composer.
45. En lib/rich-clipboard.ts sanitizar HTML pegado (hoy se reenvía al backend como contexto) para no inyectar markup ejecutable en el prompt.
46. En lib/upload-with-progress.ts abortar el XHR al desmontar /chat y no dejar uploads zombie.
47. En lib/message-preservation.ts no preservar un mensaje cuyo stream terminó en agent_runner_failed como si fuera respuesta válida.
48. En lib/chat-context-integrated.tsx (4279 líneas) partir el provider en session/messages/composer para evitar re-renders de todo /chat.
49. En lib/ai-service.ts (1252 líneas) eliminar classifyIntentFastPath de los paths de documento: F2 ya exige runner-first en el backend.
50. En lib/agent-task-service.ts no caer a /api/agent/task con un modelo OpenRouter si el catálogo local aún lo lista.
51. En components/WordConnector.tsx lazy-load y no registrar handlers de ribbon hasta que haya un .docx activo.
52. En components/ExcelRibbon.tsx (2904 líneas, 332 controles, 0 aria) etiquetar cada control del ribbon y extraer grupos a subcomponentes.
53. En components/ExcelConnector.tsx no bloquear el hilo principal parseando xlsx en el main thread; mover a worker.
54. En components/document-preview.tsx reutilizar UnifiedDocumentViewer en vez de un preview paralelo que diverge en PPT.
55. En components/viewers/UnifiedDocumentViewer.tsx (2664 líneas) partir PDF/DOCX/PPTX/XLSX en loaders y cachear la página visible.
56. En components/presentation-view.tsx (13 controles, 0 aria) añadir roles de diapositiva y atajos ←/→ anunciados.
57. En components/doc/doc-artifact-display.tsx (5 controles, 0 aria) mostrar la versión del GeneratedArtifact y un link a historial.
58. En components/doc/file-version-history-dialog.tsx comparar dos versiones de PPT/DOCX con diff-block, no solo la lista.
59. En components/office-clipboard-bridge.tsx fallar honesto si el clipboard API no está (Safari iOS) en vez de un no-op silencioso.
60. En components/ExtractedDataDownload.tsx etiquetar el formato de descarga (xlsx/csv/json) para lectores de pantalla.
61. En components/TableControls.tsx no inyectar estilos globales que pisen el markdown del chat.
62. En components/MessageActionRail.tsx hacer las acciones (copiar, regenerar, compartir) alcanzables con Tab y no solo hover.
63. En components/thinking-placeholder.tsx usar el mismo copy que activityTextFromEvent para no mentir «Pensando» cuando el tool es create_presentation.
64. En components/offline-banner.tsx distinguir offline de red vs SSE caído (lib/sse-reconnect) con acciones distintas.
65. En components/BrowserActivityViewer.tsx (F6 UI) no montarlo en /chat hasta que web_search/web_fetch estén gated por flag.
66. En hooks/use-file-processing-status (si existe en el barrel de chat) no pollinear /api/files/:id cuando el fileId ya está ready.
67. En app/chat/page.tsx (14 líneas) no importar el chat 13k de forma síncrona: next/dynamic con ssr:false y loading local.
68. En lib/chat/message-rendering.ts memoizar el split markdown y no re-tokenizar en cada chunk SSE.
69. En lib/chat/composer-dictation.ts no enviar la transcripción al generate hasta que el usuario confirme, para no gastar un turno Flash accidental.
70. En lib/chat/browser-controller.ts alinear el contrato con backend/src/services/agent-runner/browser/ (F6) y no con un stub local.
71. En lib/chat/branch-metadata.ts persistir la rama elegida en el message, no solo en memoria del tab.
72. En components/markdown/memo-markdown-block.tsx evitar re-render de bloques ya cerrados durante el stream.
73. En lib/markdown-block-split.ts tratar fences de pptx/xml como no-ejecutables.
74. En lib/stream-buffer.ts documentar y testear el flush de 16KB/50ms que el backend ya soporta con SIRAGPT_SSE_BATCH_MS.
75. En components/ui/custom-code-block.tsx no usar highlight síncrono en bloques >200 líneas dentro del timeline.
76. En components/ui/shiki-code-view.tsx lazy-load de grammars; el chat no necesita todas las lenguas al primer token.
77. En lib/download-utils.ts usar el filename del ArtifactCard (GeneratedArtifact) y no un blob innominado.
78. En lib/retry-after-fetch.ts respetar Retry-After de /api/ai/generate (402 DeepSeek) y no reintentar en loop.
79. En lib/authenticated-fetch.ts no loguear Authorization ni cookies en dev-log cuando el generate falle.
80. En lib/request-queue.ts priorizar stop-stream sobre un generate encolado.
81. En lib/toast-helper.ts no spamear un toast por cada stage F3; agrupar en live-activity.
82. En components/error-boundary.tsx reportar conversationId y lastEventId a Sentry sin el prompt del usuario.
83. En components/provider-error-boundary.tsx cubrir el árbol de /chat además del root.
84. En lib/client-logs.ts redactar DEEPSEEK_API_KEY y tokens si alguien pega un .env en el composer.
85. En components/Images/ImageHistoryPanel.tsx no mezclar el historial de imagen con artefactos Word/PPT del mismo hilo.
86. En components/MusicGenerationComponent.tsx y VideoGenerationComponent.tsx dejar explícito que el texto del turno sigue yendo a DeepSeek, no a OpenRouter.
87. En components/speech-to-text-component.tsx (0 aria) etiquetar el botón de mic y el estado de escucha.
88. En components/text-to-speech-component.tsx (17 controles, 0 aria) no autoplay sin gesto y exponer pausa por teclado.
89. En components/voice-controls.tsx no acoplar TTS al generate: el candado DeepSeek no debe esperar a ElevenLabs.
90. En components/KeyboardShortcutsModal.tsx documentar Stop, nuevo hilo, y cambiar Flash/Pro.
91. En components/composer-char-counter.tsx avisar el tope de tokens del runner (SIRAGPT_AGENT_RUNNER_MAX_TOKENS=3072) no un char count cosmética.
92. En lib/composer-layout.ts no recalcular layout en cada token SSE.
93. En lib/composer/upload-batching.ts fallar el lote si un solo PPT supera el tope y no subir el resto en silencio.
94. En components/file-processing-badge.tsx mapear stages del vocabulario real (lib/file-processing-vocab) incluyendo OCR fallido.
95. En lib/attachments/registry.ts no perder el mime de un .pptx renombrado a .zip.
96. En lib/attachments/media-meta.ts no bloquear el composer leyendo EXIF en el main thread.
97. En lib/attachments/paste-router.ts mandar un screenshot pegado a visión (F7 stub) y un .docx pegado a ArtifactCard, no al mismo path.
98. En lib/attachments/html-to-markdown.ts escapar markdown que parezca tool_call para no confundir al runner.
99. En lib/message-render-policy.ts ocultar tool_result crudos en /chat (el usuario ve stage + artifact, no JSON).
100. En lib/interactive-message-blocks.ts no ejecutar bloques interactivos de un share público sin auth.
101. En components/artifact/interactive-artifact-display.tsx sandboxar el iframe (null origin) igual que el preview de /code.
102. En components/plan/plan-artifact-display.tsx (0 aria) etiquetar aceptar/rechazar plan del orquestador F4.
103. En components/viz/viz-artifact-display.tsx no hidratar Plotly hasta viewport.
104. En components/SearchPanel.tsx no disparar web_search desde /chat hasta F6; mostrar «próximamente» honesto.
105. En components/SearchSourceSelector.tsx no listar proveedores que el candado DeepSeek no usa para generar.
106. En components/papers-result-card.tsx marcar el abstract como datos no-instrucción (mismo contrato F6).
107. En lib/academic-search-intent.ts no reescribir el prompt del usuario hacia un modelo OpenRouter.
108. En components/research/ResearchResultsWorkbench.tsx no mezclar citas con el ArtifactCard de un PPT generado en el mismo hilo.
109. En lib/research-results.ts persistir el corpus por conversationId, no global.
110. En components/ThesisGenerator.tsx (0 aria) no usar /chat como motor si thesis tiene su propia ruta; o al revés, reutilizar AgentRunner.
111. En components/ThesisChatConnector.tsx evitar un segundo SSE paralelo al de /chat sobre el mismo conversationId.
112. En app/document-cycle/page.tsx reutilizar el runner-first de /chat en vez de un ciclo profesional paralelo que ignora F2.
113. En components/syncfusion o SyncfusionBannerRemover.tsx no esconder errores de licencia como si el PPT se hubiera renderizado.
114. En lib/document-service.ts alinear el client con /api/doc/generate runner-first (error honesto, no pipeline genérico).
115. En lib/document-chat-request.ts enviar el lastArtifactId para follow-ups «ponlas rosadas» (contrato de última versión).
116. En components/download-buttons.tsx (0 aria) etiquetar formato y tamaño del artifact.
117. En app/documents/page.tsx y app/documents/editor/page.tsx compartir el viewer con /chat para no divergir en PPT.
118. En lib/hero-presentation.ts no generar un deck stub en el empty state de /chat (el fast-path stub ya se prohibió en F1).
119. En components/BrandCycle.tsx (1031 líneas) no montarlo dentro del timeline de chat; es landing.
120. En components/StarSparkles.tsx no animar por rAF en /chat si prefers-reduced-motion.
121. En components/BottomGlowBar.tsx no forzar repaint en cada token.
122. En components/LiquidButton.tsx usar un button nativo con el glow como CSS, no un div clickeable.
123. En components/dotmatrix-loader.css no aplicarlo al Stop del chat (parece que sigue generando).
124. En lib/dotmatrix-core.tsx code-split fuera de /chat.
125. En components/app-sidebar.tsx (2152 líneas) extraer la lista de hilos de /chat y virtualizarla.
126. En components/sidebar/sidebar-folders-dropdown.tsx no recargar todos los chats al abrir una carpeta.
127. En components/app-wrapper.tsx no envolver /chat con providers de code/office 3D.
128. En lib/app-wrapper-routes.ts mantener /chat fuera del bundle de /code.
129. En components/route-transition-shell.tsx no abortar el SSE de /chat en un cambio de querystring.
130. En components/navigation-transition-context.tsx preservar el conversationId al ir a /code y volver.
131. En components/layout-client-effects.tsx no registrar listeners globales que pisen Cmd+Enter del composer.
132. En app/layout.tsx no cargar el catálogo admin de modelos en el shell de /chat.
133. En components/root-providers.tsx lazy-load PostHog/Sentry para no retrasar el primer token.
134. En components/posthog-client-init.tsx no enviar el texto del prompt (PII) en eventos de /chat.
135. En components/sentry-client-init.tsx scrub de Authorization y de tool_result con OOXML.
136. En lib/web-vitals.ts reportar TTFB del primer evento SSE de /chat como métrica propia.
137. En public SW (lib/sw-register.ts) no cachear /api/ai/generate ni EventSource.
138. En app/offline/page.tsx explicar que los jobs de RunningChatsBar se reanudan al volver, no se pierden.
139. En components/PWAInstallPrompt.tsx no bloquear el composer de /chat en el primer visit.
140. En components/CreditsBadge.tsx mostrar un 402 DeepSeek como «saldo de generación agotado», no un error genérico de OpenRouter.
141. En components/UpgradeModal.tsx (0 aria) focus trap y no mencionar proveedores distintos de DeepSeek para chat.
142. En components/notification-center.tsx agrupar «PPT listo» con el ArtifactCard del hilo, no como toast suelto.
143. En lib/notifications/push.ts no mandar el título del documento en claro si la org lo marca privado.
144. En components/connection-status.tsx distinguir backend down vs DeepSeek 402 vs sandbox gVisor fail-closed.
145. En lib/next-health.ts que /chat no pinte «listo» si /api/health/ready reporta R2 o runner caídos.
146. En components/impersonation-banner.tsx persistir en todos los generate de /chat el actor real (ya hay backend de impersonation).
147. En lib/auth-context-integrated.tsx no re-fetch de sesión en cada token SSE.
148. En components/auth-guard.tsx devolver a /auth/login con next=/chat?c=… para no perder el hilo.
149. En app/share/[shareId]/page.tsx y share/message: no abrir un generate DeepSeek desde un share anónimo.
150. En lib/polling-registry.ts no pollinear chats compartidos con el mismo intervalo que un hilo vivo.
151. En components/chat/._RunningChatsBar.tsx y demás AppleDouble: borrar el archivo `._*` (no es código).

## /code — departamentos, oficina 3D, composer, canvas, computadoras, Panel/Controlar/Archivos/Recursos

152. Partir components/code/agent-company-panel.tsx (7381 líneas) en flota, departamentos, header y recursos; el trabajo de PC real lo lleva otro agente — no rehacer colocación 3D aquí.
153. Partir components/code/ai-code-chat-panel.tsx (6003 líneas) en composer, timeline y adjuntos, reutilizando ChatComposerSurface donde el contrato coincida.
154. En lib/code-agent/model-policy.ts (ya prefiere DeepSeek V4) rechazar cualquier slug que no sea deepseek-v4-flash o deepseek-v4-pro; no devolver Cerebras/GPT ni OpenRouter.
155. En components/code/code-workspace.tsx reemplazar los 4 window.confirm por un dialog accesible (foco, Escape, aria-modal).
156. Añadir app/code/error.tsx que capture fallos de CodeWorkspace/AgentCompanyPanel sin tumbar /chat.
157. En components/code/code-hub.tsx no prefetch del office 3D (agent-office-scene 2207 líneas) hasta que el usuario abra Oficina.
158. En components/code/workspace-top-bar.tsx hacer Panel/Controlar/Archivos/Recursos un tablist con flechas y aria-selected (hoy WorkspacePanelId solo cubre preview/terminal/git/validation).
159. En lib/workspace-tools-registry.ts registrar Panel/Controlar/Archivos/Recursos como destinos de teclado y deep-link (?tab=archivos).
160. En components/code/workspace-tools-menu.tsx (9 controles, 0 aria) etiquetar cada tool y no usar iconos-only.
161. En components/code/workspace-tool-panels.tsx (3114 líneas, 146 controles, 2 aria) partir paneles y etiquetar tabs.
162. En components/code/file-tree-panel.tsx virtualizar árboles >200 nodos y soportar typeahead.
163. En components/code/terminal-panel.tsx no perder el scrollback al cambiar de departamento; persistir por computerId.
164. En components/code/monaco-code-area.tsx dispose del editor al cerrar la tab (hoy se filtran modelos Monaco).
165. En components/code/editor-panel.tsx (0 aria) etiquetar split y el archivo activo.
166. En components/code/preview-pane.tsx (1994 líneas) sandboxed iframe (null origin, no-scripts) y no reusar el preview entre tenants.
167. En components/code/diff-view.tsx anunciar +/- y permitir siguiente cambio con teclado.
168. En components/code/git-tool-real.tsx (15 controles, 0 aria) etiquetar stage/commit/push y confirmar push con dialog.
169. En components/code/publishing-tool-real.tsx (1717 líneas, 89 controles, 2 aria) extraer el formulario de dominio y no bloquear el composer.
170. En components/code/company-resources-surface.tsx (1216 líneas) paginar Recursos y no cargar todos los blobs R2 al abrir la tab.
171. En components/code/project-invite-dialog.tsx (0 aria) focus trap, roles, y no filtrar el token de invite en la URL del referrer.
172. En components/code/code-chat-error-boundary.tsx reportar projectId/departmentId y ofrecer «abrir solo Archivos».
173. En components/code/dept-chat-bard.tsx no montar un segundo generate paralelo al de ai-code-chat-panel sobre el mismo run.
174. En components/code/enterprise-command-center.tsx (834 líneas) no disparar flota PROACTIVO sin confirmación (lib/code-agent-company-proactive.ts lo pide).
175. En components/code/new-tab-pane.tsx no clonar el sandbox del departamento al abrir una tab vacía.
176. En components/code/search-panel.tsx (code) usar el grep del runner (F1 tool) y no un scan en el browser de todo el repo.
177. En components/code/chat-empresa-fab.tsx no tapar el composer en mobile; respetar safe-area.
178. En components/code/project-chip.tsx no truncar el nombre sin title/tooltip accesible.
179. En components/code/department-computer-pane.tsx (otro agente hace el PC real) solo: no duplicar el header que code-workspace ya pinta.
180. En components/code/agent-office/agent-office-scene.tsx (2207 líneas) pausar el rAF cuando la tab Oficina no está visible (Page Visibility).
181. En components/code/agent-office/agent-office-city.ts (2040 líneas) code-split del mesh; no entra en el bundle de /chat.
182. En components/code/agent-office/agent-office-overlay.tsx no capturar rueda/teclado cuando el usuario está en el composer.
183. En components/code/agent-office/office-live-preview.tsx no hacer polling del preview si el departamento está idle.
184. En components/code/agent-office/use-office-soundscape.ts respetar prefers-reduced-motion y el mute global de settings.
185. En components/code/agent-office/agent-office-visual-state.ts no interpolar estado a 60fps cuando no hay cambios de agentes.
186. En components/code/agent-office/agent-office-layout.ts documentar el contrato de slots (lib/agent-company-slot.ts) para no pelear con el otro agente.
187. En components/code/browser-voice-player.tsx no autoplay voz de departamento; gesto explícito.
188. En components/code/activity-bar.tsx alinear iconos con Panel/Controlar/Archivos/Recursos y no con un set VS Code incompleto.
189. En lib/code-workspace-context.tsx (1131 líneas) partir files/selection/computers para no re-renderizar Monaco en cada tick de oficina.
190. En lib/code-workspace-utils.ts no serializar el workspace completo a localStorage (cuota y secretos en .env del proyecto).
191. En lib/code-workspace-tools.ts y lib/code-workspace-route.ts deep-link /code?project=&tab=recursos estable al recargar.
192. En lib/code-chat-sessions.ts persistir el hilo por departamento, no un único chat por proyecto.
193. En lib/code-chat-plan-label.ts mapear labels F4 (Planificando/Delegando) iguales que /chat.
194. En lib/code-chat-blocker.ts bloquear generate si el candado DeepSeek no tiene Flash/Pro disponibles.
195. En lib/code-agent/orchestrator.ts (1077 líneas) no inventar un orquestador FE: delegar en backend/src/services/agent-runner/orchestrator/.
196. En lib/code-agent/prompts.ts no pedir al modelo que use OpenRouter ni modelos no-DeepSeek.
197. En lib/code-agent/quality-gate.ts fallar el gate si el diff toca .env o docker-compose.prod.yml.
198. En lib/code-agent/vite-app-template.ts y vite-scaffold.ts no meter API keys en el template.
199. En lib/code-agent/composer-attachments.ts reutilizar lib/chat/composer-files.ts (mismos topes y mime).
200. En lib/code-agent/composer-mode-config.ts no habilitar un modo que cambie el modelo fuera de Flash/Pro.
201. En lib/code-agent/apps-mode-contract.ts alinear con /api/codex/projects/:id/runs, no con app/api/agents/run (el gateway F11 lo dice).
202. En lib/code-agent/codex-engine-mapping.ts mapear solo a DeepSeek V4; borrar aliases OpenRouter.
203. En lib/code-agent/codex-file-pull.ts no bajar el repo entero al browser; pedir paths al backend.
204. En lib/code-agent/spoken-summary.ts no leer secretos del diff en voz alta.
205. En lib/code-agent/escape.ts unificar con el shQuote del sandbox F5.
206. En lib/code-agent/workspace-diff.ts no computar diff de binarios (pptx/png) en el cliente.
207. En lib/code-agent-company.ts no activar TODOS los departamentos en un click sin dialog (el prompt de proactive ya lo advierte).
208. En lib/code-agent-company-proactive.ts cortar la flota si el backend devuelve budget_exceeded F4.
209. En lib/company-agent-file-reports.ts no fetchear reportes de todos los depts al abrir Panel.
210. En lib/company-resource-keys.ts y company-resource-access.ts firmar URLs R2 de Recursos con TTL corto (backend R2_PRESIGNED_URL_TTL_SECONDS).
211. En lib/codex/run-stream.ts reutilizar lib/sse-reconnect.ts (Last-Event-ID) en vez de un EventSource ad-hoc.
212. En lib/codex/turn-cancellation.ts y cancel-run-family.ts llamar al cancel F3 del runner/codex, no solo abortar el fetch.
213. En lib/codex/timeline-reducer.ts aceptar eventos `stage` F3/F4 además del timeline Codex viejo.
214. En lib/codex/api/company.ts no cachear departamentos sin ETag; el otro agente cambia el PC en vivo.
215. En lib/codex/api/runs.ts no reintentar un run 402 DeepSeek.
216. En lib/codex/api/types.ts marcar model como union 'deepseek-v4-flash' | 'deepseek-v4-pro'.
217. En lib/codex/api/projects.ts no exponer invite tokens en query logs.
218. En lib/codex/api/swarms.ts respetar SIRAGPT_ORCHESTRATOR_MAX_NODES del backend.
219. En lib/codex/api/publication.ts no publicar si el quality-gate FE o BE falló.
220. En lib/codex/api/checkpoints.ts no restaurar un checkpoint de otro userId (el backend debe negar; el client no debe ofrecer el botón).
221. En lib/codex/model-tiers.ts borrar tiers que no sean Flash/Pro.
222. En lib/codex/slash-commands.ts no incluir /model openrouter.
223. En lib/codex/use-codex-run.ts y use-codex-health.ts no pollinear a 250ms en idle.
224. En lib/codex/use-stick-to-bottom.ts respetar si el usuario scrolleó hacia arriba (igual que /chat).
225. En lib/codex/workspace-tabs.ts persistir Panel/Controlar/Archivos/Recursos.
226. En lib/codex/format.ts no formatear tool_result como éxito si ok=false.
227. En lib/codex-workspace-identity.ts no reutilizar projectId entre orgs.
228. En lib/code-preview-build.ts no buildear en el browser un repo > umbral; mandarlo al host-runner.
229. En lib/code-preview-start-fence.ts no ejecutar fences de markdown como shell.
230. En lib/code-detection.ts no clasificar un .pptx como proyecto de código.
231. En lib/code-templates.ts quitar el template REACT_TODO de producción o marcarlo demo.
232. En lib/code-runner/host-runner-service.ts alinear timeouts con backend/src/services/code/host-runner.js.
233. En lib/local-folder-workspace.ts no indexar node_modules ni .git en el file tree del browser.
234. En lib/github-codex-service.ts no mandar el token GitHub al prompt del runner.
235. En lib/opencode/opencode-service.ts y use-opencode-engine.ts no usar un engine que bypasee el candado DeepSeek.
236. En components/codex/codex-workspace-tree.tsx virtualizar y no seleccionar archivos binarios para el composer.
237. En components/codex/codex-agent-panel.tsx (8 controles, 1 aria) reutilizar live-activity.
238. En components/codex/codex-folders-sidebar.tsx no cargar el árbol de todos los proyectos al entrar a /codex.
239. En components/codex/run-timeline.tsx (0 aria en chips) anunciar cada stage.
240. En components/codex/files-tab.tsx no prefetch de blobs R2.
241. En components/codex/plan-card.tsx (0 aria) etiquetar Aprobar/Rechazar del plan F4.
242. En components/codex/action-chips-row.tsx no chips que disparen generate sin confirmación.
243. En components/codex/dictation-button.tsx mismo contrato que composer-dictation de /chat.
244. En components/codex/checklist-tab.tsx persistir checks en el run, no en useState suelto.
245. En components/codex/tool-permission-card.tsx (0 aria) confirmar tools peligrosas (HITL P14).
246. En components/codex/power-selector.tsx (0 aria) solo Flash/Pro.
247. En components/codex/action-required-card.tsx focus al aparecer (HITL).
248. En components/codex/bottom-tab-bar.tsx mapear a Panel/Controlar/Archivos/Recursos.
249. En components/codex/web-tab.tsx no habilitar browser hasta F6.
250. En components/codex/reasoning-block.tsx no mostrar chain-of-thought crudo en shares.
251. En components/codex/composer.tsx reutilizar ChatComposerSurface.
252. En components/codex/plan-toggle.tsx no cambiar el modelo al togglear plan.
253. En components/workspace/git-pane.tsx (26 controles, 0 aria) etiquetar y no usar window.confirm crudo.
254. En components/workspace/import-repo-panel.tsx (0 aria) validar URL y no clonar en el cliente.
255. En components/workspace/file-tree.tsx (0 aria) keyboard nav tipo VS Code.
256. En components/workspace/github-connect-card.tsx no mostrar el token parcial.
257. En app/codex/page.tsx añadir loading/error propios (hoy faltan ambos).
258. En app/workspace/page.tsx y workspace/[id] no duplicar CodeWorkspace; redirigir a /code?project=.
259. En app/projects/[id]/page.tsx (1052 líneas) extraer docs/marco-teorico y no embeber el runner de /chat dos veces.
260. En components/projects/documents-section.tsx implementar el TODO(perf) de delta API (línea 48) en vez de refetch completo.
261. En components/projects/create-project-dialog.tsx (0 aria) focus trap.
262. En lib/projects-service.ts no listar proyectos de otra org si el header X-Org falta.
263. En lib/project-templates.ts no incluir secrets de ejemplo reales.
264. En lib/publishing-console.ts no loguear el comando con tokens.
265. En components/deployments/manage-tab.tsx (21 controles, 1 aria) etiquetar restart/rollback.
266. En components/deployments/overview-tab.tsx no pollinear logs a 1s en background.
267. En components/deployments/logs-tab.tsx virtualizar y no traer stdout completo.
268. En components/deployments/domains-tab.tsx confirmar delete de dominio.
269. En components/deployments/publish-pipeline.tsx (0 aria) anunciar etapas.
270. En components/deployments/create-deployment-dialog.tsx focus trap.
271. En components/deployments/workspace-deployments-tool.tsx no desplegar si el quality-gate de /code falló.
272. En lib/deployments/deployments-api.ts no reintentar un 402/403.
273. En components/builder/ResultPanel.tsx (0 aria) y QuestionCard: no generar con un modelo fuera de DeepSeek.
274. En lib/builder/intake-service.ts alinear con AgentRunner, no con un LLM client propio.
275. En app/builder/page.tsx loading/error.
276. En components/design/design-composer.tsx no bypassear el candado DeepSeek.
277. En components/design/create-panel.tsx (0 aria) etiquetar presets.
278. En components/design/designs-grid.tsx lazy-load thumbnails R2.
279. En components/design/canvas-iframe.tsx sandbox + CSP.
280. En app/design/[id]/page.tsx no hidratar el canvas en SSR.
281. En components/gpts/gpt-actions-editor.tsx no permitir una action que apunte a OpenRouter.
282. En app/gpts/create/page.tsx (1300 líneas) partir el wizard y validar el schema de actions en cliente.
283. En lib/gpts-service.ts no persistir system prompts con secretos.
284. En lib/gpt-instructions-service.ts sanitizar.
285. En components/ComputerUseInterface.tsx (F7, 12 controles, 1 aria) no exponerlo en /code hasta que F5 gVisor esté verificado en prod.
286. En hooks/use-computer-use.tsx no enviar screenshots a un endpoint que no sea el runner nativo.
287. En components/ComputerUseReasoning.tsx no leak de PII de la VM en el timeline.

## Admin — catálogo de modelos y chrome

288. En app/admin/models/page.tsx (1175 líneas) quitar el fallback `['OpenAI','Gemini','OpenRouter']` (líneas ~628 y ~1121); el catálogo vivo es DeepSeek Flash/Pro.
289. En app/admin/models/page.tsx no ofrecer un toggle que reabra OpenRouter como path de generación (el .bak-admin-toggles lo evidencia).
290. Añadir app/admin/models/error.tsx y loading.tsx (faltan) con skeleton de la tabla de modelos.
291. En components/admin/admin-chrome.tsx añadir landmark <nav> y skip-link; hoy 0 aria.
292. En components/admin-sidebar.tsx (5 controles, 1 aria) aria-current en la ruta activa.
293. En app/admin/users/page.tsx (891 líneas) virtualizar la tabla y no fetchear todos los users al montar.
294. Añadir app/admin/users/error.tsx (solo hay loading).
295. En app/admin/logs/page.tsx (844 líneas) no traer bodies de /api/ai/generate (prompts) al browser del admin.
296. En app/admin/connections/page.tsx no mostrar secretos de MCP/OAuth en claro; solo last4 + rotar.
297. En app/admin/analytics/page.tsx (514 líneas) no mezclar costo OpenRouter histórico con costo DeepSeek nativo sin etiquetar la ruptura F11.
298. En app/admin/settings/page.tsx no permitir guardar OPENROUTER_API_KEY como generador (solo integraciones no-gen si acaso).
299. En app/admin/security/page.tsx exponer el TODO de refresh-token rotation de backend/src/routes/auth.js como checklist, no como texto muerto.
300. En app/admin/payments/page.tsx no listar PAN ni client_secret de Stripe en la tabla.
301. En app/admin/database/page.tsx no ofrecer un query box arbitrario contra Prisma en prod (o gatearlo por break-glass).
302. En app/admin/health/page.tsx mostrar gVisor runtime (sandbox.js resolveSandboxRuntime) y R2 enabled, no solo ping HTTP.
303. En app/admin/status/page.tsx alinear con /api/health/ready (R2, runner, DeepSeek, Redis).
304. En app/admin/reports/page.tsx no exportar CSV con emails si el rol no es owner.
305. En app/admin/invoices/page.tsx paginar y no hidratar PDFs de invoice en el SPA.
306. En components/admin-dashboard.tsx (9 controles, 0 aria) etiquetar KPIs y no usar color-only para errores.
307. En components/admin/CreditsTopUpModal.tsx focus trap y no topupar sin idempotency-key.
308. En components/analytics-dashboard.tsx (0 aria) tablas con captions.
309. En components/super-admin-dashboard.tsx (16 controles, 0 aria) y app/super-admin/page.tsx: loading/error y no impersonar sin motivo auditado.
310. En components/impersonation-banner.tsx visible en /admin/* además de /chat.
311. En lib/database.ts (269 líneas) borrar el mock que asigna model aleatorio entre ChatGPT/Claude/Grok/DeepSeek/Gemini — rompe el candado en demos admin.
312. En lib/model-icons.ts no resolver iconos de OpenRouter como generadores; Flash/Pro solamente en el picker de generate.
313. En app/admin/layout.tsx no heredar el chrome de /chat (app-sidebar 2k) — admin-chrome es suficiente.
314. En app/admin/page.tsx (5 líneas) no redirigir en un flash sin loading.
315. Añadir loading/error a admin/payments, security, health, analytics, invoices, settings, database, status, connections, logs, reports.
316. En components/ui/switch.tsx (hay .bak-admin-toggles) no romper el label asociado: htmlFor + id en todos los toggles del catálogo.

## Gateway / skills / MCP / memoria (UI)

317. En components/gateway/use-gateway.ts (239 líneas) no reconectar en loop si el backend responde model_forbidden (OpenRouter); mostrar el error de protocol.js.
318. En components/gateway/use-gateway.ts serializar por sessionKey (el gateway F11 ya tiene createSessionQueue) y no disparar dos chat.turn a la vez.
319. En components/gateway/GatewayBadge.tsx (0 aria en el host) anunciar estado connected/degraded/forbidden a lectores de pantalla.
320. En settings, components/settings/McpServersCard.tsx no guardar un MCP URL sin OAuth por usuario (F8/F16); el backend ya tiene agent-harness/mcp-client.js.
321. En components/settings/MemorySettingsCard.tsx (13 controles, 0 aria) etiquetar on/off de memoria y no editar embeddings en crudo.
322. En components/settings/settings-panel.tsx (1512 líneas, 47 controles, 1 aria) partir secciones y confirmar «mover TODOS tus chats a la papelera» con dialog, no window.confirm.
323. En components/settings/TotpSetupCard.tsx (11 controles, 2 aria) no dejar el QR en el DOM después de verificar.
324. En components/settings/settings-dialog.tsx no montar el panel completo (1512 líneas) en un modal de /chat.
325. En app/settings/page.tsx loading/error y no prefetch de appshots.
326. En app/settings/appshots/page.tsx no geolocalizar sin permiso (lib/appshots-geo-hint.ts).
327. En lib/settings-context.tsx no persistir el modelId si no es Flash/Pro.
328. En components/user-settings.tsx (0 aria) reutilizar settings-panel o morir (duplicado).
329. En lib/agent-task-ai-sdk-bridge.ts no puentear a un SDK que use OpenRouter.
330. Mostrar en /settings el estado de skills builtin (backend/src/services/agent-runner/skills/) con enable/disable por org.
331. Mostrar en /settings el resultado de memory/search.js (F8 stub) como «no persistente entre sesiones» hasta que GraphRAG cierre.
332. En components/KeyboardShortcutsModal.tsx añadir atajo para Gateway reconnect.
333. En lib/cowork-api.ts no reutilizar la sessionKey del gateway de /chat (SURFACES chat|code).
334. En components/chat/cowork-panel.tsx etiquetar si cowork usa el mismo runner DeepSeek o un path viejo.

## Sandbox / gVisor / artefactos R2 (UI)

335. En /code Preview, si el sandbox F5 está fail-closed (sin runsc y sin SIRAGPT_SANDBOX_RUNTIME=runc), mostrar el error honesto del backend, no un iframe en blanco.
336. En components/code/preview-pane.tsx no asumir docker cp; F5 usa exec-stream — el client no debe pedir un file:// del host.
337. En components/code-preview.tsx (8 controles, 0 aria) etiquetar refresh/open y no inyectar el bundle en el parent.
338. En lib/code-preview-build.ts respetar --network none (F5): no hacer fetch a internet desde el preview.
339. En components/artifact/interactive-artifact-display.tsx aplicar la misma CSP que el sandbox (sin eval, sin network).
340. En /chat ArtifactCard, si render_preview se saltó por falta de LibreOffice, mostrar el skip honesto (F1) y no un PNG roto.
341. En admin/health pintar runtime gVisor vs runc vs none (evento sandbox_ready ya lleva runtime+gvisor).
342. En components/download-buttons.tsx, si el artifact vive en R2, no generar un blob local duplicado de >1MB (R2_MIN_SIZE_BYTES).
343. En lib/download-utils.ts usar URL firmada y revocarla al desmontar.
344. No montar ComputerUseInterface si el health check dice gvisor:false en producción (STATE F5).
345. En components/code/terminal-panel.tsx matar el PTY al unmount (AbortSignal F3) para no dejar docker exec vivos.
346. En /admin/status mostrar SIRAGPT_R2_ENABLED y SIRAGPT_REQUIRE_R2_ARTIFACTS.
347. En el empty state de Recursos (company-resources-surface) explicar que los blobs grandes van a R2, no al volumen del sandbox.
348. En components/file-upload-progress.tsx, uploads > R2_MIN_SIZE_BYTES deben ir a R2 y no a /api/files disco.
349. En lib/upload-with-progress.ts seguir el bridge orchestration/r2-artifact-bridge.js (no un S3 client en el browser).

## Auth, billing, orgs, invitaciones (UI)

350. En app/auth/login/page.tsx (524 líneas) no filtrar el email en querystring tras error y añadir autocomplete + aria.
351. Añadir loading/error a app/auth/login, register, forgot-password, reset-password, reset/[token], callback.
352. En app/auth/register/page.tsx (511 líneas) validar fuerza de password en cliente alineada con el backend y no loguear el body.
353. En app/auth/forgot-password/page.tsx no revelar si el email existe (mismo copy en 200).
354. En app/auth/reset-password/page.tsx y reset/[token] expirar el token en UI cuando el backend lo diga, no un 500 genérico.
355. En app/auth/callback/page.tsx no persistir el OAuth state en localStorage (el backend tiene oauth-state-store.js).
356. En app/auth/page.tsx (5 líneas) redirigir sin flicker.
357. En components/AuthNavButtons.tsx no mostrar Register si la org es invite-only.
358. En components/MinimalAuthLanding.tsx no hidratar el chat 13k detrás del login.
359. En lib/auth/mfa-totp.ts no guardar el secret TOTP en sessionStorage.
360. En lib/auth/auth-guard-rules.ts cubrir /code, /admin y /orgs/invitation.
361. En app/orgs/invitation/[token]/page.tsx loading/error y no dejar el token en referrer (Referrer-Policy).
362. En app/billing/page.tsx y billing/invoices loading/error; no listar invoices de otra org.
363. En components/billing-history.tsx paginar y no traer PDFs al montar.
364. En components/payment-methods.tsx (10 controles, 0 aria) no mostrar last4 como único factor; etiquetar marca y borrar.
365. En components/subscription-manager.tsx (12 controles, 0 aria) confirmar downgrade.
366. En components/plan-change-manager.tsx no cambiar el plan en un generate en vuelo.
367. En app/plan/page.tsx añadir error.tsx (falta) y no vender «cualquier modelo» — Flash/Pro.
368. En app/payment/success/page.tsx y cancel: loading/error y no re-disparar el webhook desde el cliente.
369. En lib/plans-service.ts y plan-service.ts (duplicados) unificar y no cachear precios sin currency.
370. En components/CreditsBadge.tsx refrescar tras un 402 DeepSeek sin recargar la app.
371. En components/UpgradeModal.tsx no deep-link a OpenRouter billing.
372. En app/profile/page.tsx (716 líneas) partir sesiones/API keys/billing y no listar tokens completos.
373. En app/profile/layout.tsx no saltarse MFA.
374. En components/enterprise/agents-list.tsx (10 controles, 0 aria) no crear un agent-key sin scope.
375. En components/enterprise/api-keys-card.tsx (0 aria) mostrar la key una sola vez.
376. En components/enterprise/usage-dashboard.tsx separar costo DeepSeek de residual OpenRouter.
377. En lib/integrations/verify-webhook.ts no usarlo desde el browser.
378. En lib/integrations/slack.ts no poner el bot token en un NEXT_PUBLIC_*.
379. En components/GmailConnectionCard.tsx y GoogleServicesConnectionCard.tsx no persistir refresh tokens en localStorage.
380. En components/SpotifyConnectionCard.tsx igual: tokens solo httpOnly.
381. En components/WhatsAppButton.tsx no prellenar el mensaje con el prompt del usuario (PII).
382. En app/support/page.tsx no adjuntar logs de /chat con prompts.
383. En app/privacy-policy/page.tsx y terms: loading no crítico, pero sí ancla i18n es-en (F12).
384. En app/contabilidad/page.tsx no usar el generate de /chat para asientos sin HITL.

## Mobile PWA / APK

385. En components/mobile/android-download-card.tsx verificar firma del APK contra /api/mobile/releases, no un link estático.
386. En components/mobile/iphone-install-card.tsx documentar Add to Home Screen y no prometer APK iOS.
387. En components/mobile/mobile-install-coach.tsx no tapar el composer de /chat en el primer load PWA.
388. En app/api/mobile/download/route.ts y releases: no servir un APK sin checksum y content-disposition.
389. En app/api/desktop/download/route.ts igual (checksum, no cachear en el SW).
390. En app/descargas/page.tsx loading/error y separar PWA / APK / desktop.
391. En capacitor.config.ts no apuntar el WebView a un host con OpenRouter.
392. En android/ no commitear keystore; keystore.properties.example ya existe — verificar que el vivo no tenga secrets.
393. En lib/mobile-install.ts detectar standalone y no re-mostrar PWAInstallPrompt.
394. En components/PWAInstallPrompt.tsx persistir «ahora no» >7 días.
395. En lib/sw-register.ts no cachear /api/codex/* ni /api/ai/*.
396. En app/offline/page.tsx ofrecer reabrir el último conversationId de /chat.
397. En hooks/use-mobile.tsx unificar con components/ui/use-mobile.tsx (duplicado de 3 líneas vs 29).
398. En /chat mobile: RunningChatsBar no debe tapar el composer (safe-area-bottom).
399. En /code mobile: Panel/Controlar/Archivos/Recursos como bottom-tab (components/codex/bottom-tab-bar.tsx ya existe).
400. En /code mobile no montar agent-office-scene (WebGL) por defecto.
401. En el composer mobile, el dictation-button no debe enviar el turno al soltar sin confirmación.
402. En app/manifest / icons: no usar un icono que parezca un modelo no-DeepSeek.
403. En iOS splash: no cargar chat-interface-enhanced en el primer paint (dynamic).
404. En Android back button: cerrar ArtifactPanel/Gateway dialog antes de salir de /chat.
405. En viewport: impedir double-tap zoom en el composer (rompe el caret) sin desactivar pinch en el viewer PPT.
406. En lib/notifications/push.ts pedir permiso solo tras un artifact listo, no al login.
407. En app/api/ready/route.ts y health: el PWA no debe pintar offline si solo falló un probe de admin.
408. En components/offline-banner.tsx CTA «reanudar job» usando lib/sse-reconnect.ts.
409. En testers internos: deep link siragpt://chat?c= para la APK.

## Candado DeepSeek V4 Flash/Pro (UI) — nunca OpenRouter como generate

410. En lib/chat/catalog-model.ts devolver únicamente deepseek-v4-flash y deepseek-v4-pro; cualquier otro slug es bug.
411. En lib/code-agent/model-policy.ts hacer fail-closed: si no hay Flash/Pro en el catálogo vivo, no elegir un fallback OpenRouter/Cerebras.
412. En lib/codex/model-tiers.ts borrar tiers gold/silver que apunten a OpenRouter.
413. En app/admin/models/page.tsx el default de providers no puede ser OpenAI/Gemini/OpenRouter.
414. En lib/model-icons.ts el picker de generate no debe mostrar logos de modelos bloqueados.
415. En lib/database.ts eliminar el array de modelos aleatorios de demo.
416. En components/SlashCommandMenu.tsx /model solo acepta flash|pro.
417. En components/codex/power-selector.tsx solo Flash/Pro.
418. En lib/ai-service.ts no construir un client OpenRouter para /api/ai/generate.
419. En lib/agent-task-service.ts mandar model: deepseek-v4-flash por defecto, pro si el usuario lo eligió.
420. En lib/settings-context.tsx migrar modelIds viejos (openrouter/...) a flash en el primer load.
421. En components/gateway/use-gateway.ts enviar model ya resuelto (flash/pro); el backend tira model_forbidden si no.
422. En el empty state de /chat, el toggle Flash/Pro debe persistir por user, no por tab.
423. En CreditsBadge, un 402 se copia como «DeepSeek sin saldo», nunca «OpenRouter credit balance».
424. En lib/retry-after-fetch.ts no reintentar un 402 con otro proveedor.
425. En lib/code-agent/codex-engine-mapping.ts fallar si el mapping apunta a openrouter.ai.
426. En components/fal/fal-model-gallery.tsx dejar claro que FAL es media, no el LLM de generate.
427. En components/elevenlabs-interface.tsx igual: voz ≠ generación de texto.
428. En app/voice/page.tsx (5 líneas) no montar un generate OpenRouter «por si acaso».
429. En lib/speech/natural-speech-engine.ts no mandar el texto a un LLM distinto de DeepSeek para «limpiarlo».
430. En instrumentation.ts / PostHog: property model solo flash|pro.
431. En e2e de /chat, assert de que el request de generate no contiene openrouter.ai.
432. En el banner de impersonation, el admin no puede cambiar el modelo a algo fuera del candado.
433. En lib/gpts-service.ts un GPT custom no puede setear model=openrouter/....
434. En app/gpts/create/page.tsx el selector de modelo es Flash/Pro.
435. En components/builder y design-composer: mismo candado.
436. En lib/opencode/* no usar un engine externo de generación.
437. En app/api/agents/run/route.ts (289 líneas) no es el path vivo (NOTICE-F11); no ofrecerlo en la UI como generate.
438. En app/api/agents/route.ts no listar agentes con modelos prohibidos.
439. En components/ChatEmptyStateHero.tsx copy: «DeepSeek V4 Flash o Pro», sin «vía OpenRouter».
440. En KeyboardShortcutsModal documentar el toggle Flash/Pro.
441. En admin analytics, un filtro de modelo OpenRouter es histórico read-only, no accionable.
442. En lib/visible catalog client (si consume visible-model-catalog) no rehidratar slugs viejos.
443. En tests FE de model-policy, clonar los casos de backend native-llm.test.js (flash/pro, nunca OpenRouter).

## Oleadas post-F5 (F6–F12 en la UI, respetando ROADMAP/STATE)

444. F6 UI: no habilitar SearchPanel/BrowserActivityViewer/web-tab en /chat hasta que backend/src/services/agent-runner/browser/web-tools.js esté gated y testeado.
445. F6 UI: marcar contenido web como datos (untrusted) en sources-panel, igual que backend/src/services/agent-runner/browser/untrusted.js.
446. F7 UI: ComputerUseInterface y hooks/use-computer-use.tsx hidden-by-flag hasta gVisor verificado (STATE F5).
447. F7 UI: no enviar screenshots de la VM a un viewer que no sea el del runner.
448. F7 UI: voz (speech-to-text / text-to-speech / grok-voice-panel) no cambia el modelo de generate.
449. F8 UI: MemorySettingsCard debe decir que memory/search.js aún no es GraphRAG cross-sesión (ROADMAP F8).
450. F8 UI: McpServersCard no promete OAuth por usuario hasta F16; el harness ya tiene mcp-client.js de inventario.
451. F9 UI: admin/analytics debe poder mostrar pass-rate de evals (backend/src/services/agent-runner/evals/) cuando F9 cierre.
452. F10 UI: no pintar un «router aprendido» en admin/models — el candado es Flash/Pro, no un bandit OpenRouter.
453. F11 UI: GatewayBadge + use-gateway son la superficie; no revivir app/api/agents/run como generate.
454. F11 UI: Stripe/billing ya existe — no rehacer checkout; sí alinear copy con DeepSeek-only.
455. F12 UI: i18n es-en (lib/i18n/locale-resolution.ts + LanguageToggle) en /chat y /code, no solo landing.
456. F12 UI: PWA/CLI/email/cron — el cron del gateway (use-gateway jobs) no debe ser editable sin HITL.
457. F12 UI: no migrar el cliente a Drizzle types (lib/db/src) mientras Prisma sea el ORM vivo (STATE).
458. Playwright a11y (P11/F6): primer spec sobre /chat composer + Stop + ArtifactCard, no sobre office 3D.
459. Evals dashboard (F9): una ruta /admin/evals que lea traces stage, no un CSV manual.
460. HITL (P14): action-required-card y tool-permission-card deben bloquear el siguiente generate hasta confirmar.
461. Canary (F12): un badge en admin/status si el frontend sirve un hash distinto al UI_LOCK.

## A11y — controles reales sin etiquetar (scan vivo)

462. Etiquetar con aria-label/aria-labelledby los 332 controles de components/ExcelRibbon.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
463. Etiquetar con aria-label/aria-labelledby los 146 controles de components/code/workspace-tool-panels.tsx (hoy 2 atributos aria-) y foco visible en el tab order.
464. Etiquetar con aria-label/aria-labelledby los 89 controles de components/code/publishing-tool-real.tsx (hoy 2 atributos aria-) y foco visible en el tab order.
465. Etiquetar con aria-label/aria-labelledby los 47 controles de components/settings/settings-panel.tsx (hoy 1 atributos aria-) y foco visible en el tab order.
466. Etiquetar con aria-label/aria-labelledby los 26 controles de components/workspace/git-pane.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
467. Etiquetar con aria-label/aria-labelledby los 21 controles de components/deployments/manage-tab.tsx (hoy 1 atributos aria-) y foco visible en el tab order.
468. Etiquetar con aria-label/aria-labelledby los 17 controles de components/text-to-speech-component.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
469. Etiquetar con aria-label/aria-labelledby los 18 controles de components/editor/toolbar.tsx (hoy 1 atributos aria-) y foco visible en el tab order.
470. Etiquetar con aria-label/aria-labelledby los 16 controles de components/super-admin-dashboard.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
471. Etiquetar con aria-label/aria-labelledby los 15 controles de components/code/git-tool-real.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
472. Etiquetar con aria-label/aria-labelledby los 14 controles de components/codex/checkpoint-card.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
473. Etiquetar con aria-label/aria-labelledby los 13 controles de components/presentation-view.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
474. Etiquetar con aria-label/aria-labelledby los 13 controles de components/settings/MemorySettingsCard.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
475. Etiquetar con aria-label/aria-labelledby los 12 controles de components/subscription-manager.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
476. Etiquetar con aria-label/aria-labelledby los 14 controles de components/design/design-composer.tsx (hoy 2 atributos aria-) y foco visible en el tab order.
477. Etiquetar con aria-label/aria-labelledby los 12 controles de components/workspace/import-repo-panel.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
478. Etiquetar con aria-label/aria-labelledby los 11 controles de components/search-brain/UniversalSearchPanel.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
479. Etiquetar con aria-label/aria-labelledby los 12 controles de components/ComputerUseInterface.tsx (hoy 1 atributos aria-) y foco visible en el tab order.
480. Etiquetar con aria-label/aria-labelledby los 11 controles de components/workspace/file-tree.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
481. Etiquetar con aria-label/aria-labelledby los 10 controles de components/enterprise/agents-list.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
482. Etiquetar con aria-label/aria-labelledby los 10 controles de components/payment-methods.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
483. Etiquetar con aria-label/aria-labelledby los 10 controles de components/design/create-panel.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
484. Etiquetar con aria-label/aria-labelledby los 9 controles de components/VideoGenerationComponent.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
485. Etiquetar con aria-label/aria-labelledby los 9 controles de components/ThesisGenerator.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
486. Etiquetar con aria-label/aria-labelledby los 9 controles de components/admin-dashboard.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
487. Etiquetar con aria-label/aria-labelledby los 9 controles de components/artifact/interactive-artifact-display.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
488. Etiquetar con aria-label/aria-labelledby los 9 controles de components/ThesisProgressComponent.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
489. Etiquetar con aria-label/aria-labelledby los 9 controles de components/code/workspace-tools-menu.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
490. Etiquetar con aria-label/aria-labelledby los 8 controles de components/elevenlabs-interface.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
491. Etiquetar con aria-label/aria-labelledby los 8 controles de components/code-preview.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
492. Etiquetar con aria-label/aria-labelledby los 8 controles de components/ThesisChatConnector.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
493. Etiquetar con aria-label/aria-labelledby los 6 controles de components/MusicGenerationComponent.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
494. Etiquetar con aria-label/aria-labelledby los 6 controles de components/figma-diagram-component.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
495. Etiquetar con aria-label/aria-labelledby los 6 controles de components/deployments/publish-pipeline.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
496. Etiquetar con aria-label/aria-labelledby los 6 controles de components/plan/plan-artifact-display.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
497. Etiquetar con aria-label/aria-labelledby los 6 controles de components/codex/plan-card.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
498. Etiquetar con aria-label/aria-labelledby los 5 controles de components/doc/doc-artifact-display.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
499. Etiquetar con aria-label/aria-labelledby los 5 controles de components/deployments/create-deployment-dialog.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
500. Etiquetar con aria-label/aria-labelledby los 5 controles de components/code/editor-panel.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
501. Etiquetar con aria-label/aria-labelledby los 5 controles de components/user-settings.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
502. Etiquetar con aria-label/aria-labelledby los 5 controles de components/workspace/github-connect-card.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
503. Etiquetar con aria-label/aria-labelledby los 5 controles de components/codex/power-selector.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
504. Etiquetar con aria-label/aria-labelledby los 4 controles de components/UpgradeModal.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
505. Etiquetar con aria-label/aria-labelledby los 4 controles de components/speech-to-text-component.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
506. Etiquetar con aria-label/aria-labelledby los 4 controles de components/plan-change-manager.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
507. Etiquetar con aria-label/aria-labelledby los 4 controles de components/code/project-invite-dialog.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
508. Etiquetar con aria-label/aria-labelledby los 4 controles de components/GoogleServicesConnectionCard.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
509. Etiquetar con aria-label/aria-labelledby los 4 controles de components/viz/viz-artifact-display.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
510. Etiquetar con aria-label/aria-labelledby los 4 controles de components/builder/QuestionCard.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
511. Etiquetar con aria-label/aria-labelledby los 4 controles de components/ui/select.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
512. Etiquetar con aria-label/aria-labelledby los 4 controles de components/connection-status.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
513. Etiquetar con aria-label/aria-labelledby los 4 controles de components/codex/tool-permission-card.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
514. Etiquetar con aria-label/aria-labelledby los 4 controles de components/ui/image-modal.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
515. Etiquetar con aria-label/aria-labelledby los 3 controles de components/ExtractedDataDownload.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
516. Etiquetar con aria-label/aria-labelledby los 3 controles de components/ThesisProgressDisplay.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
517. Etiquetar con aria-label/aria-labelledby los 3 controles de components/analytics-dashboard.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
518. Etiquetar con aria-label/aria-labelledby los 3 controles de components/deployments/empty-deployment-detail.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
519. Etiquetar con aria-label/aria-labelledby los 3 controles de components/projects/create-project-dialog.tsx (hoy 0 atributos aria-) y foco visible en el tab order.
520. Etiquetar con aria-label/aria-labelledby los 3 controles de components/spotify-results.tsx (hoy 0 atributos aria-) y foco visible en el tab order.

## Capas de ruta — loading.tsx / error.tsx faltantes en app/

521. Añadir app/chat/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
522. Añadir app/chat/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
523. Añadir app/super-admin/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
524. Añadir app/super-admin/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
525. Añadir app/parafraseo/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
526. Añadir app/terms-of-service/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
527. Añadir app/billing/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
528. Añadir app/billing/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
529. Añadir app/billing/invoices/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
530. Añadir app/billing/invoices/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
531. Añadir app/admin/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
532. Añadir app/admin/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
533. Añadir app/admin/payments/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
534. Añadir app/admin/payments/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
535. Añadir app/admin/security/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
536. Añadir app/admin/security/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
537. Añadir app/admin/health/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
538. Añadir app/admin/health/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
539. Añadir app/admin/analytics/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
540. Añadir app/admin/analytics/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
541. Añadir app/admin/invoices/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
542. Añadir app/admin/invoices/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
543. Añadir app/admin/settings/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
544. Añadir app/admin/settings/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
545. Añadir app/admin/users/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
546. Añadir app/admin/database/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
547. Añadir app/admin/database/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
548. Añadir app/admin/models/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
549. Añadir app/admin/models/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
550. Añadir app/admin/status/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
551. Añadir app/admin/status/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
552. Añadir app/admin/connections/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
553. Añadir app/admin/connections/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
554. Añadir app/admin/logs/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
555. Añadir app/admin/logs/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
556. Añadir app/admin/reports/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
557. Añadir app/admin/reports/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
558. Añadir app/post/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
559. Añadir app/post/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
560. Añadir app/auth/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
561. Añadir app/auth/forgot-password/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
562. Añadir app/auth/forgot-password/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
563. Añadir app/auth/login/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
564. Añadir app/auth/login/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
565. Añadir app/auth/reset-password/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
566. Añadir app/auth/reset-password/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
567. Añadir app/auth/register/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
568. Añadir app/auth/register/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
569. Añadir app/auth/reset/[token]/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
570. Añadir app/auth/reset/[token]/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
571. Añadir app/auth/callback/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
572. Añadir app/auth/callback/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
573. Añadir app/builder/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
574. Añadir app/builder/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
575. Añadir app/thesis/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
576. Añadir app/thesis/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
577. Añadir app/offline/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
578. Añadir app/offline/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
579. Añadir app/privacy/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
580. Añadir app/orgs/invitation/[token]/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
581. Añadir app/orgs/invitation/[token]/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
582. Añadir app/gpts/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
583. Añadir app/gpts/create/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
584. Añadir app/gpts/create/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
585. Añadir app/descargas/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
586. Añadir app/descargas/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
587. Añadir app/document-cycle/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
588. Añadir app/document-cycle/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
589. Añadir app/projects/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
590. Añadir app/projects/[id]/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
591. Añadir app/projects/[id]/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
592. Añadir app/projects/[id]/marco-teorico/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
593. Añadir app/projects/[id]/marco-teorico/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
594. Añadir app/projects/[id]/docs/[docId]/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
595. Añadir app/projects/[id]/docs/[docId]/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
596. Añadir app/projects/share/[shareId]/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
597. Añadir app/projects/share/[shareId]/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
598. Añadir app/search-brain/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
599. Añadir app/search-brain/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
600. Añadir app/voice/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
601. Añadir app/voice/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
602. Añadir app/payment/success/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
603. Añadir app/payment/success/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
604. Añadir app/payment/cancel/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
605. Añadir app/payment/cancel/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
606. Añadir app/settings/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
607. Añadir app/settings/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
608. Añadir app/settings/appshots/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
609. Añadir app/settings/appshots/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
610. Añadir app/apps/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
611. Añadir app/apps/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
612. Añadir app/privacy-policy/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
613. Añadir app/codex/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
614. Añadir app/codex/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
615. Añadir app/demo/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
616. Añadir app/demo/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
617. Añadir app/share/message/[shareId]/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
618. Añadir app/share/message/[shareId]/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
619. Añadir app/share/[shareId]/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
620. Añadir app/share/[shareId]/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
621. Añadir app/contabilidad/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
622. Añadir app/contabilidad/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
623. Añadir app/workspace/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
624. Añadir app/workspace/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
625. Añadir app/workspace/[id]/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
626. Añadir app/workspace/[id]/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
627. Añadir app/code/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
628. Añadir app/support/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
629. Añadir app/support/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
630. Añadir app/documents/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
631. Añadir app/documents/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
632. Añadir app/documents/editor/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
633. Añadir app/documents/editor/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
634. Añadir app/deployments/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
635. Añadir app/deployments/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
636. Añadir app/profile/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
637. Añadir app/profile/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
638. Añadir app/design/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
639. Añadir app/design/[id]/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
640. Añadir app/design/[id]/loading.tsx con skeleton del chrome real de esa superficie (no el spinner genérico de app/loading.tsx).
641. Añadir app/plan/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
642. Añadir app/terms/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.
643. Añadir app/library/error.tsx con reset() y copy en español para que un crash de esa página no tumbe el layout raíz.

## Higiene del árbol vivo — .bak y AppleDouble (FE)

644. Borrar app/admin/models/page.tsx.bak-admin-toggles-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
645. Borrar app/chat/page.tsx.bak-company-start-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
646. Borrar app/globals.css.bak-admin-toggles-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
647. Borrar app/globals.css.bak-composer-align-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
648. Borrar app/globals.css.bak-composer-logos-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
649. Borrar app/globals.css.bak-composer-pro-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
650. Borrar components/agentic-steps.tsx.bak-livefail-20260814 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
651. Borrar components/app-sidebar.tsx.bak-hide-chat-noise-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
652. Borrar components/chat-interface-enhanced.tsx.bak-hide-chat-noise-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
653. Borrar components/chat/RunningChatsBar.tsx.bak-hide-chat-noise-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
654. Borrar components/chat/chat-session-chips.tsx.bak-hide-chat-noise-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
655. Borrar components/code/agent-company-panel.tsx.bak-company-start-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
656. Borrar components/code/agent-company-panel.tsx.bak-dept-chat-bard-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
657. Borrar components/code/agent-company-panel.tsx.bak-dept-computer-20260814-213120 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
658. Borrar components/code/agent-company-panel.tsx.bak-dept-computer-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
659. Borrar components/code/agent-company-panel.tsx.bak-dept-delete-20260814-210619 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
660. Borrar components/code/agent-company-panel.tsx.bak-dept-delete-liveonly-20260814-211605 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
661. Borrar components/code/agent-company-panel.tsx.bak-dept-real-computer-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
662. Borrar components/code/agent-company-panel.tsx.bak-drop-dup-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
663. Borrar components/code/agent-company-panel.tsx.bak-nav-fullscreen-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
664. Borrar components/code/agent-company-panel.tsx.bak-office-live-preview-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
665. Borrar components/code/agent-company-panel.tsx.bak-polsia-only-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
666. Borrar components/code/agent-office/agent-office-scene.tsx.bak-office-live-preview-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
667. Borrar components/code/agent-office/use-office-soundscape.ts.bak-company-start-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
668. Borrar components/code/ai-code-chat-panel.tsx.bak-composer-align-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
669. Borrar components/code/ai-code-chat-panel.tsx.bak-composer-logos-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
670. Borrar components/code/ai-code-chat-panel.tsx.bak-composer-pro-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
671. Borrar components/code/ai-code-chat-panel.tsx.bak-dept-chat-bard-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
672. Borrar components/code/ai-code-chat-panel.tsx.bak-drop-dup-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
673. Borrar components/code/ai-code-chat-panel.tsx.bak-drop-launch-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
674. Borrar components/code/code-workspace.tsx.bak-canvas-toggle-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
675. Borrar components/code/code-workspace.tsx.bak-dept-chat-bard-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
676. Borrar components/code/code-workspace.tsx.bak-dept-computer-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
677. Borrar components/code/code-workspace.tsx.bak-dept-real-computer-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
678. Borrar components/code/code-workspace.tsx.bak-drop-dup-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
679. Borrar components/code/code-workspace.tsx.bak-header-clean-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
680. Borrar components/code/code-workspace.tsx.bak-nav-fullscreen-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
681. Borrar components/code/dept-chat-bard.tsx.bak-composer-pro-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
682. Borrar components/code/dept-chat-bard.tsx.bak-drop-dup-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
683. Borrar components/code/dept-chat-bard.tsx.bak-header-clean-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
684. Borrar components/code/preview-pane.tsx.bak-canvas-toggle-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
685. Borrar components/code/preview-pane.tsx.bak-dept-computer-20260814-213120 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
686. Borrar components/code/preview-pane.tsx.bak-header-clean-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
687. Borrar components/code/project-chip.tsx.bak-drop-dup-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
688. Borrar components/code/project-chip.tsx.bak-header-clean-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
689. Borrar components/code/project-invite-dialog.tsx.bak-invite-pro-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
690. Borrar components/code/terminal-panel.tsx.bak-dept-computer-20260814-213120 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
691. Borrar components/code/workspace-top-bar.tsx.bak-canvas-toggle-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
692. Borrar components/code/workspace-top-bar.tsx.bak-dept-computer-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
693. Borrar components/code/workspace-top-bar.tsx.bak-dept-real-computer-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
694. Borrar components/code/workspace-top-bar.tsx.bak-drop-dup-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
695. Borrar components/code/workspace-top-bar.tsx.bak-header-clean-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
696. Borrar components/ui/switch.tsx.bak-admin-toggles-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
697. Borrar lib/background-jobs-context.tsx.bak-hide-chat-noise-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
698. Borrar lib/chat-context-integrated.tsx.bak-admin-toggles-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
699. Borrar lib/code-agent-company.ts.bak-dept-chat-bard-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
700. Borrar lib/code-agent-company.ts.bak-dept-computer-20260814-213120 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
701. Borrar lib/code-agent/composer-mode-config.ts.bak-composer-pro-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
702. Borrar lib/code-workspace-context.tsx.bak-dept-computer-20260814-213120 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
703. Borrar lib/code-workspace-context.tsx.bak-dept-computer-header-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
704. Borrar lib/codex/api/company.ts.bak-dept-computer-20260814-213120 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
705. Borrar lib/codex/api/projects.ts.bak-dept-computer-20260814-213120 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
706. Borrar lib/codex/api/types.ts.bak-dept-computer-20260814-213120 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
707. Borrar tests/code-agent-company-placement-source.test.ts.bak-dept-real-computer-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
708. Borrar tests/code-composer-split-layout-source.test.ts.bak-composer-logos-20260815 del VPS (/opt/siragpt): es un backup de hotpatch y un import/glob puede servirlo por error.
709. Borrar el AppleDouble components/._app-sidebar.tsx (archivo `._*`) que contamina listados, hashes de UI-lock y búsquedas.
710. Borrar el AppleDouble components/._app-wrapper.tsx (archivo `._*`) que contamina listados, hashes de UI-lock y búsquedas.
711. Borrar el AppleDouble components/._chat-interface-enhanced.tsx (archivo `._*`) que contamina listados, hashes de UI-lock y búsquedas.
712. Borrar el AppleDouble components/._root-providers.tsx (archivo `._*`) que contamina listados, hashes de UI-lock y búsquedas.
713. Borrar el AppleDouble components/chat/._RunningChatsBar.tsx (archivo `._*`) que contamina listados, hashes de UI-lock y búsquedas.
714. Borrar el AppleDouble lib/._app-wrapper-routes.ts (archivo `._*`) que contamina listados, hashes de UI-lock y búsquedas.
715. Borrar el AppleDouble lib/._chat-context-integrated.tsx (archivo `._*`) que contamina listados, hashes de UI-lock y búsquedas.
716. Borrar el AppleDouble lib/._running-chat-jobs.ts (archivo `._*`) que contamina listados, hashes de UI-lock y búsquedas.

## Partir god-files frontend (líneas vivas)

717. Partir app/globals.css (8218 líneas vivas) en tokens / chat / code / admin / mobile (el archivo tiene 8217 líneas), dejando un barrel para no romper imports.
718. Partir app/admin/users/page.tsx (891 líneas vivas) en tabla / filtros / impersonate, dejando un barrel para no romper imports.
719. Partir app/admin/models/page.tsx (1176 líneas vivas) en tabla / editor / providers, dejando un barrel para no romper imports.
720. Partir app/admin/logs/page.tsx (844 líneas vivas) en filtros / viewer / redaction, dejando un barrel para no romper imports.
721. Partir app/gpts/create/page.tsx (1301 líneas vivas) en pasos del wizard, dejando un barrel para no romper imports.
722. Partir app/projects/page.tsx (829 líneas vivas) en lista / create / folders, dejando un barrel para no romper imports.
723. Partir app/projects/[id]/page.tsx (1053 líneas vivas) en docs / chat / marco, dejando un barrel para no romper imports.
724. Partir app/codex/page.tsx (825 líneas vivas) en hub / runs / files, dejando un barrel para no romper imports.
725. Partir app/profile/page.tsx (717 líneas vivas) en sesiones / keys / billing, dejando un barrel para no romper imports.
726. Partir components/WordConnector.tsx (1678 líneas vivas) en ribbon / document / comments, dejando un barrel para no romper imports.
727. Partir components/ExcelRibbon.tsx (2904 líneas vivas) en grupos de ribbon, dejando un barrel para no romper imports.
728. Partir components/chat-interface-enhanced.tsx (13159 líneas vivas) en Composer / Timeline / SSE / Artifacts / Media, dejando un barrel para no romper imports.
729. Partir components/document-preview.tsx (1032 líneas vivas) en reusar UnifiedDocumentViewer, dejando un barrel para no romper imports.
730. Partir components/agentic-steps.tsx (1199 líneas vivas) en stage mapper / UI, dejando un barrel para no romper imports.
731. Partir components/message-component.tsx (3438 líneas vivas) en markdown / media / actions, dejando un barrel para no romper imports.
732. Partir components/text-to-speech-component.tsx (860 líneas vivas) en player / voices / queue, dejando un barrel para no romper imports.
733. Partir components/app-sidebar.tsx (2153 líneas vivas) en nav / hilos / folders, dejando un barrel para no romper imports.
734. Partir components/elevenlabs-interface.tsx (736 líneas vivas) en voices / generate / history, dejando un barrel para no romper imports.
735. Partir components/chat/cowork-panel.tsx (1021 líneas vivas) en roster / timeline / files, dejando un barrel para no romper imports.
736. Partir components/viewers/UnifiedDocumentViewer.tsx (2665 líneas vivas) en pdf / docx / pptx / xlsx loaders, dejando un barrel para no romper imports.
737. Partir components/settings/settings-panel.tsx (1512 líneas vivas) en cuenta / memoria / MCP / peligro, dejando un barrel para no romper imports.
738. Partir components/code/workspace-tool-panels.tsx (3114 líneas vivas) en un panel por archivo, dejando un barrel para no romper imports.
739. Partir components/code/preview-pane.tsx (1995 líneas vivas) en iframe / toolbar / errors, dejando un barrel para no romper imports.
740. Partir components/code/enterprise-command-center.tsx (835 líneas vivas) en OKRs / flota / budget, dejando un barrel para no romper imports.
741. Partir components/code/company-resources-surface.tsx (1217 líneas vivas) en lista / preview / upload, dejando un barrel para no romper imports.
742. Partir components/code/ai-code-chat-panel.tsx (6004 líneas vivas) en composer / timeline / adjuntos, dejando un barrel para no romper imports.
743. Partir components/code/publishing-tool-real.tsx (1717 líneas vivas) en form / pipeline / domains, dejando un barrel para no romper imports.
744. Partir components/code/agent-company-panel.tsx (7382 líneas vivas) en flota / departamentos / header / recursos, dejando un barrel para no romper imports.
745. Partir components/code/agent-office/agent-office-city.ts (2041 líneas vivas) en mesh / layout data, dejando un barrel para no romper imports.
746. Partir components/code/agent-office/agent-office-scene.tsx (2208 líneas vivas) en escena / luces / agents (code-split, no /chat), dejando un barrel para no romper imports.
747. Partir lib/code-workspace-context.tsx (1132 líneas vivas) en files / selection / computers, dejando un barrel para no romper imports.
748. Partir lib/ai-service.ts (1253 líneas vivas) en intent / media / generate client, dejando un barrel para no romper imports.
749. Partir lib/agent-task-service.ts (817 líneas vivas) en client / poll / cancel, dejando un barrel para no romper imports.
750. Partir lib/chat-context-integrated.tsx (4280 líneas vivas) en session / messages / composer providers, dejando un barrel para no romper imports.
751. Partir lib/api.ts (4116 líneas vivas) en chats / files / billing / code clients, dejando un barrel para no romper imports.
752. Partir lib/code-preview-build.ts (786 líneas vivas) en plan / compile / errors, dejando un barrel para no romper imports.
753. Partir lib/code-agent/orchestrator.ts (1078 líneas vivas) en eliminar o delegar al backend F4, dejando un barrel para no romper imports.
754. Partir lib/speech/natural-speech-engine.ts (1041 líneas vivas) en engine / voices / queue, dejando un barrel para no romper imports.

## TypeScript — `any` en módulos vivos

755. Reemplazar los 10 `: any`/`as any` de app/admin/users/page.tsx (891 líneas) por tipos de lib/api-types.ts o interfaces locales.
756. Reemplazar los 18 `: any`/`as any` de app/admin/connections/page.tsx (793 líneas) por tipos de lib/api-types.ts o interfaces locales.
757. Reemplazar los 9 `: any`/`as any` de app/admin/logs/page.tsx (844 líneas) por tipos de lib/api-types.ts o interfaces locales.
758. Reemplazar los 12 `: any`/`as any` de app/projects/[id]/page.tsx (1053 líneas) por tipos de lib/api-types.ts o interfaces locales.
759. Reemplazar los 12 `: any`/`as any` de app/projects/[id]/marco-teorico/page.tsx (396 líneas) por tipos de lib/api-types.ts o interfaces locales.
760. Reemplazar los 19 `: any`/`as any` de components/WordConnector.tsx (1678 líneas) por tipos de lib/api-types.ts o interfaces locales.
761. Reemplazar los 88 `: any`/`as any` de components/ExcelRibbon.tsx (2904 líneas) por tipos de lib/api-types.ts o interfaces locales.
762. Reemplazar los 237 `: any`/`as any` de components/chat-interface-enhanced.tsx (13159 líneas) por tipos de lib/api-types.ts o interfaces locales.
763. Reemplazar los 104 `: any`/`as any` de components/message-component.tsx (3438 líneas) por tipos de lib/api-types.ts o interfaces locales.
764. Reemplazar los 8 `: any`/`as any` de components/spotify-results.tsx (149 líneas) por tipos de lib/api-types.ts o interfaces locales.
765. Reemplazar los 18 `: any`/`as any` de components/app-sidebar.tsx (2153 líneas) por tipos de lib/api-types.ts o interfaces locales.
766. Reemplazar los 16 `: any`/`as any` de components/ExcelConnector.tsx (473 líneas) por tipos de lib/api-types.ts o interfaces locales.
767. Reemplazar los 8 `: any`/`as any` de components/chat/cowork-panel.tsx (1021 líneas) por tipos de lib/api-types.ts o interfaces locales.
768. Reemplazar los 12 `: any`/`as any` de components/Library/ResearchLibrary.tsx (550 líneas) por tipos de lib/api-types.ts o interfaces locales.
769. Reemplazar los 18 `: any`/`as any` de components/viewers/UnifiedDocumentViewer.tsx (2665 líneas) por tipos de lib/api-types.ts o interfaces locales.
770. Reemplazar los 16 `: any`/`as any` de components/settings/settings-panel.tsx (1512 líneas) por tipos de lib/api-types.ts o interfaces locales.
771. Reemplazar los 30 `: any`/`as any` de components/code/ai-code-chat-panel.tsx (6004 líneas) por tipos de lib/api-types.ts o interfaces locales.
772. Reemplazar los 12 `: any`/`as any` de components/sidebar/sidebar-folders-dropdown.tsx (1158 líneas) por tipos de lib/api-types.ts o interfaces locales.
773. Reemplazar los 20 `: any`/`as any` de lib/ai-service.ts (1253 líneas) por tipos de lib/api-types.ts o interfaces locales.
774. Reemplazar los 11 `: any`/`as any` de lib/agent-task-service.ts (817 líneas) por tipos de lib/api-types.ts o interfaces locales.
775. Reemplazar los 113 `: any`/`as any` de lib/chat-context-integrated.tsx (4280 líneas) por tipos de lib/api-types.ts o interfaces locales.
776. Reemplazar los 87 `: any`/`as any` de lib/api.ts (4116 líneas) por tipos de lib/api-types.ts o interfaces locales.
777. Reemplazar los 11 `: any`/`as any` de lib/performance-optimizer.ts (217 líneas) por tipos de lib/api-types.ts o interfaces locales.

## Fugas OpenRouter en frontend (candado DeepSeek)

778. Auditar app/globals.css (1 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
779. Auditar app/admin/models/page.tsx (2 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
780. Auditar app/admin/connections/page.tsx (9 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
781. Auditar app/privacy-policy/page.tsx (1 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
782. Auditar app/openclaw/native/[[...path]]/route.ts (5 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
783. Auditar app/terms/page.tsx (1 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
784. Auditar components/chat-interface-enhanced.tsx (2 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
785. Auditar components/icon-provider.tsx (5 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
786. Auditar components/settings/settings-panel.tsx (2 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
787. Auditar components/design/chat-panel.tsx (1 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
788. Auditar components/design/design-composer.tsx (5 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
789. Auditar lib/design-service.ts (1 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
790. Auditar lib/model-icons.ts (7 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
791. Auditar lib/code-chat-blocker.ts (3 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.
792. Auditar lib/chat/media-composer-config.ts (3 menciones a OpenRouter): si el archivo participa en generate, dejar solo DeepSeek Flash/Pro; si es histórico/admin, marcarlo read-only.

## Tests frontend faltantes (módulos grandes sin suite colocada)

793. Añadir unit test para lib/sse-reconnect.ts cubriendo reanudación Last-Event-ID y tope de reintentos.
794. Añadir unit test para lib/live-activity.ts cubriendo labels F3/F4 y fallback Pensando.
795. Añadir unit test para lib/running-chat-jobs.ts cubriendo persistencia y cancel.
796. Añadir unit test para lib/code-agent/model-policy.ts cubriendo solo flash/pro, nunca OpenRouter.
797. Añadir unit test para lib/chat/catalog-model.ts cubriendo catálogo DeepSeek-only.
798. Añadir unit test para lib/chat/turn-cancellation.ts cubriendo Stop unificado.
799. Añadir unit test para components/gateway/use-gateway.ts cubriendo model_forbidden y serial lane.
800. Añadir unit test para lib/codex/run-stream.ts cubriendo SSE + cancel.
801. Añadir unit test para lib/authenticated-fetch.ts cubriendo no leak de Authorization.
802. Añadir unit test para lib/retry-after-fetch.ts cubriendo 402 DeepSeek no-retry-loop.
803. Añadir unit test para lib/sw-register.ts cubriendo no cachea /api/ai ni /api/codex.
804. Añadir unit test para lib/auth/auth-guard-rules.ts cubriendo rutas /code /admin /orgs.
805. Añadir unit test para lib/company-resource-access.ts cubriendo scope org.
806. Añadir unit test para lib/code-chat-blocker.ts cubriendo bloquea generate sin Flash/Pro.
807. Añadir unit test para lib/hydrate-streaming-chat.ts cubriendo cancelled ≠ final.
808. Añadir unit test para lib/document-chat-request.ts cubriendo lastArtifactId en follow-up.
809. Añadir unit test para lib/mobile-install.ts cubriendo standalone no re-prompt.
810. Añadir unit test para lib/i18n/locale-resolution.ts cubriendo es-en fallback.
811. Añadir unit test para lib/next-health.ts cubriendo ready vs live.
812. Añadir unit test para lib/fetch-sanitize.ts cubriendo redact secrets.

## Perf y observabilidad frontend

813. Quitar o gatear los 9 console.log de components/text-to-speech-component.tsx (no prompts, no tokens, no OOXML).
814. Medir y memoizar el hot path de lib/projects-service.ts (343 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
815. Medir y memoizar el hot path de lib/dotmatrix-core.tsx (959 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
816. Medir y memoizar el hot path de lib/project-templates.ts (898 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
817. Medir y memoizar el hot path de lib/code-chat-sessions.ts (438 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
818. Medir y memoizar el hot path de lib/code-workspace-context.tsx (1132 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
819. Medir y memoizar el hot path de lib/code-agent-company.ts (378 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
820. Medir y memoizar el hot path de lib/ai-service.ts (1253 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
821. Medir y memoizar el hot path de lib/agentic-search-service.ts (287 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
822. Medir y memoizar el hot path de lib/agent-task-service.ts (817 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
823. Medir y memoizar el hot path de lib/paste-capture.ts (293 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
824. Medir y memoizar el hot path de lib/auth-context-integrated.tsx (345 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
825. Medir y memoizar el hot path de lib/pending-messages.ts (482 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
826. Medir y memoizar el hot path de lib/chat-context-integrated.tsx (4280 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
827. Medir y memoizar el hot path de lib/download-utils.ts (273 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
828. Medir y memoizar el hot path de lib/database.ts (270 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
829. Medir y memoizar el hot path de lib/github-codex-service.ts (454 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
830. Medir y memoizar el hot path de lib/upload-with-progress.ts (440 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
831. Medir y memoizar el hot path de lib/cowork-api.ts (359 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
832. Medir y memoizar el hot path de lib/gpts-service.ts (433 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
833. Medir y memoizar el hot path de lib/attachment-ingest.ts (410 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
834. Medir y memoizar el hot path de lib/api-types.ts (272 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
835. Medir y memoizar el hot path de lib/company-agent-file-reports.ts (587 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
836. Medir y memoizar el hot path de lib/github-service.ts (309 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
837. Medir y memoizar el hot path de lib/message-preservation.ts (658 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
838. Medir y memoizar el hot path de lib/code-workspace-tools.ts (351 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
839. Medir y memoizar el hot path de lib/workspace-tools-registry.ts (387 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
840. Medir y memoizar el hot path de lib/request-queue.ts (310 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
841. Medir y memoizar el hot path de lib/code-workspace-utils.ts (404 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
842. Medir y memoizar el hot path de lib/local-folder-workspace.ts (506 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
843. Medir y memoizar el hot path de lib/agent-office-model.ts (627 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
844. Medir y memoizar el hot path de lib/publishing-console.ts (363 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
845. Medir y memoizar el hot path de lib/api.ts (4116 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
846. Medir y memoizar el hot path de lib/toast-helper.ts (296 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
847. Medir y memoizar el hot path de lib/retry-after-fetch.ts (332 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
848. Medir y memoizar el hot path de lib/code-preview-build.ts (786 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
849. Medir y memoizar el hot path de lib/settings-context.tsx (320 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
850. Medir y memoizar el hot path de lib/code-detection.ts (438 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
851. Medir y memoizar el hot path de lib/authenticated-fetch.ts (320 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
852. Medir y memoizar el hot path de lib/long-paste.ts (1110 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
853. Medir y memoizar el hot path de lib/background-jobs-context.tsx (269 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
854. Medir y memoizar el hot path de lib/rich-clipboard.ts (517 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
855. Medir y memoizar el hot path de lib/api-client-react/src/custom-fetch.ts (372 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
856. Medir y memoizar el hot path de lib/codex/run-stream.ts (258 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
857. Medir y memoizar el hot path de lib/codex/timeline-reducer.ts (297 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
858. Medir y memoizar el hot path de lib/codex/api/types.ts (701 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
859. Medir y memoizar el hot path de lib/attachments/registry.ts (308 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
860. Medir y memoizar el hot path de lib/attachments/media-meta.ts (330 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
861. Medir y memoizar el hot path de lib/code-agent/vite-app-template.ts (761 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
862. Medir y memoizar el hot path de lib/code-agent/orchestrator.ts (1078 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
863. Medir y memoizar el hot path de lib/code-agent/codex-engine-mapping.ts (350 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
864. Medir y memoizar el hot path de lib/code-agent/vite-scaffold.ts (573 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
865. Medir y memoizar el hot path de lib/code-agent/prompts.ts (257 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.
866. Medir y memoizar el hot path de lib/speech/natural-speech-engine.ts (1041 líneas): no recalcular en cada chunk SSE ni en cada tick de oficina 3D.

## Otras superficies vivas (projects, gpts, thesis, voice, search, cowork)

867. En app/search-brain/page.tsx no disparar un generate OpenRouter; Search Brain es retrieval (F6) + respuesta DeepSeek.
868. En components/search-brain/UniversalSearchPanel.tsx (11 controles, 0 aria) etiquetar fuentes y marcar snippets untrusted.
869. En lib/search-brain-ui.ts no hidratar providers que no existan en searchBrain/providers.js.
870. En app/thesis/page.tsx loading/error y un solo SSE (no ThesisChatConnector + /chat a la vez).
871. En components/ThesisProgressDisplay.tsx anunciar el % a aria-live.
872. En app/parafraseo/page.tsx usar /api/paraphrase DeepSeek, no un client browser.
873. En app/post/page.tsx HITL antes de publicar (social-posts backend).
874. En app/apps/page.tsx no listar apps con generate OpenRouter.
875. En app/demo/page.tsx no gastar créditos DeepSeek de prod en la demo pública.
876. En app/library/page.tsx error.tsx (falta) y no prefetch de todos los PDFs.
877. En components/Library/LibraryTabs.tsx virtualizar.
878. En components/Library/ResearchLibrary.tsx untrusted + org scope.
879. En app/voice/page.tsx no montar chat-interface-enhanced.
880. En components/voice/voice-catalog-modal.tsx (1 aria) focus trap.
881. En app/openclaw/native/[[...path]]/route.ts (486 líneas) no es generate — no proxyar a OpenRouter.
882. En app/home-page.tsx no prefetch del office 3D.
883. En components/landing/PricingSection.tsx copy Flash/Pro, no «todos los modelos».
884. En components/landing/CTASection.tsx mismo candado.
885. En app/robots.ts y sitemap.ts no indexar /admin /chat /code autenticados.
886. En app/not-found.tsx enlace a /chat y /code, no a demos muertas.
887. En components/theme-toggle.tsx no forzar dark en el viewer PPT (el hex del usuario manda).
888. En components/LanguageToggle.tsx persistir locale (F12 i18n).
889. En messages/ (i18n) cubrir errores agent_runner_failed / llm_402 / budget_exceeded.
890. En e2e/ añadir spec /chat Stop a mitad de create_presentation (F3).
891. En e2e/ spec /chat follow-up de color sobre última versión (F1 artifacts).
892. En e2e/ spec admin/models no muestra OpenRouter como generate.
893. En e2e/ spec /code tab Archivos deep-link.
894. En e2e/ spec invite org token single-use.
895. En e2e/ spec PWA offline no cachea generate.
896. En hooks/use-computer-use.tsx flag F7 default off.
897. En hooks/use-toast.ts unificar con components/ui/use-toast.ts (duplicado 194 líneas).
898. En hooks/use-voices.tsx no fetch de voces en /chat hasta abrir TTS.
899. En hooks/use-debounce.ts usarlo en ChatSearchDialog y file-tree typeahead.
900. En components/ui/accessible-icon-button.tsx adoptarlo en activity-bar y MessageActionRail (ya existe y no se usa).
901. En components/ui/sidebar.tsx (645 líneas) no es el chrome de /code; no mezclar.
902. En components/ui/chart.tsx no en el hot path de /chat.
903. En instrumentation.ts sample rate distinto para /chat SSE vs /admin.
904. En next.config.mjs no bundlear agent-office-city en el chunk de /chat.
905. En components.json / shadcn: no regenerar ui/ que pise accessible-icon-button.
906. En lib/api-base-url.ts no caer a un host OpenRouter.
907. En lib/prisma.ts (9 líneas, client FE) no usarlo desde el browser.
908. En lib/db/src/* Drizzle no es el ORM vivo (STATE) — no generar queries desde FE.
909. En lib/api-zod/src/generated/* regenerar desde docs/openapi.json y fallar CI si drift.
910. En lib/api-client-react/src/custom-fetch.ts usar authenticated-fetch (cookies + redact).
911. En lib/safe-uuid.ts usarlo en clientMessageId (idempotency).
912. En lib/dev-log.ts off en prod y redact.
913. En lib/performance-optimizer.ts no diferir RunningChatsBar (el usuario necesita Stop).
914. En lib/background-jobs-context.tsx unificar con running-chat-jobs (hay bak-hide-chat-noise).
915. En lib/artifact-panel-context.tsx no guardar el blob en context (R2 URL).
916. En lib/hero-presentation.ts no stub deck.
917. En lib/image-generation-recovery.ts no reintentar con otro LLM de texto.
918. En lib/images-service.ts media ≠ generate.
919. En lib/gmail-service.ts tokens httpOnly.
920. En lib/github-service.ts no mandar token al runner prompt.
921. En lib/agentic-search-service.ts F6 untrusted.
922. En lib/cowork-api.ts isolation sessionKey.
923. En lib/workspace-workflow-service.ts no auto-commit.
924. En lib/use-workspace-run.ts cancel F3.
925. En lib/code-secr* (code-security si existe) no subir .env del proyecto.
926. En lib/attachments/html-to-markdown.ts untrusted.
927. En lib/markdown/remark-callouts.ts no ejecutar HTML.
928. En lib/markdown/normalize-math.ts no bloquear el primer token.
929. En lib/markdown-html.ts sanitizar.
930. En lib/research-artifacts.ts org scope.
931. En lib/academic-search-intent.ts no reescribir a OpenRouter.
932. En lib/gpt-icon-url.ts no hotlink no-CSP.
933. En lib/plans-service.ts currency.
934. En lib/document-batch-limits.ts (1 línea) no dejarlo vacío: exportar el tope real que usa composer-files.
935. En lib/interactive-message-blocks.ts no exec en share público.
936. En lib/appshots-geo-hint.ts consent.
937. En lib/sentry-config.ts scrub OOXML y Authorization.
938. En lib/next-api-cors.ts no * en /api/ai.
939. En lib/middleware.ts (54 líneas, FE) no duplicar auth del backend.
940. En lib/polling-registry.ts backoff.
941. En lib/notifications/push.ts payload sin prompt.
942. En lib/voice/spoken-response-summary.ts no leer secretos.
943. En lib/code-agent/spoken-summary.ts igual.
944. En lib/agent-office-model.ts no en el bundle /chat.
945. En lib/agent-office-environment.ts igual.
946. En lib/agent-company-slot.ts / center-slot / preview-slot: contrato estable para el otro agente del PC real — no cambiar geometría en esta oleada.
947. En lib/codex/codex-project-link.ts no leak invite.
948. En lib/codex/codex-api.ts barrel DeepSeek-only.
949. En lib/codex/format.ts cancelled ≠ done.
950. En lib/opencode/use-opencode-engine.ts no engine OpenRouter.
951. En lib/builder/dimensions.ts no generate.
952. En lib/builder/intake-service.ts DeepSeek.
953. En lib/integrations/slack.ts no NEXT_PUBLIC token.
954. En lib/integrations/verify-webhook.ts server-only.
955. En lib/dotmatrix-hooks.ts no en /chat generate.
956. En lib/rich-clipboard.ts sanitize.
957. En lib/paste-capture.ts no capturar passwords de un iframe de billing.
958. En lib/long-paste.ts umbral env una vez.
959. En lib/upload-with-progress.ts abort on unmount.
960. En lib/retry-after-fetch.ts 402.
961. En lib/request-queue.ts stop primero.
962. En lib/toast-helper.ts no toast por stage.
963. En lib/client-logs.ts redact.
964. En lib/web-vitals.ts TTFB SSE.
965. En lib/next-health.ts R2+runner.
966. En lib/sw-register.ts no cache generate.
967. En lib/mobile-install.ts standalone.
968. En lib/i18n/locale-resolution.ts F12.
969. En lib/settings-context.tsx migrar modelIds viejos.
970. En lib/auth-context-integrated.tsx no refetch por token SSE.
971. En lib/chat-context-integrated.tsx partir provider.
972. En lib/code-workspace-context.tsx partir provider.
973. En lib/background-streams-context.tsx tope concurrente.
974. En lib/background-jobs-context.tsx unificar jobs.
975. En components/icon-provider.tsx no bloquear primer paint.
976. En components/icons/* SVGs con title.
977. En components/skeleton/skeleton-pulse.tsx usarlo en loading.tsx de /chat y /code.
978. En components/loading-boundary.tsx no esconder el Stop.
979. En components/credential-warning.tsx si DEEPSEEK falta, copy honesto (no «AI provider»).
980. En components/WhatsAppButton.tsx no PII del prompt.
981. En components/ProcessingGmailCard.tsx y ProcessingGoogleServicesCard.tsx no tokens.
982. En components/GmailConnectionCard.tsx httpOnly.
983. En components/SpotifyConnectionCard.tsx httpOnly.
984. En components/GoogleServicesConnectionCard.tsx httpOnly.
985. En components/ExcelConnector.tsx worker parse.
986. En components/SyncfusionBannerRemover.tsx no ocultar error de render PPT.
987. En components/ImageGenerationEffect.tsx no bloquear composer.
988. En components/StarSparkles.tsx reduced-motion.
989. En components/BrandLogo.tsx no link a un status OpenRouter.
990. En components/BrandCycle.tsx fuera de /chat.
991. En components/BottomGlowBar.tsx no repaint por token.
992. En components/LiquidButton.tsx button nativo.
993. En components/CreditsBadge.tsx 402 DeepSeek.
994. En components/UpgradeModal.tsx focus trap.
995. En components/PWAInstallPrompt.tsx no tapar composer.
996. En components/GlobalDropRedirector.tsx mime-aware.
997. En components/ChatSearchDialog.tsx dialog a11y.
998. En components/SearchPanel.tsx flag F6.
999. En components/SearchSourceSelector.tsx no OpenRouter generate.
1000. En components/SourcesChip.tsx foco.
1001. En components/SlashCommandMenu.tsx /model flash|pro.
1002. En components/KeyboardShortcutsModal.tsx Stop + Flash/Pro.
1003. En components/keyboard-shortcuts.tsx no pelear con Monaco en /code.
1004. En components/notification-center.tsx agrupar PPT listo.
1005. En components/offline-banner.tsx SSE vs red.
1006. En components/connection-status.tsx gVisor/R2/402.
1007. En components/auth-guard.tsx next=.
1008. En components/impersonation-banner.tsx en /admin y /code.
1009. En components/error-boundary.tsx conversationId + lastEventId.
1010. En components/provider-error-boundary.tsx cubre /chat.
1011. En components/route-transition-shell.tsx no abortar SSE.
1012. En components/app-shell.tsx no meter office 3D.
1013. En components/app-wrapper.tsx split bundles.
1014. En components/root-providers.tsx lazy Sentry/PostHog.
1015. En components/theme-provider.tsx no forzar dark en PPT.
1016. En components/layout-client-effects.tsx no pisar Cmd+Enter.
1017. En components/posthog-client-init.tsx no prompt PII.
1018. En components/sentry-client-init.tsx scrub.
1019. En components/virtual-scroll.tsx usarlo en timeline /chat y file-tree /code.
1020. En components/office-clipboard-bridge.tsx fail honesto iOS.
1021. En components/paste-preview-overlay.tsx Enter/Escape.
1022. En components/file-upload-progress.tsx error por archivo.
1023. En components/file-processing-badge.tsx stages reales.
1024. En components/download-buttons.tsx filename artifact.
1025. En components/download-demo.tsx no en prod /chat.
1026. En components/presentation-view.tsx atajos ←/→.
1027. En components/document-preview.tsx un viewer.
1028. En components/code-preview.tsx sandbox.
1029. En components/composer-char-counter.tsx tope 3072 tokens runner.
1030. En components/thinking-placeholder.tsx copy de live-activity.
1031. En components/thinking-trace.tsx iteration/attempt.
1032. En components/agent-trace.tsx append-only.
1033. En components/agentic-steps.tsx stages F4.
1034. En components/MessageActionRail.tsx Tab.
1035. En components/sources-panel.tsx untrusted.
1036. En components/papers-result-card.tsx untrusted.
1037. En components/fal/fal-model-gallery.tsx media ≠ LLM.
1038. En components/fal/fal-brand-badge.tsx igual.
1039. En components/images/ImageHistoryPanel.tsx no mezclar con PPT.
1040. En components/viz/chartjs-chart.tsx lazy.
1041. En components/viz/plotly-chart.tsx lazy.
1042. En components/marco-teorico/source-card.tsx citas reales (crossref).
1043. En components/marco-teorico/source-chart.tsx no inventar series.
1044. En components/builder/CoverageRail.tsx no generate.
1045. En components/builder/ResultPanel.tsx DeepSeek.
1046. En components/design/chat-panel.tsx DeepSeek.
1047. En components/design/designs-grid.tsx lazy thumbs.
1048. En components/gpts/gpt-actions-editor.tsx no URL OpenRouter.
1049. En components/deployments/overview-tab.tsx poll idle.
1050. En components/deployments/logs-tab.tsx virtualizar.
1051. En components/deployments/domains-tab.tsx confirm delete.
1052. En components/deployments/shared.tsx no secrets.
1053. En components/deployments/version-timeline.tsx authz.
1054. En components/deployments/workspace-deployments-tool.tsx quality-gate.
1055. En components/codex/codex-folder-picker.tsx no binarios.
1056. En components/codex/codex-mark.tsx no branding OpenRouter.
1057. En components/codex/files-tab.tsx no prefetch R2.
1058. En components/codex/checklist-tab.tsx persistir en run.
1059. En components/codex/web-tab.tsx flag F6.
1060. En components/codex/reasoning-block.tsx no CoT en shares.
1061. En components/codex/action-chips-row.tsx confirm.
1062. En components/codex/action-required-card.tsx focus HITL.
1063. En components/codex/dictation-button.tsx confirmar envío.
1064. En components/codex/bottom-tab-bar.tsx Panel/Controlar/Archivos/Recursos.
1065. En components/codex/run-timeline.tsx aria stages.
1066. En components/codex/composer.tsx reusar ChatComposerSurface.
1067. En components/codex/plan-toggle.tsx no cambia model.
1068. En components/mobile/android-download-card.tsx checksum.
1069. En components/mobile/iphone-install-card.tsx A2HS honesto.
1070. En components/mobile/mobile-install-coach.tsx no tapar composer.
1071. En components/admin/CreditsTopUpModal.tsx idempotency.
1072. En components/admin/admin-chrome.tsx skip-link.
1073. En components/gateway/GatewayBadge.tsx aria estado.
1074. En app/api/health/ready/route.ts no filtrar env.
1075. En app/api/health/live/route.ts no tocar DB.
1076. En app/api/health/route.ts alinear con backend /ready.
1077. En app/api/ready/route.ts igual.
1078. En app/api/desktop/download/route.ts checksum.
1079. En app/api/desktop/releases/route.ts checksum.
1080. En app/api/mobile/download/route.ts checksum.
1081. En app/api/mobile/releases/route.ts checksum.
1082. En app/api/demo/route.ts no créditos prod.
1083. En app/api/agents/run/route.ts no es generate vivo (NOTICE-F11).
1084. En app/api/agents/route.ts no listar modelos prohibidos.
1085. En app/chat/layout.tsx no importar office 3D.
1086. En app/code/loading.tsx skeleton de Panel/Archivos, no WebGL.
1087. En app/gpts/layout.tsx no prefetch create wizard.
1088. En app/library/layout.tsx no prefetch PDFs.
1089. En app/profile/layout.tsx MFA.
1090. En app/admin/layout.tsx admin-chrome only.
1091. En app/admin/users/loading.tsx no es error.tsx — falta error.
1092. En app/page.tsx no meter chat 13k en landing.
1093. En capacitor.config.ts host siragpt.com, no OpenRouter.

— Fin del catálogo: **1093 ítems** honestos citados al árbol vivo `/opt/siragpt` (VPS 62.72.11.231, 2026-08-15).
