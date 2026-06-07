import path from "node:path";
import { defineConfig } from "prisma/config";
import { loadEnvFiles } from "./src/config/load-env";

// Prisma 7 removes support for `package.json#prisma`; this file replaces it.
//
// Once a Prisma config file exists, Prisma no longer auto-loads `.env`, so we
// reuse the backend's single source of truth for environment resolution
// (`src/config/load-env`). It loads, in precedence order, backend/.env.local ->
// root/.env.local -> backend/.env -> root/.env with `override: false`, so real
// process.env values (CI secrets, the production container) always win. This
// keeps `prisma migrate deploy/dev`, `generate`, `db push`, `studio`, `db seed`
// and the production boot wrapper resolving DATABASE_URL / PRISMA_DATABASE_URL
// identically.
loadEnvFiles();

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  migrations: {
    // Replaces the deprecated `package.json#prisma.seed`.
    seed: "node prisma/seed.js",
  },
});
