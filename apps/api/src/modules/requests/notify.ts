import type { RequestRecord } from '@eidp/contracts/requests'
import { profileOf } from '../../integrations/ldap/index.ts'
import { errorFields, log } from '../../lib/log.ts'
import { devopsAddresses, enqueueMail, portalLink, renderEmail, type EmailContent } from '../notifications/index.ts'
import { find } from './rows.ts'

/**
 * What a request's people are told by mail, and when — the old portal's
 * notifications, without its Re-notify button being the safety net:
 *
 * - filed → DevOps (MAIL_DEVOPS_TO): something waits on them;
 * - rejected → the requester, with the reason;
 * - completed → the requester, with where it is;
 * - failed → DevOps: theirs to fix and retry. The requester is not told of a
 *   failure DevOps will retry; their request page says it.
 *
 * Every one is queued (modules/notifications), never sent inline, and never
 * fails what it is about: a request is filed, decided or done whether or not
 * its mail could be queued.
 */

export const refOf = (id: string) => `request:${id}`

/** The thing asked for, in a few words. */
export function whatOf(r: RequestRecord): string {
  const names = (r.grantees ?? []).join(', ')
  switch (r.kind) {
    case 'create_repository':
      return `repository ${r.repository} in ${r.project}`
    case 'create_project':
      return `Azure DevOps project ${r.project}`
    case 'create_jira_project':
      return `Jira project ${r.project} (${r.projectKey})`
    case 'grant_access':
      return `access to ${r.project} for ${names}`
    case 'revoke_access':
      return `removing ${names} from ${r.project}`
    case 'create_pipeline':
      return `pipeline for ${r.pipeline?.application ?? r.repository}`
    default:
      return `${String(r.kind).replaceAll('_', ' ')} ${r.project}`
  }
}

/** What it is, where, and for whom: the rows every message carries. */
function factsOf(r: RequestRecord): [string, string][] {
  return [
    ['Request', whatOf(r)],
    ...(r.collection ? ([['Where', `${r.collection} / ${r.project}`]] as [string, string][]) : []),
    ['Asked for by', r.requestedByName],
  ]
}

const link = (r: RequestRecord) => portalLink(`/requests/${r.id}`)

async function queue(r: RequestRecord, topic: string, to: string[], subject: string, content: EmailContent, cc: string[] = []) {
  try {
    const { text, html } = renderEmail(content)
    await enqueueMail({ topic, ref: refOf(r.id), to, cc, subject, text, html })
  } catch (err) {
    log.warn('request mail could not be queued', { request: r.id, topic, ...errorFields(err) })
  }
}

/** The requester's address, from the directory. */
async function requesterOf(r: RequestRecord): Promise<string[]> {
  const profile = await profileOf(r.requestedBy).catch(() => null)
  return profile?.mail ? [profile.mail] : []
}

/** Filed: DevOps have something to decide. */
export async function notifyFiled(r: RequestRecord): Promise<void> {
  const to = devopsAddresses()
  if (to.length === 0) return
  await queue(r, 'request.filed', to, `New request: ${whatOf(r)}`, {
    heading: 'A request is waiting for a decision',
    intro: `${r.requestedByName} asked for ${whatOf(r)}.`,
    facts: factsOf(r),
    quote: { label: 'Their reason', text: r.justification },
    action: { label: 'Review it', url: link(r) },
    footer: 'You get this because you decide requests in e-IDP.',
  })
}

/** Rejected: the requester, with why. */
export async function notifyRejected(r: RequestRecord): Promise<void> {
  await queue(r, 'request.rejected', await requesterOf(r), `Rejected: ${whatOf(r)}`, {
    heading: 'Your request was not approved',
    intro: `${r.decidedByName ?? 'DevOps'} rejected your request for ${whatOf(r)}. Fix what they say and ask again.`,
    facts: factsOf(r),
    quote: r.decisionNote ? { label: 'Why', text: r.decisionNote } : null,
    action: { label: 'Open your request', url: link(r) },
    footer: 'You get this because you asked for it in e-IDP.',
  })
}

/** Done: the requester, with where to find it. */
export async function notifyCompleted(id: string): Promise<void> {
  const r = await find(id).catch(() => null)
  if (!r) return
  const pipeline = r.kind === 'create_pipeline'
  const heading =
    r.kind === 'grant_access' ? 'Access granted' : r.kind === 'revoke_access' ? 'Access removed' : pipeline ? 'Your pipeline is set up' : 'Your request is done'
  await queue(r, 'request.completed', await requesterOf(r), `Done: ${whatOf(r)}`, {
    heading,
    intro: `Your request for ${whatOf(r)} was approved${r.decidedByName ? ` by ${r.decidedByName}` : ''} and is done.`,
    // A pipeline's result is a commit: DevOps' to read, so the requester gets their request page instead.
    facts: [...factsOf(r), ...(r.resultUrl && !pipeline ? ([['Open it', r.resultUrl]] as [string, string][]) : [])],
    action: { label: 'Open your request', url: link(r) },
    footer: 'You get this because you asked for it in e-IDP.',
  })
}

/** Failed: DevOps, who retry it once the cause is fixed. */
export async function notifyFailed(id: string): Promise<void> {
  const to = devopsAddresses()
  if (to.length === 0) return
  const r = await find(id).catch(() => null)
  if (!r) return
  await queue(r, 'request.failed', to, `Failed: ${whatOf(r)}`, {
    heading: 'A request could not be carried out',
    intro: `Approving ${whatOf(r)} failed part-way. Retry it from its page once the cause is fixed; a retry picks up where it stopped.`,
    facts: factsOf(r),
    quote: r.error ? { label: 'What went wrong', text: r.error } : null,
    action: { label: 'Open the request', url: link(r) },
    footer: 'You get this because you decide requests in e-IDP.',
  })
}
