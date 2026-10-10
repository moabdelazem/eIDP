/**
 * Access: permissions, roles and the bindings that grant them (docs/access.md).
 * Every module asks here what someone may do; the routes manage bindings.
 */
export { PERMISSIONS, ROLES, accessOf, auditAssume, can, canSomewhere, describe, teamsOwning } from './service.ts'
export type { Access, Permission, Role, Target } from './service.ts'
/** Read by Platform activity; written here alone. */
export { rbacAudit } from './schema.ts'
