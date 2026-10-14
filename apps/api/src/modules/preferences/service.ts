import type { OverviewLayout, OverviewPreference } from '@eidp/contracts/preferences'
import { and, eq } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { userPreferences } from './schema.ts'

/**
 * Each person's own settings, kept with them rather than in one browser: the
 * Overview's layout follows someone to another machine. Read and written only
 * for the person signed in — the routes never take a uid.
 */

const OVERVIEW = 'overview'

export async function overviewLayout(uid: string): Promise<OverviewPreference> {
  const [row] = await db
    .select({ value: userPreferences.value, updatedAt: userPreferences.updatedAt })
    .from(userPreferences)
    .where(and(eq(userPreferences.uid, uid.toLowerCase()), eq(userPreferences.name, OVERVIEW)))
  return { layout: row?.value ?? null, updatedAt: row?.updatedAt.toISOString() ?? null }
}

export async function saveOverviewLayout(uid: string, layout: OverviewLayout): Promise<OverviewPreference> {
  // Each card once, in the order given; a card both placed and hidden stays placed, and hidden.
  const clean: OverviewLayout = { order: [...new Set(layout.order)], hidden: [...new Set(layout.hidden)] }
  const [row] = await db
    .insert(userPreferences)
    .values({ uid: uid.toLowerCase(), name: OVERVIEW, value: clean })
    .onConflictDoUpdate({ target: [userPreferences.uid, userPreferences.name], set: { value: clean, updatedAt: new Date() } })
    .returning({ value: userPreferences.value, updatedAt: userPreferences.updatedAt })
  return { layout: row!.value, updatedAt: row!.updatedAt.toISOString() }
}

/** Back to the portal's own arrangement for them. */
export async function resetOverviewLayout(uid: string): Promise<void> {
  await db.delete(userPreferences).where(and(eq(userPreferences.uid, uid.toLowerCase()), eq(userPreferences.name, OVERVIEW)))
}
