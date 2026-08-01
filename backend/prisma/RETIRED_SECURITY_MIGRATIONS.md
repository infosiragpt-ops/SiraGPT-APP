# Retired Security Migrations

The following historical, data-only migration directories are intentionally
absent from the active Prisma migration chain:

- `20260524033500_ensure_prod_admin_account`
- `20260527000000_reset_admin_password`
- `20260628171000_force_reset_prod_admin_password`

They created or reset a privileged bootstrap identity with credential material
stored in SQL. Existing databases can retain their completed records in
`_prisma_migrations`; the SQL must not be restored to the active migrations
directory. Fresh databases do not need these data mutations.

`20260731233000_retire_legacy_bootstrap_admin` remains active and idempotently
revokes the historical identity in databases where it existed.
