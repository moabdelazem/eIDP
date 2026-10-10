/** The catalog: the inventories repo read into systems and applications (docs/platform.md). */
export { readApplication } from './service.ts'
export { atBoot, jobs } from './jobs.ts'
/** Read by Access (who owns a project) and My pipelines; written here alone. */
export { catalogApplications, catalogSystems } from './schema.ts'
