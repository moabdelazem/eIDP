import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit reads the tables from each module's schema.ts and keeps its
 * snapshots in drizzle/meta, which is how it knows what changed. The SQL it
 * writes is moved into src/lib/migrations by `pnpm db:generate`, where the
 * API's own runner applies it at boot (docs/platform.md).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/lib/schema.ts', './src/modules/*/schema.ts'],
  out: './drizzle',
})
