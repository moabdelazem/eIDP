import type { Appearance, AppearancePreference, OverviewLayout, OverviewPreference } from '@eidp/contracts/preferences'
import { and, eq } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { userPreferences } from './schema.ts'

/**
 * Each person's own settings, kept with them rather than in one browser: the
 * Overview's layout, and the theme and colours they chose, follow someone to
 * another machine. Read and written only
 * for the person signed in — the routes never take a uid.
 */

const OVERVIEW = 'overview'
const APPEARANCE = 'appearance'

export async function overviewLayout(uid: string): Promise<OverviewPreference> {
  const [row] = await db
    .select({ value: userPreferences.value, updatedAt: userPreferences.updatedAt })
    .from(userPreferences)
    .where(and(eq(userPreferences.uid, uid.toLowerCase()), eq(userPreferences.name, OVERVIEW)))
  return { layout: (row?.value as OverviewLayout | undefined) ?? null, updatedAt: row?.updatedAt.toISOString() ?? null }
}

export async function saveOverviewLayout(uid: string, layout: OverviewLayout): Promise<OverviewPreference> {
  // Each card once, in the order given; a card both placed and hidden stays placed, and hidden.
  const clean: OverviewLayout = { order: [...new Set(layout.order)], hidden: [...new Set(layout.hidden)] }
  const [row] = await db
    .insert(userPreferences)
    .values({ uid: uid.toLowerCase(), name: OVERVIEW, value: clean })
    .onConflictDoUpdate({ target: [userPreferences.uid, userPreferences.name], set: { value: clean, updatedAt: new Date() } })
    .returning({ value: userPreferences.value, updatedAt: userPreferences.updatedAt })
  return { layout: row!.value as OverviewLayout, updatedAt: row!.updatedAt.toISOString() }
}

/** Back to the portal's own arrangement for them. */
export async function resetOverviewLayout(uid: string): Promise<void> {
  await db.delete(userPreferences).where(and(eq(userPreferences.uid, uid.toLowerCase()), eq(userPreferences.name, OVERVIEW)))
}

/** The theme and colours someone chose, or null until they choose. */
export async function appearance(uid: string): Promise<AppearancePreference> {
  const [row] = await db
    .select({ value: userPreferences.value, updatedAt: userPreferences.updatedAt })
    .from(userPreferences)
    .where(and(eq(userPreferences.uid, uid.toLowerCase()), eq(userPreferences.name, APPEARANCE)))
  return { appearance: (row?.value as Appearance | undefined) ?? null, updatedAt: row?.updatedAt.toISOString() ?? null }
}

export async function saveAppearance(uid: string, value: Appearance): Promise<AppearancePreference> {
  const clean: Appearance = { theme: value.theme, palette: value.palette }
  const [row] = await db
    .insert(userPreferences)
    .values({ uid: uid.toLowerCase(), name: APPEARANCE, value: clean })
    .onConflictDoUpdate({ target: [userPreferences.uid, userPreferences.name], set: { value: clean, updatedAt: new Date() } })
    .returning({ value: userPreferences.value, updatedAt: userPreferences.updatedAt })
  return { appearance: row!.value as Appearance, updatedAt: row!.updatedAt.toISOString() }
}
