/**
 * The catalog as the UI consumes it: a system holds applications, and an
 * application exists in one or more environments. Fetched from the API, which
 * builds it from the `inventories` repo.
 */

export type Environment = 'dev' | 'qc' | 'uat' | 'prd_dr' | 'prd'

export type Application = {
  id: string
  name: string
  repository: string | null
  buildTechnology: string | null
  deployPlatform: string | null
  microservice: boolean | null
  /** Environments this application has a descriptor for. */
  environments: Environment[]
}

export type System = {
  id: string
  projectName: string
  company: string | null
  /**
   * Environment to owning team, from every `<env>_team` key in group_vars/all
   * — including stress and preprod, which no application deploys to by name.
   */
  teams: Record<string, string>
  applications: Application[]
}

export function findApplication(
  systems: System[],
  id: string | undefined,
): { system: System; app: Application } | undefined {
  for (const system of systems) {
    const app = system.applications.find((candidate) => candidate.id === id)
    if (app) return { system, app }
  }
  return undefined
}
