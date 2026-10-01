# Conectar GitHub desde el chat

Cuando el usuario pide acceder a GitHub, el chat solicita una conexión asociada a ese usuario y conversación. Los errores de autenticación de las herramientas de GitHub también ofrecen este flujo. El modelo no construye enlaces OAuth: el cliente los pide al endpoint autenticado existente.

La interfaz reserva una pestaña durante el envío cuando la intención de iniciar sesión es explícita. Si el navegador bloquea la apertura, el aviso existente permite abrir GitHub o cancelar. El acceso y el consentimiento se realizan en GitHub. La autorización queda cifrada en la cuenta de SiraGPT, usando la persistencia existente; no se guardan contraseñas, URLs OAuth ni tokens en el chat o el almacenamiento del navegador.

El callback consume el estado una sola vez y guarda un recibo por usuario, chat e intento durante diez minutos. El cliente consulta ese recibo, verifica la autorización contra GitHub y comprueba la misma versión de conexión antes de continuar. La continuación ocurre una sola vez, cuando la conversación original está visible y libre. Conserva el borrador, los adjuntos y los permisos anteriores. Conectar una cuenta no autoriza por sí solo publicar, fusionar, pagar o borrar.

Cambiar de chat mantiene la espera en el chat original. Cancelar o denegar no continúa; una autorización caducada o revocada pide reconectar. Si GitHub separa la ventana por su política de aislamiento, la confirmación se recupera mediante el recibo del servidor. Después de navegar al proveedor no se interpreta `window.closed` como prueba de cancelación, porque también puede representar ese aislamiento; el aviso ofrece Cancelar y la espera caduca.

## Alcance y evidencia

- Este cambio conecta GitHub. No guarda un perfil de navegador universal ni sesiones de correo, bancos o pagos; otros servicios requieren sus respectivos conectores.
- No modifica F7, variables de entorno, credenciales, DNS o despliegues. Reutiliza la configuración OAuth y Redis existentes.
- Los tests del backend ejercitan Express, estado firmado, consumo y cifrado reales con GitHub y base de datos simulados. Las pruebas de interfaz usan Next y Chromium reales con las APIs y el proveedor externo simulados. Esto no acredita una autorización real de una cuenta ni una validación en producción.
- El chat conserva su comprobación previa de cuota y configuración del proveedor; si esa comprobación bloquea el turno, el acceso directo de GitHub sigue disponible. El endpoint de conexión no necesita un modelo.
- CI incluye el flujo de navegador en la comprobación crítica existente.

Referencia: [flujo oficial de autorización de GitHub](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
