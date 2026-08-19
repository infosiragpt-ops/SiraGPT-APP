import {
  pgTable,
  text,
  real,
  integer,
  uuid,
  timestamp,
  customType,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]): string {
    return `[${value.map((n) => n.toFixed(6)).join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/[[\]]/g, "")
      .split(",")
      .map(Number);
  },
});

export const userMemories = pgTable(
  "user_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding").notNull(),
    category: text("category").notNull().default("knowledge"),
    importanceScore: real("importance_score").notNull().default(0.1),
    confidence: real("confidence").notNull().default(0.8),
    source: text("source"),
    lastAccessedAt: timestamp("last_accessed_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    accessCount: integer("access_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("user_memories_user_hash_idx").on(
      table.userId,
      table.contentHash
    ),
    index("user_memories_user_access_idx").on(
      table.userId,
      table.lastAccessedAt
    ),
    index("user_memories_user_category_idx").on(table.userId, table.category),
  ]
);

export type UserMemory = typeof userMemories.$inferSelect;
export type NewUserMemory = typeof userMemories.$inferInsert;
