# Coding V2: límite de esta entrega

Este cambio refuerza la admisión y el acceso al adaptador de desarrollo; no
habilita Coding V2 en producción ni certifica Kubernetes, preview o ejecución
de tareas reales de extremo a extremo.

- `NODE_ENV=production` mantiene la función inhabilitada aunque se configure
  `AGENTES_CODING_V2=1`. Retirar esta barrera requiere otra revisión, aislamiento
  efectivo y aceptación multiusuario del proveedor de producción.
- Las rutas HTTP y SSE comprueban la identidad autenticada y el propietario
  antes de acceder a una sesión. No se modifica su vencimiento al denegar acceso.
- El terminal WebSocket valida la sesión persistida, rechaza tokens limitados
  a otro ámbito y comprueba propietario e identidad antes de cada nueva orden.
- El driver de memoria sirve para pruebas con un ejecutor inyectado: sin él
  responde con un error, nunca con éxito. Los drivers desconocidos no tienen
  fallback silencioso.
- Los recursos CPU/RAM solicitados no pueden superar los valores configurados
  por el servidor. Los valores nulos, ilimitados o inválidos no son aceptados
  como límites. La capacidad se reserva antes de crear un contenedor.

Verificación reproducible: ejecutar los seis archivos
`backend/tests/agentes-coding-{flags,sandbox,terminal,repo-map,structural-edit,session-guards}.test.js`
con el runner `node --test`. Incluyen HTTP/SSE local con identidades ficticias,
validación criptográfica con clave efímera de prueba y transporte inyectado.
No son aceptación Kubernetes ni pruebas pagadas de un modelo. Los tests de
otros módulos, CI requerido y aceptación de publicación siguen siendo gates
independientes; no se reducen umbrales ni se excluyen suites.

Pendientes de la entrega integral: confinamiento efectivo de archivos y red,
límite de salida y terminación real de procesos, recuperación duradera,
presupuesto verificado y flujo auténtico de proyecto/preview/diff/commit.
Mantener los detalles de revisión de seguridad por canal privado hasta su
remediación y no presentar el catálogo OSS como código integrado.
