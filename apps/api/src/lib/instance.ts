import { hostname } from 'node:os'

/** This process among the replicas — the pod's name on Kubernetes — for leases, locks, the log and `pg_stat_activity`. */
export const instance = `${hostname()}:${process.pid}`

let draining = false

/** Whether this process has been asked to stop: it finishes what it has and takes nothing new. */
export const isDraining = () => draining

export function startDraining(): void {
  draining = true
}
