import type { OverviewLayout } from '@eidp/contracts/preferences'

/**
 * The Overview's cards, in the order and with the visibility someone chose —
 * or, until they choose, the portal's for someone like them. Pure, so it is
 * tested without a browser (layout.test.ts).
 *
 * `available` is the cards this person may see, in the default order;
 * `hiddenByDefault` the ones that start hidden for them. A saved layout keeps
 * its order for the cards it names; a card it does not name (new since they
 * saved, or newly theirs) goes after the one it follows by default, and
 * starts as it would by default. Names of cards no longer available are
 * dropped, so a layout outlives a role taken away.
 */
export function arrange(
  available: readonly string[],
  hiddenByDefault: ReadonlySet<string>,
  saved: OverviewLayout | null,
): { shown: string[]; hidden: string[] } {
  if (!saved) {
    return { shown: available.filter((id) => !hiddenByDefault.has(id)), hidden: available.filter((id) => hiddenByDefault.has(id)) }
  }
  const order = saved.order.filter((id) => available.includes(id))
  for (const [i, id] of available.entries()) {
    if (order.includes(id)) continue
    // After the card it follows by default, wherever that one went; first if none does.
    const before = available.slice(0, i).findLast((prev) => order.includes(prev))
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id)
  }
  const hidden = new Set(saved.hidden.filter((id) => available.includes(id)))
  for (const id of available) if (!saved.order.includes(id) && !saved.hidden.includes(id) && hiddenByDefault.has(id)) hidden.add(id)
  return { shown: order.filter((id) => !hidden.has(id)), hidden: order.filter((id) => hidden.has(id)) }
}

/** Moves a card one place up or down among the shown ones. */
export function move(shown: string[], id: string, by: -1 | 1): string[] {
  const at = shown.indexOf(id)
  const to = at + by
  if (at < 0 || to < 0 || to >= shown.length) return shown
  const next = [...shown]
  ;[next[at], next[to]] = [next[to]!, next[at]!]
  return next
}

/** "Good morning" by the hour where the person is. */
export function greeting(hour: number): string {
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}
