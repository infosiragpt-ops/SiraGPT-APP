# Adaptador de coworkers para `/code`

La integración toma las ideas centrales de OpenBot sin incorporar una segunda
aplicación ni sustituir el workspace de código existente.

## Mapa de capacidades

| Capacidad | Adaptación en SiraGPT |
| --- | --- |
| Coworkers especializados | Panel **Coworkers** dentro de la empresa de agentes en `/code`. Incluye perfiles de planificación, implementación e investigación, además de perfiles locales creados por el usuario. |
| Conversación | Un coworker abre el chat agéntico existente con su rol, política y contexto de workspace. El motor, la vista previa y los archivos siguen siendo los de `/code`. |
| Políticas de herramientas | Cada perfil hace visible su política antes de iniciar una conversación. Los perfiles de revisión e investigación no declaran cambios; el de implementación deja los cambios sujetos al circuito de aprobaciones del runtime. |
| Aprobaciones | La interfaz consume las aprobaciones pendientes del control plane de Cowork y permite aprobar o denegar una acción. La decisión se realiza únicamente mediante la ruta autenticada del backend. |
| Auditoría | Se muestran eventos recientes del registro append-only del control plane, nunca argumentos sensibles ni credenciales. |
| Credenciales y conectores | Se mantienen en el almacén cifrado del backend. La interfaz no recibe, persiste ni muestra secretos. |

## Contrato de servicio

La interfaz usa las rutas autenticadas bajo `/api/cowork`:

- `GET /workspaces`, `GET /approvals` y `GET /audit` para cargar el estado.
- `POST /approvals/:approvalId/decision` para resolver una aprobación.

El backend debe montar `createCoworkPlatformRouter()` y disponer de la
migración Prisma del control plane. Si el servicio no está disponible, la
interfaz presenta un estado explícito y no intenta ejecutar ni simular
aprobaciones, auditoría o conectores.

## Límites intencionales

- No hay OAuth ni credenciales de producción en esta capa.
- No se habilitan computadores remotos, Docker ni servicios externos de forma
  automática.
- Los coworkers personalizados se guardan solo en el navegador hasta que se
  implemente un catálogo de perfiles persistente y revisado por el servidor.