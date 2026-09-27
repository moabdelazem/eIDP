export type Project = {
  id: string
  name: string
  team: string
  repo: string
  language: string
}

/**
 * Stand-in data so the map and its detail page can be navigated before the
 * engine repository is wired up. Replace wholesale — nothing should grow
 * around this shape until the real one is known.
 */
export const projects: Project[] = [
  {
    id: 'billing-api',
    name: 'Billing API',
    team: 'Payments',
    repo: 'org/billing-api',
    language: 'Go',
  },
  {
    id: 'checkout-web',
    name: 'Checkout',
    team: 'Payments',
    repo: 'org/checkout-web',
    language: 'TypeScript',
  },
  {
    id: 'identity',
    name: 'Identity',
    team: 'Platform',
    repo: 'org/identity',
    language: 'Java',
  },
]

export function findProject(id: string | undefined): Project | undefined {
  return projects.find((project) => project.id === id)
}
