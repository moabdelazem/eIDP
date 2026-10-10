import type { RequestRecord } from '@eidp/contracts/requests'
import * as jira from '../../integrations/jira/index.ts'
import { recordCompleted, recordCreated, withContext } from './steps.ts'

/**
 * Creates the Jira project, led by the requester, then puts the requester and
 * their team in its member role. As with Azure DevOps, both are found in Jira
 * before anything is created, and `result_url` is written the moment the
 * project exists, so a retry after a failed grant only grants.
 */
export async function executeJiraProject(request: RequestRecord): Promise<void> {
  const lead = await jira.findUser(request.requestedBy)
  const members = [lead, ...(request.teamGroup ? [await jira.findGroup(request.teamGroup)] : [])]
  const key = request.projectKey!
  const resultUrl = jira.browseUrl(key)

  if (request.resultUrl === null) {
    await jira.createProject({ key, name: request.project, description: request.description ?? '', lead: lead.name })
    await recordCreated(request.id, resultUrl)
  }
  const { memberRole } = jira.jiraConfig()
  await withContext(`Created ${key}, but could not grant access`, () => jira.addToRole(key, memberRole, members))
  await recordCompleted(request.id, resultUrl)
}
