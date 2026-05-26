import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/user-memories";

const connectionString =
  process.env.DATABASE_URL ||
  process.env.PRISMA_DATABASE_URL ||
  "postgresql://localhost:5432/siragpt";

function createPool() {
  const url = new URL(connectionString);
  return new Pool({
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    max: Number(process.env.DATABASE_POOL_MAX || "10"),
    min: Number(process.env.DATABASE_POOL_MIN || "1"),
    connectionTimeoutMillis: Number(
      process.env.DATABASE_POOL_TIMEOUT_MS || "10000"
    ),
  });
}

const pool = createPool();
export const db = drizzle(pool, { schema });
export { schema, pool };
