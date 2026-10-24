import type { RequestRecord } from '@eidp/contracts/requests'
import * as jira from '../../integrations/jira/index.ts'
import { recordCompleted, recordCreated, withContext } from './steps.ts'

/**
 * Creates the Jira project, led by the lead named on the form (the requester
 * when none was), then puts the requester, the lead and their team in its
 * member role. As with Azure DevOps, everyone is found in Jira before
 * anything is created, and `result_url` is written the moment the project
 * exists, so a retry after a failed grant only grants.
 */
export async function executeJiraProject(request: RequestRecord): Promise<void> {
  const requester = await jira.findUser(request.requestedBy)
  const lead = request.projectLead ? await jira.findUser(request.projectLead) : requester
  const members = [requester, ...(lead === requester ? [] : [lead]), ...(request.teamGroup ? [await jira.findGroup(request.teamGroup)] : [])]
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
