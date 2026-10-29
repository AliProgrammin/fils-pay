#!/usr/bin/env -S npx tsx
/**
 * Seeds the demo data only when the database has none yet.
 *
 * db/seed/index.ts truncates and regenerates everything on each run. That is
 * right for local dev, but on a hosted box it would wipe what judges did each
 * time the stack restarts. ops/docker-compose.prod.yml runs this file instead.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx db/seed/once.ts
 */
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("seed:once: DATABASE_URL environment variable is not set");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const { rows } = await pool.query<{ seeded: boolean }>("SELECT EXISTS (SELECT 1 FROM merchants) AS seeded");
await pool.end();

if (rows[0]?.seeded) {
  console.log("seed:once: merchants already exist, skipping (demo data is seeded only once)");
} else {
  await import("./index.js");
}
