import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Every user-owned row carries ownerId so one shared account model works
// across all apps. ownerId is the Remote-Sub value from the identity provider.
export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
