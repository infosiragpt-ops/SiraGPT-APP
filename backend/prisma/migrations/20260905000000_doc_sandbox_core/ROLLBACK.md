# Reversión segura de doc-sandbox F1

Esta migración es aditiva. Revertir la aplicación conserva las tres tablas, `users.docQuotaEpoch` y los originales privados; no ejecutar un `DROP` productivo. Detener admisión, cancelar/drenar jobs y completar la limpieza remota y las reservas de cuota antes de retirar el worker. El tombstone conserva la revocación de descargas mientras se purgan objetos/proveedor. No retirar el reconciliador si quedan reservas inciertas ni reembolsarlas manualmente: una versión anterior no mantiene el epoch de cuota en sus resets.

Solo en base **efímera de test**, sin datos que conservar, se puede probar la reversión dentro de una transacción:

```sql
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM doc_jobs) THEN
    RAISE EXCEPTION 'Reversión rechazada: doc_jobs contiene datos';
  END IF;
END $$;
DROP TABLE doc_job_artifacts;
DROP TABLE doc_job_events;
DROP TABLE doc_jobs;
ALTER TABLE users DROP COLUMN "docQuotaEpoch";
COMMIT;
```

Una base productiva con datos requiere exportación cifrada y autorización específica antes de una eliminación de esquema. La fila de Prisma de esta migración no se modifica manualmente en producción. Las pruebas usan esquema aislado y reejecutan `migration.sql` para verificar la restauración del esquema vacío.
