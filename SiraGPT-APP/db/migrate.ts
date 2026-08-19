import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', 'backend', '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/siragpt';

async function runMigrations() {
  const migrationClient = postgres(connectionString, { max: 1 });
  const db = drizzle(migrationClient);

  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, 'migrations'),
  });

  await migrationClient.end();
  console.log('Migrations complete');
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
