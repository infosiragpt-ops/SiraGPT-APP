import { Prisma, type PrismaClient } from '@prisma/client';

/** Real, isolated catalog projection for admission tests, never production data. */
export async function createDocumentModelCatalogFixture(db: PrismaClient): Promise<void> {
  await db.$executeRaw(Prisma.sql`CREATE TYPE "ModelType" AS ENUM ('TEXT','IMAGE','VIDEO','AUDIO','MUSIC')`);
  // Prisma includes the primary identity in findUnique's SQL even when its
  // explicit select only requests name/provider/type/isActive. Keep the same
  // id primary key and name uniqueness contract as the application schema.
  await db.$executeRaw(Prisma.sql`CREATE TABLE ai_models(
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
    type "ModelType" NOT NULL, "isActive" BOOLEAN NOT NULL
  )`);
  await db.$executeRaw(Prisma.sql`INSERT INTO ai_models(id,name,provider,type,"isActive") VALUES
    ('fixture-mechanical-id','fixture-mechanical','anthropic','TEXT',true),
    ('fixture-academic-id','fixture-academic','anthropic','TEXT',true)`);
}
