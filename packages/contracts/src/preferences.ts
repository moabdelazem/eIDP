/** What each person keeps about how the portal looks to them: what `/preferences` sends (apps/api modules/preferences). */

/**
 * The Overview as someone arranged it: the cards in the order they put them,
 * and the ones they hid. Card ids the portal no longer has are ignored; new
 * cards take their default place.
 */
export type OverviewLayout = { order: string[]; hidden: string[] }

/** `GET /preferences/overview`: null until someone saves one. */
export type OverviewPreference = { layout: OverviewLayout | null; updatedAt: string | null }
